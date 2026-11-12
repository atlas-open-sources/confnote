import io
import socket
import urllib.error
from email.message import Message

import pytest
from enrichment.fetch import MAX_BYTES, Fetcher, public_url


class Response(io.BytesIO):
    def __init__(self, body):
        super().__init__(body)
        self.headers = Message()


class Opener:
    def __init__(self, routes):
        self.routes = routes
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        value = self.routes[request.full_url]
        if isinstance(value, Exception):
            raise value
        return Response(value)


@pytest.fixture(autouse=True)
def public_dns(monkeypatch):
    monkeypatch.setattr(
        socket, "getaddrinfo", lambda *args, **kwargs: [(2, 1, 6, "", ("93.184.216.34", 443))]
    )


def test_robots_disallow_never_fetches_body():
    opener = Opener({"https://example.com/robots.txt": b"User-agent: *\nDisallow: /private\n"})
    with pytest.raises(ValueError, match="robots disallows"):
        Fetcher(opener=opener).fetch("https://example.com/private")
    assert len(opener.requests) == 1


def test_rate_limit_and_snapshot_hash(tmp_path):
    ticks = [0.0]
    waits = []

    def sleep(delay):
        waits.append(delay)
        ticks[0] += delay

    opener = Opener(
        {
            "https://example.com/robots.txt": b"User-agent: *\nCrawl-delay: 4\n",
            "https://example.com/feed": b"facts",
        }
    )
    snapshot = Fetcher(opener=opener, clock=lambda: ticks[0], sleep=sleep).fetch(
        "https://example.com/feed"
    )
    assert waits == [4.0]
    assert (
        snapshot.content_hash
        == "sha256:0694aacb66d62e742a92e8d5f1e82bd9d2a8ca1be88744201fbe63d0f5007502"
    )
    snapshot.save(tmp_path)
    assert len(list(tmp_path.glob("*.json"))) == 1
    assert all(
        request.get_header("User-agent").startswith("event-catalogue/")
        for request in opener.requests
    )


def test_private_credentials_ports_refused(monkeypatch):
    for url in (
        "file:///etc/passwd",
        "https://user:pass@example.com",  # pragma: allowlist secret - synthetic rejection fixture
        "https://example.com:444/test",
    ):
        with pytest.raises(ValueError):
            public_url(url)
    monkeypatch.setattr(
        socket, "getaddrinfo", lambda *args, **kwargs: [(2, 1, 6, "", ("127.0.0.1", 80))]
    )
    with pytest.raises(ValueError, match="non-public"):
        public_url("http://example.com/")


def test_redirect_target_rechecks_robots():
    redirect = urllib.error.HTTPError(
        "https://example.com/feed",
        302,
        "redirect",
        {"Location": "https://other.example/feed"},
        None,
    )
    opener = Opener(
        {
            "https://example.com/robots.txt": b"User-agent: *\nAllow: /",
            "https://example.com/feed": redirect,
            "https://other.example/robots.txt": b"User-agent: *\nDisallow: /",
        }
    )
    with pytest.raises(ValueError, match="robots disallows"):
        Fetcher(opener=opener, sleep=lambda _: None).fetch("https://example.com/feed")
    assert "https://other.example/feed" not in [request.full_url for request in opener.requests]


def test_oversized_snapshot_fails():
    opener = Opener(
        {
            "https://example.com/robots.txt": b"User-agent: *\nAllow: /",
            "https://example.com/feed": b"x" * (MAX_BYTES + 1),
        }
    )
    with pytest.raises(ValueError, match="size limit"):
        Fetcher(opener=opener, sleep=lambda _: None).fetch("https://example.com/feed")
