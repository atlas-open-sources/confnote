"""Transcription provider glue — the shared local/remote seam.

Local (Local AI Cat) and remote (OpenAI) both expose the OpenAI-shaped
`POST /v1/audio/transcriptions`, so the file→text call is identical; only
base URL + bearer key + model differ. Capture differs: local can app-own
the mic via Cat's recording endpoints; remote is file-only (OpenAI has no
recording API).

stdlib-only (urllib + a hand-rolled multipart body) to keep the core
zero-dependency. The token is read from the server-side settings store and
never leaves this process.

This module is provider plumbing only — it does NOT touch the markdown
vault. server.py owns the routes + writes the result into `## Transcript`.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
import uuid


def provider_cfg(settings: dict) -> dict:
    """Flatten the transcription settings into the active provider's config."""
    tr = (settings or {}).get("transcription", {})
    provider = tr.get("provider", "local")
    if provider == "openai":
        base = (tr.get("openai_base_url") or "").rstrip("/")
    else:
        provider = "local"
        base = (tr.get("local_base_url") or "").rstrip("/")
    return {
        "provider": provider,
        "base": base,
        "key": tr.get("api_key") or "",
        "model": tr.get("model") or "whisper-1",
        "save_history": bool(tr.get("save_in_cat_history")),
    }


def availability(cfg: dict, timeout: float = 4.0) -> dict:
    """Is the provider usable right now? Local → probe /health. Remote →
    key presence (we don't burn a models call on every status poll).
    Returns {available, can_record, detail}."""
    if cfg["provider"] == "openai":
        ok = bool(cfg["key"])
        return {
            "available": ok,
            "can_record": False,  # OpenAI has no recording API
            "detail": "ready" if ok else "no API key set",
        }
    # local
    try:
        with urllib.request.urlopen(f"{cfg['base']}/health", timeout=timeout) as r:
            code = getattr(r, "status", r.getcode())
            up = 200 <= code < 300
    except Exception:
        up = False
    return {
        "available": up,
        "can_record": up,
        "detail": "ready" if up else "Local AI Cat not reachable — get it at localaicat.com",
    }


# ---------- file transcription (shared: local + remote) ----------


def _multipart(fields: dict, file_field: str, filename: str, data: bytes, mime: str):
    boundary = "----confnote" + uuid.uuid4().hex
    bb = boundary.encode()
    crlf = b"\r\n"
    out = bytearray()
    for k, v in fields.items():
        out += b"--" + bb + crlf
        out += f'Content-Disposition: form-data; name="{k}"'.encode() + crlf + crlf
        out += str(v).encode() + crlf
    out += b"--" + bb + crlf
    out += (
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"'.encode()
        + crlf
    )
    out += f"Content-Type: {mime}".encode() + crlf + crlf
    out += data + crlf
    out += b"--" + bb + b"--" + crlf
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def transcribe_bytes(
    cfg: dict,
    data: bytes,
    filename: str,
    mime: str = "application/octet-stream",
    timeout: float = 300.0,
) -> str:
    """POST audio to <base>/v1/audio/transcriptions and return the text.
    Raises RuntimeError with a friendly message on failure."""
    payload = _transcribe_request(cfg, {"response_format": "json"}, data, filename, mime, timeout)
    return (payload.get("text") or "").strip()


# A block recording runs for hours; the Cat transcribes it in one request.
SEGMENTS_TIMEOUT_S = 3600.0


def transcribe_segments(
    cfg: dict,
    data: bytes,
    filename: str,
    mime: str = "application/octet-stream",
    timeout: float = SEGMENTS_TIMEOUT_S,
) -> list[tuple[float, float, str]]:
    """Timed transcript: `verbose_json` with segment timestamps. Returns
    `[(t0, t1, text)]` in file seconds, empty when the provider sent none."""
    fields = {"response_format": "verbose_json", "timestamp_granularities[]": "segment"}
    payload = _transcribe_request(cfg, fields, data, filename, mime, timeout)
    return segments_from_payload(payload)


# Segments longer than this (median) can't place a hand-off: the Cat's last
# resort is one segment spanning the whole take, which is text, not timing.
COARSE_SEGMENT_S = 60.0


def _timed(rows, text_key: str) -> list[tuple[float, float, str]]:
    out = []
    for row in rows or []:
        try:
            t0, t1 = float(row["start"]), float(row["end"])
        except (KeyError, TypeError, ValueError):
            continue
        text = str(row.get(text_key) or "").strip()
        if text:
            out.append((t0, t1, text))
    return out


def _coarse(segs: list[tuple[float, float, str]]) -> bool:
    if len(segs) < 2:
        return True
    lengths = sorted(t1 - t0 for t0, t1, _ in segs)
    return lengths[len(lengths) // 2] > COARSE_SEGMENT_S


def segments_from_payload(payload) -> list[tuple[float, float, str]]:
    """`{segments: [{start, end, text}], words: [{word, start, end}]}` (or a
    bare segment list) → `[(t0, t1, text)]`. Coarse segments fall back to the
    word (or phrase) timings; with neither, empty, so the caller cuts at
    agenda times and says so."""
    if not isinstance(payload, dict):
        segs = _timed(payload, "text")
        return [] if _coarse(segs) else segs
    segs = _timed(payload.get("segments"), "text")
    if not _coarse(segs):
        return segs
    words = _timed(payload.get("words"), "word")
    return [] if _coarse(words) else words


def _transcribe_request(
    cfg: dict, extra: dict, data: bytes, filename: str, mime: str, timeout: float
) -> dict:
    if not cfg["base"]:
        raise RuntimeError("no transcription base URL configured")
    fields = {"model": cfg["model"], **extra}
    # Local AI Cat honours `save` (keep in Cat's history or not); OpenAI
    # ignores the unknown field. Default is off — we keep audio+transcript
    # in the conference folder, so Cat history would just duplicate it.
    if cfg.get("provider") == "local":
        fields["save"] = "true" if cfg.get("save_history") else "false"
    body, ctype = _multipart(fields, "file", filename, data, mime)
    headers = {"Content-Type": ctype}
    if cfg["key"]:
        headers["Authorization"] = "Bearer " + cfg["key"]
    req = urllib.request.Request(
        f"{cfg['base']}/v1/audio/transcriptions", data=body, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = json.loads(r.read().decode("utf-8", "replace") or "{}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:200] if hasattr(e, "read") else ""
        raise RuntimeError(f"transcription failed (HTTP {e.code}) {detail}".strip()) from None
    except Exception as e:
        raise RuntimeError(f"transcription request failed: {e}") from None
    return payload if isinstance(payload, dict) else {}


# ---------- app-owned recording (LOCAL / Cat only) ----------

_REC_ROOT = "/v1/local/transcription"


def _post(cfg: dict, path: str, timeout: float = 10.0) -> dict:
    headers = {}
    if cfg["key"]:
        headers["Authorization"] = "Bearer " + cfg["key"]
    req = urllib.request.Request(f"{cfg['base']}{path}", data=b"", headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace") or "{}")


def _get(cfg: dict, path: str, timeout: float = 10.0) -> dict:
    headers = {}
    if cfg["key"]:
        headers["Authorization"] = "Bearer " + cfg["key"]
    req = urllib.request.Request(f"{cfg['base']}{path}", headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace") or "{}")


def start_recording(cfg: dict) -> dict:
    """Begin a Cat app-owned recording. Returns the job snapshot ({id, ...})."""
    if cfg["provider"] != "local":
        raise RuntimeError("recording is only supported via Local AI Cat")
    return _post(cfg, f"{_REC_ROOT}/recordings")


def stop_recording(cfg: dict, rec_id: str, poll_timeout: float = 300.0) -> dict:
    """Stop the recording, then poll the job until it completes. Returns the
    final job snapshot (with `text`, `audioPath`)."""
    if cfg["provider"] != "local":
        raise RuntimeError("recording is only supported via Local AI Cat")
    _post(cfg, f"{_REC_ROOT}/recordings/{rec_id}/stop")
    deadline = time.monotonic() + poll_timeout
    while time.monotonic() < deadline:
        job = _get(cfg, f"{_REC_ROOT}/jobs/{rec_id}")
        state = job.get("state")
        if state == "completed":
            return job
        if state in ("failed", "cancelled"):
            raise RuntimeError(f"recording {state}: {job.get('errorMessage') or ''}".strip())
        time.sleep(1.0)
    raise RuntimeError("recording transcription timed out")
