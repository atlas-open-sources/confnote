"""Concierge import → UI navigation (the `conference_imported` stream path).

When the concierge imports a conference, the server emits a `conference_imported`
stream event and the client navigates to / renders the new conference. That path
runs through /api/chat/global (the live agent), which e2e avoids — so we exercise
it deterministically: import via the SAME create API `add_conference` uses, then
fire the client handler the stream would call.

Isolation: a function-scoped EMPTY vault that is torn down after the test (server
terminated + tmp vault removed). The developer's real vault is never touched.
"""

import json
from pathlib import Path

SEED = Path(__file__).with_name("seed-agenda.json")


def test_import_then_conference_imported_navigates(empty_server, page):
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(empty_server + "/")
    page.evaluate("() => localStorage.clear()")
    page.goto(empty_server + "/#/")
    page.wait_for_selector("#sidebar")
    page.wait_for_selector("#sidebar .empty")

    # Fresh vault → the home sidebar shows the empty state.
    assert "No events yet" in page.locator("#sidebar").inner_text()

    # Import a conference exactly the way the agent's add_conference does — the
    # /api/conferences create API (deterministic; no live agent involved).
    agenda = json.loads(SEED.read_text())
    res = page.evaluate(
        """async (a) => {
            const r = await fetch('/api/conferences', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(a),
            });
            return { status: r.status, body: await r.json() };
        }""",
        agenda,
    )
    assert res["status"] == 201, res
    slug = res["body"]["slug"]
    assert slug == "2026-05-19-beyond-the-prompt"

    # Fire the stream event the concierge emits on import; the client should
    # navigate to the new conference and render its agenda rail.
    page.evaluate("(s) => window.confnote.handleConferenceImported({ slug: s })", slug)
    page.wait_for_url(f"**/#/{slug}")
    page.wait_for_selector(".rail")
    assert "Beyond The Prompt" in page.locator("#crumbs").inner_text()
    # Every agenda row is imported (logistics included) — Registration shows up.
    assert page.locator(".rl-row", has_text="Registration and Coffee").count() == 1


def test_import_appears_in_home_sidebar_on_refresh(empty_server, page):
    """Belt-and-braces: after import, the home conferences list reflects it on
    a normal home re-render (the path a user hits without the stream event)."""
    page.set_viewport_size({"width": 1400, "height": 900})
    page.goto(empty_server + "/")
    page.evaluate("() => localStorage.clear()")
    page.goto(empty_server + "/#/")
    page.wait_for_selector("#sidebar")

    agenda = json.loads(SEED.read_text())
    status = page.evaluate(
        """async (a) => (await fetch('/api/conferences', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(a),
        })).status""",
        agenda,
    )
    assert status == 201

    # Reload home → the sidebar refetches /api/conferences and lists the import.
    page.reload()
    page.wait_for_selector(".sb-conf")
    assert "Beyond The Prompt" in page.locator("#sidebar").inner_text()
    assert "No events yet" not in page.locator("#sidebar").inner_text()
