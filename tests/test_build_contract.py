"""Build inputs are shared and the headless path must not install/probe identities."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]


def test_web_build_has_one_authoritative_static_source():
    assert not (REPO / "packages/web-app/core-ui-static").exists()
    script = (REPO / "packages/web-app/scripts/build-static.mjs").read_text()
    assert '"core-ui", "static"' in script
    assert '"catalogue-web", "static"' in script
    assert 'slots: [...shippedVendorSlots, "chat"]' in script


def test_headless_build_has_explicit_safe_mode_and_pins():
    script = (REPO / "packages/local-app/build-macos.sh").read_text()
    guard = script.split("sanitize_bundle_tag", 1)[0]
    for line in ['CONFNOTE_SIGN_ID=""', "ALLOW_ADHOC=1", "NO_INSTALL=1", 'NOTARIZE=""']:
        assert line in guard
    assert '-r "$DIR/requirements.lock"' in script
    for vendor in ["tldraw", "bryntum"]:
        assert f"--exclude 'modules/{vendor}/'" in script
    # AG Grid Community (MIT) ships in the Mac app, as in the OSS export.
    excludes = [line for line in script.splitlines() if "--exclude" in line or "not in {" in line]
    assert excludes
    assert not [line for line in excludes if "aggrid" in line or "ag-grid" in line]


NOTICES = ["ATTRIBUTION.md", "LICENSE", "confs-tech-LICENSE", "geonames-sources.json"]


@pytest.mark.parametrize("parent_layout", [False, True])
def test_mac_catalogue_staging_preserves_notices(tmp_path, parent_layout):
    source = tmp_path / "data" / "dist"
    source.mkdir(parents=True)
    (source / "index.json").write_text('{"events": []}')
    for name in NOTICES:
        ((source.parent if parent_layout else source) / name).write_text(name)
    stage = tmp_path / "stage"
    script = (REPO / "packages/local-app/build-macos.sh").read_text()
    staging = script.split("# A distribution build supplies", 1)[1].split(
        "# The default OSS artifact", 1
    )[0]
    # Execute the actual staging block without installing dependencies or packaging an app.
    staging = staging[staging.index("if [") :]
    subprocess.run(
        ["bash", "-eu", "-c", staging],
        env={**os.environ, "CONFNOTE_CATALOGUE_DIR": str(source), "STATIC_STAGE": str(stage)},
        check=True,
    )
    for name in ["index.json", *NOTICES]:
        assert (stage / "catalogue" / name).read_text() == (
            source / name if (source / name).exists() else source.parent / name
        ).read_text()
    for notice in [
        "$REPO/LICENSE:.",
        "$REPO/NOTICE:.",
        "$REPO/licenses:licenses",
        "$REPO/packages/events-model/LICENSE:packages/events-model",
    ]:
        assert f'--add-data "{notice}"' in script


@pytest.mark.parametrize(
    ("parent_layout", "bryntum_key", "tldraw", "bryntum"),
    [
        (False, "", "", ""),
        (True, "", "", ""),
        (False, "build-time-key", "", ""),
        (False, "", "1", ""),
        (False, "", "", "0"),
    ],
)
def test_web_distribution_preserves_notices(tmp_path, parent_layout, bryntum_key, tldraw, bryntum):
    web = tmp_path / "packages/web-app"
    (web / "scripts").mkdir(parents=True)
    shutil.copyfile(
        REPO / "packages/web-app/scripts/build-static.mjs", web / "scripts/build-static.mjs"
    )
    static = tmp_path / "packages/core-ui/static"
    static.mkdir(parents=True)
    (static / "index.html").write_text('<script src="/app.js"></script>')
    for vendor in ["tldraw", "ag-grid", "aggrid", "bryntum"]:
        module = static / "modules" / vendor
        module.mkdir(parents=True)
        (module / "manifest.json").write_text("{}")
        (module / "module.js").write_text(vendor)
        (module / "build").mkdir()
        (module / "build" / "esbuild.mjs").write_text("bundle sources")
    shutil.copyfile(
        REPO / "packages/core-ui/static/modules/bryntum/build/write-license.mjs",
        static / "modules/bryntum/build/write-license.mjs",
    )
    # A built bundle is present, so the web build does not npm install Bryntum here.
    (static / "modules/bryntum/vendor").mkdir()
    (static / "modules/bryntum/vendor/bryntum-island.bundle.js").write_text("trial bundle")
    # A developer's local key file never ships without the build-time env.
    (static / "modules/bryntum/license.local.js").write_text("local developer key")
    catalogue = tmp_path / "packages/catalogue-web/static"
    catalogue.mkdir(parents=True)
    (catalogue / "index.html").write_text("catalogue UI")
    for name in ["LICENSE", "NOTICE", "licenses", "packages/events-model/LICENSE"]:
        target = tmp_path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if (REPO / name).is_dir():
            shutil.copytree(REPO / name, target)
        else:
            shutil.copyfile(REPO / name, target)
    data = tmp_path / "data/dist"
    data.mkdir(parents=True)
    for name in NOTICES:
        ((data.parent if parent_layout else data) / name).write_text(f"data {name}")
    subprocess.run(
        ["node", str(web / "scripts/build-static.mjs")],
        env={
            **os.environ,
            "CONFNOTE_CATALOGUE_DIR": str(data),
            "CONFNOTE_CORE_STATIC_DIR": str(static),
            "CONFNOTE_BRYNTUM_LICENSE_KEY": bryntum_key,
            "CONFNOTE_TLDRAW": tldraw,
            "CONFNOTE_BRYNTUM": bryntum,
        },
        check=True,
    )
    output = web / "public"
    for name in [
        "LICENSE",
        "NOTICE",
        "packages/events-model/LICENSE",
        "licenses/vendor/EasyMDE-MIT.txt",
        "licenses/CC-BY-4.0.txt",
    ]:
        assert (output / name).read_bytes() == (REPO / name).read_bytes()
    for name in NOTICES:
        assert (output / "catalogue" / name).read_text() == f"data {name}"
    assert (output / "catalogue/index.html").read_text() == "catalogue UI"
    # The web vendor allowlist: AG Grid Community always; Bryntum (trial or licensed) unless CONFNOTE_BRYNTUM=0
    # (production); tldraw only on an explicit CONFNOTE_TLDRAW=1 deploy, without its sources.
    shipped = ["aggrid"] + ([] if bryntum == "0" else ["bryntum"]) + (["tldraw"] if tldraw else [])
    for vendor in ["tldraw", "ag-grid", "aggrid", "bryntum"]:
        assert (output / "modules" / vendor).exists() == (vendor in shipped)
    config = json.loads((output / "modules.config.json").read_text())
    assert config["slots"] == [*shipped, "chat"]
    if bryntum == "0":
        return
    assert (output / "modules/bryntum/vendor/bryntum-island.bundle.js").exists()
    assert not (output / "modules/bryntum/build").exists()
    assert not (output / "modules/tldraw/build").exists()
    license = output / "modules/bryntum/license.local.js"
    if bryntum_key:
        assert json.dumps(bryntum_key) in license.read_text()
        assert license.stat().st_mode & 0o777 == 0o600
    else:
        assert not license.exists()


def test_cat_bundler_retains_dependency_legal_comments():
    script = (REPO / "packages/cat-app/build.mjs").read_text()
    assert 'legalComments: "eof"' in script
