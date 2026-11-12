#!/usr/bin/env python3
"""Place the voiceover blocks on their cues, duck the music bed under them, and mux onto the cut.

usage: mix.py <blocks.json> <voice dir> <music wav> <silent cut mp4> <out mp4> <work dir>
  blocks.json is the cue list `motion/render.py captions` writes; the voice dir holds tts.py's block-NN.wav.

Voice: each block is trimmed to its speech, placed at cue + lead, and the whole track is
gained to VOICE_LUFS. Music: MUSIC_OFFSET into the render, gained to BED_LUFS, faded up over
the title and out over the closing, and ducked by DUCK_DB while the voice speaks.
Audio is AAC 192k stereo 48 kHz; the video stream is copied.
"""

import json
import re
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

RATE = 48000
VOICE_LUFS = -16.0
VOICE_PEAK_DB = -2.5  # limiter ceiling on the voice, leaves headroom for the bed and AAC
MIX_PEAK_DB = -1.5
BED_LUFS = -26.0  # music level between lines
DUCK_DB = -9.0  # extra cut under the voice: bed sits ~20 dB under it
DUCK_ATTACK = 0.25  # s ramp down before a line starts
DUCK_RELEASE = 0.60  # s ramp up after a line ends
DEFAULT_LEAD = 0.15  # s from the cue to the first word
MIN_GAP = 0.25  # s of quiet required between two lines
SILENCE_DBFS = -45.0
TRIM_PAD_START = 0.03
TRIM_PAD_END = 0.15
EDGE_FADE = 0.01
MUSIC_OFFSET = 4.0  # s, skips the render's sparse intro
FADE_IN = 3.0  # s, music fade-up over the title
FADE_OUT_TAIL = 6.0  # s, music fades out over the last seconds


def run(cmd: list[str]) -> str:
    return subprocess.run(cmd, check=True, capture_output=True, text=True).stderr


def video_seconds(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(out.stdout.strip())


def integrated_lufs(path: Path) -> float:
    log = run(
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-i",
            str(path),
            "-af",
            "ebur128=framelog=quiet",
            "-f",
            "null",
            "-",
        ]
    )
    return float(re.findall(r"I:\s+(-?[\d.]+) LUFS", log)[-1])


def read_wav_mono(path: Path) -> np.ndarray:
    with wave.open(str(path)) as wav:
        assert wav.getframerate() == RATE and wav.getnchannels() == 1
        data = np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2")
    return data.astype(np.float32) / 32768


def decode_stereo(path: Path) -> np.ndarray:
    raw = subprocess.run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-i",
            str(path),
            "-f",
            "f32le",
            "-ac",
            "2",
            "-ar",
            str(RATE),
            "-",
        ],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype="<f4").reshape(-1, 2).copy()


def write_wav(path: Path, samples: np.ndarray) -> None:
    stereo = samples if samples.ndim == 2 else np.stack([samples, samples], axis=1)
    pcm = (np.clip(stereo, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(pcm.tobytes())


def speech_span(samples: np.ndarray) -> tuple[int, int]:
    loud = np.flatnonzero(np.abs(samples) > 10 ** (SILENCE_DBFS / 20))
    start = max(0, loud[0] - int(TRIM_PAD_START * RATE))
    end = min(len(samples), loud[-1] + int(TRIM_PAD_END * RATE))
    return start, end


def edge_faded(clip: np.ndarray) -> np.ndarray:
    n = int(EDGE_FADE * RATE)
    ramp = np.linspace(0, 1, n, dtype=np.float32)
    clip = clip.copy()
    clip[:n] *= ramp
    clip[-n:] *= ramp[::-1]
    return clip


def placement_problems(
    placed: list[dict], total_seconds: float, min_gap: float = MIN_GAP
) -> list[str]:
    """Lines closer than min_gap to the next one, or a last line that runs past the video."""
    problems = []
    for here, after in zip(placed, placed[1:], strict=False):
        if after["on"] - here["off"] < min_gap:
            problems.append(
                f"block {here['n']} ends {after['on'] - here['off']:.2f}s before block {after['n']}"
            )
    if placed and placed[-1]["off"] > total_seconds:
        problems.append("last block runs past the video")
    return problems


def place_voice(blocks: list[dict], voice_dir: Path, total: int) -> tuple[np.ndarray, list[dict]]:
    track = np.zeros(total, dtype=np.float32)
    placed = []
    for block in blocks:
        samples = read_wav_mono(voice_dir / f"block-{block['n']:02d}.wav")
        start, end = speech_span(samples)
        clip = edge_faded(samples[start:end])
        at = int((block["start"] + block.get("lead", DEFAULT_LEAD)) * RATE)
        track[at : at + len(clip)] += clip[: max(0, total - at)]
        placed.append(
            {
                "n": block["n"],
                "on": at / RATE,
                "off": (at + len(clip)) / RATE,
                "cue": block["start"],
                "next_cue": block["end"],
            }
        )
    problems = placement_problems(placed, total / RATE)
    if problems:
        sys.exit("placement problems:\n  " + "\n  ".join(problems))
    return track, placed


def duck_envelope(placed: list[dict], total: int) -> np.ndarray:
    t = np.arange(total, dtype=np.float32) / RATE
    duck = np.zeros(total, dtype=np.float32)  # 0 = no duck, 1 = full duck
    for line in placed:
        down = np.clip((t - (line["on"] - DUCK_ATTACK)) / DUCK_ATTACK, 0, 1)
        up = np.clip(((line["off"] + DUCK_RELEASE) - t) / DUCK_RELEASE, 0, 1)
        duck = np.maximum(duck, np.minimum(down, up))
    return 10 ** (DUCK_DB * duck / 20)


def fades(total: int) -> np.ndarray:
    t = np.arange(total, dtype=np.float32) / RATE
    end = total / RATE
    fade_in = np.clip(t / FADE_IN, 0, 1)
    fade_out = np.clip((end - t) / FADE_OUT_TAIL, 0, 1)
    return (fade_in * fade_out) ** 2  # squared: an equal-power-ish curve


def main() -> None:
    blocks = json.loads(Path(sys.argv[1]).read_text())
    voice_dir, music_wav, cut, out_mp4, work = (Path(a) for a in sys.argv[2:7])
    work.mkdir(parents=True, exist_ok=True)
    total = int(round(video_seconds(cut) * RATE))

    voice, placed = place_voice(blocks, voice_dir, total)
    write_wav(work / "voice-raw.wav", voice)
    voice *= 10 ** ((VOICE_LUFS - integrated_lufs(work / "voice-raw.wav")) / 20)
    write_wav(work / "voice-gained.wav", voice)
    run(
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-y",
            "-i",
            str(work / "voice-gained.wav"),
            "-af",
            f"alimiter=limit={VOICE_PEAK_DB}dB:level=false:attack=5:release=50",
            "-c:a",
            "pcm_s16le",
            str(work / "voice-track.wav"),
        ]
    )
    voice = decode_stereo(work / "voice-track.wav")[:total, 0]

    music = decode_stereo(music_wav)[int(MUSIC_OFFSET * RATE) :][:total]
    if len(music) < total:
        sys.exit(f"music is {len(music) / RATE:.1f}s after the offset, need {total / RATE:.1f}s")
    write_wav(work / "music-raw.wav", music)
    music *= 10 ** ((BED_LUFS - integrated_lufs(work / "music-raw.wav")) / 20)
    bed = music * (duck_envelope(placed, total) * fades(total))[:, None]
    write_wav(work / "bed-track.wav", bed)

    mix = bed + voice[:, None]
    peak_dbfs = 20 * np.log10(np.abs(mix).max())
    if peak_dbfs > MIX_PEAK_DB:
        sys.exit(f"mix peaks at {peak_dbfs:.2f} dBFS")
    write_wav(work / "mix.wav", mix)
    run(
        [
            "ffmpeg",
            "-nostdin",
            "-hide_banner",
            "-n",
            "-i",
            str(cut),
            "-i",
            str(work / "mix.wav"),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            str(RATE),
            "-ac",
            "2",
            "-movflags",
            "+faststart",
            "-shortest",
            str(out_mp4),
        ]
    )
    (work / "placement.json").write_text(json.dumps(placed, indent=1) + "\n")
    print(f"sample peak {peak_dbfs:.2f} dBFS; wrote {out_mp4}")


if __name__ == "__main__":
    main()
