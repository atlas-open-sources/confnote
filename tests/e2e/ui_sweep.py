#!/usr/bin/env python3
"""Render every screen of a confnote build in light and dark at 1440 and 1024 wide.

    packages/local-app/.venv/bin/python tests/e2e/ui_sweep.py --out <dir> \
        --source --mac "packages/local-app/dist/confnote.app" --web \
        --url staging=https://staging.confnote.si

Each target is started on a throwaway vault (the Mac bundle under a throwaway
HOME, headless) and seeded with the Beyond The Prompt agenda; `--url` targets
are only read: the sweep navigates and opens panels, it never saves or sends.
Per screen it records console errors, failed requests, uncaught page errors,
horizontal overflow and cumulative layout shift, and keeps a PNG. Per target
it tabs through the top bar and checks the focused control shows a ring.
Writes `<out>/results.json` and `<out>/shots/*.png`. Not collected by pytest.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

REPO = Path(__file__).resolve().parents[2]
SEED_AGENDA = Path(__file__).with_name("seed-agenda.json")
VIEWPORTS = {1440: 900, 1024: 768}
THEMES = ("light", "dark")
START_TIMEOUT_S = 45.0
PANEL_SETTLE_MS = 1500
SCREEN_SETTLE_MS = 800
FOCUS_TABS = 6
# A signed-out hosted page answers its account probe with 401; that is the design.
EXPECTED_STATUS = {("/api/me", 401)}
CLS_SCRIPT = """
window.__cls = 0;
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
}).observe({ type: "layout-shift", buffered: true });
"""


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait(url: str, proc: subprocess.Popen | None, log: Path) -> None:
    deadline = time.time() + START_TIMEOUT_S
    while time.time() < deadline:
        if proc and proc.poll() is not None:
            raise RuntimeError(f"{url} exited {proc.returncode}:\n{log.read_text()}")
        with contextlib.suppress(Exception), urllib.request.urlopen(url, timeout=1) as r:
            if r.status == 200:
                return
        time.sleep(0.2)
    raise RuntimeError(f"{url} never answered:\n{log.read_text()}")


def _seed(url: str) -> str:
    request = urllib.request.Request(
        url + "/api/conferences",
        data=SEED_AGENDA.read_bytes(),
        headers={"Content-Type": "application/json", "Origin": url},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as r:
        return json.loads(r.read())["slug"]


class Target:
    """One build to sweep: a URL plus, for local builds, the process serving it."""

    def __init__(self, name: str, url: str, proc=None, tmp: Path | None = None, readonly=False):
        self.name, self.url, self.proc, self.tmp, self.readonly = name, url, proc, tmp, readonly

    def close(self) -> None:
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        if self.tmp:
            shutil.rmtree(self.tmp, ignore_errors=True)


def start_source() -> Target:
    tmp = Path(tempfile.mkdtemp(prefix="sweep-source-"))
    port, log = _free_port(), tmp / "server.log"
    env = {
        **os.environ,
        "CONF_NOTES_DIR": str(tmp / "vault"),
        "CONF_NOTES_PORT": str(port),
        "CONF_NOTES_NOOPEN": "1",
        "CONF_NOTES_NO_KEYCHAIN": "1",
        "CONFNOTE_CATALOGUE_URL": "",
    }
    (tmp / "vault").mkdir()
    with log.open("wb") as out:
        proc = subprocess.Popen(
            [sys.executable, str(REPO / "packages/local-app/server.py")],
            env=env,
            stdout=out,
            stderr=subprocess.STDOUT,
        )
    url = f"http://127.0.0.1:{port}"
    _wait(url + "/api/conferences", proc, log)
    _seed(url)
    return Target("local source", url, proc, tmp)


def start_mac(bundle: Path) -> Target:
    tmp = Path(tempfile.mkdtemp(prefix="sweep-mac-"))
    port, log = _free_port(), tmp / "bundle.log"
    env = {
        "HOME": str(tmp),
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "LANG": "en_US.UTF-8",
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
    _wait(url + "/api/conferences", proc, log)
    _seed(url)
    return Target(f"Mac {bundle.stem}", url, proc, tmp)


def start_web() -> Target:
    """The web build on the loopback dev server (signed out, filesystem storage)."""
    tmp = Path(tempfile.mkdtemp(prefix="sweep-web-"))
    port, log = _free_port(), tmp / "web.log"
    web = REPO / "packages/web-app"
    subprocess.run(["npm", "run", "build"], cwd=web, check=True, capture_output=True)
    env = {
        **os.environ,
        "PORT": str(port),
        "CONFNOTE_WEB_AGENT_MODE": "off",
        "CONFNOTE_EMAIL_MODE": "disabled",
        "CONFNOTE_WEB_DATA_DIR": str(tmp / "data"),
    }
    with log.open("wb") as out:
        proc = subprocess.Popen(
            [str(web / "node_modules/.bin/tsx"), "scripts/dev-local.ts"],
            cwd=web,
            env=env,
            stdout=out,
            stderr=subprocess.STDOUT,
        )
    url = f"http://127.0.0.1:{port}"
    _wait(url + "/", proc, log)
    return Target("local web", url, proc, tmp)


def _first_slug(target: Target) -> str | None:
    with (
        contextlib.suppress(Exception),
        urllib.request.urlopen(target.url + "/api/conferences", timeout=10) as r,
    ):
        conferences = json.loads(r.read())
        if isinstance(conferences, list) and conferences:
            return conferences[0]["slug"]
    return None


def _first_note(target: Target, slug: str) -> str | None:
    with (
        contextlib.suppress(Exception),
        urllib.request.urlopen(f"{target.url}/api/conference?slug={slug}", timeout=10) as r,
    ):
        for event in json.loads(r.read()).get("events", []):
            if event.get("note") and event.get("type") not in ("logistics", "break"):
                return event["note"]
    return None


def _screens(page: Page, slug: str | None, note: str | None):
    """Yield (name, action) pairs; each action leaves the screen ready for a shot."""

    def goto(route: str, ready: str):
        def run():
            page.goto(page.url.split("#")[0] + route)
            page.wait_for_selector(ready, timeout=15000)

        return run

    def click(selector: str, ready: str):
        def run():
            page.locator(selector).first.click()
            page.wait_for_selector(ready, timeout=15000)

        return run

    def close_with_escape():
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)

    yield "home", goto("#/", "#sidebar")
    yield "find-events", goto("#/~find", "#findEventsView")
    if not slug:
        return
    yield "conference", goto(f"#/{slug}", ".rail")
    for view in ("agenda", "now", "speakers"):
        yield (
            f"conference-{view}",
            click(f'.conf-tab[data-view="{view}"]', f".conf-tab.on[data-view='{view}']"),
        )
    yield "brief", goto(f"#/{slug}/~brief", ".agenda-brief.active")
    if note:
        yield "note", goto(f"#/{slug}/{note}", "#tabbar .tab")
    yield "settings", click("#settingsBtn", "#settingsModal")
    yield "_close", close_with_escape


def _drawer_names(page: Page) -> list[str]:
    return page.eval_on_selector_all(
        "#drawerStrip .drawer-tab", "els => els.map(e => e.getAttribute('aria-label'))"
    )


def _focus_ring(page: Page) -> list[dict]:
    """Tab from the top of the page and report whether each focused control shows a ring."""
    page.goto(page.url.split("#")[0] + "#/")
    page.wait_for_selector("#sidebar")
    page.locator("body").click(position={"x": 5, "y": 5})
    stops = []
    for _ in range(FOCUS_TABS):
        page.keyboard.press("Tab")
        stops.append(
            page.evaluate("""() => {
              const el = document.activeElement;
              if (!el || el === document.body) return { label: "body", ring: false };
              const s = getComputedStyle(el);
              const ring = (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0)
                || (s.boxShadow && s.boxShadow !== "none");
              return { label: el.getAttribute("aria-label") || el.textContent.trim().slice(0, 30)
                || el.tagName, ring };
            }""")
        )
    return stops


def sweep(target: Target, out: Path, browser) -> dict:
    slug = _first_slug(target)
    note = _first_note(target, slug) if slug else None
    rows, focus = [], None
    for width, height in VIEWPORTS.items():
        for theme in THEMES:
            context = browser.new_context(
                viewport={"width": width, "height": height}, color_scheme=theme
            )
            context.add_init_script(
                f"localStorage.setItem('confnote-theme', '{theme}');" + CLS_SCRIPT
            )
            page = context.new_page()
            issues: list[str] = []
            page.on("pageerror", lambda e, sink=issues: sink.append(f"page error: {e}"))
            page.on(
                "console",
                lambda m, sink=issues: (
                    sink.append(f"console: {m.text}") if m.type == "error" else None
                ),
            )

            def on_response(r, sink=issues):
                path = r.url.split("?")[0].replace(target.url, "")
                if r.status >= 400 and (path, r.status) not in EXPECTED_STATUS:
                    sink.append(f"HTTP {r.status} {path}")

            page.on("response", on_response)
            page.goto(target.url + "/#/")
            page.wait_for_selector("#sidebar", timeout=20000)
            screens = list(_screens(page, slug, note))
            if slug:
                screens.append(("_back", lambda p=page: p.goto(target.url + f"/#/{slug}")))
            for name, action in screens:
                issues.clear()
                try:
                    action()
                    page.wait_for_timeout(SCREEN_SETTLE_MS)
                except Exception as error:  # a missing screen is a finding, not a crash
                    issues.append(f"did not render: {str(error).splitlines()[0]}")
                if name.startswith("_"):
                    continue
                rows.append(_record(page, out, target, name, theme, width, issues))
            if slug:
                page.wait_for_selector(".rail", timeout=15000)
                for drawer in _drawer_names(page):
                    issues.clear()
                    try:
                        page.locator(f'#drawerStrip .drawer-tab[aria-label="{drawer}"]').click()
                        page.wait_for_selector("#drawerHost.open", timeout=10000)
                        page.wait_for_timeout(PANEL_SETTLE_MS)
                    except Exception as error:
                        issues.append(f"did not open: {str(error).splitlines()[0]}")
                    rows.append(
                        _record(page, out, target, f"drawer-{drawer.lower()}", theme, width, issues)
                    )
                    with contextlib.suppress(Exception):
                        page.locator("#drawerClose").click(timeout=3000)
            if focus is None:
                focus = _focus_ring(page)
            context.close()
    return {
        "target": target.name,
        "url": target.url,
        "readonly": target.readonly,
        "slug": slug,
        "rows": rows,
        "focus": focus,
    }


def _record(page: Page, out: Path, target: Target, name, theme, width, issues) -> dict:
    stem = f"{target.name.lower().replace(' ', '-')}-{name}-{theme}-{width}"
    shot = out / "shots" / f"{stem}.png"
    page.screenshot(path=str(shot))
    metrics = page.evaluate(
        "() => ({ overflow: document.documentElement.scrollWidth - innerWidth,"
        " cls: Math.round((window.__cls || 0) * 1000) / 1000 })"
    )
    found = list(dict.fromkeys(issues))
    if metrics["overflow"] > 0:
        found.append(f"horizontal overflow {metrics['overflow']}px")
    return {
        "screen": name,
        "theme": theme,
        "width": width,
        "shot": f"shots/{shot.name}",
        "cls": metrics["cls"],
        "issues": found,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--source", action="store_true", help="sweep server.py from this tree")
    parser.add_argument("--mac", action="append", default=[], help="a built .app to sweep")
    parser.add_argument("--web", action="store_true", help="sweep the web build on dev-local")
    parser.add_argument("--url", action="append", default=[], help="name=url, read only")
    args = parser.parse_args()
    (args.out / "shots").mkdir(parents=True, exist_ok=True)
    starts = []
    if args.source:
        starts.append(start_source)
    for bundle in args.mac:
        starts.append(lambda b=Path(bundle).resolve(): start_mac(b))
    if args.web:
        starts.append(start_web)
    for item in args.url:
        name, url = item.split("=", 1)
        starts.append(lambda n=name, u=url.rstrip("/"): Target(n, u, readonly=True))
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for start in starts:
            target = start()
            try:
                results.append(sweep(target, args.out, browser))
                print(f"swept {target.name}: {len(results[-1]['rows'])} renders", flush=True)
            finally:
                target.close()
        browser.close()
    (args.out / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
