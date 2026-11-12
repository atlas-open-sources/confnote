"""Planner (bryntum) drawer module: registration + the three views.

Loads the real Bryntum vendor bundle (trial mode: no license.local.js in the
test server). The catalogue is replaced with fixture events so the trip view
is deterministic; the conference day view uses the seeded Beyond The Prompt
agenda, and OpenAI DevDay 2026 (tools/devday-2026.json) imported into a fresh
vault for parallel talks. Day picks are the agenda's stars, tested both ways.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import pytest
from playwright.sync_api import expect

REPO = Path(__file__).resolve().parents[2]
STATIC = REPO / "packages/core-ui/static"
MODULE_DIR = STATIC / "modules/bryntum"
SLUG = "2026-05-19-beyond-the-prompt"
# Set to a folder to keep a screenshot of each view (review artefacts).
SHOTS = os.environ.get("BRYNTUM_SHOTS")

FIXTURE_EVENTS = [
    {
        "id": "evt-a",
        "name": "River builders",
        "format": "meetup",
        "start": "2099-06-10",
        "end": "2099-06-11",
        "city": "London",
        "country": "GB",
        "applications": [{"type": "cfp", "deadline": "2099-06-01T23:59:00Z"}],
    },
    {
        "id": "evt-b",
        "name": "Small systems",
        "format": "conference",
        "start": "2099-06-11",
        "end": "2099-06-12",
        "city": "London",
        "country": "GB",
    },
    {
        "id": "evt-c",
        "name": "Open web",
        "format": "conference",
        "start": "2099-06-14",
        "end": "2099-06-14",
        "city": "London",
        "country": "GB",
    },
    {
        "id": "evt-d",
        "name": "Elsewhere",
        "format": "conference",
        "start": "2099-06-11",
        "end": "2099-06-11",
        "city": "Berlin",
        "country": "DE",
    },
]


def _slots() -> list[str]:
    return json.loads((STATIC / "modules.config.json").read_text()).get("slots") or []


pytestmark = pytest.mark.skipif(
    "bryntum" not in _slots(), reason="bryntum module is toggled off in modules.config.json"
)


@pytest.fixture(scope="module", autouse=True)
def _bundle_built():
    # The bundle is built by `make bryntum`, never committed: fail loudly, never skip.
    if not (MODULE_DIR / "vendor/bryntum-island.bundle.js").is_file():
        pytest.fail(
            "Bryntum bundle missing: run `make bryntum` (npm ci --ignore-scripts + npm run build in the module's build/)"
        )


# Catalogue and agenda strings are scraped, so they are untrusted.
PAYLOAD = '<img src=x onerror="window.__pwned=1">'
HOSTILE_EVENT = {
    "id": "evt-x",
    "name": PAYLOAD + "Hostile",
    "format": PAYLOAD,
    "start": "2099-06-10",
    "end": "2099-06-10",
    "city": "London",
    "country": "GB",
    "applications": [{"type": PAYLOAD, "deadline": "2099-06-02T00:00:00Z"}],
}


def _json_route(page, pattern: str, payload):
    page.route(
        pattern,
        lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps(payload)
        ),
    )


def _open_planner(page, view: str, trip: dict | None = None, events=None):
    _json_route(page, "**/api/catalogue", {"schema_version": 1, "events": events or FIXTURE_EVENTS})
    page.evaluate(
        """([view, trip]) => {
            localStorage.setItem('confnote-planner-view-v2', view);
            localStorage.setItem('confnote-trip', JSON.stringify(trip ? [trip] : []));
            localStorage.setItem('confnote-event-tracking', JSON.stringify({ 'evt-a': 'going', 'evt-c': 'interested' }));
        }""",
        [view, trip],
    )
    page.emulate_media(color_scheme="dark")
    page.reload()
    page.wait_for_selector("#sidebar")
    page.evaluate(f"() => {{ location.hash = '#/{SLUG}/0940-opening-keynote.md'; }}")
    page.wait_for_selector(".drawer-tab[data-id='bryntum']", timeout=4000)
    page.locator(".drawer-tab[data-id='bryntum']").click()
    page.wait_for_function(
        "() => document.getElementById('drawerHost')?.classList.contains('open')", timeout=3000
    )


def _shot(page, name: str):
    if SHOTS:
        page.wait_for_timeout(500)
        page.screenshot(path=str(Path(SHOTS) / f"{name}.png"))


def test_trip_days_stay_readable_in_the_default_drawer(app):
    """A week doesn't fit the default drawer at a readable day width: it scrolls, on a one-line toolbar."""
    _open_planner(app, "trip", {"city": "London", "from": "2099-06-09", "to": "2099-06-15"})
    app.wait_for_selector(".cn-bry .b-sch-event", timeout=15000)
    widths = app.evaluate(
        "() => [...document.querySelectorAll('.cn-bry .b-sch-event')]"
        ".map((e) => e.getBoundingClientRect().width)"
    )
    assert min(widths) >= 80
    toolbar = app.locator(".cn-bry-bar").bounding_box()
    date_to = app.locator(".cn-bry-trip [name='to']").bounding_box()
    assert date_to["y"] < toolbar["y"] + 10  # the "to" date sits on the first line


def test_trip_view_renders_fixture_events_with_clash(app):
    # The whole week fits a widened drawer, so every bar renders at once.
    app.evaluate("() => localStorage.setItem('confnote-drawer-w', '900')")
    _open_planner(app, "trip", {"city": "London", "from": "2099-06-09", "to": "2099-06-15"})
    app.wait_for_selector(".cn-bry .b-sch-event", timeout=15000)
    names = app.locator(".cn-bry .b-sch-event-wrap").all_inner_texts()
    assert sorted(n.strip() for n in names) == ["Open web", "River builders", "Small systems"]
    # River builders (10–11) and Small systems (11–12) share the 11th.
    assert app.locator(".cn-bry .b-sch-event.cn-clash").count() == 2
    assert "2 clashing" in app.locator(".cn-bry-msg").inner_text()
    _shot(app, "after-trip-view")

    app.locator(".cn-bry .b-sch-event-wrap", has_text="Open web").click()
    app.wait_for_function(
        "() => JSON.parse(localStorage.getItem('confnote-event-tracking'))['evt-c'] === 'going'"
    )
    assert "Going to Open web" in app.locator(".cn-bry-msg").inner_text()


def _session(page, title: str):
    return page.locator(".cn-bry .b-cal-event-wrap", has_text=title).first


def _stars(page, slug: str = SLUG) -> list:
    return page.evaluate("(slug) => window.confnote.stars.list(slug).sort()", slug)


def _saved_picks(vault, slug: str = SLUG) -> list:
    """The picks as the notebook holds them: `attending: true` in each note's frontmatter."""
    return sorted(
        note.name
        for note in (vault / slug / "notes").glob("*.md")
        if "\nattending: true\n" in note.read_text().partition("\n---\n")[0] + "\n"
    )


def test_day_view_is_the_conference_programme_by_room(app):
    _open_planner(app, "day")
    app.wait_for_selector(".cn-bry .b-cal-event-wrap", timeout=15000)
    # The conference views come first (Rooms, Day); Trip is secondary.
    tabs = [t.strip() for t in app.locator(".cn-bry-tab").all_inner_texts()]
    assert tabs == ["Rooms", "Day", "Trip", "Calendar"]
    rooms = [
        t.strip()
        for t in app.locator(
            ".cn-bry .b-day-resource-calendar-row-resource-name"
        ).all_text_contents()
    ]
    assert "Auditorium" in rooms and "Hasslett" in rooms
    assert app.locator(".cn-bry .b-cal-event-wrap").count() > 5
    # Talks are picks; registration and coffee are not, as in the sidebar.
    assert "cn-pick" in _session(app, "Opening Keynote").get_attribute("class")
    assert "cn-rest" in _session(app, "Coffee Break").get_attribute("class")
    _shot(app, "after-conference-day")


OLD_MY_DAY_BRIEF = """# Brief

## My day goals

- Meet the speaker <!-- id:welcome -->

## My day

- 09:40 Opening Keynote · Auditorium <!-- id:opening-keynote -->
- 10:10 Goodbye slop; welcome determinism · Auditorium <!-- id:goodbye-slop -->

## Notes

Keep this.
"""


def test_old_my_day_picks_become_stars_once(app, confnote_server):
    """The old Day view's "## My day" list in BRIEF.md becomes stars on the first open, and only then."""
    brief_path = confnote_server.vault / SLUG / "BRIEF.md"
    original = brief_path.read_text() if brief_path.exists() else None
    brief_path.write_text(OLD_MY_DAY_BRIEF)
    try:
        _open_planner(app, "day")
        _session(app, "Opening Keynote").wait_for(timeout=15000)
        app.wait_for_function(f"() => window.confnote.stars.list('{SLUG}').length === 2")
        # Both My day sessions; "## My day goals" (welcome) is a different section.
        assert sorted(_stars(app)) == ["0940-opening-keynote.md", "1010-goodbye-slop.md"]
        assert "cn-picked" in _session(app, "Opening Keynote").get_attribute("class")
        assert app.locator("#railTrack .rl-row.starred").count() == 2
        assert brief_path.read_text() == OLD_MY_DAY_BRIEF  # the brief is left as it was

        # Unpick one; reopening the Day view does not bring it back.
        _session(app, "Opening Keynote").click()
        app.wait_for_function(f"() => window.confnote.stars.list('{SLUG}').length === 1")
        app.locator(".cn-bry-tab[data-view='trip']").click()
        app.locator(".cn-bry-tab[data-view='day']").click()
        _session(app, "Opening Keynote").wait_for(timeout=15000)
        app.wait_for_timeout(500)
        assert _stars(app) == ["1010-goodbye-slop.md"]
    finally:
        if original is None:
            brief_path.unlink(missing_ok=True)
        else:
            brief_path.write_text(original)


def test_pick_in_the_planner_stars_the_agenda(app, confnote_server):
    """Bryntum → app: a pick is the agenda's star, and the sidebar and the open note follow at once."""
    _open_planner(app, "day")
    keynote = _session(app, "Opening Keynote")
    keynote.wait_for(timeout=15000)
    keynote.click()
    app.wait_for_function(
        f"() => window.confnote.stars.list('{SLUG}').includes('0940-opening-keynote.md')"
    )
    # Bryntum repaints the record a frame after the star is written: wait for it.
    expect(keynote).to_have_class(re.compile(r"\bcn-picked\b"))
    expect(app.locator("#railTrack .rl-row.starred", has_text="Opening Keynote")).to_have_count(1)
    # The note on screen is the keynote: its Attend button turns on too.
    expect(app.locator(".ehead .attend-star")).to_contain_text("Attending")
    expect(app.locator(".cn-bry-msg")).to_contain_text("1 picked")
    # The pick is in the notebook, not in this browser.
    app.wait_for_function(
        f"async () => (await (await fetch('/api/picks?slug={SLUG}')).json()).notes.length === 1"
    )
    assert _saved_picks(confnote_server.vault) == ["0940-opening-keynote.md"]

    keynote.click()
    app.wait_for_function(
        f"() => !window.confnote.stars.list('{SLUG}').includes('0940-opening-keynote.md')"
    )
    # Bryntum repaints the record a frame after the star is written: wait for it.
    expect(keynote).not_to_have_class(re.compile(r"\bcn-picked\b"))
    assert app.locator("#railTrack .rl-row.starred").count() == 0
    # A break is never a pick.
    _session(app, "Coffee Break").click()
    assert _stars(app) == []


def test_star_in_the_agenda_fills_the_planner(app):
    """App → Bryntum: starring a session in the sidebar fills it in the open Day view."""
    _open_planner(app, "day")
    talk = _session(app, "Goodbye slop")
    talk.wait_for(timeout=15000)
    assert "cn-picked" not in talk.get_attribute("class")
    app.locator("#railTrack .rl-row", has_text="Goodbye slop").locator(".rl-star").click()
    app.wait_for_function(
        """() => document.querySelector('.cn-bry .b-cal-event-wrap[data-event-id="goodbye-slop"]')
            ?.classList.contains('cn-picked')"""
    )
    assert "★" in talk.inner_text()
    # Unstar from the dashboard's Schedule: the Planner follows that path too.
    app.evaluate(f"() => {{ location.hash = '#/{SLUG}'; }}")
    star = app.locator(".conf-dashboard [data-star='1010-goodbye-slop.md']").first
    star.wait_for(timeout=5000)
    star.click()
    app.wait_for_function(
        """() => !document.querySelector('.cn-bry .b-cal-event-wrap[data-event-id="goodbye-slop"]')
            ?.classList.contains('cn-picked')"""
    )


def test_pick_on_the_dashboard_view_updates_its_count(app):
    """A pick made in the Planner while the conference dashboard is open repaints its saved count."""
    _open_planner(app, "day")
    app.evaluate(f"() => {{ location.hash = '#/{SLUG}'; }}")
    app.wait_for_selector(".conf-dashboard")
    assert "0 saved" in app.locator(".conf-metrics").inner_text()
    _session(app, "Product Roadmap").click()
    app.wait_for_function(
        "() => document.querySelector('.conf-metrics')?.textContent.includes('1 saved')"
    )


# The showcase agendas, imported for real into a fresh vault: OpenAI DevDay 2026
# names no rooms (three parallel talks at 11:15, 12:00 and 14:15), AI Engineer
# Shanghai 2026 has two rooms on its first day and one on its second.
DEVDAY = REPO / "tools/devday-2026.json"
DEVDAY_SLUG = "2026-09-29-openai-devday-2026"


def _showcase_page(page, server, slug: str, view: str | None = "day"):
    import subprocess
    import sys

    subprocess.run(
        [sys.executable, str(REPO / "tools/import_agenda.py"), str(DEVDAY), str(server.vault)],
        check=True,
        capture_output=True,
    )
    page.set_viewport_size({"width": 1440, "height": 900})
    page.goto(server + "/")
    page.evaluate(
        """(view) => {
            if (view) localStorage.setItem('confnote-planner-view-v2', view);
            else localStorage.removeItem('confnote-planner-view-v2');
            localStorage.setItem('confnote-drawer-w', '900');
        }""",
        view,
    )
    page.goto(f"{server}/#/{slug}")
    page.reload()
    page.wait_for_selector(".drawer-tab[data-id='bryntum']", timeout=8000)
    page.locator(".drawer-tab[data-id='bryntum']").click()
    bars = ".cn-bry .b-cal-event-wrap" if view == "day" else ".cn-bry .b-sch-event"
    page.wait_for_selector(bars, timeout=15000)


def test_devday_parallel_talks_sit_side_by_side_and_clash_in_both_uis(empty_server, page):
    _showcase_page(page, empty_server, DEVDAY_SLUG)
    # No rooms in the agenda: one column, no room header, parallel talks side by side.
    assert page.locator(".cn-bry .b-day-resource-calendar-row-resource-name").count() == 0
    parallel = [
        _session(page, "What Will You Build"),
        _session(page, "What Comes After Loops"),
        _session(page, "Stack Overflow"),
    ]
    boxes = [p.bounding_box() for p in parallel]
    assert len({round(b["y"]) for b in boxes}) == 1
    assert len({round(b["x"]) for b in boxes}) == 3

    parallel[0].click()
    parallel[1].click()
    page.wait_for_function(
        "() => document.querySelectorAll('.cn-bry .b-cal-event-wrap.cn-clash').length === 2"
    )
    assert "2 clashing" in page.locator(".cn-bry-msg").inner_text()
    # The third talk at 11:15 overlaps a pick: dimmed, like the sidebar's skipped rows.
    assert "cn-skipped" in parallel[2].get_attribute("class")
    assert len(_stars(page, DEVDAY_SLUG)) == 2

    # The app shows the same clash: My Agenda lists it under "Conflicts to decide".
    page.evaluate(f"() => {{ location.hash = '#/{DEVDAY_SLUG}'; }}")
    page.locator(".conf-tab[data-view='agenda']").click()
    page.locator(".agenda-view h2", has_text="Conflicts to decide").wait_for(timeout=5000)
    assert page.locator(".agenda-view .conflict-group").count() == 1

    # "Only my picks" keeps just the two.
    page.locator(".cn-bry-action[data-action='mine']").click()
    page.wait_for_function(
        "() => document.querySelectorAll('.cn-bry .b-cal-event-wrap').length === 2"
    )


def _talk(page, title: str):
    return page.locator(".cn-bry[data-view='rooms'] .b-sch-event", has_text=title).first


def test_multitrack_day_opens_on_rooms_by_track_and_bands_the_clash(empty_server, page):
    """DevDay names no rooms but runs three talks at once: the Planner opens on Rooms, one row per track."""
    _showcase_page(page, empty_server, DEVDAY_SLUG, view=None)
    expect(page.locator(".cn-bry-tab[aria-selected='true']")).to_have_text("Rooms")
    rows = [
        t.strip()
        for t in page.locator(".cn-bry .b-grid-sub-grid-locked .b-grid-cell").all_text_contents()
    ]
    assert rows == ["Track 1", "Track 2", "Track 3"]
    # The three 11:15 talks start together, one per track; lunch is a band, not a bar.
    parallel = [
        _talk(page, "What Will You Build"),
        _talk(page, "What Comes After Loops"),
        _talk(page, "Stack Overflow"),
    ]
    boxes = [p.bounding_box() for p in parallel]
    assert len({round(b["x"]) for b in boxes}) == 1
    assert len({round(b["y"]) for b in boxes}) == 3
    assert page.locator(".cn-bry .b-sch-event", has_text="Lunch").count() == 0
    # Lunch is a band in view (breakfast is too, scrolled left of the first talk).
    expect(page.locator(".cn-bry .cn-rest-range", has_text="Lunch").first).to_be_visible()

    # Two picks at once: both outlined, the overlap banded red across every track.
    parallel[0].click()
    expect(parallel[0]).to_have_class(re.compile(r"\bcn-picked\b"))
    parallel[1].click()
    page.wait_for_function(
        "() => document.querySelectorAll('.cn-bry .b-sch-event.cn-clash').length === 2"
    )
    expect(page.locator(".cn-bry .b-time-ranges-body-canvas .cn-clash-range")).to_have_count(1)
    expect(page.locator(".cn-bry-msg")).to_contain_text("2 clashing")
    assert "cn-skipped" in parallel[2].get_attribute("class")
    # The picks are the notebook's: `attending: true` in each note's frontmatter.
    page.wait_for_function(
        f"async () => (await (await fetch('/api/picks?slug={DEVDAY_SLUG}')).json()).notes.length === 2"
    )
    assert len(_saved_picks(empty_server.vault, DEVDAY_SLUG)) == 2
    _shot(page, "after-rooms-devday")

    # Unpicking one clears the band; the Day tab still draws the same picks.
    parallel[1].click()
    expect(page.locator(".cn-bry .b-time-ranges-body-canvas .cn-clash-range")).to_have_count(0)
    page.locator(".cn-bry-tab[data-view='day']").click()
    page.wait_for_selector(".cn-bry[data-view='day'] .b-cal-event-wrap.cn-picked", timeout=15000)


def test_single_track_day_opens_on_day(app):
    """Beyond The Prompt runs one talk at a time: with no tab chosen, the Planner opens on Day."""
    app.evaluate("() => localStorage.removeItem('confnote-planner-view-v2')")
    app.reload()
    app.wait_for_selector("#sidebar")
    app.evaluate(f"() => {{ location.hash = '#/{SLUG}'; }}")
    app.locator(".drawer-tab[data-id='bryntum']").click()
    app.wait_for_selector(".cn-bry[data-view='day'] .b-cal-event-wrap", timeout=15000)
    expect(app.locator(".cn-bry-tab[aria-selected='true']")).to_have_text("Day")


def test_rooms_view_by_room_with_untrusted_names(app):
    """An agenda with rooms gets a row per room; scraped room, talk, break and lunch names stay text."""
    _json_route(
        app,
        f"**/api/conference?slug={SLUG}",
        {
            "conference": {"name": PAYLOAD},
            "events": [
                {
                    "id": "s1",
                    "title": PAYLOAD + "Talk",
                    "room": PAYLOAD + "Room",
                    "note": "s1.md",
                    "start": "2026-05-19T09:00:00+01:00",
                    "end": "2026-05-19T10:00:00+01:00",
                },
                {
                    "id": "s2",
                    "title": "Other talk",
                    "room": "Hall B",
                    "note": "s2.md",
                    "start": "2026-05-19T09:30:00+01:00",
                    "end": "2026-05-19T10:30:00+01:00",
                },
                # Breaks and lunch are drawn as time-range bands, whose label is HTML.
                {
                    "id": "b1",
                    "type": "break",
                    "title": PAYLOAD + "Break",
                    "start": "2026-05-19T09:10:00+01:00",
                    "end": "2026-05-19T09:20:00+01:00",
                },
                {
                    "id": "l1",
                    "type": "lunch",
                    "title": PAYLOAD + "Lunch",
                    "note": "l1.md",
                    "start": "2026-05-19T09:40:00+01:00",
                    "end": "2026-05-19T10:00:00+01:00",
                },
            ],
        },
    )
    _open_planner(app, "rooms")
    _talk(app, "Talk").wait_for(timeout=15000)
    rows = app.locator(".cn-bry .b-grid-sub-grid-locked .b-grid-cell").all_text_contents()
    assert [r.strip() for r in rows] == [PAYLOAD + "Room", "Hall B"]
    # Breaks and lunch are bands labelled by their type: no agenda text reaches the
    # time-range label, which Bryntum puts into the DOM.
    bands = app.locator(".cn-bry .b-time-ranges-canvas .cn-rest-range")
    labels = sorted({t.strip() for t in bands.all_text_contents()})
    assert labels == ["Break", "Lunch"]
    canvases = app.evaluate(
        "() => [...document.querySelectorAll('.cn-bry .b-time-ranges-canvas')].map((c) => c.innerHTML).join('')"
    )
    assert canvases and "onerror" not in canvases and "Break" in canvases
    _talk(app, "Talk").hover()
    app.locator(".b-tooltip", has_text="Talk").first.wait_for()
    _assert_not_injected(app)


def test_calendar_view_shows_tracked_event_and_deadline(app):
    _open_planner(app, "calendar")
    app.wait_for_selector(".cn-bry .b-calendar", timeout=15000)
    app.wait_for_function(
        "() => document.querySelector('.cn-bry-msg')?.textContent.includes('2 tracked events')"
    )
    _shot(app, "after-calendar")


def _assert_not_injected(page):
    page.wait_for_timeout(300)
    assert page.evaluate("() => window.__pwned") is None
    assert page.locator(".cn-bry img[src='x']").count() == 0


def test_untrusted_catalogue_text_and_workspace_url_are_not_executed(app):
    # Signed in on the web target, with /api/going answering a javascript: URL.
    _json_route(app, "**/api/me", {"id": "u1"})
    _json_route(app, "**/api/tracking", {"evt-x": "going"})
    _json_route(app, "**/api/going", {"url": "javascript:window.__pwned=2"})
    _open_planner(
        app, "trip", {"city": "London", "from": "2099-06-09", "to": "2099-06-12"}, [HOSTILE_EVENT]
    )
    hostile = app.locator(".cn-bry .b-sch-event", has_text="Hostile").first
    hostile.wait_for(timeout=15000)
    assert PAYLOAD in app.locator(".cn-bry .b-grid-cell", has_text="Hostile").first.inner_text()
    hostile.hover()
    app.locator(".b-tooltip", has_text="Hostile").first.wait_for()
    _assert_not_injected(app)
    hostile.click()
    app.wait_for_function(
        "() => document.querySelector('.cn-bry-msg')?.textContent.includes('Going to')"
    )
    assert app.url.startswith("http")
    _assert_not_injected(app)

    app.locator(".cn-bry-tab[data-view='calendar']").click()
    app.locator(".cn-bry .b-cal-event", has_text="Hostile").first.wait_for(timeout=15000)
    _assert_not_injected(app)


def test_untrusted_agenda_rooms_and_titles_are_text(app):
    _json_route(
        app,
        f"**/api/conference?slug={SLUG}",
        {
            "conference": {"name": PAYLOAD},
            "events": [
                {
                    "id": "s1",
                    "title": PAYLOAD + "Talk",
                    "room": PAYLOAD + "Room",
                    "start": "2026-05-19T09:00:00+01:00",
                    "end": "2026-05-19T10:00:00+01:00",
                }
            ],
        },
    )
    _open_planner(app, "day")
    app.locator(".cn-bry .b-cal-event-wrap", has_text="Talk").first.wait_for(timeout=15000)
    assert (
        PAYLOAD
        in app.locator(".cn-bry .b-day-resource-calendar-row-resource-name").first.text_content()
    )
    app.locator(".cn-bry .b-cal-event-wrap", has_text="Talk").first.hover()
    app.locator(".b-tooltip", has_text="Talk").first.wait_for()
    _assert_not_injected(app)


# ---------------------------------------------------------------- Plan × PayPal --
# "Plan my days" goes through /api/chat/plan (stubbed here: the real one is a
# tool-less, Router-metered Concierge step) and the Credits row reads
# /api/wallet/usage. Dates sit around today so the trip and the spend share a
# timeline.


def _near(days: int) -> str:
    from datetime import date, timedelta

    return (date.today() + timedelta(days=days)).isoformat()


def _now_iso(minutes_ago: int) -> str:
    from datetime import UTC, datetime, timedelta

    return (datetime.now(UTC) - timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z")


def _plan_events():
    return [
        {
            "id": "evt-p1",
            "name": "River builders",
            "format": "meetup",
            "start": _near(1),
            "end": _near(2),
            "city": "London",
        },
        {
            "id": "evt-p2",
            "name": "Small systems",
            "format": "conference",
            "start": _near(2),
            "end": _near(3),
            "city": "London",
        },
    ]


def _ndjson(*events) -> str:
    return "".join(json.dumps(e) + "\n" for e in events)


def _stub_chat(page, *events, calls=None):
    def handle(route):
        if calls is not None:
            calls.append(json.loads(route.request.post_data or "{}"))
        route.fulfill(status=200, content_type="application/x-ndjson", body=_ndjson(*events))

    page.route("**/api/chat/plan", handle)


def _stub_usage(page, ledgers: list):
    """Each call returns the next ledger page (the last one repeats)."""

    def handle(route):
        rows = ledgers.pop(0) if len(ledgers) > 1 else ledgers[0]
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"rows": rows}))

    page.route("**/api/wallet/usage", handle)


def _hover(page, locator):
    """Glide onto a narrow bar's middle (Bryntum shows its tip on mouse movement)."""
    box = locator.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] - 20)
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, steps=8)


def _clear_tooltip(page):
    page.mouse.move(0, 0)
    page.wait_for_function("() => !document.querySelector('.b-tooltip:not(.b-hidden)')")


PURCHASE = {
    "reason": "purchase",
    "model": None,
    "charged": "5.0000",
    "balanceAfter": "5.0000",
    "ref": "82K50813R58218109",
}


def test_plan_my_days_places_concierge_picks_and_shows_credits(app):
    before = [{**PURCHASE, "at": _now_iso(10)}]
    charges = [
        {
            "at": _now_iso(1),
            "reason": "charge",
            "model": PAYLOAD + "sonnet",
            "charged": "-0.0116",
            "balanceAfter": "4.9884",
            "ref": "led-2",
        },
        {
            "at": _now_iso(0),
            "reason": "charge",
            "model": "claude-sonnet-4-6",
            "charged": "-0.0168",
            "balanceAfter": "4.9716",
            "ref": "led-3",
        },
    ]
    _stub_usage(app, [before, charges + before])
    plan = {
        "days": [
            {
                "date": _near(1),
                "eventId": "evt-p1",
                "start": "10:00",
                "end": "16:00",
                "note": PAYLOAD + "you are going",
            },
            {
                "date": _near(2),
                "eventId": "evt-p2",
                "start": "09:00",
                "end": "13:00",
                "note": "the better talk",
            },
            {"date": _near(2), "eventId": "evt-unknown", "start": "09:00", "end": "13:00"},
        ]
    }
    calls: list = []
    _stub_chat(app, {"text": "```json\n" + json.dumps(plan) + "\n```"}, {"done": True}, calls=calls)
    _open_planner(app, "trip", {"city": "London", "from": _near(0), "to": _near(4)}, _plan_events())
    app.wait_for_selector(".cn-bry .b-sch-event", timeout=15000)
    rows = [t.strip() for t in app.locator(".cn-bry .b-grid-cell", has_text="").all_inner_texts()]
    # The Credits row is not part of the trip: Spend shows it.
    assert "My plan" in rows and "Credits" not in rows
    assert app.locator(".cn-bry .b-sch-event.cn-grant").count() == 0
    assert app.locator(".cn-bry-action[data-action='spend']").is_visible()

    app.locator(".cn-bry-action[data-action='plan']").click()
    app.wait_for_function(
        "() => document.querySelector('.cn-bry-msg')?.textContent.includes('planned 2 days')",
        timeout=10000,
    )
    # The browser sends data only (the server owns the prompt and calls the model with no tools).
    assert set(calls[0]) == {"trip", "candidates"}
    assert calls[0]["trip"]["city"] == "London"
    assert [c["id"] for c in calls[0]["candidates"]] == ["evt-p1", "evt-p2"]
    plan_bars = app.locator(".cn-bry .b-sch-event.cn-plan")
    assert sorted(t.strip() for t in plan_bars.all_inner_texts()) == [
        "River builders",
        "Small systems",
    ]
    assert "Spend shows its charges" in app.locator(".cn-bry-msg").inner_text()
    saved = app.evaluate("() => JSON.parse(localStorage.getItem('confnote-bryntum-plan:personal'))")
    assert [(d["date"], d["eventId"], d["start"]) for d in saved] == [
        (_near(1), "evt-p1", "10:00"),
        (_near(2), "evt-p2", "09:00"),
    ]

    _hover(app, plan_bars.first)
    app.locator(".b-tooltip", has_text="Concierge:").first.wait_for()
    _assert_not_injected(app)
    _shot(app, "after-plan-my-days")

    _clear_tooltip(app)
    app.locator(".cn-bry-action[data-action='spend']").click()
    charge = app.locator(".cn-bry .b-sch-event.cn-charge", has_text="$0.0116").first
    charge.wait_for(timeout=10000)
    # Live: the plan run's two charges are on the Credits row with the purchase.
    assert app.locator(".cn-bry .b-sch-event.cn-charge").count() == 2
    assert (
        app.locator(".cn-bry-action[data-action='spend']").get_attribute("aria-pressed") == "true"
    )
    _hover(app, charge)
    tip = app.locator(".b-tooltip", has_text="Balance after").first
    tip.wait_for()
    assert "Amount: −$0.0116" in tip.inner_text()
    _assert_not_injected(app)
    # The PayPal purchase ten minutes earlier carries its order id.
    _clear_tooltip(app)
    _hover(app, app.locator(".cn-bry .b-sch-event.cn-grant").first)
    app.locator(".b-tooltip", has_text="PayPal ref: 82K50813R58218109").first.wait_for()
    _shot(app, "after-zoom-to-spend")


def test_plan_bar_drag_is_saved(app):
    _stub_usage(app, [[]])
    _open_planner(app, "trip", {"city": "London", "from": _near(0), "to": _near(4)}, _plan_events())
    app.evaluate(
        "(day) => localStorage.setItem('confnote-bryntum-plan:personal', JSON.stringify([{date: day, eventId: 'evt-p1', start: '10:00', end: '16:00', note: ''}]))",
        _near(1),
    )
    app.locator(".cn-bry-tab[data-view='trip']").click()
    bar = app.locator(".cn-bry .b-sch-event.cn-plan").first
    bar.wait_for(timeout=15000)
    box = bar.bounding_box()
    # The bar is 10:00–16:00, a quarter of a day wide: move it one day later.
    day_width = box["width"] * 4
    app.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    app.mouse.down()
    app.mouse.move(box["x"] + box["width"] / 2 + day_width, box["y"] + box["height"] / 2, steps=12)
    app.mouse.up()
    app.wait_for_function(
        "(day) => JSON.parse(localStorage.getItem('confnote-bryntum-plan:personal'))[0].date === day",
        arg=_near(2),
        timeout=5000,
    )


def test_plan_out_of_credits_hands_off_to_the_buy_more_card(app):
    _stub_usage(app, [[]])
    _stub_chat(
        app,
        {"error": "You are out of AI credits.", "status": 402, "available": 5, "required": 40000},
        {"done": True},
    )
    _open_planner(app, "trip", {"city": "London", "from": _near(0), "to": _near(4)}, _plan_events())
    app.wait_for_selector(".cn-bry .b-sch-event", timeout=15000)
    app.evaluate(
        "() => window.addEventListener('confnote-credits-required', (e) => { window.__creditsRequired = e.detail.required; })"
    )
    app.locator(".cn-bry-action[data-action='plan']").click()
    app.wait_for_function(
        "() => document.querySelector('.cn-bry-msg')?.textContent.includes('Out of AI credits')"
    )
    assert app.evaluate("() => window.__creditsRequired") == 40000
    assert app.locator(".cn-bry .b-sch-event.cn-plan").count() == 0


def test_day_view_from_home_offers_the_conferences_instead_of_an_empty_stage(app):
    app.evaluate(
        "() => { localStorage.setItem('confnote-planner-view-v2', 'day'); location.hash = '#/'; }"
    )
    app.reload()
    app.wait_for_selector(".drawer-tab[data-id='bryntum']", timeout=4000)
    app.locator(".drawer-tab[data-id='bryntum']").click()
    picker = app.locator(".cn-bry-bar select[aria-label='Conference']")
    picker.wait_for(timeout=15000)
    assert "Pick a conference" in app.locator(".cn-bry-stage").inner_text()
    # The chrome is styled before any bundle loads (it used to be a bare, unstyled stage).
    assert app.locator("link[data-confnote-bryntum$='bryntum.css']").count() == 1
    picker.select_option(SLUG)
    app.wait_for_selector(".cn-bry .b-cal-event-wrap", timeout=15000)
    assert app.locator(".cn-bry-dayselect[aria-label='Day']").count() == 1


def test_day_clicked_while_trip_still_loads_keeps_its_scheduler(app):
    """Trip waits on a slow catalogue; Day opens meanwhile. Trip's late draw must not wipe Day."""
    _json_route(app, "**/api/catalogue", {"schema_version": 1, "events": FIXTURE_EVENTS})
    app.evaluate("() => localStorage.setItem('confnote-planner-view-v2', 'trip')")
    app.reload()
    app.wait_for_selector("#sidebar")
    # Slow only the catalogue, in the page, so the test can click Day while Trip waits.
    app.evaluate(
        """() => { const real = window.fetch; window.fetch = (url, opts) => String(url).includes('/api/catalogue')
            ? new Promise((done) => setTimeout(() => done(real(url, opts)), 2500)) : real(url, opts); }"""
    )
    app.evaluate(f"() => {{ location.hash = '#/{SLUG}/0940-opening-keynote.md'; }}")
    app.wait_for_selector(".drawer-tab[data-id='bryntum']", timeout=4000)
    app.locator(".drawer-tab[data-id='bryntum']").click()
    app.locator(".cn-bry-tab[data-view='day']").click()
    app.wait_for_selector(".cn-bry[data-view='day'] .b-cal-event-wrap", timeout=15000)
    app.wait_for_timeout(3500)  # the superseded Trip load lands in this window
    assert app.locator(".cn-bry[data-view='day'] .b-calendar").count() == 1
    assert app.locator(".cn-bry[data-view='day'] .b-cal-event-wrap").count() > 0
