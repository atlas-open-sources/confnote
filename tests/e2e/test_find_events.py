"""Find events reads the same catalogue index in local HTTP and the mocked Cat grant."""

import base64
import functools
import json
import os
import re
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from playwright.sync_api import expect

REPO = Path(__file__).resolve().parents[2]
INDEX = {
    "schema_version": "events.catalogue.v2",
    "catalogue_updated_at": "2026-10-31T00:00:00Z",
    "events": [
        {
            "id": "future-community",
            "name": "Future Community Day",
            "start": "2099-05-19T18:00:00+09:00",
            "end": "2099-05-19T21:00:00+09:00",
            "timezone": "Asia/Seoul",
            "city": "Seoul",
            "country": "KR",
            "topics": ["ai"],
            "url": "https://example.com/community",
        }
    ],
}


@pytest.fixture(params=["local", "cat"])
def find_target(request, tmp_path):
    if request.param == "local":
        catalogue = tmp_path / "catalogue"
        catalogue.mkdir()
        (catalogue / "index.json").write_text(json.dumps(INDEX))
        env = {
            **os.environ,
            "PYTHONPATH": str(REPO / "packages/local-app"),
            "CONF_NOTES_DIR": str(tmp_path / "vault"),
            "CONFNOTE_CATALOGUE_DIR": str(catalogue),
            "CONF_NOTES_NO_KEYCHAIN": "1",
            "CONF_NOTES_NOOPEN": "1",
            "CONFNOTE_CATALOGUE_URL": "",
        }
        proc = subprocess.Popen(
            [
                sys.executable,
                "-u",
                "-c",
                'import server; s=server.LocalHTTPServer(("127.0.0.1",0),server.Handler); print(s.server_address[1],flush=True); s.serve_forever()',
            ],
            cwd=REPO,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            port = int(proc.stdout.readline())
            yield f"http://127.0.0.1:{port}", False
        finally:
            proc.terminate()
            proc.wait(timeout=5)
    else:
        dest = tmp_path / "cat"
        # Disk gate applies to every build, including the test fixture.
        import shutil

        assert shutil.disk_usage(Path.home()).free >= 40 * 1024**3
        subprocess.run(
            ["node", "packages/cat-app/build.mjs", "--out", str(dest)],
            cwd=REPO,
            check=True,
            capture_output=True,
        )
        handler = functools.partial(SimpleHTTPRequestHandler, directory=str(dest))
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{httpd.server_port}", True
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join()


def test_find_events_local_and_cat(page, find_target):
    url, cat = find_target
    if cat:
        encoded = base64.b64encode(json.dumps(INDEX).encode()).decode()
        page.add_init_script(f"""window.cat = {{request: async function(message) {{
          if(message.operation === 'file.read' && message.path === 'catalogue/index.json') return {{ok:true,data:'{encoded}'}};
          if(message.operation === 'file.list') return {{ok:true,data:btoa('[]')}};
          throw new Error('File was not found inside the project-folder grant.');
        }}}};""")
    page.set_viewport_size({"width": 375, "height": 812})
    page.goto(url)
    page.locator(".hometabs").get_by_role("link", name="Find events").click()
    view = page.locator("#findEventsView")
    expect(view.get_by_role("link", name="Future Community Day")).to_be_visible()
    expect(view.get_by_text("Updated", exact=False)).to_be_visible()
    expect(view.get_by_role("button", name="Refresh catalogue")).not_to_be_visible()
    # The hosted-only parts stay off outside the web build.
    expect(view.get_by_role("button", name="Grid", exact=True)).not_to_be_visible()
    expect(view.locator("#calendar")).not_to_be_visible()
    view.get_by_role("searchbox").fill("nonexistent")
    expect(view.get_by_text("Nothing here yet.", exact=False)).to_be_visible()
    view.get_by_role("searchbox").fill("Seoul")
    view.get_by_role("link", name="Future Community Day").click()
    expect(page).to_have_url(re.compile(r"#/~find/future-community$"))
    expect(view.get_by_role("link", name="Organizer’s page ↗")).to_have_attribute(
        "href", "https://example.com/community"
    )
    view.get_by_role("button", name="Back to events").click()
    # The view stays mounted, so the search survives the round trip.
    expect(view.get_by_role("searchbox")).to_have_value("Seoul")
    expect(view.get_by_role("link", name="Future Community Day")).to_be_visible()
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")


def test_find_events_refresh_only_runs_after_explicit_button(page, confnote_server):
    refreshes = []
    payload = {**INDEX, "refresh_available": True}
    page.route("**/api/catalogue", lambda route: route.fulfill(json=payload))

    def refresh(route):
        refreshes.append(route.request.method)
        route.fulfill(json={"ok": True, "unchanged": True})

    page.route("**/api/catalogue/refresh", refresh)
    page.goto(str(confnote_server) + "/#/~find")
    view = page.locator("#findEventsView")
    expect(view.get_by_role("link", name="Future Community Day")).to_be_visible()
    assert refreshes == []
    view.get_by_role("button", name="Refresh catalogue").click()
    expect(view.get_by_role("button", name="Refresh catalogue")).to_be_enabled()
    assert refreshes == ["POST"]
