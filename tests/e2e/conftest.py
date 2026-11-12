"""Playwright e2e fixtures for confnote.

Each test session gets its OWN confnote server, bound to a tmp notes vault
seeded from `tests/e2e/seed-agenda.json` (a verbatim copy of Beyond The
Prompt). The user's real `~/Documents/confnote` is never touched.

Run:  app/.venv/bin/pytest -q tests/e2e        (after `make e2e-install`)
"""

from __future__ import annotations

import contextlib
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import pytest


@dataclass
class ServerInfo:
    """Per-session live server info. `str(self)` returns the URL so existing
    `confnote_server + "/path"` callsites keep working."""

    url: str
    vault: Path

    def __str__(self) -> str:
        return self.url

    def __add__(self, other: str) -> str:
        return self.url + other

    def __radd__(self, other: str) -> str:
        return other + self.url


REPO = Path(__file__).resolve().parents[2]
SEED_AGENDA = Path(__file__).with_name("seed-agenda.json")
# A cold GitHub macOS runner loads pyobjc and the agent SDK far slower than our Macs.
SERVER_START_TIMEOUT = 30.0


def _free_port() -> int:
    """Pick a random free TCP port we can hand to the server."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for(url: str, timeout: float = 8.0) -> bool:
    """Poll `url` until it returns 200 or `timeout` elapses."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with contextlib.suppress(Exception), urllib.request.urlopen(url, timeout=0.5) as r:
            if r.status == 200:
                return True
        time.sleep(0.1)
    return False


def _start_server(env: dict) -> subprocess.Popen:
    """Run the same server.py the .app uses, unbuffered, with faulthandler on
    so a hung start can be asked for every thread's stack."""
    return subprocess.Popen(
        [sys.executable, "-u", "-X", "faulthandler", str(REPO / "packages/local-app/server.py")],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def _hung_server_output(proc: subprocess.Popen) -> str:
    """Stop a server that never answered and return what it printed. SIGABRT
    makes faulthandler dump every thread's stack, so the failure shows where
    the start hung, not an empty message."""
    if proc.poll() is None:
        proc.send_signal(signal.SIGABRT)
    try:
        out, _ = proc.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        out, _ = proc.communicate()
    return f"exit code {proc.returncode}\n" + out.decode(errors="replace")


@pytest.fixture(scope="session")
def confnote_server(tmp_path_factory) -> ServerInfo:
    """Start a confnote server on a free port; return info with `.url` and
    `.vault`. Plain-string concatenation still works (`confnote_server + "/x"`)
    so existing tests don't break.

    Vault is `<tmp>/vault`, seeded by running `tools/import_agenda.py`
    against the bundled Beyond The Prompt agenda. The server speaks the
    real codepath — same one the packaged app uses.
    """
    vault = tmp_path_factory.mktemp("vault")
    shutil.copy(SEED_AGENDA, vault / "btp.json")
    # importer creates <vault>/<date>-<slug>/{agenda.json,notes/*.md,…}
    subprocess.run(
        [sys.executable, str(REPO / "tools/import_agenda.py"), str(vault / "btp.json"), str(vault)],
        check=True,
        capture_output=True,
    )

    port = _free_port()
    env = {
        **os.environ,
        "CONF_NOTES_DIR": str(vault),
        "CONF_NOTES_PORT": str(port),
        "CONF_NOTES_NOOPEN": "1",
        "CONFNOTE_CATALOGUE_URL": "",  # don't pop a browser tab during tests
        # Force file-mode key storage so e2e is deterministic AND never
        # writes test keys into the developer's real login Keychain.
        "CONF_NOTES_NO_KEYCHAIN": "1",
    }
    proc = _start_server(env)
    url = f"http://127.0.0.1:{port}"
    info = ServerInfo(url=url, vault=Path(vault))
    try:
        if not _wait_for(f"{url}/api/conferences", timeout=SERVER_START_TIMEOUT):
            out = _hung_server_output(proc)
            raise RuntimeError(f"confnote server did not come up on {url}\n{out}")
        yield info
    finally:
        proc.terminate()
        with contextlib.suppress(Exception):
            proc.wait(timeout=3)


def answer_settings_as_web(page) -> None:
    """Answer /api/settings as the hosted build does (`web: true`), passing the local
    values through, so tests that fake a web account see the account controls."""

    def settings(route):
        response = route.fetch()
        route.fulfill(response=response, json={**response.json(), "web": True})

    page.route("**/api/settings", settings)


PICK_LINE = re.compile(r"(?m)^attending:.*\n")


def clear_picks(vault: Path) -> None:
    """Remove every pick ("attending: …" in a note's frontmatter) from `vault`."""
    for note in vault.glob("*/notes/*.md"):
        text = note.read_text()
        head, sep, body = text.partition("\n---\n")
        if sep and PICK_LINE.search(head + "\n"):
            note.write_text(PICK_LINE.sub("", head + "\n").rstrip("\n") + sep + body)


@pytest.fixture(autouse=True)
def isolated_picks(request):
    """Picks live in the session server's notes now, not in each test's fresh
    localStorage: clear them after every test that used that server."""
    yield
    if "confnote_server" in request.fixturenames:
        clear_picks(request.getfixturevalue("confnote_server").vault)


@pytest.fixture
def chat_reset(confnote_server):
    """Reset the chat state (JSONL + archive + session-id) between tests.
    Use in tests that mutate chat state."""
    chat_dir = confnote_server.vault / ".chat"
    shutil.rmtree(chat_dir, ignore_errors=True)
    yield chat_dir
    shutil.rmtree(chat_dir, ignore_errors=True)


@pytest.fixture
def empty_server(tmp_path_factory):
    """Function-scoped server on its OWN EMPTY tmp vault (no seeded conference)
    — for the import flow, which needs a 'No events yet' starting state.
    Fully isolated and torn down: the server process is terminated and the tmp
    vault is removed after the test, so nothing leaks between tests or to the
    developer's real vault."""
    vault = tmp_path_factory.mktemp("empty-vault")
    port = _free_port()
    env = {
        **os.environ,
        "CONF_NOTES_DIR": str(vault),
        "CONF_NOTES_PORT": str(port),
        "CONF_NOTES_NOOPEN": "1",
        "CONFNOTE_CATALOGUE_URL": "",
        "CONF_NOTES_NO_KEYCHAIN": "1",
    }
    proc = _start_server(env)
    url = f"http://127.0.0.1:{port}"
    info = ServerInfo(url=url, vault=Path(vault))
    try:
        if not _wait_for(f"{url}/api/conferences", timeout=SERVER_START_TIMEOUT):
            out = _hung_server_output(proc)
            raise RuntimeError(f"empty confnote server did not come up on {url}\n{out}")
        yield info
    finally:
        proc.terminate()
        with contextlib.suppress(Exception):
            proc.wait(timeout=3)
        shutil.rmtree(vault, ignore_errors=True)


@pytest.fixture
def app(confnote_server, page):
    """Open the app at home and return a `page` already loaded.

    Each test gets a fresh localStorage so sidebar-width / theme state from
    a previous test doesn't leak in.
    """
    page.set_viewport_size({"width": 1400, "height": 900})
    page.on("pageerror", lambda error: print(f"Browser error: {error}"))
    page.on(
        "requestfailed", lambda request: print(f"Failed request: {request.url}: {request.failure}")
    )
    # Clear on document initialization; a second immediate navigation can
    # abort the first home fetch and leave its empty fallback on screen.
    page.add_init_script("""if (!sessionStorage.getItem('confnote-test-initialized')) {
        localStorage.clear();
        sessionStorage.setItem('confnote-test-initialized', '1');
    }""")
    page.goto(confnote_server + "/#/")
    page.wait_for_selector("#sidebar")
    page.wait_for_selector("#sidebar .sb-conf")
    page.wait_for_selector("#sidebar .sb-grip")
    return page
