#!/usr/bin/env python3
"""Sign the demo account in through AuthKit off camera and save the browser session for the takes.

usage: signin.py <state file>
  CONFNOTE_DEMO_EMAIL      the account to sign in (required; never printed)
  CONFNOTE_DEMO_BASE       the site (default https://staging.confnote.si)
  CONFNOTE_DEMO_CODE_FILE  where the emailed sign-in code is dropped (default .authkit-code beside the state file)

At AuthKit's code screen the script prints "CODE SCREEN <UTC time>" and waits up to 9 minutes for the code file.
Whoever reads the email writes the 6-digit code there (chmod 600); the script reads it once, deletes it and never
prints it. The session cookies go to <state file> (0600). Nothing is recorded.
"""

import os
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright
from take import BASE, USER_AGENT, VIEWPORT

CODE_WAIT_S = 540  # AuthKit codes last 10 minutes


def read_code(code_file: Path) -> str:
    for _ in range(CODE_WAIT_S):
        if code_file.exists() and code_file.read_text().strip():
            code = code_file.read_text().strip()
            code_file.unlink()
            return code
        time.sleep(1)
    sys.exit("no sign-in code arrived")


def main() -> None:
    state = Path(sys.argv[1]).resolve()
    email = os.environ.get("CONFNOTE_DEMO_EMAIL")
    if not email:
        sys.exit("set CONFNOTE_DEMO_EMAIL")
    code_file = Path(os.environ.get("CONFNOTE_DEMO_CODE_FILE", state.parent / ".authkit-code"))
    with sync_playwright() as p:
        browser = p.chromium.launch()
        context = browser.new_context(viewport=VIEWPORT, color_scheme="dark", user_agent=USER_AGENT)
        page = context.new_page()
        page.goto(f"{BASE}/api/auth/signin?returnTo=/")
        page.wait_for_load_state("networkidle")
        page.locator("input[name=email]").fill(email)
        page.locator("button[type=submit]").first.click()
        page.locator("input[name=password], input[name=code]").first.wait_for(
            state="attached", timeout=20_000
        )
        if page.locator("input[name=password]").count():
            page.get_by_role("button", name=re.compile(r"Email sign-in code", re.I)).click()
        code_box = page.locator("input[name=code], input[autocomplete=one-time-code]").first
        code_box.wait_for(state="attached", timeout=20_000)
        print(
            f"CODE SCREEN {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}, waiting for {code_file}",
            flush=True,
        )
        code = read_code(code_file)
        if code_box.is_visible():
            code_box.type(code)
        else:
            page.locator("input[type=text]:visible").first.click()
            page.keyboard.type(code)
        page.wait_for_url(lambda u: u.startswith(BASE), timeout=30_000)
        page.wait_for_load_state("networkidle")
        context.storage_state(path=str(state))
        os.chmod(state, 0o600)
        print(f"signed in; session saved to {state}", flush=True)
        browser.close()


if __name__ == "__main__":
    main()
