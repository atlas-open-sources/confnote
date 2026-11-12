"""Parallel rooms sit side by side in the agenda rail; one room stays a single column."""

import re

from playwright.sync_api import expect

SLUG = "2026-05-19-beyond-the-prompt"


def _event(template, event_id, title, start, end, room):
    return {
        **template,
        "id": event_id,
        "type": "talk",
        "title": title,
        "start": f"2026-11-05T{start}:00+08:00",
        "end": f"2026-11-05T{end}:00+08:00",
        "room": room,
        "track": "",
        "note": f"{start.replace(':', '')}-{event_id}.md",
    }


def _multitrack_payload(app, confnote_server):
    payload = app.request.get(confnote_server + f"/api/conference?slug={SLUG}").json()
    template = next(event for event in payload["events"] if event.get("note"))
    payload["rooms"] = [
        {"id": "main-stage", "name": "Main stage"},
        {"id": "breakout", "name": "AI applications breakout"},
    ]
    payload["events"] = [
        _event(template, "community", "Community", "13:00", "13:40", "main-stage"),
        _event(template, "harness", "Agent harness", "13:45", "14:05", "main-stage"),
        _event(template, "lobsterville", "Lobsterville", "14:05", "14:25", "main-stage"),
        _event(template, "youmind", "[Breakout] YouMind", "13:45", "14:05", "breakout"),
        _event(template, "evals", "[Breakout] Trust your evals", "14:08", "14:20", "breakout"),
        _event(template, "close", "Day 1 close", "17:45", "17:50", "main-stage"),
    ]
    return payload


def _fake_picks(app):
    """The faked agenda's notes exist only here, so its picks are kept here too."""
    picked = set()

    def handle(route):
        if route.request.method == "PUT":
            for note, on in route.request.post_data_json["picks"].items():
                if on:
                    picked.add(note)
                else:
                    picked.discard(note)
        route.fulfill(json={"slug": SLUG, "notes": sorted(picked), "changed": {}})

    app.route("**/api/picks?*", handle)


def _open(app, confnote_server, payload, now):
    _fake_picks(app)
    app.route("**/api/conference?*", lambda route: route.fulfill(json=payload))
    app.route("**/api/conf-doc?*", lambda route: route.fulfill(json={"status": ""}))
    app.add_init_script(f"Date.now = () => Date.parse('{now}')")
    app.goto(confnote_server + f"/#/{SLUG}")
    app.reload()
    app.wait_for_selector(".rl-row")


def test_parallel_rooms_render_as_columns_with_the_now_marker(app, confnote_server):
    payload = _multitrack_payload(app, confnote_server)
    _open(app, confnote_server, payload, "2026-11-05T14:10:00+08:00")

    lanes = app.locator(".rl-lanes")
    expect(lanes).to_have_count(1)
    expect(app.locator(".rl-lane-h")).to_have_text(["Main stage", "AI applications breakout"])
    main, breakout = app.locator(".rl-lane").all()
    expect(main.locator(".rl-ti")).to_have_text(["Agent harness", "Lobsterville"])
    # the column header names the room, so the "[Breakout]" title tag is dropped
    expect(breakout.locator(".rl-ti")).to_have_text(["YouMind", "Trust your evals"])
    # sessions outside the parallel stretch stay single-column rows
    expect(app.locator("#railTrack > .rl-row .rl-ti")).to_have_text(["Community", "Day 1 close"])
    # both rooms' live sessions light up side by side
    expect(app.locator(".rl-row.live .rl-ti")).to_have_text(["Lobsterville", "Trust your evals"])

    # the ● marker sits on the live session that started last: the breakout one
    # (a lane is display:contents, so measure its header for the column's left edge)
    dot_left = app.locator("#railNow").evaluate("dot => dot.offsetLeft")
    breakout_left = app.locator(".rl-lane-h").nth(1).evaluate("h => h.offsetLeft")
    assert dot_left > breakout_left

    # sessions that start together sit on one line across the columns
    harness = app.locator('.rl-cell:has-text("Agent harness")').bounding_box()
    youmind = app.locator('.rl-cell:has-text("YouMind")').bounding_box()
    assert abs(harness["y"] - youmind["y"]) < 2


def test_rooms_that_never_overlap_keep_one_column(app, confnote_server):
    # The seed agenda holds talks in the Auditorium and its breaks in Hasslett,
    # one after the other: two rooms, never at the same time.
    app.goto(confnote_server + f"/#/{SLUG}")
    app.wait_for_selector(".rl-row")
    expect(app.locator("#railTrack > .rl-row")).to_have_count(18)
    expect(app.locator(".rl-lanes")).to_have_count(0)


def test_single_room_agenda_keeps_one_column(app, confnote_server):
    payload = _multitrack_payload(app, confnote_server)
    for event in payload["events"]:
        event["room"] = "main-stage"
    _open(app, confnote_server, payload, "2026-11-05T14:10:00+08:00")
    expect(app.locator(".rl-lanes")).to_have_count(0)
    expect(app.locator("#railTrack > .rl-row")).to_have_count(6)


def test_schedule_tab_puts_parallel_rooms_in_columns_and_stars_a_breakout(app, confnote_server):
    payload = _multitrack_payload(app, confnote_server)
    _open(app, confnote_server, payload, "2026-11-05T14:10:00+08:00")
    app.wait_for_selector(".conf-dashboard")

    rooms = app.locator(".schedule-slot.rooms")
    expect(rooms).to_have_count(1)
    expect(rooms.locator(".tg-range span")).to_contain_text("2 concurrent rooms")
    expect(rooms.locator(".slot-room-h")).to_have_text(["Main stage", "AI applications breakout"])
    breakout = rooms.locator('.tg-cell[style*="grid-column:2"] .tg-card')
    expect(breakout).to_have_count(2)
    expect(rooms.locator(".tg-card.live")).to_have_count(2)
    # Sessions that start together share a grid row, so they sit on one line.
    harness = rooms.locator('.tg-cell:has-text("Agent harness")')
    youmind = rooms.locator('.tg-cell:has-text("YouMind")')
    assert abs(harness.bounding_box()["y"] - youmind.bounding_box()["y"]) < 2

    breakout.first.locator("[data-star]").click()
    app.locator('.conf-tab[data-view="agenda"]').click()
    expect(app.locator(".agenda-view .session-card")).to_have_count(1)
    expect(app.locator(".agenda-view .session-card")).to_contain_text("YouMind")


def test_schedule_shows_breaks_as_plain_rows(app, confnote_server):
    payload = _multitrack_payload(app, confnote_server)
    rest = _event(payload["events"][0], "break-7", "Break", "17:00", "17:10", "main-stage")
    payload["events"].append({**rest, "type": "break"})
    _open(app, confnote_server, payload, "2026-11-05T14:10:00+08:00")
    app.wait_for_selector(".conf-dashboard")
    row = app.locator(".schedule-list .mini-event.rest")
    expect(row).to_have_count(1)
    expect(row).to_contain_text("Break")
    expect(row.locator("[data-star]")).to_have_count(0)
    row.click()
    app.wait_for_url("**/1700-break-7.md")


def test_starring_a_parallel_session_dims_the_other_room(app, confnote_server):
    payload = _multitrack_payload(app, confnote_server)
    _open(app, confnote_server, payload, "2026-11-05T14:10:00+08:00")
    evals = app.locator('.rl-lane .rl-row:has-text("Trust your evals")')
    evals.hover()
    evals.locator(".rl-star").click()
    expect(evals).to_have_class(re.compile(r"\bstarred\b"))
    expect(evals.locator(".rl-star")).to_have_text("★")
    # the main-stage session overlapping it is the one being skipped
    expect(app.locator(".rl-row.skipped .rl-ti")).to_have_text(["Lobsterville"])


def test_rail_lists_the_events_source_and_links(app, confnote_server):
    payload = _multitrack_payload(app, confnote_server)
    payload["sources"] = [{"label": "Program", "url": "https://example.com/program"}]
    payload["conference"]["url"] = "https://example.com"
    payload["conference"]["links"] = [
        {"label": "X", "url": "https://x.com/example"},
        {"label": "Bad", "url": "javascript:alert(1)"},
    ]
    _open(app, confnote_server, payload, "2026-11-05T14:10:00+08:00")
    links = app.locator(".rl-links a")
    expect(links).to_have_text(["Program ↗", "Website ↗", "X ↗"])
    expect(links.first).to_have_attribute("href", "https://example.com/program")
    expect(links.first).to_have_attribute("target", "_blank")


def test_clicking_a_session_keeps_the_rail_scroll(app, confnote_server):
    payload = _multitrack_payload(app, confnote_server)
    _open(app, confnote_server, payload, "2026-11-05T14:10:00+08:00")
    track = app.locator("#railTrack")
    # a short rail so it scrolls; a stylesheet, since the click re-renders the track
    app.add_style_tag(content="#railTrack { max-height: 160px !important; }")
    track.evaluate("t => { t.scrollTop = 60; }")
    before = track.evaluate("t => t.scrollTop")
    row = app.locator('.rl-lane .rl-row:has-text("YouMind")')
    row.click()
    app.wait_for_url("**/*youmind*")
    app.wait_for_timeout(300)
    assert abs(app.locator("#railTrack").evaluate("t => t.scrollTop") - before) < 40
