"""Featured templates on Find events and rich conference schedule views."""

from __future__ import annotations


def test_discover_template_fork_builds_schedule_views(empty_server, page):
    page.set_viewport_size({"width": 1440, "height": 950})
    page.goto(empty_server + "/")
    page.evaluate("() => localStorage.clear()")
    page.goto(empty_server + "/#/")
    page.wait_for_selector("#sidebar")

    page.locator(".hometabs").get_by_role("link", name="Find events").click()
    page.wait_for_selector(".featured-card")
    assert "AI Engineer World's Fair 2026" in page.locator(".featured-card").first.inner_text()
    assert "560 sessions" in page.locator(".featured-card").first.inner_text()
    # The internal discovery-source note is gone from the product.
    assert page.get_by_text("Discovery sources under review").count() == 0

    page.get_by_role("button", name="Add to My events").click()
    page.wait_for_url("**/#/2026-06-28-ai-engineer-world-s-fair-2026", timeout=15000)
    page.wait_for_selector(".conf-dashboard")
    assert "conflict slots" in page.locator(".conf-metrics").inner_text()
    assert page.locator(".schedule-slot").count() > 3

    first_star = page.locator(".session-card .icon-star").first
    first_star.click()
    page.locator('.conf-tab[data-view="agenda"]').click()
    page.wait_for_selector(".agenda-view .session-card")
    assert page.locator(".agenda-view .session-card").count() == 1

    page.locator('.conf-tab[data-view="speakers"]').click()
    page.wait_for_selector(".speaker-view")
    page.locator("#speakerSearch").fill("OpenAI")
    assert page.locator(".speaker-row").count() >= 1
