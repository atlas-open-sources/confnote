"""Grids (AG Grid Community) drawer module e2e.

Opens the drawer, lists an open action across conferences, ticks it through
the grid's Done checkbox and checks the note's markdown is what changed.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from playwright.sync_api import expect

SLUG = "2026-05-19-beyond-the-prompt"
NOTE = "0940-opening-keynote.md"
ACTION = "Email the grid booth about the community licence"
SHOTS = os.environ.get("CONFNOTE_GRID_SHOTS")


def _note(app, server):
    return app.request.get(f"{server}/api/note?slug={SLUG}&file={NOTE}").json()


def _put_actions(app, text):
    # In-page fetch: the server only accepts writes that originate in confnote.
    status = app.evaluate(
        """async ([url, body]) => (await fetch(url, {
            method: 'PUT', headers: {'Content-Type': 'application/json'}, body,
        })).status""",
        [f"/api/note?slug={SLUG}&file={NOTE}", json.dumps({"sections": {"Actions": text}})],
    )
    assert status == 200


def _open_grids(app):
    app.evaluate(f"() => {{ location.hash = '#/{SLUG}/{NOTE}'; }}")
    app.wait_for_selector(".drawer-tab[data-id='aggrid']")
    app.locator(".drawer-tab[data-id='aggrid']").click()
    app.wait_for_function("() => document.getElementById('drawerHost')?.classList.contains('open')")
    app.wait_for_function("() => typeof window.agGrid?.createGrid === 'function'", timeout=10000)


def test_grids_handle_registers_and_lazy_loads(app):
    """The bundle is not in the initial payload; opening the drawer loads it."""
    assert app.evaluate("() => typeof window.agGrid") == "undefined"
    _open_grids(app)
    app.wait_for_selector(".grids-grid .ag-root-wrapper")
    tabs = app.locator(".grids-tab").all_inner_texts()
    assert tabs == ["Actions", "Events", "Ledger"]


def test_grid_done_ticks_action_through_existing_path(app, confnote_server):
    server = confnote_server.url
    original = _note(app, server).get("sections", {}).get("Actions", "")
    _put_actions(app, f"- [ ] {ACTION}\n")
    try:
        if SHOTS:
            # Before: the hand-rolled per-conference Actions modal.
            Path(SHOTS).mkdir(parents=True, exist_ok=True)
            app.emulate_media(color_scheme="dark")
            app.evaluate(f"() => {{ location.hash = '#/{SLUG}/{NOTE}'; }}")
            app.locator(".agenda-actions").click()
            app.wait_for_selector("#debriefModal .actionlist")
            app.screenshot(path=str(Path(SHOTS) / "before-actions-modal.png"))
            app.keyboard.press("Escape")
        _open_grids(app)
        row = app.locator(".grids-grid .ag-row", has_text=ACTION)
        row.wait_for(timeout=10000)
        if SHOTS:
            app.wait_for_timeout(500)  # let the drawer finish sliding in
            app.screenshot(path=str(Path(SHOTS) / "after-actions-grid.png"))
        row.locator("input.grids-done").check()
        app.wait_for_function(
            "(text) => ![...document.querySelectorAll('.grids-grid .ag-row')]"
            ".some((r) => r.textContent.includes(text))",
            arg=ACTION,
            timeout=10000,
        )
        assert f"- [x] {ACTION}" in _note(app, server)["sections"]["Actions"]
    finally:
        _put_actions(app, original)


def test_grid_events_and_ledger_views_render(app):
    if SHOTS:
        app.emulate_media(color_scheme="dark")
    _open_grids(app)
    app.locator(".grids-tab[data-view='events']").click()
    app.wait_for_selector(".grids-grid[data-view='events'] .ag-header-cell[col-id='start']")
    # The default drawer is narrow: its key columns fit the width, the rest are hidden, nothing scrolls.
    # The fit runs on AG Grid's size event, after the first header render: wait for it.
    expect(app.locator(".grids-grid .ag-header-cell[col-id='city']")).to_have_count(0)
    app.wait_for_function(
        "() => { const v = document.querySelector('.grids-grid .ag-body-horizontal-scroll-viewport');"
        " return v && v.scrollWidth <= v.clientWidth + 1; }"
    )
    if SHOTS:
        app.screenshot(path=str(Path(SHOTS) / "after-events-grid.png"))
    app.locator(".grids-tab[data-view='ledger']").click()
    app.wait_for_selector(".grids-grid[data-view='ledger'] .ag-header-cell[col-id='amount']")
    # The Mac app has no wallet (no /api/wallet/usage): the panel says the ledger is hosted.
    expect(app.locator(".grids-status")).to_contain_text("hosted app")
    if SHOTS:
        app.screenshot(path=str(Path(SHOTS) / "after-usage-grid.png"))


# The hosted Router wallet ledger, newest first, over two pages (`next` cursor),
# as packages/web-app/lib/product.ts usageRows() answers it.
LEDGER_PAGES = {
    "": {
        "rows": [
            {
                "at": "2026-11-12T10:05:00Z",
                "reason": "charge",
                "model": "claude-sonnet-4-6",
                "inputTokens": 5200,
                "outputTokens": 410,
                "charged": "-0.0216",
                "balanceAfter": "14.9584",
                "unit": "USD",
                "ref": "crd_9f2c11aa",
            },
            {
                "at": "2026-11-12T10:00:00Z",
                "reason": "grant",
                "model": None,
                "charged": "10.0000",
                "balanceAfter": "14.9800",
                "unit": "USD",
                "ref": "82K50813R58218109",
                "auto": True,
            },
            {
                "at": "2026-11-11T18:30:00Z",
                "reason": "promo",
                "model": None,
                "charged": "2.0000",
                "balanceAfter": "4.9800",
                "unit": "USD",
                "ref": "crd_promo0001",
            },
        ],
        "next": "page2",
    },
    "page2": {
        "rows": [
            {
                "at": "2026-11-11T09:00:00Z",
                "reason": "charge",
                "model": '=HYPERLINK("x")',
                "charged": "-0.0200",
                "balanceAfter": "2.9800",
                "unit": "USD",
                "ref": "crd_aa00bb11",
            },
            {
                "at": "2026-11-10T09:00:00Z",
                "reason": "grant",
                "model": None,
                "charged": "3.0000",
                "balanceAfter": "3.0000",
                "unit": "USD",
                "ref": "5O190127TN364715T",
            },
        ],
    },
}


def _stub_ledger(app):
    def handle(route):
        from urllib.parse import parse_qs, urlparse

        cursor = parse_qs(urlparse(route.request.url).query).get("cursor", [""])[0]
        route.fulfill(
            status=200, content_type="application/json", body=json.dumps(LEDGER_PAGES[cursor])
        )

    app.route("**/api/wallet/usage*", handle)


def test_ledger_grid_reads_every_page_sorts_filters_and_exports_csv(app):
    _stub_ledger(app)
    app.evaluate("() => localStorage.setItem('confnote-drawer-w', '900')")
    app.reload()
    if SHOTS:
        app.emulate_media(color_scheme="dark")
    _open_grids(app)
    app.locator(".grids-tab[data-view='ledger']").click()
    app.wait_for_selector(".grids-grid[data-view='ledger'] .ag-header-cell[col-id='paypalOrder']")
    # Both pages, newest first, with a balance and totals in the status line.
    expect(app.locator(".grids-grid .ag-row")).to_have_count(5)
    status = app.locator(".grids-status").inner_text()
    assert "5 entries" in status and "balance $14.96" in status
    assert "added $15.00" in status and "spent $0.0416" in status
    first = app.locator(".grids-grid .ag-row[row-index='0']")
    expect(first.locator("[col-id='kind']")).to_have_text("Usage step")
    expect(first.locator("[col-id='amount']")).to_have_text("−$0.0216")
    expect(first.locator("[col-id='step']")).to_have_text("claude-sonnet-4-6 · 5.2k in / 410 out")
    auto = app.locator(".grids-grid .ag-row[row-id='82K50813R58218109']")
    expect(auto.locator("[col-id='kind']")).to_have_text("Auto top-up")
    expect(auto.locator("[col-id='paypalOrder']")).to_have_text("82K50813R58218109")
    bonus = app.locator(".grids-grid .ag-row[row-id='crd_promo0001']")
    expect(bonus.locator("[col-id='kind']")).to_have_text("Bonus")
    expect(bonus.locator("[col-id='paypalOrder']")).to_have_text("")
    if SHOTS:
        app.screenshot(path=str(Path(SHOTS) / "after-ledger-grid.png"))

    # Sort by amount: the largest top-up first after two clicks (asc, then desc).
    header = app.locator(".grids-grid .ag-header-cell[col-id='amount'] .ag-header-cell-label")
    header.click()
    header.click()
    expect(app.locator(".grids-grid .ag-row[row-index='0'] [col-id='amount']")).to_have_text(
        "+$10.00"
    )

    # The quick filter narrows to one kind; CSV exports exactly what is shown.
    app.locator(".grids-quick").fill("Top-up")
    expect(app.locator(".grids-grid .ag-row")).to_have_count(2)
    with app.expect_download() as download:
        app.locator(".grids-csv").click()
    path = download.value.path()
    assert download.value.suggested_filename.startswith("confnote-ledger-")
    lines = Path(path).read_text(encoding="utf-8-sig").strip().splitlines()
    assert lines[0].startswith(
        '"Date","Kind","Amount","Balance after","Model / step","PayPal order","Short"'
    )
    assert len(lines) == 3
    assert (
        lines[1]
        == '"2026-11-12T10:00:00Z","Auto top-up","10","14.98","","82K50813R58218109","58218109"'
    )
    # A cell a spreadsheet would run as a formula is exported as text.
    app.locator(".grids-quick").fill("HYPERLINK")
    with app.expect_download() as download:
        app.locator(".grids-csv").click()
    exported = Path(download.value.path()).read_text(encoding="utf-8-sig")
    assert "'=HYPERLINK" in exported and ',"=HYPERLINK' not in exported


HOSTILE_NAME = '<img src=x onerror="window.__gridXss=1"><script>window.__gridXss=2</script>'
HOSTILE_CATALOGUE = {
    "schema_version": "confnote.events.v1",
    "events": [
        {
            "id": "evt-js-url",
            "name": HOSTILE_NAME,
            "start": "2099-01-01",
            "end": "2099-01-02",
            "url": "javascript:window.__gridXss=3",
            "organizers": ['<img src=x onerror="window.__gridXss=4">'],
        },
        {
            "id": "evt-http",
            "name": "Safe link",
            "start": "2099-01-03",
            "end": "2099-01-03",
            "url": "https://example.org/event",
        },
    ],
}


def test_events_grid_renders_scraped_text_and_urls_inertly(app):
    """The catalogue is scraped: markup stays text and only http(s) URLs link."""
    app.route(
        "**/api/catalogue",
        lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps(HOSTILE_CATALOGUE)
        ),
    )
    _open_grids(app)
    app.locator(".grids-tab[data-view='events']").click()
    app.locator(".grids-grid .ag-row", has_text="Safe link").wait_for(timeout=10000)
    grid = app.locator(".grids-grid")
    assert grid.locator("img, script").count() == 0
    assert grid.locator("a[href^='javascript' i]").count() == 0
    assert grid.locator("a[href='https://example.org/event']").count() == 1
    assert grid.get_by_text(HOSTILE_NAME, exact=True).count() == 1
    app.wait_for_timeout(200)  # give any injected handler a chance to fire
    assert app.evaluate("() => window.__gridXss") is None


def _rows_text(app):
    return app.evaluate(
        "() => [...document.querySelectorAll('.grids-grid .ag-center-cols-container .ag-row')]"
        ".map((r) => r.textContent)"
    )


def test_stale_grid_refuses_to_tick_a_different_action(app, confnote_server):
    """Done carries the action text: a stale row position must not complete a neighbour."""
    server = confnote_server.url
    original = _note(app, server).get("sections", {}).get("Actions", "")
    _put_actions(app, "- [ ] Alpha task\n- [ ] Bravo task\n- [ ] Charlie task\n")
    try:
        _open_grids(app)
        app.locator(".grids-grid .ag-row", has_text="Alpha task").wait_for(timeout=10000)
        # The note changes behind the grid: Bravo moves from open position 1 to 0.
        _put_actions(app, "- [ ] Bravo task\n- [ ] Charlie task\n")
        # The shared helper refuses a mismatched identity without writing.
        assert (
            app.evaluate(
                "([s, n]) => window.confnote.tickAction(s, n, 0, 'Charlie task')", [SLUG, NOTE]
            )
            is False
        )
        app.locator(".grids-grid .ag-row", has_text="Bravo task").locator(
            "input.grids-done"
        ).check()
        app.wait_for_function(
            "() => ![...document.querySelectorAll('.grids-grid .ag-row')]"
            ".some((r) => r.textContent.includes('Alpha task'))",
            timeout=10000,
        )
        assert _note(app, server)["sections"]["Actions"].strip() == (
            "- [ ] Bravo task\n- [ ] Charlie task"
        )
        # The reloaded row now ticks the right line.
        app.locator(".grids-grid .ag-row", has_text="Bravo task").locator(
            "input.grids-done"
        ).check()
        app.wait_for_function(
            "() => ![...document.querySelectorAll('.grids-grid .ag-row')]"
            ".some((r) => r.textContent.includes('Bravo task'))",
            timeout=10000,
        )
        actions = _note(app, server)["sections"]["Actions"]
        assert "- [x] Bravo task" in actions and "- [ ] Charlie task" in actions
    finally:
        _put_actions(app, original)


def test_failed_tracking_save_rolls_back_without_reposting(app):
    posts = []

    def tracking(route):
        if route.request.method == "POST":
            posts.append(route.request.post_data)
            route.fulfill(status=500, content_type="application/json", body="{}")
        else:
            route.fulfill(status=200, content_type="application/json", body="{}")

    app.route("**/api/tracking", tracking)
    app.route(
        "**/api/catalogue",
        lambda route: route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps({"events": HOSTILE_CATALOGUE["events"][1:]}),
        ),
    )
    _open_grids(app)
    app.locator(".grids-tab[data-view='events']").click()
    cell = app.locator(".grids-grid .ag-row", has_text="Safe link").locator("[col-id='status']")
    cell.wait_for(timeout=10000)
    cell.click()
    cell.locator(".ag-picker-field-wrapper").click()
    app.locator(".ag-select-list .ag-list-item", has_text="interested").click()
    app.wait_for_timeout(1500)  # a re-POST loop would show up within this window
    assert len(posts) == 1
    assert json.loads(posts[0])["status"] == "interested"
    assert cell.inner_text().strip() == "—"


def test_a_tab_clicked_mid_load_wins_over_the_first_load(app):
    """The Actions load is slow; Events is clicked before it lands. Only the Events grid mounts."""
    import time

    def slow_conferences(route):
        time.sleep(1.5)
        route.continue_()

    app.route("**/api/conferences", slow_conferences)
    app.evaluate(f"() => {{ location.hash = '#/{SLUG}/{NOTE}'; }}")
    app.wait_for_selector(".drawer-tab[data-id='aggrid']")
    app.locator(".drawer-tab[data-id='aggrid']").click()
    app.locator(".grids-tab[data-view='events']").click()
    app.wait_for_selector(".grids-grid[data-view='events'] .ag-header-cell[col-id='start']")
    app.wait_for_timeout(2500)  # the superseded Actions load lands in this window
    assert app.locator(".grids-grid").get_attribute("data-view") == "events"
    assert app.locator(".grids-grid .ag-root-wrapper").count() == 1
    assert app.locator(".grids-grid .ag-header-cell[col-id='text']").count() == 0
    app.unroute("**/api/conferences")
