"""The site's /download page: coming soon before a release, the stable URL + sha after.

Serves packages/web-app/site statically and fakes the downloads site's latest.json.
"""

from __future__ import annotations

import functools
import http.server
import json
import threading
from pathlib import Path

import pytest

SITE = Path(__file__).resolve().parents[2] / "packages/web-app/site"
LATEST = "https://confnote-downloads.vercel.app/latest.json"
STABLE = "/download/confnote-mac.dmg"


@pytest.fixture(scope="module")
def site_url():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(SITE))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def test_download_page_coming_soon(page, site_url):
    page.route(LATEST, lambda route: route.fulfill(status=404, body="not found"))
    page.goto(f"{site_url}/download.html")
    btn = page.locator("#downloadBtn")
    assert btn.get_attribute("href") == STABLE
    assert btn.get_attribute("aria-disabled") == "true"
    assert "Coming soon" in btn.inner_text()
    assert page.locator("#catPromo a").get_attribute("href") == "https://localaicat.com"


def test_download_page_links_the_stable_url(page, site_url):
    latest = {
        "version": "0.0.0",
        "sha256": "ab" * 32,
        "size": 61_000_000,
        "minimum_macos": "27.0",
        "architectures": ["arm64"],
    }
    page.route(
        LATEST,
        lambda route: route.fulfill(
            status=200, content_type="application/json", body=json.dumps(latest)
        ),
    )
    page.goto(f"{site_url}/download.html")
    btn = page.locator("#downloadBtn")
    page.wait_for_function("!document.getElementById('downloadBtn').hasAttribute('aria-disabled')")
    assert btn.get_attribute("href") == STABLE
    assert "confnote 0.0.0" in btn.inner_text()
    assert "macOS 27.0 or later, Apple Silicon" in page.locator("#requirements").inner_text()
    assert page.locator("#sha").inner_text() == "ab" * 32
