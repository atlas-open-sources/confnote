"""Planner (bryntum) module registration: Module 2, lazy bundle built at install, never committed or exported."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
STATIC = REPO / "packages/core-ui/static"
MODULE_DIR = STATIC / "modules/bryntum"
# The clean OSS export ships this test without a git history.
IN_OSS_EXPORT = (REPO / "OSS-EXPORT-MANIFEST.json").is_file()


def _slots() -> list[str]:
    return json.loads((STATIC / "modules.config.json").read_text()).get("slots") or []


def test_bryntum_registration_contract():
    manifest = json.loads((MODULE_DIR / "manifest.json").read_text())
    assert manifest["id"] == "bryntum"
    assert (MODULE_DIR / manifest["entry"]).is_file()
    assert _slots().index("bryntum") == 1, "the Planner is Module 2"
    build = json.loads((MODULE_DIR / "build/package.json").read_text())
    assert build["dependencies"]["@bryntum/calendar"].startswith("npm:@bryntum/calendar-trial@"), (
        "the bundle builds from Bryntum's public npm trial package"
    )
    assert not {"preinstall", "install", "postinstall", "prepare"} & set(build["scripts"]), (
        "the bundle builds in an explicit step, never an install hook"
    )
    lock = json.loads((MODULE_DIR / "build/package-lock.json").read_text())
    pinned = {**build["dependencies"], **build["devDependencies"]}
    assert not [
        spec for spec in pinned.values() if spec[0] in "^~*" or "@^" in spec or "@~" in spec
    ]
    for name, entry in lock["packages"].items():
        if name:
            assert entry["resolved"].startswith("https://registry.npmjs.org/"), name
            assert entry["integrity"].startswith("sha512-"), name
    trial = lock["packages"]["node_modules/@bryntum/calendar"]
    assert trial["resolved"].endswith("/calendar-trial-" + trial["version"] + ".tgz")
    assert "registry.npmjs.org" in (MODULE_DIR / "build/.npmrc").read_text()
    oss_export = (REPO / "scripts/oss_export.py").read_text()
    assert '"bryntum"' in oss_export, "the OSS export must exclude the bryntum module"
    gitignore = (REPO / ".gitignore").read_text()
    assert "packages/core-ui/static/modules/bryntum/license.local.js" in gitignore
    assert "packages/core-ui/static/modules/bryntum/vendor/" in gitignore
    assert "packages/core-ui/static/modules/bryntum/build/package-lock.json" not in gitignore
    makefile = (REPO / "Makefile").read_text()
    assert "npm ci --ignore-scripts" in makefile
    web_build = (REPO / "packages/web-app/scripts/build-static.mjs").read_text()
    assert '"ci", "--ignore-scripts"' in web_build


def test_core_never_names_bryntum():
    for core in ("app.js", "drawer.js", "index.html"):
        assert "bryntum" not in (STATIC / core).read_text().lower(), core


@pytest.mark.skipif(IN_OSS_EXPORT, reason="the OSS export has no git history")
def test_licence_key_is_not_committed():
    """Only the placeholder example is tracked; the real file is gitignored."""
    example = (MODULE_DIR / "license.local.js.example").read_text()
    assert "YOUR-BRYNTUM-LICENSE-KEY" in example
    tracked = subprocess.run(
        ["git", "-C", str(REPO), "ls-files", "--", "packages/core-ui/static/modules/bryntum"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    assert tracked, "the module itself is tracked"
    assert not [name for name in tracked if name.endswith("license.local.js")]
    assert not [name for name in tracked if "/bryntum/vendor/" in name], (
        "Bryntum's trial bundle is never committed"
    )


def _load_exporter():
    spec = importlib.util.spec_from_file_location("oss_export", REPO / "scripts/oss_export.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.skipif(IN_OSS_EXPORT, reason="the OSS export has no git history")
def test_oss_allowlist_names_every_module_file_outside_vendor():
    tracked = subprocess.run(
        ["git", "-C", str(REPO), "ls-files", "--", "packages/core-ui/static/modules/bryntum"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()
    ours = {name.lower() for name in tracked if "/bryntum/vendor/" not in name}
    assert ours <= _load_exporter().OWN_MODULE_FILES


def test_oss_export_ships_module_code_and_slot_but_not_bryntum_bundle(tmp_path):
    """Run a real export over a committed tree that carries the module."""
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    source = tmp_path / "source"
    files = {
        "README.md": "public",
        "packages/core-ui/static/modules.config.json": json.dumps(
            {"slots": ["module-1", "bryntum", "tldraw", "chat"]}
        ),
        "packages/core-ui/static/modules/bryntum/bryntum.js": "ours",
        "packages/core-ui/static/modules/bryntum/vendor/bryntum-island.bundle.js": "proprietary",
        "packages/core-ui/static/modules/bryntum/build/esbuild.mjs": "ours",
        "packages/core-ui/static/modules/module-1/module-1.js": "public",
    }
    for name, text in files.items():
        (source / name).parent.mkdir(parents=True, exist_ok=True)
        (source / name).write_text(text)
    git = ["git", "-C", str(source)]
    subprocess.run(["git", "init", "-q", str(source)], check=True, env=env)
    subprocess.run([*git, "add", "--", *files], check=True, env=env)
    subprocess.run(
        [*git, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test"]
        + ["commit", "-qm", "fixture"],
        check=True,
        env=env,
    )

    destination = tmp_path / "export"
    with contextlib.redirect_stdout(io.StringIO()):
        _load_exporter().export(source, destination, False)

    exported = [p.relative_to(destination).as_posix() for p in destination.rglob("*")]
    assert "packages/core-ui/static/modules/module-1/module-1.js" in exported
    assert "packages/core-ui/static/modules/bryntum/bryntum.js" in exported
    assert "packages/core-ui/static/modules/bryntum/build/esbuild.mjs" in exported
    assert not [name for name in exported if "/vendor" in name]
    config = json.loads((destination / "packages/core-ui/static/modules.config.json").read_text())
    assert "bryntum" in config["slots"]
