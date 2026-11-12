"""Unit tests for the demo video kit's pure parts (tools/demo-video): no browser, network, ffmpeg or audio."""

import importlib.util
import sys
from pathlib import Path

import pytest

KIT = Path(__file__).resolve().parents[1] / "tools" / "demo-video"


def load(relative: str):
    path = KIT / relative
    sys.path.insert(0, str(path.parent))
    try:
        spec = importlib.util.spec_from_file_location(path.stem, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(path.parent))


gate = load("gate/privacy_gate.py")
tts = load("voice/tts.py")


def test_gate_flags_the_account_email_its_local_part_and_domain():
    ids = gate.identifiers_from("demo+one@company.example", [])
    hits = gate.scan(
        ["Account & AI", "demo+one · free", "signed in as demo+one@company.example"], ids
    )
    assert hits["identifiers"] == ["demo+one · free", "signed in as demo+one@company.example"]


def test_gate_flags_a_real_email_but_not_the_sandbox_guest():
    hits = gate.scan(
        ["contact: someone@vendor.com", "confnote-guest-1@example.org", "guest@example.o"], ["zzzz"]
    )
    assert hits["emails"] == ["contact: someone@vendor.com"]
    assert len(hits["sandbox"]) == 1  # "example.o" is OCR clipping, not an email shape


def test_gate_ignores_ocr_reading_a_zero_as_at_inside_digits():
    lines = ['"start": "2026-@5-19T09:40:00+01:00"', "checkout order 8X264859UR@20315C"]
    assert gate.scan(lines, ["zzzz"]) == {"identifiers": [], "emails": [], "sandbox": []}


def test_ssml_escapes_text_and_applies_pronunciations():
    ssml = tts.ssml_for("confnote got a 402 & kept going", "+5%", voice="en-US-TestNeural")
    assert '<voice name="en-US-TestNeural"><prosody rate="+5%">' in ssml
    assert '<sub alias="conf note">confnote</sub>' in ssml
    assert '<sub alias="four oh two">402</sub>' in ssml
    assert "&amp; kept going" in ssml


def test_spoken_seconds_trims_leading_and_trailing_silence(tmp_path):
    import array
    import wave

    rate = 1000
    samples = array.array("h", [0] * 500 + [8000] * 1500 + [0] * 700)
    path = tmp_path / "block.wav"
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(samples.tobytes())
    assert tts.spoken_seconds(path) == pytest.approx(1.499, abs=0.002)


def test_mix_reports_lines_too_close_and_a_last_line_past_the_end():
    pytest.importorskip("numpy")
    mix = load("voice/mix.py")
    placed = [
        {"n": 1, "on": 0.0, "off": 2.0},
        {"n": 2, "on": 2.1, "off": 4.0},
        {"n": 3, "on": 5.0, "off": 9.0},
    ]
    problems = mix.placement_problems(placed, total_seconds=8.0)
    assert problems == ["block 1 ends 0.10s before block 2", "last block runs past the video"]
    assert mix.placement_problems(placed[2:], total_seconds=10.0) == []


def test_captions_time_subtitles_to_the_spoken_line_and_chain_the_cues():
    pytest.importorskip("playwright")
    render = load("motion/render.py")
    blocks = [[1, 0.5, "cards (motion)", "First line."], [2, 6.0, "1 · Import", "Second line."]]
    srt, script, cues = render.caption_files(blocks, {"1": 3.0, "2": 2.0}, total=10.0)
    assert "00:00:00,500 --> 00:00:03,900" in srt
    assert "**0:06.0 1 · Import** (block 2)" in script
    assert cues == [
        {"n": 1, "text": "First line.", "start": 0.5, "end": 6.0, "lead": 0.0},
        {"n": 2, "text": "Second line.", "start": 6.0, "end": 10.0, "lead": 0.0},
    ]


def test_render_server_serves_only_mounted_folders(tmp_path):
    pytest.importorskip("playwright")
    render = load("motion/render.py")
    kit = tmp_path / "kit"
    (kit / "motion").mkdir(parents=True)
    (kit / "motion" / "index.html").write_text("ok")
    (tmp_path / "secret.txt").write_text("no")
    mounts = {"kit": kit}
    assert render.resolve_mounted(mounts, "/kit/motion/index.html?storyboard=x") == (
        kit / "motion" / "index.html"
    )
    assert render.resolve_mounted(mounts, "/kit/motion%20x/a b.png") == kit / "motion x" / "a b.png"
    assert render.resolve_mounted(mounts, "/kit/../secret.txt") is None
    assert render.resolve_mounted(mounts, "/kit/%2e%2e/secret.txt") is None
    assert render.resolve_mounted(mounts, "/other/secret.txt") is None
    assert render.resolve_mounted(mounts, "/kit") is None
