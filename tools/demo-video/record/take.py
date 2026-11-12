"""Playwright helpers for recording confnote demo takes (import this from a take script).

A take reuses a signed-in session (signin.py), so no sign-in screen or code is ever recorded. The account email
is smudged on screen by an injected style (a redaction, like a blur in post); nothing else on the page changes.
Every helper waits on the app's own signals rather than fixed sleeps; `beat()` adds reading pauses only when
recording.
"""

import json
import os
import time
from pathlib import Path

from playwright.sync_api import BrowserContext, Page

BASE = os.environ.get("CONFNOTE_DEMO_BASE", "https://staging.confnote.si")
VIEWPORT = {"width": 1920, "height": 1080}
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/142.0.0.0 Safari/537.36"
)
WIDE_DRAWER_PX = 900
# The Account & AI panel prints "<email> · <plan>" in its first paragraph.
SMUDGE_EMAIL = (
    ".product-account .product-controls > p:first-of-type"
    " { color: transparent !important; text-shadow: 0 0 14px rgba(237,237,237,.6) !important; }"
)
TURN_COUNTER = "window.addEventListener('confnote-concierge-turn', () => { window.__turns = (window.__turns || 0) + 1; });"


class Take:
    """One recording: a context on a saved session, a timeline of marks and the evidence it gathers."""

    def __init__(self, browser, state: Path, out: Path, record: bool):
        self.out = out
        self.record = record
        self.t0 = time.time()
        self.timeline: list[dict] = []
        self.evidence: dict = {"base": BASE}
        out.mkdir(parents=True, exist_ok=True)
        options = {
            "viewport": VIEWPORT,
            "screen": VIEWPORT,  # native fullscreen (the tldraw canvas) fills the recorded 1080p, not an 800x600 screen
            "color_scheme": "dark",
            "user_agent": USER_AGENT,
            "storage_state": str(state),
        }
        if record:
            options |= {"record_video_dir": str(out / "video"), "record_video_size": VIEWPORT}
        self.context: BrowserContext = browser.new_context(**options)
        self.context.add_init_script(TURN_COUNTER)
        self.context.add_init_script(
            "document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style');"
            f" s.textContent = {json.dumps(SMUDGE_EMAIL)}; document.head.append(s); }});"
        )
        self.page: Page = self.context.new_page()
        self.videos: dict[str, str] = {}

    # ---- bookkeeping

    def mark(self, label: str) -> None:
        """A timeline mark; video time is close to the mark's time (the video starts with the page)."""
        t = round(time.time() - self.t0, 2)
        self.timeline.append({"t": t, "label": label})
        print(f"[{t:6.1f}s] {label}", flush=True)

    def beat(self, ms: int = 1200) -> None:
        if self.record:
            time.sleep(ms / 1000)

    def typing(self, ms: int) -> int:
        return ms if self.record else 0

    def shot(self, name: str) -> None:
        self.page.screenshot(path=str(self.out / name))

    def api(self, path: str) -> dict:
        return self.page.evaluate(
            "async (p) => { const r = await fetch(p); return {status: r.status, body: await r.json().catch(() => null)}; }",
            path,
        )

    def balance(self) -> int:
        return self.api("/api/wallet")["body"]["available"]

    def close(self) -> None:
        (self.out / "timeline.json").write_text(json.dumps(self.timeline, indent=2))
        (self.out / "evidence.json").write_text(json.dumps(self.evidence, indent=2))
        if self.record:
            self.videos["main"] = str(self.page.video.path())
        self.context.close()
        (self.out / "videos.json").write_text(json.dumps(self.videos, indent=2))

    # ---- app helpers

    def drawer(self, name: str) -> None:
        tab = self.page.locator(".drawer-tab", has_text=name)
        if (
            tab.get_attribute("aria-selected") != "true"
            and "on" not in (tab.get_attribute("class") or "").split()
        ):
            tab.click()
        self.beat(800)

    def close_drawer(self) -> None:
        close = self.page.locator(".drawer-x:visible")
        if close.count():
            close.first.click()
            self.beat(500)

    def widen_drawer(self) -> None:
        # Let the drawer finish sliding in before measuring its grip.
        self.page.wait_for_timeout(700)
        grip = self.page.locator(".drawer-grip:visible").first.bounding_box()
        if not grip:
            return
        x, y = grip["x"] + grip["width"] / 2, grip["y"] + grip["height"] / 2
        current = self.page.evaluate(
            "() => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--drawer-w')) || 480"
        )
        self.page.mouse.move(x, y)
        self.page.mouse.down()
        self.page.mouse.move(x - (WIDE_DRAWER_PX - current), y, steps=20 if self.record else 2)
        self.page.mouse.up()
        self.beat(600)

    def send(self, text: str, paste: bool = False, timeout_ms: int = 240_000) -> None:
        """Type (or paste) into the Concierge and wait for its turn to finish."""
        self.drawer("Concierge")
        box = self.page.locator("#text-input:visible").first
        box.click()
        if paste:
            box.fill(text)
            self.beat(1200)
        else:
            box.type(text, delay=self.typing(22))
        turns = self.page.evaluate("() => window.__turns || 0")
        box.press("Enter")
        self.page.wait_for_function(f"() => (window.__turns || 0) > {turns}", timeout=timeout_ms)

    def open_account(self) -> None:
        if self.page.locator(".product-account[open]").count() == 0:
            self.page.locator(".product-account summary").click()
        self.page.wait_for_function(
            "() => /AI credits: \\$/.test(document.querySelector('.product-account')?.textContent || '')",
            timeout=20_000,
        )

    def close_account(self) -> None:
        if self.page.locator(".product-account[open]").count():
            self.page.locator(".product-account summary").click()

    def grid(self, tab: str) -> None:
        """Open a Grids tab. The drawer's first load must settle first, or a tab click races it."""
        self.drawer("Grids")
        self.page.wait_for_function(
            "() => /rows|Sign in|Could not/.test(document.querySelector('.grids-status')?.textContent || '')",
            timeout=60_000,
        )
        self.page.wait_for_timeout(1000)
        self.page.locator(".grids-tab", has_text=tab).click()
        self.page.wait_for_function(
            "() => /[1-9]\\d* rows/.test(document.querySelector('.grids-status')?.textContent || '')",
            timeout=90_000,
        )
