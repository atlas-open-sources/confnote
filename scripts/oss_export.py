"""Export a committed revision with an explicit denylist; never publish anything."""

import argparse
import json
import os
import re
import stat
import subprocess
from pathlib import Path, PurePosixPath

PROPRIETARY = ("tldraw", "bryntum", "ag-grid", "ag_grid", "aggrid")
# AG Grid Community is MIT: exactly these reviewed Grids files ship. Anything
# else under the module (a stray enterprise bundle, say) stays excluded.
OPEN_VENDOR_SLOTS = {"aggrid"}
OPEN_VENDOR_FILES = frozenset(
    {
        "packages/core-ui/static/modules/aggrid/aggrid.js",
        "packages/core-ui/static/modules/aggrid/aggrid.css",
        "packages/core-ui/static/modules/aggrid/manifest.json",
        "packages/core-ui/static/modules/aggrid/vendor/ag-grid-community.min.js",
        "packages/core-ui/static/modules/aggrid/vendor/license.txt",
        "packages/core-ui/static/modules/aggrid/vendor/readme.md",
        "packages/core-ui/static/modules/aggrid/vendor/ag-charts-community.min.js",
        "packages/core-ui/static/modules/aggrid/vendor/license-ag-charts.txt",
        "licenses/vendor/ag-grid-community-mit.txt",
        "licenses/vendor/ag-charts-community-mit.txt",
        "tests/test_aggrid_module.py",
    }
)
# Bryntum is proprietary, but the Planner module around it is ours: these
# reviewed files ship. Bryntum's built bundle (modules/bryntum/vendor/) and the
# gitignored licence key never do: `make bryntum` builds the bundle from
# Bryntum's public npm trial package (pinned lockfile), so the slot stays on.
BUILT_AT_INSTALL_SLOTS = {"bryntum"}
OWN_MODULE_FILES = frozenset(
    {
        "packages/core-ui/static/modules/bryntum/bryntum.js",
        "packages/core-ui/static/modules/bryntum/bryntum.css",
        "packages/core-ui/static/modules/bryntum/plan-map.js",
        "packages/core-ui/static/modules/bryntum/manifest.json",
        "packages/core-ui/static/modules/bryntum/readme.md",
        "packages/core-ui/static/modules/bryntum/license.local.js.example",
        "packages/core-ui/static/modules/bryntum/build/.npmrc",
        "packages/core-ui/static/modules/bryntum/build/esbuild.mjs",
        "packages/core-ui/static/modules/bryntum/build/package.json",
        "packages/core-ui/static/modules/bryntum/build/package-lock.json",
        "packages/core-ui/static/modules/bryntum/build/write-license.mjs",
        "packages/core-ui/static/modules/bryntum/build/src/island.js",
        "packages/core-ui/static/modules/bryntum/build/src/island.css",
        "tests/test_bryntum_registration.py",
        "tests/test_bryntum_plan_map.py",
        "tests/e2e/test_bryntum_module.py",
    }
)
REVIEWED_FILES = OPEN_VENDOR_FILES | OWN_MODULE_FILES
LICENCE_KEY_FILES = {"license.local.js"}
EXPORT_README_NOTE = """
## Sponsor modules in this export

This tree is a clean export of the confnote source (`OSS-EXPORT-MANIFEST.json` lists every file).

- **Grids (AG Grid, Module 1)** ships whole and is on by default: our module in
  `packages/core-ui/static/modules/aggrid/` and the unmodified AG Grid Community bundle (MIT) in its `vendor/`
  folder. `vendor/README.md` names the npm package version (`ag-grid-community`) and its hashes.
- **Planner (Bryntum, Module 2)** is on by default: our module ships in `packages/core-ui/static/modules/bryntum/`
  (`bryntum.js`, `bryntum.css`, the `build/` scripts) with its tests. Bryntum's own bundle is commercial, so it is not
  in this export: `make bryntum` builds it from Bryntum's public trial package (`@bryntum/calendar-trial` on npmjs, no
  login). It runs `npm ci --ignore-scripts` from the committed lockfile (exact version and integrity hash, no install
  scripts) in `packages/core-ui/static/modules/bryntum/build`, then `npm run build` there, which writes `vendor/`.
  The web build (`packages/web-app`, `npm run build`) does the same on its own.
  Without a licence key Bryntum runs in trial mode with a watermark. A key goes only in the gitignored
  `license.local.js` (see `license.local.js.example` and `build/write-license.mjs`), never in git.
- The Sketch module (tldraw) is not part of this export.
"""
PRIVATE_COMPONENTS = {
    ".git",
    ".claude",
    ".codex",
    ".agents",
    ".vercel",
    ".repos",
    ".venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    "dist",
    "build",
    "artifacts",
    "reports",
    "reviews",
    "feedback",
    "personal",
    "personal-notes",
    "notes",
    "vaults",
}
INTERNAL_DOCS = ("docs/internal/",)
INTERNAL_FILES = {
    "data/ai-engineer-worldsfair-2026/speakers.json",
    "data/ai-engineer-worldsfair-2026/llms.md",
}


def drop_reason(name: str, mode: str = "100644") -> str | None:
    path = PurePosixPath(name)
    parts = tuple(part.lower() for part in path.parts)
    lower = name.lower()
    if (
        path.is_absolute()
        or ".." in parts
        or not parts
        or "\\" in name
        or any(ord(char) < 32 for char in name)
    ):
        return "unsafe path"
    if mode not in {"100644", "100755"}:
        return "symlink or non-regular git entry"
    if parts[-1] in LICENCE_KEY_FILES:
        return "licence key file"
    if lower in REVIEWED_FILES:
        return None
    if any(part in PRIVATE_COMPONENTS for part in parts):
        return "private or generated directory"
    if lower.startswith(INTERNAL_DOCS) or lower in INTERNAL_FILES:
        return "internal documentation or personal source"
    if any(token in lower for token in PROPRIETARY):
        return "excluded vendor module or its private planning/test fixture"
    if any("mochirouter" in part or part.startswith(("feedback-", "personal-")) for part in parts):
        return "internal project or personal notes"
    if any(part.startswith(".env") for part in parts):
        return "environment file"
    if re.search(
        r"(?:^|/)(?:auth\.json|credentials[^/]*|id_rsa[^/]*|id_ed25519[^/]*|[^/]+\.(?:pem|key|p12|pfx))$",
        lower,
    ):
        return "credential material"
    return None


def git(repo: Path, *args: str) -> bytes:
    # Hooks may export GIT_DIR/GIT_INDEX_FILE; an explicit repo must stay isolated.
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    return subprocess.check_output(["git", "-C", str(repo), *args], env=environment)


def inventory(repo: Path) -> tuple[str, list[tuple[str, str, str | None]]]:
    revision = git(repo, "rev-parse", "HEAD").decode().strip()
    rows = []
    for entry in git(repo, "ls-tree", "-r", "-z", revision).split(b"\0"):
        if not entry:
            continue
        metadata, raw_name = entry.split(b"\t", 1)
        mode, _kind, object_id = metadata.decode().split()
        name = raw_name.decode("utf8")
        rows.append((name, object_id, drop_reason(name, mode)))
    return revision, rows


def new_destination(destination: Path, repo: Path) -> Path:
    destination = destination.absolute()
    for parent in [destination, *destination.parents]:
        if parent.is_symlink():
            raise ValueError("destination or ancestor is a symlink")
    destination = destination.resolve(strict=False)
    if destination.exists():
        raise ValueError("destination must not exist; exports never overwrite")
    if not destination.parent.is_dir():
        raise ValueError("destination parent must already exist")
    if destination == repo or repo in destination.parents:
        raise ValueError("destination must be outside the source repository")
    return destination


def export(repo: Path, destination: Path | None, dry_run: bool) -> dict:
    repo = repo.resolve()
    revision, rows = inventory(repo)
    if destination is not None:
        destination = new_destination(destination, repo)
    if not dry_run and destination is None:
        raise ValueError("choose a new destination or use --dry-run")
    kept = [name for name, _, reason in rows if reason is None]
    dropped = {name: reason for name, _, reason in rows if reason is not None}
    for name, _, reason in rows:
        print(f"DROP {name} — {reason}" if reason else f"KEEP {name}")
    manifest = {"revision": revision, "kept": kept, "dropped": dropped, "network": "none"}
    if dry_run:
        return manifest
    destination.mkdir(mode=0o700)
    for name, object_id, reason in rows:
        if reason:
            continue
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        data = git(repo, "cat-file", "blob", object_id)
        # The OSS runtime starts without proprietary slots even from an older source tree.
        if name.endswith("modules.config.json"):
            config = json.loads(data)
            config["slots"] = [
                slot
                for slot in config.get("slots", [])
                if slot not in PROPRIETARY
                or slot in OPEN_VENDOR_SLOTS
                or slot in BUILT_AT_INSTALL_SLOTS
            ]
            config["_comment"] = (
                "OSS export: excluded vendor modules are not enabled. The Planner (bryntum) "
                "builds Bryntum's bundle with `make bryntum`; see README.md."
            )
            data = (json.dumps(config, indent=2) + "\n").encode()
        if name == "README.md":
            data = data.rstrip(b"\n") + b"\n" + EXPORT_README_NOTE.encode()
        if name == "data/ai-engineer-worldsfair-2026/sessions.json":
            schedule = json.loads(data)
            for session in schedule.get("sessions", []):
                session.pop("description", None)
            data = (json.dumps(schedule, indent=2, ensure_ascii=False) + "\n").encode()
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        descriptor = os.open(target, flags, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
        mode = git(repo, "ls-tree", revision, "--", name).split(b" ", 1)[0]
        if mode == b"100755":
            target.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    with (destination / "OSS-EXPORT-MANIFEST.json").open("x") as stream:
        public_manifest = {
            "revision": revision,
            "kept": kept,
            "excluded_count": len(dropped),
            "transformations": [
                "disabled excluded vendor slots",
                "removed raw World Fair session descriptions",
                "added the sponsor-module section to README.md",
            ],
            "network": "none",
        }
        json.dump(public_manifest, stream, indent=2)
        stream.write("\n")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", nargs="?", type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    try:
        result = export(repo, args.destination, args.dry_run)
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"Export refused: {exc}\n")
    print(
        f"Revision {result['revision']}: {len(result['kept'])} kept, {len(result['dropped'])} dropped; no publication performed."
    )


if __name__ == "__main__":
    main()
