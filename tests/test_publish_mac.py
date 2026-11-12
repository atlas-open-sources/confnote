"""publish_mac.py: argument, name, sha and site-config handling (no build, no network)."""

import hashlib
import importlib.util
import json
import plistlib
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/publish_mac.py"
spec = importlib.util.spec_from_file_location("publish_mac", SCRIPT)
publish = importlib.util.module_from_spec(spec)
spec.loader.exec_module(publish)


def test_modes_are_exclusive():
    with pytest.raises(SystemExit):
        publish.parse_args(["--dry-run", "--init"])
    args = publish.parse_args(["--dry-run", "--site-dir", "/x/site"])
    assert args.dry_run and not args.init and args.site_dir == Path("/x/site")


def test_dmg_name_keeps_version_and_short_commit():
    commit = "d85ccad" + "0" * 33
    assert publish.dmg_name("0.0.0", commit) == "confnote-0.0.0-d85ccad.dmg"
    with pytest.raises(ValueError):
        publish.dmg_name("1.0/../x", "d85ccad")
    with pytest.raises(ValueError):
        publish.dmg_name("1.0", "not-a-sha")


def test_version_comes_from_the_app(tmp_path):
    contents = tmp_path / "confnote.app" / "Contents"
    contents.mkdir(parents=True)
    with (contents / "Info.plist").open("wb") as f:
        plistlib.dump({"CFBundleShortVersionString": "0.0.0"}, f)
    assert publish.app_version(tmp_path / "confnote.app") == "0.0.0"


def test_sha256_matches_hashlib(tmp_path):
    blob = tmp_path / "x.dmg"
    blob.write_bytes(b"confnote" * 300_000)
    assert publish.sha256_file(blob) == hashlib.sha256(blob.read_bytes()).hexdigest()


def test_version_key_orders_numerically():
    assert publish.version_key("27.0") > publish.version_key("26.10")
    assert publish.version_key("11.0") < publish.version_key("15.0")


def test_manifest_points_at_the_versioned_file():
    latest = publish.manifest(
        "0.0.0", "confnote-0.0.0-d85ccad.dmg", "ab" * 32, 123, "27.0", ["arm64"], "d85ccad"
    )
    assert latest["url"] == "https://confnote-downloads.vercel.app/mac/confnote-0.0.0-d85ccad.dmg"
    assert latest["stable_url"].endswith("/download/confnote-mac.dmg")
    assert latest["sha256"] == "ab" * 32


def test_site_config_redirects_stable_name(tmp_path):
    soon = publish.site_config(None)
    stable = next(r for r in soon["redirects"] if r["source"] == "/confnote-mac.dmg")
    assert stable["destination"] == publish.COMING_SOON_URL

    latest = publish.manifest(
        "0.0.0", "confnote-0.0.0-d85ccad.dmg", "cd" * 32, 1, "27.0", ["arm64"], "d85ccad"
    )
    publish.write_site(tmp_path, latest)
    config = json.loads((tmp_path / "vercel.json").read_text())
    stable = next(r for r in config["redirects"] if r["source"] == "/confnote-mac.dmg")
    assert stable == {
        "source": "/confnote-mac.dmg",
        "destination": "/mac/confnote-0.0.0-d85ccad.dmg",
        "permanent": False,
    }
    assert json.loads((tmp_path / "latest.json").read_text())["sha256"] == "cd" * 32
