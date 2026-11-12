"""The Ledger's balance chart (AG Charts Community) over fixture wallet rows; nothing reaches a Router."""

from playwright.sync_api import expect

ME = {"email": "fixture@example.test", "workspaceId": "ws-1", "entitlements": {"plan": "free"}}
ROWS = [
    {
        "ref": "crd_1",
        "at": "2026-11-12T09:00:00Z",
        "reason": "grant",
        "charged": 2,
        "balanceAfter": 2,
    },
    {
        "ref": "use_1",
        "at": "2026-11-12T09:05:00Z",
        "reason": "charge",
        "charged": -0.0412,
        "balanceAfter": 1.9588,
        "model": "claude-opus-5-5",
        "inputTokens": 5200,
        "outputTokens": 640,
    },
    {
        "ref": "use_2",
        "at": "2026-11-12T09:20:00Z",
        "reason": "charge",
        "charged": -0.3101,
        "balanceAfter": 1.6487,
        "model": "claude-opus-5-5",
    },
    {
        "ref": "8XJ27461AB123456C",
        "at": "2026-11-12T10:00:00Z",
        "reason": "purchase",
        "charged": 5,
        "balanceAfter": 6.6487,
    },
    {
        "ref": "use_3",
        "at": "2026-11-12T10:30:00Z",
        "reason": "charge",
        "charged": -0.9,
        "balanceAfter": 5.7487,
    },
]


def _open_ledger(page, server, rows):
    page.add_init_script(
        "window.confnote = Object.assign(window.confnote || {}, { webMode: true });"
    )
    page.route("**/api/me", lambda route: route.fulfill(json=ME))
    page.route("**/api/wallet/usage*", lambda route: route.fulfill(json={"rows": rows}))
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(str(server) + "/#/")
    page.wait_for_selector(".drawer-tab[data-id='aggrid']")
    page.locator(".drawer-tab[data-id='aggrid']").click()
    page.locator(".grids-tabs").get_by_role("tab", name="Ledger").click()


def test_ledger_chart_draws_the_balance_over_time(page, confnote_server):
    _open_ledger(page, confnote_server, ROWS)
    chart = page.locator(".grids-chart")
    expect(chart.locator("canvas").first).to_be_visible(timeout=10000)
    assert page.evaluate("typeof window.agCharts?.AgCharts?.create") == "function"
    expect(page.locator(".grids-status")).to_contain_text("5 entries")
    # Back to Events: the chart steps aside.
    page.locator(".grids-tabs").get_by_role("tab", name="Events").click()
    expect(chart).to_be_hidden()


def test_ledger_chart_empty_state(page, confnote_server):
    _open_ledger(page, confnote_server, [])
    expect(page.locator(".grids-chart.empty")).to_have_text(
        "The balance chart appears with your first ledger entry."
    )
