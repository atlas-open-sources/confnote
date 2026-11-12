#!/usr/bin/env python3
"""Publish the notarized confnote Mac app for download (`make app-publish`).

    build prod with NOTARIZE=1 (signed with a timestamp, notarized, app stapled)
    -> DMG (app + /Applications link), signed, notarized, stapled
    -> spctl must say "Notarized Developer ID"
    -> copy into the downloads site, write latest.json + vercel.json, deploy it
    -> download the stable URL as a stranger would (quarantine set) and check it

The downloads site is its own static Vercel project (confnote-downloads), so a
publish never needs a web-app deploy and a web-app deploy never drops the file.
https://confnote-web-app.vercel.app/download/confnote-mac.dmg redirects to it.

The version is the built app's CFBundleShortVersionString. This script never
changes it; 0.0.0 ships as 0.0.0 with a warning.

    --dry-run       package the existing dist app (no notarize, no deploy), print the plan
    --skip-build    reuse packages/local-app/dist/confnote.app (must already be notarized)
    --init          deploy the site with no release yet ("coming soon")
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
APP = REPO / "packages" / "local-app" / "dist" / "confnote.app"
DIST = REPO / "packages" / "local-app" / "dist"
DEFAULT_SITE = Path.home() / "Documents/mcc/fujira/theforest/confnote/media/downloads"
DOWNLOADS_ORIGIN = "https://confnote-downloads.vercel.app"
STABLE_URL = "https://confnote-web-app.vercel.app/download/confnote-mac.dmg"
COMING_SOON_URL = "https://confnote-web-app.vercel.app/download"
VERCEL_PROJECT = "confnote-downloads"
VERCEL_SCOPE = "atlascodes"
SIGN_ID = os.environ.get(
    "CONFNOTE_SIGN_ID", "Developer ID Application: Atlas Codes LTD (599WAZ6282)"
)
NOTARY_PROFILE = os.environ.get("CONFNOTE_NOTARY_PROFILE", "confnote-notary")
NOTARIZED = "source=Notarized Developer ID"
# The team App Store Connect API key notarizes with no keychain and no human step
# (the Local AI Cat's release scripts do the same). The env file holds the key's
# path and ids only; notarytool reads the key file itself.
RELEASE_ENV = Path(
    os.environ.get("CONFNOTE_RELEASE_ENV", Path.home() / ".config/confnote/release.env")
)
ASC_VARS = ("ASC_KEY_PATH", "ASC_KEY_ID", "ASC_ISSUER_ID")


def release_env() -> dict[str, str]:
    """ASC_* from the environment, else from RELEASE_ENV; empty when neither has all three."""
    values = {name: os.environ.get(name, "") for name in ASC_VARS}
    if not all(values.values()) and RELEASE_ENV.is_file():
        for line in RELEASE_ENV.read_text().splitlines():
            name, _, value = line.partition("=")
            if name.strip() in ASC_VARS and value.strip():
                values[name.strip()] = os.path.expanduser(value.strip())
    return values if all(values.values()) else {}


def notary_auth(asc: dict[str, str]) -> list[str]:
    if asc:
        return [
            "--key",
            asc["ASC_KEY_PATH"],
            "--key-id",
            asc["ASC_KEY_ID"],
            "--issuer",
            asc["ASC_ISSUER_ID"],
        ]
    return ["--keychain-profile", NOTARY_PROFILE]


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    print("  $ " + " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=True, **kw)


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--init", action="store_true")
    p.add_argument("--skip-build", action="store_true")
    p.add_argument(
        "--site-dir",
        type=Path,
        default=Path(os.environ.get("CONFNOTE_DOWNLOADS_DIR", DEFAULT_SITE)),
    )
    p.add_argument("--app", type=Path, default=APP)
    return p.parse_args(argv)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def app_version(app: Path) -> str:
    with (app / "Contents" / "Info.plist").open("rb") as f:
        return str(plistlib.load(f).get("CFBundleShortVersionString") or "0.0.0")


def dmg_name(version: str, commit: str) -> str:
    if not re.fullmatch(r"[0-9A-Za-z.\-]+", version):
        raise ValueError(f"unsafe version string: {version!r}")
    if not re.fullmatch(r"[0-9a-f]{7,40}", commit):
        raise ValueError(f"bad commit: {commit!r}")
    return f"confnote-{version}-{commit[:7]}.dmg"


def version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in re.findall(r"\d+", version))


def macho_files(app: Path) -> list[Path]:
    out = []
    for path in (app / "Contents").rglob("*"):
        if path.is_file() and not path.is_symlink():
            with path.open("rb") as f:
                magic = f.read(4)
            if magic in (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe"):
                out.append(path)
    return out


def minimum_macos(app: Path) -> str:
    """The highest LC_BUILD_VERSION minos across every Mach-O in the bundle."""
    best = "11.0"
    for path in macho_files(app):
        res = subprocess.run(["vtool", "-show-build", str(path)], capture_output=True, text=True)
        for m in re.finditer(r"minos\s+([0-9.]+)", res.stdout):
            if version_key(m.group(1)) > version_key(best):
                best = m.group(1)
    return best


def architectures(app: Path) -> list[str]:
    exe = app / "Contents" / "MacOS" / app.stem
    res = subprocess.run(["lipo", "-archs", str(exe)], capture_output=True, text=True, check=True)
    return sorted(res.stdout.split())


def manifest(
    version: str, file: str, sha: str, size: int, min_os: str, archs: list[str], commit: str
) -> dict:
    return {
        "name": "confnote",
        "version": version,
        "file": file,
        "url": f"{DOWNLOADS_ORIGIN}/mac/{file}",
        "stable_url": STABLE_URL,
        "sha256": sha,
        "size": size,
        "minimum_macos": min_os,
        "architectures": archs,
        "commit": commit,
        "published_at": dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def site_config(latest_file: str | None) -> dict:
    """vercel.json for the downloads site: the stable redirect + headers."""
    target = f"/mac/{latest_file}" if latest_file else COMING_SOON_URL
    return {
        "$schema": "https://openapi.vercel.sh/vercel.json",
        "redirects": [
            {"source": "/", "destination": COMING_SOON_URL, "permanent": False},
            {"source": "/confnote-mac.dmg", "destination": target, "permanent": False},
        ],
        "headers": [
            {
                "source": "/latest.json",
                "headers": [
                    {"key": "Access-Control-Allow-Origin", "value": "*"},
                    {"key": "Cache-Control", "value": "no-cache"},
                ],
            },
            {
                "source": "/mac/(.*)",
                "headers": [
                    {"key": "Cache-Control", "value": "public, max-age=31536000, immutable"}
                ],
            },
        ],
    }


def write_site(site: Path, latest: dict | None) -> None:
    site.mkdir(parents=True, exist_ok=True)
    (site / "mac").mkdir(exist_ok=True)
    (site / "vercel.json").write_text(
        json.dumps(site_config(latest and latest["file"]), indent=2) + "\n"
    )
    latest_path = site / "latest.json"
    if latest:
        latest_path.write_text(json.dumps(latest, indent=2) + "\n")


def make_dmg(app: Path, out: Path, sign: bool, timestamp: bool) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=DIST, prefix="dmg-stage-") as stage:
        run(["ditto", str(app), str(Path(stage) / app.name)])
        os.symlink("/Applications", Path(stage) / "Applications")
        if out.exists():
            out.unlink()
        run(
            [
                "hdiutil",
                "create",
                "-volname",
                "confnote",
                "-srcfolder",
                stage,
                "-ov",
                "-format",
                "UDZO",
                str(out),
            ]
        )
    if sign:
        ts = "--timestamp" if timestamp else "--timestamp=none"
        run(["codesign", "--force", ts, "--sign", SIGN_ID, str(out)])


def assess(path: Path, kind: str) -> str:
    res = subprocess.run(
        ["spctl", "-a", "-vv", "-t", kind, str(path)], capture_output=True, text=True
    )
    return (res.stdout + res.stderr).strip()


def git_commit() -> str:
    return subprocess.run(
        ["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True, check=True
    ).stdout.strip()


def deploy(site: Path) -> None:
    if not (site / ".vercel" / "project.json").exists():
        run(
            [
                "vercel",
                "link",
                "--yes",
                "--project",
                VERCEL_PROJECT,
                "--scope",
                VERCEL_SCOPE,
                "--cwd",
                str(site),
            ]
        )
    run(["vercel", "deploy", "--prod", "--yes", "--scope", VERCEL_SCOPE, "--cwd", str(site)])


def verify_as_stranger(expected_sha: str) -> None:
    """curl the stable URL, mark it quarantined like a browser does, check sha + Gatekeeper."""
    with tempfile.TemporaryDirectory(prefix="confnote-stranger-") as tmp:
        dmg = Path(tmp) / "confnote-mac.dmg"
        run(["curl", "-fsSL", "-o", str(dmg), STABLE_URL])
        run(["xattr", "-w", "com.apple.quarantine", "0081;00000000;Safari;", str(dmg)])
        got = sha256_file(dmg)
        if got != expected_sha:
            sys.exit(f"stranger download sha256 {got} != published {expected_sha}")
        verdict = assess(dmg, "install")
        print(verdict)
        if NOTARIZED not in verdict:
            sys.exit("stranger download is not accepted as Notarized Developer ID")
    print("stranger download: sha256 matches, Gatekeeper says Notarized Developer ID")


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    site = args.site_dir.expanduser()

    if args.init:
        write_site(site, None)
        deploy(site)
        print(f"downloads site deployed with no release; {STABLE_URL} -> {COMING_SOON_URL}")
        return 0

    if not args.dry_run and not args.skip_build:
        run(
            ["sh", str(REPO / "packages/local-app/build-macos.sh")],
            env={**os.environ, **release_env(), "NOTARIZE": "1", "NO_INSTALL": "1"},
        )
    app = args.app
    if not app.is_dir():
        sys.exit(f"no app at {app}; build it first (make app-release) or drop --skip-build")

    version = app_version(app)
    if version == "0.0.0":
        print(
            "WARNING: the app says version 0.0.0 (CFBundleShortVersionString); shipping it as is. musa sets the version."
        )
    commit = git_commit()
    name = dmg_name(version, commit)
    min_os = minimum_macos(app)
    archs = architectures(app)
    print(f"version {version}, commit {commit[:7]}, macOS {min_os}+, {'/'.join(archs)}")

    if not args.dry_run:
        verdict = assess(app, "execute")
        print(verdict)
        if NOTARIZED not in verdict:
            sys.exit(
                f"{app} is not notarized; run without --skip-build or `make app-release` first"
            )

    dmg = DIST / name
    make_dmg(app, dmg, sign=True, timestamp=not args.dry_run)
    if not args.dry_run:
        run(
            [
                "xcrun",
                "notarytool",
                "submit",
                str(dmg),
                *notary_auth(release_env()),
                "--wait",
            ]
        )
        run(["xcrun", "stapler", "staple", str(dmg)])
        verdict = assess(dmg, "install")
        print(verdict)
        if NOTARIZED not in verdict:
            sys.exit(f"{dmg} is not accepted as Notarized Developer ID")

    sha = sha256_file(dmg)
    size = dmg.stat().st_size
    latest = manifest(version, name, sha, size, min_os, archs, commit)
    (DIST / f"{name}.sha256").write_text(f"{sha}  {name}\n")
    print(f"{name}  {size} bytes  sha256 {sha}")

    if args.dry_run:
        print(
            "dry run: would copy it to",
            site / "mac" / name,
            "write latest.json + vercel.json, deploy",
            VERCEL_PROJECT,
        )
        print(json.dumps(latest, indent=2))
        print(json.dumps(site_config(name), indent=2))
        return 0

    write_site(site, None)
    shutil.copy2(dmg, site / "mac" / name)
    write_site(site, latest)
    deploy(site)
    verify_as_stranger(sha)
    print(f"published {name} -> {STABLE_URL}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
