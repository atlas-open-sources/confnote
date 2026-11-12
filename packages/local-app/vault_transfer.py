"""Import a `.confnote` file (a `confnote.vault.v1` bundle) into the vault.

The public site's "Download notes" saves one conference as a JSON bundle of
plain files keyed by `<slug>/<path>`. `validate_bundle` ports the rules of
packages/web-app/lib/vault-transfer.ts `validateBundle` one for one (path
allowlist, size caps, agenda checks, asset and encryption shape); change both
together. `import_bundle` writes a validated bundle under the vault and never
overwrites silently: an existing conference is refused unless the caller asks
to merge its notes (old copies kept as `<note>.md.bak-<time>`) or to import it
as a copy under the next free `<slug>-N`.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import shutil
from datetime import datetime
from pathlib import Path

SCHEMA = "confnote.vault.v1"
MAX_BYTES = 2_000_000
MAX_FILES = 2000
# fullmatch everywhere: Python's `$` also matches before a trailing newline.
CONF_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+")
NOTE_RE = re.compile(r"[0-9]{4}-[a-z0-9-]+\.md")
ASSET_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
ISO_RE = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:Z|[+-][0-9]{2}:[0-9]{2})"
)
CONF_DOCS = ("agenda.json", "README.md", "speakers.md", "BRIEF.md", "DEBRIEF.md", "INBOX.md")
ENCRYPTION_KEYS = {"v", "salt", "iterations", "kdf", "verifier_iv", "verifier_ct"}
MIN_ITERATIONS = 100_000
MAX_ITERATIONS = 2_000_000
MAX_COPIES = 99
MODES = ("new", "merge", "copy")


class BundleError(ValueError):
    """The bundle is malformed or unsafe; nothing was written."""


class ImportConflict(ValueError):
    """A conference in the bundle already exists and no merge/copy was asked."""

    def __init__(self, slugs: list[str]):
        super().__init__("A conference with this name is already in your notes folder.")
        self.slugs = slugs


def _allowed(name: str) -> bool:
    parts = name.split("/")
    if len(parts) not in (2, 3) or not CONF_RE.fullmatch(parts[0]):
        return False
    if len(parts) == 2:
        return parts[1] in CONF_DOCS
    return parts[1] == "notes" and bool(NOTE_RE.fullmatch(parts[2]))


def _allowed_asset(name: str) -> bool:
    parts = name.split("/")
    if len(parts) != 5:
        return False
    slug, notes, assets, stem, filename = parts
    return (
        bool(CONF_RE.fullmatch(slug))
        and notes == "notes"
        and assets == "assets"
        and bool(NOTE_RE.fullmatch(f"{stem}.md"))
        and bool(ASSET_NAME_RE.fullmatch(filename))
        and ".." not in filename
    )


def _canonical_base64(value) -> bytes | None:
    """Decoded bytes, or None unless `value` is canonical (round-trip) base64."""
    if not isinstance(value, str):
        return None
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        return None
    return raw if base64.b64encode(raw).decode() == value else None


def _validate_encryption(meta) -> dict:
    iterations = meta.get("iterations") if isinstance(meta, dict) else None
    if (
        not isinstance(meta, dict)
        or set(meta) - ENCRYPTION_KEYS
        or meta.get("v") != 1
        or meta.get("kdf") != "PBKDF2-SHA256"
        or not isinstance(iterations, int)
        or isinstance(iterations, bool)
        or not MIN_ITERATIONS <= iterations <= MAX_ITERATIONS
    ):
        raise BundleError("Invalid private encryption parameters")
    for field, size in (("salt", 16), ("verifier_iv", 12), ("verifier_ct", 0)):
        raw = _canonical_base64(meta.get(field))
        if raw is None:
            raise BundleError("Invalid private encryption encoding")
        if (size and len(raw) != size) or (not size and not 16 <= len(raw) <= 256):
            raise BundleError("Invalid private encryption length")
    return meta


def _agenda_errors(agenda) -> list[str]:
    """Port of web-app lib/agenda.ts `validateAgenda` (errors only)."""
    if not isinstance(agenda, dict):
        return ["agenda must be a JSON object"]
    errors = []
    conf = agenda.get("conference")
    if not isinstance(conf, dict) or not conf:
        errors.append("conference is required")
    else:
        if not conf.get("name"):
            errors.append("conference.name is required")
        if not conf.get("date"):
            errors.append("conference.date is required")
    events = agenda.get("events")
    if not isinstance(events, list):
        return [*errors, "events must be an array"]
    for i, ev in enumerate(events):
        if not isinstance(ev, dict):
            errors.append(f"events[{i}] must be an object")
            continue
        for field in ("id", "title", "start", "end"):
            if not ev.get(field):
                errors.append(f"events[{i}].{field} is required")
        for field in ("start", "end"):
            value = ev.get(field)
            if value and not (isinstance(value, str) and ISO_RE.fullmatch(value)):
                errors.append(f"events[{i}].{field} must be ISO 8601 with timezone")
    return errors


def _note_file(ev: dict) -> str:
    start = ev.get("start") or ""
    return f"{start[11:13]}{start[14:16]}-{ev['id']}.md"


def _check_agenda(text: str) -> None:
    try:
        agenda = json.loads(text)
    except ValueError as e:
        raise BundleError("Invalid vault agenda") from e
    if _agenda_errors(agenda):
        raise BundleError("Invalid vault agenda")
    for field, low, high in (
        ("schedule_offset_minutes", -1440, 1440),
        ("schedule_revision", 0, None),
    ):
        value = agenda.get(field, 0)
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or value < low
            or (high is not None and value > high)
        ):
            raise BundleError("Invalid vault agenda schedule")
    targets = set()
    for ev in agenda["events"]:
        if not (ev.get("id") and ev.get("start")):
            continue
        target = _note_file(ev)
        owned = target == f"session-{ev['id']}.md" or re.fullmatch(
            r"[0-9]{4}-" + re.escape(str(ev["id"])) + r"\.md", target
        )
        if target in targets or not owned:
            raise BundleError("Invalid vault note ownership")
        targets.add(target)


def validate_bundle(value) -> dict:
    """Return the bundle if it is safe to import; raise BundleError otherwise."""
    files = value.get("files") if isinstance(value, dict) else None
    if not isinstance(files, dict) or value.get("schema_version") != SCHEMA:
        raise BundleError("Invalid vault bundle")
    size = len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())
    if len(files) > MAX_FILES or size > MAX_BYTES:
        raise BundleError("Vault bundle exceeds the import limit")
    for name, content in files.items():
        if not _allowed(name) or not isinstance(content, str):
            raise BundleError("Unsafe vault path or content")
        if name.endswith("/agenda.json"):
            _check_agenda(content)
        if f"{name.split('/')[0]}/agenda.json" not in files:
            raise BundleError("Every conference needs an agenda")
    if "assets" in value:
        assets = value["assets"]
        if not isinstance(assets, dict) or len(assets) > MAX_FILES:
            raise BundleError("Invalid vault assets")
        for name, encoded in assets.items():
            if (
                not _allowed_asset(name)
                or _canonical_base64(encoded) is None
                or f"{name.split('/')[0]}/agenda.json" not in files
            ):
                raise BundleError("Unsafe vault asset")
    if "privateEncryption" in value:
        _validate_encryption(value["privateEncryption"])
    return value


def bundle_conferences(bundle: dict) -> dict[str, dict]:
    """{slug: {"files": {rel: text}, "assets": {rel: b64}}} for a validated bundle."""
    out: dict[str, dict] = {}
    for name, text in bundle["files"].items():
        slug, rel = name.split("/", 1)
        out.setdefault(slug, {"files": {}, "assets": {}})["files"][rel] = text
    for name, encoded in (bundle.get("assets") or {}).items():
        slug, rel = name.split("/", 1)
        out[slug]["assets"][rel] = encoded
    return out


def _inside(base: Path, rel: str) -> Path:
    """`base/rel`, refusing anything that resolves outside `base` (symlinks too)."""
    base = base.resolve()
    target = (base / rel).resolve()
    if base not in target.parents:
        raise BundleError("Unsafe vault path or content")
    return target


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".import-tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def _write_bytes(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".import-tmp")
    tmp.write_bytes(raw)
    os.replace(tmp, path)


def _backup_name(path: Path, stamp: str) -> Path:
    candidate = path.with_name(f"{path.name}.bak-{stamp}")
    n = 2
    while candidate.exists():
        candidate = path.with_name(f"{path.name}.bak-{stamp}-{n}")
        n += 1
    return candidate


def free_copy_slug(base: Path, slug: str) -> str:
    for n in range(2, MAX_COPIES + 1):
        candidate = f"{slug}-{n}"
        if not (base / candidate).exists():
            return candidate
    raise BundleError("Too many copies of this conference already")


def _conference_name(conf: dict) -> str:
    try:
        return json.loads(conf["files"]["agenda.json"])["conference"]["name"]
    except (KeyError, TypeError, ValueError):
        return ""


def preview_bundle(base: Path, bundle: dict) -> list[dict]:
    """What an import would touch, per conference, without writing anything."""
    out = []
    for slug, conf in bundle_conferences(bundle).items():
        exists = (base / slug).exists()
        notes = [rel for rel in conf["files"] if rel.startswith("notes/")]
        changed = []
        if exists:
            for rel in notes:
                path = _inside(base, f"{slug}/{rel}")
                if not path.is_file() or path.read_text() != conf["files"][rel]:
                    changed.append(rel.split("/", 1)[1])
        out.append(
            {
                "slug": slug,
                "name": _conference_name(conf),
                "exists": exists,
                "notes": len(notes),
                "changed_notes": changed,
                "copy_slug": free_copy_slug(base, slug) if exists else None,
            }
        )
    return out


def _write_conference(base: Path, slug: str, conf: dict) -> dict:
    written = 0
    for rel, text in conf["files"].items():
        _write_text(_inside(base, f"{slug}/{rel}"), text)
        written += 1
    for rel, encoded in conf["assets"].items():
        _write_bytes(_inside(base, f"{slug}/{rel}"), _canonical_base64(encoded) or b"")
        written += 1
    return {"slug": slug, "written": written, "backups": []}


def _merge_conference(base: Path, slug: str, conf: dict, stamp: str) -> dict:
    """Write only notes (and new assets) that differ; never touch the agenda or docs."""
    written, backups = 0, []
    for rel, text in conf["files"].items():
        if not rel.startswith("notes/"):
            continue
        path = _inside(base, f"{slug}/{rel}")
        if path.is_file():
            if path.read_text() == text:
                continue
            backup = _backup_name(path, stamp)
            shutil.copy2(path, backup)
            backups.append(f"notes/{backup.name}")
        _write_text(path, text)
        written += 1
    for rel, encoded in conf["assets"].items():
        path = _inside(base, f"{slug}/{rel}")
        if path.exists():
            continue
        _write_bytes(path, _canonical_base64(encoded) or b"")
        written += 1
    return {"slug": slug, "written": written, "backups": backups}


def import_bundle(
    base: Path,
    value,
    mode: str = "new",
    private_config: dict | None = None,
    now: datetime | None = None,
) -> dict:
    """Validate and write `value` under `base`.

    mode "new" refuses (ImportConflict) when a conference already exists;
    "merge" writes changed notes over it, keeping `.bak-<time>` copies;
    "copy" writes it to the next free `<slug>-N` folder.
    """
    if mode not in MODES:
        raise BundleError(f"Unknown import mode: {mode}")
    bundle = validate_bundle(value)
    meta = bundle.get("privateEncryption")
    if meta is not None and private_config is not None and meta != private_config:
        raise BundleError(
            "These notes were encrypted with a different Private passphrase than this vault."
        )
    conferences = bundle_conferences(bundle)
    existing = [slug for slug in conferences if (base / slug).exists()]
    if existing and mode == "new":
        raise ImportConflict(existing)
    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    results = []
    for slug, conf in conferences.items():
        if slug not in existing:
            results.append(_write_conference(base, slug, conf))
        elif mode == "merge":
            results.append(_merge_conference(base, slug, conf, stamp))
        else:
            results.append(_write_conference(base, free_copy_slug(base, slug), conf))
    return {
        "ok": True,
        "mode": mode,
        "conferences": results,
        "private_config": meta if meta is not None and private_config is None else None,
    }
