"""Every core screen of the local app loads without a failed request or console error.

A 404 on a probe the local server never answers (it once asked /api/me on every
load) shows as a red console line in the Mac app's inspector and hides real errors.
"""

import pytest

SETTLE_MS = 2000  # startup fetches finish well inside this; the app polls, so never networkidle
SLUG = "2026-05-19-beyond-the-prompt"
# screen -> (hash route, selector that means it rendered)
SCREENS = {
    "home": ("#/", "#sidebar .sb-conf"),
    "find-events": ("#/~find", "#findEventsView"),
    "conference": (f"#/{SLUG}", ".rail"),
}


@pytest.mark.parametrize("screen", SCREENS)
def test_screen_loads_clean(confnote_server, page, screen):
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on(
        "response", lambda r: errors.append(f"HTTP {r.status} {r.url}") if r.status >= 400 else None
    )
    page.set_viewport_size({"width": 1440, "height": 900})
    route, rendered = SCREENS[screen]
    page.goto(confnote_server + "/" + route)
    page.wait_for_selector(rendered)
    page.wait_for_timeout(SETTLE_MS)
    assert not errors, errors
