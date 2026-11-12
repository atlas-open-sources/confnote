#!/usr/bin/env python3
"""Voice each narration block with Azure neural TTS (SSML), one wav per block, and measure the spoken length.

usage: tts.py <blocks-text.json> <out dir> [block numbers...]
  blocks-text.json: [{"n": 1, "text": "...", "rate": "+0%"}, ...]
  writes <out>/block-NN.wav, block-NN.ssml and speech-seconds.json ({"<n>": spoken seconds})

The Azure Speech resource comes from the environment (or the defaults below):
  CONFNOTE_TTS_ACCOUNT, CONFNOTE_TTS_GROUP, CONFNOTE_TTS_REGION, CONFNOTE_TTS_VOICE
The key is read from `az cognitiveservices account keys list` inside this process. It is never printed, logged,
written to disk or put on a command line, and nothing here stores it.
"""

import array
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave
from http.client import IncompleteRead
from pathlib import Path
from xml.sax.saxutils import escape

ACCOUNT = os.environ.get("CONFNOTE_TTS_ACCOUNT", "")
GROUP = os.environ.get("CONFNOTE_TTS_GROUP", "")
REGION = os.environ.get("CONFNOTE_TTS_REGION", "swedencentral")
VOICE = os.environ.get("CONFNOTE_TTS_VOICE", "en-GB-RyanNeural")
OUTPUT_FORMAT = "riff-48khz-16bit-mono-pcm"
ATTEMPTS = 4  # Azure sometimes cuts a chunked reply short
RETRY_PAUSE_S = 3
SILENCE_DBFS = -45.0

# Spoken forms for words TTS would otherwise misread: lexicon.json, each entry checked by transcription (see its
# "why"). Azure's <lexicon> element only takes a public URL, so the entries are applied inline as SSML.
LEXICON_PATH = Path(
    os.environ.get("CONFNOTE_TTS_LEXICON", Path(__file__).with_name("lexicon.json"))
)


VOICELESS_IPA = "ptkfθ"  # a possessive after these is /s/, otherwise /z/


def spoken_markup(entry: dict, possessive: str = "") -> str:
    """The entry as SSML. A possessive goes inside the markup: left outside, "Bryntum's" is read "Bryntum as"."""
    word = escape(entry["text"]) + possessive
    if "ipa" in entry:
        ipa = entry["ipa"]
        if possessive:
            ipa += "s" if ipa[-1] in VOICELESS_IPA else "z"
        return f'<phoneme alphabet="ipa" ph="{ipa}">{word}</phoneme>'
    if "alias" in entry:
        return f'<sub alias="{escape(entry["alias"]) + possessive}">{word}</sub>'
    return f'<say-as interpret-as="{entry["say_as"]}">{escape(entry["text"])}</say-as>{possessive}'


def load_lexicon(path: Path) -> tuple[re.Pattern, dict]:
    entries = {escape(e["text"]): e for e in json.loads(path.read_text())["entries"]}
    # Longest first, whole words only, one pass: "Mochi" never matches inside an inserted <phoneme>.
    words = sorted(entries, key=len, reverse=True)
    alternatives = "|".join(re.escape(w) for w in words)
    pattern = re.compile(r"(?<![\w-])(" + alternatives + r")((?:'|’)s)?(?![\w-])")
    return pattern, entries


LEXICON_PATTERN, LEXICON = load_lexicon(LEXICON_PATH)


def voice_locale(voice: str) -> str:
    """The voice's own locale ("en-GB-RyanNeural" -> "en-GB"), so a British voice is not read as American."""
    return "-".join(voice.split("-")[:2])


def ssml_for(text: str, rate: str, voice: str = VOICE) -> str:
    body = LEXICON_PATTERN.sub(
        lambda m: spoken_markup(LEXICON[m.group(1)], m.group(2) or ""), escape(text)
    )
    return (
        '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"'
        f' xml:lang="{voice_locale(voice)}">'
        f'<voice name="{voice}"><prosody rate="{rate}">{body}</prosody></voice></speak>'
    )


def spoken_seconds(path: Path) -> float:
    """Length from the first to the last sample above SILENCE_DBFS."""
    threshold = 10 ** (SILENCE_DBFS / 20) * 32768
    with wave.open(str(path)) as wav:
        rate = wav.getframerate()
        samples = array.array("h", wav.readframes(wav.getnframes()))
    loud = [i for i, s in enumerate(samples) if abs(s) > threshold]
    return round((loud[-1] - loud[0]) / rate, 3) if loud else 0.0


def read_key() -> str:
    if not ACCOUNT or not GROUP:
        sys.exit(
            "set CONFNOTE_TTS_ACCOUNT and CONFNOTE_TTS_GROUP (the Azure Speech resource and its group)"
        )
    out = subprocess.run(
        [
            "az",
            "cognitiveservices",
            "account",
            "keys",
            "list",
            "-n",
            ACCOUNT,
            "-g",
            GROUP,
            "-o",
            "json",
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return json.loads(out)["key1"]


def synthesize(key: str, ssml: str) -> bytes:
    request = urllib.request.Request(
        f"https://{REGION}.tts.speech.microsoft.com/cognitiveservices/v1",
        data=ssml.encode("utf-8"),
        headers={
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
            "User-Agent": "confnote-demo-video",
        },
    )
    for attempt in range(1, ATTEMPTS + 1):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.read()
        except (IncompleteRead, urllib.error.URLError):
            if attempt == ATTEMPTS:
                raise
            time.sleep(RETRY_PAUSE_S)
    raise RuntimeError("unreachable")


def main() -> None:
    blocks = json.loads(Path(sys.argv[1]).read_text())
    out_dir = Path(sys.argv[2])
    only = {int(n) for n in sys.argv[3:]}
    out_dir.mkdir(parents=True, exist_ok=True)
    key = read_key()
    lengths_file = out_dir / "speech-seconds.json"
    lengths = json.loads(lengths_file.read_text()) if lengths_file.exists() else {}
    characters = 0
    for block in blocks:
        if only and block["n"] not in only:
            continue
        ssml = ssml_for(block["text"], block.get("rate", "+0%"))
        stem = f"block-{block['n']:02d}"
        (out_dir / f"{stem}.ssml").write_text(ssml + "\n")
        (out_dir / f"{stem}.wav").write_bytes(synthesize(key, ssml))
        lengths[str(block["n"])] = spoken_seconds(out_dir / f"{stem}.wav")
        characters += len(ssml)
        print(f"{stem}: {lengths[str(block['n'])]:.2f} s spoken")
    lengths_file.write_text(json.dumps(lengths, indent=1, sort_keys=True) + "\n")
    print(f"SSML characters sent (markup included): {characters}")


if __name__ == "__main__":
    main()
