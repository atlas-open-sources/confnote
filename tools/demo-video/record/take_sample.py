#!/usr/bin/env python3
"""Sample take: on a fresh signed-in account, import a conference from its agenda link, open a session, take a
note and ask the Concierge to research the talk. Copy it and add your own steps (take.py has the helpers).

usage: take_sample.py --state STATE.json --out DIR [--record]
  --agenda-url   the agenda JSON link to paste (default: the Beyond The Prompt agenda)
  --session      the session to open (default: "Bringing AI to the Canvas")
Writes DIR/timeline.json (marks for the storyboard), DIR/evidence.json and, with --record, DIR/video/*.webm.
"""

import argparse
from pathlib import Path

from playwright.sync_api import sync_playwright
from take import BASE, Take

AGENDA_URL = "https://www.ag-grid.com/downloads/beyond-the-prompt/beyond-the-prompt-agenda.json"
SESSION = "Bringing AI to the Canvas"
NOTE = "- Agents need a place to point at things, not just a chat box"
RESEARCH = "Research this talk and its speaker. Save a short brief to Research with two questions I could ask."


def run(take: Take, agenda_url: str, session: str) -> None:
    page = take.page
    take.mark("home")
    page.goto(f"{BASE}/")
    page.wait_for_load_state("networkidle")
    take.beat(2000)
    take.mark("import")
    page.locator(".new-empty-conf, .new-conf-btn").first.click()
    page.locator("#text-input:visible").first.wait_for(timeout=20_000)
    take.beat(1200)
    take.send(agenda_url, paste=True, timeout_ms=120_000)
    take.mark("imported")
    take.beat(3000)
    take.evidence["conferences"] = take.api("/api/conferences")["body"]
    take.close_drawer()
    page.locator("#sidebar").locator(f"text={session}").first.click()
    page.locator("#editor .CodeMirror").first.wait_for(timeout=20_000)
    take.mark("note")
    page.locator("#editor .CodeMirror").first.click()
    page.keyboard.type(NOTE, delay=take.typing(28))
    take.beat(2000)
    take.mark("research")
    before = take.balance()
    take.send(RESEARCH)
    take.mark("answered")
    take.beat(3500)
    take.evidence["researchCostMicros"] = before - take.balance()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--record", action="store_true")
    ap.add_argument("--agenda-url", default=AGENDA_URL)
    ap.add_argument("--session", default=SESSION)
    args = ap.parse_args()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        take = Take(browser, args.state, args.out, args.record)
        try:
            run(take, args.agenda_url, args.session)
        finally:
            take.shot("zz-last.png")
            take.close()
            browser.close()


if __name__ == "__main__":
    main()
