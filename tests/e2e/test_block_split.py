"""Re-split a block recording through /api/recording/split and see the slice
in the session's Links & Files tab.

The audio is a few minutes of generated silence (afconvert → AAC m4a) and the
timed transcript is a mocked segments file, so neither the Cat nor a
microphone is involved. avconvert cuts the slice for real. No audio plays.
"""

from __future__ import annotations

import json
import subprocess
import wave
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SLUG = "2026-05-19-beyond-the-prompt"
NOTE = "1110-codebase-design.md"
BLOCK_SECONDS = 180
SAMPLE_RATE = 16000

pytestmark = pytest.mark.skipif(
    not (REPO / "packages/local-app/recording_split.py").exists()
    or not Path("/usr/bin/avconvert").exists(),
    reason="needs recording_split (split-core) and macOS avconvert",
)


def _silent_m4a(folder: Path) -> Path:
    wav = folder / "block.wav"
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(b"\0\0" * SAMPLE_RATE * BLOCK_SECONDS)
    m4a = folder / "block.m4a"
    subprocess.run(
        ["/usr/bin/afconvert", "-f", "m4af", "-d", "aac", str(wav), str(m4a)],
        check=True,
        capture_output=True,
    )
    return m4a


def test_split_files_a_slice_the_files_tab_lists(app, tmp_path):
    audio = _silent_m4a(tmp_path)
    segments = tmp_path / "segments.json"
    segments.write_text(
        json.dumps(
            {
                "segments": [
                    {"start": 50, "end": 55, "text": "Next speaker, please welcome Stephen Cooper"},
                    {
                        "start": 60,
                        "end": 70,
                        "text": "Hello, I'm Stephen. Codebase design for agents.",
                    },
                    {"start": 120, "end": 130, "text": "Small modules keep the context focused."},
                ]
            }
        )
    )
    body = {
        "slug": SLUG,
        "audio_path": str(audio),
        "segments_path": str(segments),
        "notes": [NOTE],
        "started_at": "2026-05-19T11:09:00+01:00",
    }
    result = app.evaluate(
        """async (body) => {
            const r = await fetch("/api/recording/split", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Confnote-Request": "1" },
              body: JSON.stringify(body),
            });
            return { status: r.status, data: await r.json() };
        }""",
        body,
    )
    assert result["status"] == 200, result
    rows = result["data"]["results"]
    assert [r["note"] for r in rows] == [NOTE]
    assert rows[0]["status"] == "filed", rows

    app.evaluate(f"() => {{ location.hash = '#/{SLUG}/{NOTE}'; }}")
    app.wait_for_selector("#tabbar .tab")
    app.locator('#tabbar [data-t="Links & Files"]').click()
    app.wait_for_function(
        "() => /recording-\\d{8}-\\d{6}\\.m4a/.test(document.querySelector('.lf-files')?.textContent || '')",
        timeout=5000,
    )
