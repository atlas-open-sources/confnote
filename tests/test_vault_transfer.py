"""`.confnote` import: bundle validation (the TS rules, ported) and the vault writes."""

from __future__ import annotations

import base64
import json
import socket
import sys
import threading
import urllib.error
import urllib.request
from datetime import datetime
from http.server import ThreadingHTTPServer

import pytest

sys.path.insert(0, "packages/local-app")
import server  # noqa: E402
import vault_transfer as vt  # noqa: E402

SLUG = "2026-11-05-demo-conf"
AGENDA = {
    "conference": {"name": "Demo", "date": "2026-11-05"},
    "events": [
        {
            "id": "keynote",
            "title": "Keynote",
            "start": "2026-11-05T09:00:00+08:00",
            "end": "2026-11-05T09:30:00+08:00",
        },
        {
            "id": "lunch",
            "title": "Lunch",
            "start": "2026-11-05T12:00:00+08:00",
            "end": "2026-11-05T13:00:00+08:00",
        },
    ],
}
NOW = datetime(2026, 11, 5, 14, 30, 0)


def bundle(files=None, **extra):
    return {
        "schema_version": "confnote.vault.v1",
        "files": {f"{SLUG}/agenda.json": json.dumps(AGENDA), **(files or {})},
        **extra,
    }


# ---------- validate_bundle ----------


def test_accepts_agenda_docs_and_notes():
    ok = bundle({f"{SLUG}/README.md": "# Demo\n", f"{SLUG}/notes/0900-keynote.md": "# Keynote\n"})
    assert vt.validate_bundle(ok) is ok


@pytest.mark.parametrize(
    "name",
    [
        f"{SLUG}/../evil.md",
        f"{SLUG}/notes/../../evil.md",
        f"{SLUG}/notes/sub/0900-keynote.md",
        f"../{SLUG}/README.md",
        f"/{SLUG}/README.md",
        f"{SLUG}/notes/0900-keynote.md.bak",
        f"{SLUG}/notes/0900-keynote.md\n",
        f"{SLUG}/notes/.hidden.md",
        f"{SLUG}/secrets.env",
        f"{SLUG}/.confnote/private.json",
        f"{SLUG}\n/README.md",
        "not-a-slug/README.md",
        "2026-11-05-déjà/README.md",
    ],
)
def test_refuses_unsafe_paths(name):
    with pytest.raises(vt.BundleError):
        vt.validate_bundle(bundle({name: "x"}))


def test_refuses_wrong_schema_non_string_and_missing_agenda():
    with pytest.raises(vt.BundleError, match="Invalid vault bundle"):
        vt.validate_bundle({"schema_version": "confnote.vault.v2", "files": {}})
    with pytest.raises(vt.BundleError, match="Invalid vault bundle"):
        vt.validate_bundle([])
    with pytest.raises(vt.BundleError, match="Unsafe"):
        vt.validate_bundle(bundle({f"{SLUG}/README.md": 42}))
    with pytest.raises(vt.BundleError, match="needs an agenda"):
        vt.validate_bundle({"schema_version": vt.SCHEMA, "files": {f"{SLUG}/README.md": "x"}})


def test_refuses_invalid_agenda_and_shared_note_owner():
    bad = {"conference": {"name": "Demo"}, "events": []}
    with pytest.raises(vt.BundleError, match="Invalid vault agenda"):
        vt.validate_bundle(
            {"schema_version": vt.SCHEMA, "files": {f"{SLUG}/agenda.json": json.dumps(bad)}}
        )
    with pytest.raises(vt.BundleError, match="Invalid vault agenda"):
        vt.validate_bundle({"schema_version": vt.SCHEMA, "files": {f"{SLUG}/agenda.json": "{"}})
    twice = {**AGENDA, "events": [AGENDA["events"][0], AGENDA["events"][0]]}
    with pytest.raises(vt.BundleError, match="ownership"):
        vt.validate_bundle(
            {"schema_version": vt.SCHEMA, "files": {f"{SLUG}/agenda.json": json.dumps(twice)}}
        )


def test_refuses_oversized_bundle():
    with pytest.raises(vt.BundleError, match="import limit"):
        vt.validate_bundle(bundle({f"{SLUG}/README.md": "x" * vt.MAX_BYTES}))


def test_assets_and_encryption_shape():
    png = base64.b64encode(b"png").decode()
    ok = bundle(assets={f"{SLUG}/notes/assets/0900-keynote/slide.png": png})
    assert vt.validate_bundle(ok)
    for name in (
        f"{SLUG}/notes/assets/0900-keynote/../x.png",
        f"{SLUG}/notes/assets/0900-keynote/.x.png",
    ):
        with pytest.raises(vt.BundleError, match="Unsafe vault asset"):
            vt.validate_bundle(bundle(assets={name: png}))
    with pytest.raises(vt.BundleError, match="Unsafe vault asset"):
        vt.validate_bundle(bundle(assets={f"{SLUG}/notes/assets/0900-keynote/a.png": "@@"}))
    with pytest.raises(vt.BundleError, match="encryption"):
        vt.validate_bundle(bundle(privateEncryption={"v": 1, "kdf": "MD5"}))


# ---------- import_bundle ----------


def test_import_new_writes_plain_files(tmp_path):
    note = "---\nsession: Keynote\n---\n\n# Keynote\n\n## Human notes\n\nhello from the browser\n"
    result = vt.import_bundle(tmp_path, bundle({f"{SLUG}/notes/0900-keynote.md": note}))
    assert result["conferences"] == [{"slug": SLUG, "written": 2, "backups": []}]
    assert (tmp_path / SLUG / "notes" / "0900-keynote.md").read_text() == note
    assert json.loads((tmp_path / SLUG / "agenda.json").read_text()) == AGENDA


def test_import_refuses_existing_conference_without_a_choice(tmp_path):
    (tmp_path / SLUG / "notes").mkdir(parents=True)
    (tmp_path / SLUG / "notes" / "0900-keynote.md").write_text("mine")
    with pytest.raises(vt.ImportConflict) as conflict:
        vt.import_bundle(tmp_path, bundle({f"{SLUG}/notes/0900-keynote.md": "theirs"}))
    assert conflict.value.slugs == [SLUG]
    assert (tmp_path / SLUG / "notes" / "0900-keynote.md").read_text() == "mine"
    assert not (tmp_path / SLUG / "agenda.json").exists()


def test_merge_writes_only_changed_notes_and_keeps_backups(tmp_path):
    notes = tmp_path / SLUG / "notes"
    notes.mkdir(parents=True)
    (tmp_path / SLUG / "agenda.json").write_text("local agenda")
    (notes / "0900-keynote.md").write_text("old keynote")
    (notes / "1200-lunch.md").write_text("same lunch")
    incoming = bundle(
        {
            f"{SLUG}/README.md": "incoming readme",
            f"{SLUG}/notes/0900-keynote.md": "new keynote",
            f"{SLUG}/notes/1200-lunch.md": "same lunch",
        }
    )
    result = vt.import_bundle(tmp_path, incoming, "merge", now=NOW)
    assert result["conferences"] == [
        {"slug": SLUG, "written": 1, "backups": ["notes/0900-keynote.md.bak-20261105-143000"]}
    ]
    assert (notes / "0900-keynote.md").read_text() == "new keynote"
    assert (notes / "0900-keynote.md.bak-20261105-143000").read_text() == "old keynote"
    assert (tmp_path / SLUG / "agenda.json").read_text() == "local agenda"
    assert not (tmp_path / SLUG / "README.md").exists()
    assert sorted(p.name for p in notes.iterdir()) == [
        "0900-keynote.md",
        "0900-keynote.md.bak-20261105-143000",
        "1200-lunch.md",
    ]
    # a second merge in the same second never overwrites the first backup
    vt.import_bundle(tmp_path, bundle({f"{SLUG}/notes/0900-keynote.md": "newer"}), "merge", now=NOW)
    assert (notes / "0900-keynote.md.bak-20261105-143000").read_text() == "old keynote"
    assert (notes / "0900-keynote.md.bak-20261105-143000-2").read_text() == "new keynote"


def test_copy_imports_under_the_next_free_slug(tmp_path):
    (tmp_path / SLUG).mkdir()
    (tmp_path / f"{SLUG}-2").mkdir()
    result = vt.import_bundle(tmp_path, bundle({f"{SLUG}/notes/0900-keynote.md": "x"}), "copy")
    assert result["conferences"][0]["slug"] == f"{SLUG}-3"
    assert (tmp_path / f"{SLUG}-3" / "notes" / "0900-keynote.md").read_text() == "x"
    assert list((tmp_path / SLUG).iterdir()) == []


def test_import_refuses_a_symlinked_conference_folder(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / SLUG).symlink_to(outside)
    with pytest.raises(vt.BundleError):
        vt.import_bundle(vault, bundle({f"{SLUG}/notes/0900-keynote.md": "x"}), "merge")
    assert list(outside.iterdir()) == []


def test_import_refuses_a_different_private_passphrase(tmp_path):
    meta = {
        "v": 1,
        "kdf": "PBKDF2-SHA256",
        "iterations": 200000,
        "salt": base64.b64encode(b"s" * 16).decode(),
        "verifier_iv": base64.b64encode(b"i" * 12).decode(),
        "verifier_ct": base64.b64encode(b"c" * 32).decode(),
    }
    other = {**meta, "salt": base64.b64encode(b"t" * 16).decode()}
    with pytest.raises(vt.BundleError, match="different Private passphrase"):
        vt.import_bundle(tmp_path, bundle(privateEncryption=meta), private_config=other)
    result = vt.import_bundle(tmp_path, bundle(privateEncryption=meta))
    assert result["private_config"] == meta


def test_preview_lists_changed_notes(tmp_path):
    notes = tmp_path / SLUG / "notes"
    notes.mkdir(parents=True)
    (notes / "0900-keynote.md").write_text("old")
    preview = vt.preview_bundle(
        tmp_path,
        bundle({f"{SLUG}/notes/0900-keynote.md": "new", f"{SLUG}/notes/1200-lunch.md": "x"}),
    )
    assert preview == [
        {
            "slug": SLUG,
            "name": "Demo",
            "exists": True,
            "notes": 2,
            "changed_notes": ["0900-keynote.md", "1200-lunch.md"],
            "copy_slug": f"{SLUG}-2",
        }
    ]


# ---------- POST /api/import ----------


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    httpd = ThreadingHTTPServer(("127.0.0.1", port), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"127.0.0.1:{port}", tmp_path
    finally:
        httpd.shutdown()
        thread.join(timeout=3)


def _import(host, payload, origin=None, header="1", host_header=None):
    headers = {"Content-Type": "application/json", "Origin": origin or f"http://{host}"}
    if host_header:
        headers["Host"] = host_header
    if header:
        headers["X-Confnote-Request"] = header
    req = urllib.request.Request(
        f"http://{host}/api/import",
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def test_api_import_flow(api):
    host, vault = api
    first = bundle({f"{SLUG}/notes/0900-keynote.md": "v1"})
    code, body = _import(host, {"bundle": first, "mode": "check"})
    assert code == 200 and body["conferences"][0]["exists"] is False
    assert not (vault / SLUG).exists()
    assert _import(host, {"bundle": first})[0] == 200
    code, body = _import(host, {"bundle": bundle({f"{SLUG}/notes/0900-keynote.md": "v2"})})
    assert code == 409 and body["slugs"] == [SLUG]
    assert body["conferences"][0]["changed_notes"] == ["0900-keynote.md"]
    second = bundle({f"{SLUG}/notes/0900-keynote.md": "v2"})
    code, body = _import(host, {"bundle": second, "mode": "merge"})
    assert code == 200 and body["conferences"][0]["backups"]
    assert (vault / SLUG / "notes" / "0900-keynote.md").read_text() == "v2"


def test_api_import_refuses_cross_site_and_bad_bundles(api):
    host, vault = api
    payload = {"bundle": bundle()}
    assert _import(host, payload, origin="https://evil.example")[0] == 403
    assert _import(host, payload, header=None)[0] == 403
    # DNS rebinding: evil.example resolved to 127.0.0.1, so Host and Origin agree
    rebound = "evil.example:8787"
    assert _import(host, payload, origin=f"http://{rebound}", host_header=rebound)[0] == 403
    code, body = _import(host, {"bundle": bundle({f"{SLUG}/../x.md": "x"})})
    assert code == 400 and "Unsafe" in body["error"]
    assert _import(host, {"bundle": bundle(), "mode": "overwrite"})[0] == 400
    assert list(vault.iterdir()) == []


# ---------- shared-vault content stays inert ----------


@pytest.mark.parametrize(
    "extra",
    [
        {"schedule_offset_minutes": '"><img src=x onerror=alert(1)>'},
        {"schedule_offset_minutes": 5000},
        {"schedule_offset_minutes": True},
        {"schedule_revision": "1"},
        {"schedule_revision": -1},
    ],
)
def test_refuses_a_schedule_that_is_not_a_bounded_integer(extra):
    # An agenda with no events skips effective_event's offset check, so the
    # bundle check must hold on its own.
    agenda = {**AGENDA, "events": [], **extra}
    with pytest.raises(vt.BundleError, match="schedule"):
        vt.validate_bundle(
            {"schema_version": vt.SCHEMA, "files": {f"{SLUG}/agenda.json": json.dumps(agenda)}}
        )


def test_conference_payload_only_hands_the_ui_integer_schedule_fields(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    (tmp_path / SLUG / "notes").mkdir(parents=True)
    agenda = {
        **AGENDA,
        "events": [],
        "schedule_offset_minutes": '"><img src=x>',
        "schedule_revision": "x",
    }
    (tmp_path / SLUG / "agenda.json").write_text(json.dumps(agenda))
    payload = server.conference_payload(SLUG)
    assert payload["schedule_offset_minutes"] == 0
    assert payload["schedule_revision"] == 0


def test_note_assets_are_served_sandboxed(api):
    host, base = api
    assets = base / SLUG / "notes" / "assets" / "0900-keynote"
    assets.mkdir(parents=True)
    (assets / "x.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')
    (assets / "slides.pdf").write_bytes(b"%PDF-1.4\n")
    url = f"http://{host}/assets?slug={SLUG}&path=assets/0900-keynote/"
    with urllib.request.urlopen(url + "x.svg", timeout=5) as r:
        assert r.headers["Content-Type"] == "image/svg+xml"
        assert r.headers["Content-Security-Policy"].startswith("sandbox;")
        assert r.headers["X-Content-Type-Options"] == "nosniff"
    with urllib.request.urlopen(url + "slides.pdf", timeout=5) as r:
        assert r.headers.get("Content-Security-Policy") is None
        assert r.headers["X-Content-Type-Options"] == "nosniff"
