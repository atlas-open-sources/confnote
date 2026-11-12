"""Unit tests for the transcription provider seam.

We spin up a tiny stand-in HTTP server that speaks the bits of the
OpenAI-shaped surface we use (/health, /v1/audio/transcriptions, and the
Local AI Cat recording job routes), so the shared local/remote plumbing is
exercised without a real provider.
"""

from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

sys.path.insert(0, "packages/local-app")
import server  # noqa: E402
import transcription  # noqa: E402


class _StubProvider(BaseHTTPRequestHandler):
    """Mimics Local AI Cat / OpenAI just enough for the tests."""

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"status": "ok", "service": "local-transcription-api"})
        if self.path.startswith("/v1/local/transcription/jobs/"):
            # always "completed" with text
            return self._json(
                200, {"state": "completed", "text": "recorded words", "audioPath": "/x.m4a"}
            )
        return self._json(404, {"error": "nope"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n) if n else b""
        if self.path == "/v1/audio/transcriptions":
            # confirm it's multipart and carries our file part; stash the
            # body so tests can assert on the `save` field.
            type(self).last_audio_body = raw
            ctype = self.headers.get("Content-Type", "")
            ok = "multipart/form-data" in ctype and b'name="file"' in raw and b'name="model"' in raw
            return self._json(200 if ok else 400, {"text": "hello world" if ok else ""})
        if self.path == "/v1/local/transcription/recordings":
            return self._json(202, {"id": "rec-123", "state": "recording"})
        if self.path.endswith("/stop"):
            return self._json(202, {"id": "rec-123", "state": "queued"})
        return self._json(404, {"error": "nope"})


@pytest.fixture
def stub():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), _StubProvider)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    yield base
    srv.shutdown()


def _local_cfg(base):
    return transcription.provider_cfg(
        {"transcription": {"provider": "local", "local_base_url": base, "model": "whisper-1"}}
    )


# Fake key for the remote-provider tests. A constant (not an inline string
# literal) so the secret scanner never trips, regardless of how ruff wraps
# the call sites.
_FAKE_KEY = "sk-test"  # pragma: allowlist secret


# ---------------------------------------------------------- pure helpers


def test_provider_cfg_local_vs_remote():
    loc = transcription.provider_cfg({"transcription": {"provider": "local"}})
    rem = transcription.provider_cfg(
        {"transcription": {"provider": "openai", "openai_base_url": "https://api.openai.com/"}}
    )
    assert loc["provider"] == "local"
    assert rem["provider"] == "openai"
    assert rem["base"] == "https://api.openai.com"  # trailing slash stripped


def test_multipart_has_file_and_field():
    body, ctype = transcription._multipart(
        {"model": "whisper-1"}, "file", "a.wav", b"RIFFDATA", "audio/wav"
    )
    assert ctype.startswith("multipart/form-data; boundary=")
    assert b'name="model"' in body
    assert b'name="file"; filename="a.wav"' in body
    assert b"RIFFDATA" in body


# ---------------------------------------------------------- availability


def test_availability_local_up(stub):
    out = transcription.availability(_local_cfg(stub))
    assert out["available"] is True
    assert out["can_record"] is True


def test_availability_local_down():
    cfg = _local_cfg("http://127.0.0.1:9")  # nothing there
    out = transcription.availability(cfg, timeout=1)
    assert out["available"] is False
    assert "localaicat.com" in out["detail"]


def test_availability_openai_needs_key():
    no_key = transcription.provider_cfg({"transcription": {"provider": "openai"}})
    assert transcription.availability(no_key)["available"] is False
    with_key = transcription.provider_cfg(
        {"transcription": {"provider": "openai", "api_key": _FAKE_KEY}}
    )
    out = transcription.availability(with_key)
    assert out["available"] is True
    assert out["can_record"] is False  # remote can't record


# ---------------------------------------------------------- transcribe


def test_transcribe_bytes_round_trip(stub):
    text = transcription.transcribe_bytes(_local_cfg(stub), b"AUDIO", "clip.wav", "audio/wav")
    assert text == "hello world"


def test_transcribe_bytes_raises_friendly_on_bad_base():
    cfg = _local_cfg("http://127.0.0.1:9")
    with pytest.raises(RuntimeError):
        transcription.transcribe_bytes(cfg, b"AUDIO", "clip.wav", timeout=1)


def test_local_sends_save_false_by_default(stub):
    cfg = transcription.provider_cfg(
        {"transcription": {"provider": "local", "local_base_url": stub, "model": "whisper-1"}}
    )
    assert cfg["save_history"] is False
    transcription.transcribe_bytes(cfg, b"AUDIO", "clip.wav", "audio/wav")
    body = _StubProvider.last_audio_body
    assert b'name="save"' in body
    assert b"false" in body.split(b'name="save"')[1][:40]


def test_local_sends_save_true_when_enabled(stub):
    cfg = transcription.provider_cfg(
        {
            "transcription": {
                "provider": "local",
                "local_base_url": stub,
                "model": "whisper-1",
                "save_in_cat_history": True,
            }
        }
    )
    assert cfg["save_history"] is True
    transcription.transcribe_bytes(cfg, b"AUDIO", "clip.wav", "audio/wav")
    body = _StubProvider.last_audio_body
    assert b"true" in body.split(b'name="save"')[1][:40]


def test_openai_omits_save_field(stub):
    # OpenAI has no "save" concept — we must not send it for the remote provider.
    cfg = transcription.provider_cfg(
        {"transcription": {"provider": "openai", "openai_base_url": stub, "api_key": _FAKE_KEY}}
    )
    transcription.transcribe_bytes(cfg, b"AUDIO", "clip.wav", "audio/wav")
    assert b'name="save"' not in _StubProvider.last_audio_body


# ---------------------------------------------------------- recording


def test_start_and_stop_recording(stub):
    cfg = _local_cfg(stub)
    job = transcription.start_recording(cfg)
    assert job["id"] == "rec-123"
    final = transcription.stop_recording(cfg, "rec-123", poll_timeout=5)
    assert final["text"] == "recorded words"


def test_recording_rejected_for_remote():
    cfg = transcription.provider_cfg(
        {"transcription": {"provider": "openai", "api_key": _FAKE_KEY}}
    )
    with pytest.raises(RuntimeError, match="Local AI Cat"):
        transcription.start_recording(cfg)


# --------------------------------------------- append into the note


@pytest.fixture
def tmp_vault(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    slug = "2026-01-01-test"
    (tmp_path / slug / "notes").mkdir(parents=True)
    (tmp_path / slug / "agenda.json").write_text(
        json.dumps(
            {
                "conference": {"name": "T"},
                "events": [
                    {
                        "id": "talk",
                        "title": "Talk",
                        "start": "2026-01-01T09:00:00+00:00",
                        "end": "2026-01-01T10:00:00+00:00",
                    }
                ],
                "speakers": {},
            }
        )
    )
    note = tmp_path / slug / "notes" / "0900-talk.md"
    note.write_text(
        "---\nid: talk\n---\n\n# Talk\n\n## Human notes\n\n\n## Transcript\n\n\n## Actions\n\n"
    )
    return tmp_path, slug


def test_append_transcript_writes_section_and_frontmatter(tmp_vault):
    _, slug = tmp_vault
    p = server.append_transcript(slug, "0900-talk.md", "first pass", source="local")
    _, _, secs = server.parse_note(p.read_text())
    assert "first pass" in secs["Transcript"]
    # appends, preserving prior content
    server.append_transcript(slug, "0900-talk.md", "second pass", source="local")
    _, _, secs2 = server.parse_note(p.read_text())
    assert "first pass" in secs2["Transcript"]
    assert "second pass" in secs2["Transcript"]
    fm, _, _ = server.parse_note(p.read_text())
    assert fm.get("transcript") == "local"


def test_append_transcript_ignores_empty(tmp_vault):
    _, slug = tmp_vault
    p = server.append_transcript(slug, "0900-talk.md", "   ")
    _, _, secs = server.parse_note(p.read_text())
    assert secs["Transcript"] == ""
