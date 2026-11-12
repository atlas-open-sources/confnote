"""Smoke test for a built Mac bundle: signature, Info.plist, contents, and its UI.

Point CONFNOTE_TEST_APP at a dist bundle (`make app-smoke` runs both channels).
The bundle's own frozen server runs headless (CONF_NOTES_NOGUI=1) under a
throwaway HOME, so this is a real first launch: the default vault
`~/Documents/confnote` is created and seeded, app state lands in the tmp
`~/Library/Application Support`, and the developer's vault, Keychain and
installed apps are never touched. Playwright then drives the SPA the native
window would show.

Not covered here: the pywebview window itself (frameless NSWindow, the
window-control bridge, the native folder picker). Driving it needs a screen.
`test_window_bridge_*` check the frozen app carries the Cocoa backend and that
every `pywebview.api` call the page makes exists on the bridge.

Set CONFNOTE_SMOKE_SHOTS=<dir> to keep a PNG per step for the evidence page.
"""

from __future__ import annotations

import contextlib
import json
import os
import plistlib
import re
import shutil
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

import pytest
from playwright.sync_api import expect

REPO = Path(__file__).resolve().parents[2]
SEED_AGENDA = Path(__file__).with_name("seed-agenda.json")
STATIC = REPO / "packages/core-ui/static"
APP = os.environ.get("CONFNOTE_TEST_APP", "")
START_TIMEOUT_S = 40.0
VENDOR_MODULES_KEPT_OUT = ("tldraw", "bryntum")
STARTER_CONFERENCE = "OpenAI DevDay 2026"
SEED_SLUG = "2026-05-19-beyond-the-prompt"
VIEWPORT = {"width": 1440, "height": 900}


@pytest.fixture(scope="module")
def bundle() -> Path:
    if not APP or not Path(APP).is_dir():
        pytest.skip("Set CONFNOTE_TEST_APP to a built .app (make app-smoke)")
    return Path(APP)


@pytest.fixture(scope="module")
def info(bundle) -> dict:
    with (bundle / "Contents/Info.plist").open("rb") as f:
        return plistlib.load(f)


@pytest.fixture(scope="module")
def channel(bundle) -> str:
    return "dev" if bundle.stem.endswith(" dev") else "prod"


@pytest.fixture(scope="module")
def shots():
    """Return a saver that writes `<channel>-<name>.png` when CONFNOTE_SMOKE_SHOTS is set."""
    target = os.environ.get("CONFNOTE_SMOKE_SHOTS")
    stem = "dev" if APP.rstrip("/").endswith(" dev.app") else "prod"

    def save(page, name: str) -> None:
        if target:
            Path(target).mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(Path(target) / f"mac-{stem}-{name}.png"))

    return save


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _get_json(url: str):
    with urllib.request.urlopen(url, timeout=2) as r:
        return json.loads(r.read())


@pytest.fixture(scope="module")
def launched(bundle, tmp_path_factory):
    """Launch the bundle's own executable headless under a fresh HOME.

    No CONF_NOTES_DIR: the vault resolves exactly as on a new user's Mac.
    """
    home = tmp_path_factory.mktemp("home")
    port = _free_port()
    log = home / "bundle.log"
    env = {
        "HOME": str(home),
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "LANG": "en_US.UTF-8",
        "TMPDIR": str(tmp_path_factory.mktemp("tmp")),
        "CONF_NOTES_NOGUI": "1",
        "CONF_NOTES_NOOPEN": "1",
        "CONF_NOTES_NO_KEYCHAIN": "1",
        "CONF_NOTES_NO_NATIVE_NOTIFY": "1",
        "CONF_NOTES_PORT": str(port),
        "CONFNOTE_CATALOGUE_URL": "",
    }
    with log.open("wb") as out:
        proc = subprocess.Popen(
            [str(bundle / "Contents/MacOS" / bundle.stem)],
            env=env,
            stdout=out,
            stderr=subprocess.STDOUT,
        )
    url = f"http://127.0.0.1:{port}"
    deadline = time.time() + START_TIMEOUT_S
    while time.time() < deadline:
        if proc.poll() is not None:
            break
        with contextlib.suppress(Exception):
            _get_json(url + "/api/conferences")
            break
        time.sleep(0.2)
    else:
        proc.kill()
    if proc.poll() is not None:
        pytest.fail(f"bundle exited with {proc.returncode} before serving:\n{log.read_text()}")
    try:
        yield {"url": url, "home": home, "log": log, "proc": proc}
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(home, ignore_errors=True)


@pytest.fixture
def ui(launched, page):
    """A page on the bundle's home with console errors collected in `page.errors`."""
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on(
        "console",
        lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None,
    )
    page.on(
        "response",
        lambda r: errors.append(f"HTTP {r.status}: {r.url}") if r.status >= 400 else None,
    )
    page.set_viewport_size(VIEWPORT)
    page.goto(launched["url"] + "/#/")
    page.wait_for_selector("#sidebar .sb-conf")
    page.errors = errors
    return page


# ---- the bundle on disk ------------------------------------------------------


def test_signature_verifies_strictly(bundle):
    result = subprocess.run(
        ["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(bundle)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    details = subprocess.run(
        ["codesign", "-dv", "--verbose=4", str(bundle)], capture_output=True, text=True
    ).stderr
    if os.environ.get("CONFNOTE_HEADLESS_BUILD") == "1":
        return  # CI builds sign ad hoc on purpose.
    assert "Authority=Developer ID Application" in details, details
    flags = re.search(r"flags=0x[0-9a-f]+\(([^)]*)\)", details)
    assert flags and "runtime" in flags.group(1), f"hardened runtime missing:\n{details}"


def test_info_plist_matches_the_channel(bundle, info, channel):
    assert info["CFBundleExecutable"] == bundle.stem
    assert info["CFBundleName"] == bundle.stem
    assert info["CFBundlePackageType"] == "APPL"
    assert info.get("NSHighResolutionCapable") is True
    assert "transcribe" in info.get("NSMicrophoneUsageDescription", "")
    if channel == "dev":
        assert info["CFBundleIdentifier"].startswith("com.atlas.confnote.dev.")
        assert info["CFBundleIconFile"] == "icon-dev.icns"
    else:
        assert info["CFBundleIdentifier"] == "com.atlas.confnote"
        assert info["CFBundleIconFile"] == "icon.icns"
    assert (bundle / "Contents/Resources" / info["CFBundleIconFile"]).is_file()
    # The version string is reported, not judged: choosing one is musa's call.
    print(f"CFBundleShortVersionString={info.get('CFBundleShortVersionString')!r}")


def test_bundle_ships_notices_and_no_dev_cruft(bundle):
    resources = bundle / "Contents/Resources"
    for notice in ("LICENSE", "NOTICE", "licenses"):
        assert (resources / notice).exists(), f"missing {notice}"
    static = resources / "static"
    for vendor in VENDOR_MODULES_KEPT_OUT:
        assert not (static / "modules" / vendor).exists(), f"{vendor} must stay web-only"
    slots = json.loads((static / "modules.config.json").read_text())["slots"]
    assert not set(slots) & set(VENDOR_MODULES_KEPT_OUT), slots
    assert "chat" in slots
    assert not list(bundle.rglob("node_modules")), "npm cruft in the bundle"
    assert not (bundle / "Contents/Frameworks/claude_agent_sdk/_bundled").exists()


def test_window_bridge_backend_is_frozen_in(bundle):
    """The native window needs pywebview's Cocoa backend inside the bundle."""
    frameworks = bundle / "Contents/Frameworks"
    cocoa = list(frameworks.rglob("webview/platforms/cocoa.py")) + list(
        (bundle / "Contents/Resources").rglob("webview/platforms/cocoa.py")
    )
    assert cocoa, "webview/platforms/cocoa.py is not in the bundle"
    assert list(frameworks.glob("WebKit/_WebKit*.so")), (
        "pyobjc WebKit bindings are not in the bundle"
    )


def test_window_bridge_covers_every_call_the_page_makes():
    """Every `pywebview.api.<name>` the SPA or its shell calls must exist on desktop._WinApi."""
    source = (REPO / "packages/local-app/desktop.py").read_text()
    bridge = set(re.findall(r"^    def (\w+)\(self", source.split("class _WinApi", 1)[1], re.M))
    called: set[str] = set()
    for path in [*STATIC.rglob("*.js"), STATIC / "index.html"]:
        if {"vendor", "node_modules", "build"} & set(path.parts):
            continue
        called |= set(re.findall(r"pywebview\??\.api\??\.(\w+)", path.read_text()))
    assert {"win_minimize", "open_external"} <= called, "bridge calls moved; update this test"
    assert called <= bridge, f"page calls missing bridge methods: {sorted(called - bridge)}"


# ---- the bundle running ------------------------------------------------------


def test_first_launch_makes_and_seeds_the_default_vault(launched, channel):
    vault = launched["home"] / "Documents/confnote"
    payload = _get_json(launched["url"] + "/api/vault")
    assert Path(payload["current"]) == vault.resolve()
    assert payload["channel"] == channel
    assert payload["env_pinned"] is False
    names = [c["name"] for c in _get_json(launched["url"] + "/api/conferences")]
    assert STARTER_CONFERENCE in names, names
    seeded = [p for p in vault.iterdir() if not p.name.startswith(".")]
    assert len(seeded) == 1 and (seeded[0] / "agenda.json").is_file(), seeded
    assert list((seeded[0] / "notes").glob("*.md")), "starter notes were not written"


def test_home_renders_without_console_errors(ui, shots):
    assert STARTER_CONFERENCE in ui.locator("#sidebar").inner_text()
    expect(ui.locator("#settingsBtn")).to_be_visible()
    shots(ui, "home")
    assert not ui.errors, ui.errors


def test_import_an_agenda_through_the_new_conference_flow(ui, launched, shots):
    ui.evaluate("() => openNewConferenceModal()")
    ui.wait_for_selector("#newConfModal")
    ui.locator("#ncJson").fill(SEED_AGENDA.read_text())
    ui.locator("#ncValidate").click()
    ui.wait_for_selector(".new-conf-result.ok")
    shots(ui, "import-validated")
    ui.locator("#ncCreate").click()
    ui.wait_for_url(f"**/#/{SEED_SLUG}")
    ui.wait_for_selector(".rail")
    assert "Beyond The Prompt" in ui.locator("#crumbs").inner_text()
    assert (launched["home"] / "Documents/confnote" / SEED_SLUG / "agenda.json").is_file()
    shots(ui, "conference")
    assert not ui.errors, ui.errors


def test_notes_save_as_plain_markdown_files(ui, launched, shots):
    notes = launched["home"] / "Documents/confnote" / SEED_SLUG / "notes"
    note = sorted(notes.glob("*.md"))[1]
    ui.evaluate(f"() => {{ location.hash = '#/{SEED_SLUG}/{note.name}'; }}")
    ui.wait_for_selector("#paneBody1 .CodeMirror")
    ui.locator("#paneBody1 .CodeMirror").click()
    ui.keyboard.type("Typed in the Mac bundle smoke.")
    for _ in range(50):
        if "Typed in the Mac bundle smoke." in note.read_text():
            break
        ui.wait_for_timeout(100)
    text = note.read_text()
    assert "Typed in the Mac bundle smoke." in text
    assert text.lstrip().startswith(("#", "---")), "a note is a plain markdown file"
    shots(ui, "note")
    assert not ui.errors, ui.errors


def test_find_events_opens(ui, shots):
    ui.locator(".hometabs").get_by_role("link", name="Find events").click()
    view = ui.locator("#findEventsView")
    expect(view.get_by_role("searchbox")).to_be_visible()
    view.get_by_role("searchbox").fill("zzz-no-such-event")
    expect(view.get_by_text("Nothing here yet.", exact=False)).to_be_visible()
    shots(ui, "find-events")
    assert not ui.errors, ui.errors


def test_drawer_has_grids_and_concierge_only(ui, shots):
    ui.goto(ui.url.split("#")[0] + f"#/{SEED_SLUG}")
    ui.wait_for_selector(".rail")
    strip = ui.locator("#drawerStrip")
    expect(strip.get_by_role("button", name="Concierge")).to_be_visible()
    for absent in ("Planner", "Sketch", "tldraw"):
        assert strip.get_by_role("button", name=absent).count() == 0, absent
    strip.get_by_role("button", name="Concierge").click()
    ui.wait_for_selector("#drawerHost.open")
    shots(ui, "concierge")
    ui.locator("#drawerClose").click()
    grids = strip.get_by_role("button", name="Grids")
    if grids.count():
        grids.click()
        ui.wait_for_selector("#drawerHost.open .ag-root-wrapper", timeout=10000)
        shots(ui, "grids")
        ui.locator("#drawerClose").click()
    assert not ui.errors, ui.errors


def test_settings_opens_and_closes_with_escape(ui, launched, shots):
    ui.locator("#settingsBtn").click()
    ui.wait_for_selector("#settingsModal")
    shots(ui, "settings")
    ui.keyboard.press("Escape")
    expect(ui.locator("#settingsModal")).to_have_count(0)
    assert not ui.errors, ui.errors


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_theme_paints(ui, shots, theme):
    ui.evaluate(f"() => localStorage.setItem('confnote-theme', '{theme}')")
    ui.goto(ui.url.split("#")[0] + f"#/{SEED_SLUG}")
    ui.reload()
    ui.wait_for_selector(".rail")
    assert ui.evaluate("() => document.documentElement.dataset.theme") == theme
    bg = ui.evaluate("() => getComputedStyle(document.body).backgroundColor")
    channels = [int(n) for n in re.findall(r"\d+", bg)[:3]]
    if theme == "dark":
        assert max(channels) < 80, bg
    else:
        assert min(channels) > 200, bg
    shots(ui, f"theme-{theme}")
    assert not ui.errors, ui.errors


def test_bundle_log_has_no_tracebacks(launched):
    assert "Traceback" not in launched["log"].read_text(), launched["log"].read_text()
