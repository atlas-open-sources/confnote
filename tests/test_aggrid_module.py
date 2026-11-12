"""The Grids module (AG Grid Community) follows the MODULE.md contract."""

import hashlib
import importlib.util
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
STATIC = REPO / "packages/core-ui/static"
MODULE = STATIC / "modules/aggrid"
BUNDLE_SHA256 = "5fc8736cc0726dcd2e2901681180462fe4d1a519b31a2b4ab7268a97a52a3532"  # pragma: allowlist secret (public file hash)
CHARTS_SHA256 = "bb55974410690aa28266f4512dd6091f9ae882f810e16287f8da5f2ad7223277"  # pragma: allowlist secret (public file hash)


def test_manifest_folder_and_slot_share_one_name():
    manifest = json.loads((MODULE / "manifest.json").read_text())
    assert manifest["id"] == MODULE.name == "aggrid"
    assert (MODULE / manifest["entry"]).is_file()
    assert manifest["primitive"] == "drawer"
    slots = json.loads((STATIC / "modules.config.json").read_text())["slots"]
    assert "aggrid" in slots and len(slots) <= 4


def test_entry_self_registers_and_lazy_loads_the_vendored_bundle():
    entry = (MODULE / "aggrid.js").read_text()
    assert 'const ID = "aggrid"' in entry and "drawer.register({" in entry
    assert '"/modules/aggrid/vendor/ag-grid-community.min.js"' in entry
    index = (STATIC / "index.html").read_text()
    assert "ag-grid-community" not in index, "the bundle must load on open, not at boot"


def test_community_only_with_pinned_bundle_and_licence():
    bundle = (MODULE / "vendor/ag-grid-community.min.js").read_bytes()
    assert hashlib.sha256(bundle).hexdigest() == BUNDLE_SHA256
    licence = (MODULE / "vendor/LICENSE.txt").read_text()
    assert licence.startswith("The MIT License")
    assert (REPO / "licenses/vendor/AG-Grid-Community-MIT.txt").read_text() == licence
    for path in MODULE.rglob("*"):
        if path.is_file() and path.parent.name != "vendor":
            text = path.read_text()
            assert "ag-grid-enterprise" not in text and "LicenseManager" not in text


def test_core_reaches_actions_through_a_generic_hook():
    app = (STATIC / "app.js").read_text()
    assert "window.confnote.tickAction = tickRemoteAction;" in app
    assert "aggrid" not in app.lower() and "ag grid" not in app.lower()


def test_oss_allowlist_names_every_reviewed_module_file():
    spec = importlib.util.spec_from_file_location("oss_export", REPO / "scripts/oss_export.py")
    exporter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(exporter)
    shipped = {
        path.relative_to(REPO).as_posix().lower() for path in MODULE.rglob("*") if path.is_file()
    }
    assert shipped <= exporter.OPEN_VENDOR_FILES


def test_ag_charts_community_is_pinned_licensed_and_lazy():
    bundle = (MODULE / "vendor/ag-charts-community.min.js").read_bytes()
    assert hashlib.sha256(bundle).hexdigest() == CHARTS_SHA256
    licence = (MODULE / "vendor/LICENSE-ag-charts.txt").read_text()
    assert licence.startswith("The MIT License")
    assert (REPO / "licenses/vendor/AG-Charts-Community-MIT.txt").read_text() == licence
    entry = (MODULE / "aggrid.js").read_text()
    assert '"/modules/aggrid/vendor/ag-charts-community.min.js"' in entry
    assert "ag-charts-enterprise" not in entry
    assert "ag-charts" not in (STATIC / "index.html").read_text(), (
        "the chart loads with the Ledger, not at boot"
    )
