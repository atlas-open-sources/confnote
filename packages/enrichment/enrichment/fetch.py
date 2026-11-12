"""Public-source fetching with robots, per-origin throttling and immutable snapshots."""

import hashlib
import http.client
import ipaddress
import json
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

USER_AGENT = "event-catalogue/0.1"
MAX_BYTES = 8 * 1024 * 1024
MIN_INTERVAL = 2.0


@dataclass(frozen=True)
class Snapshot:
    url: str
    fetched_at: str
    content_hash: str
    text: str
    encoding: str = "utf-8"

    def save(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"{self.content_hash.removeprefix('sha256:')}.json"
        if not target.exists():
            target.write_text(json.dumps(asdict(self), ensure_ascii=False, indent=2) + "\n")


def public_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise ValueError("only credential-free public HTTP(S) URLs are allowed")
    if parsed.port not in (None, 80, 443):
        raise ValueError("nonstandard port refused")
    addresses = socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(row[4][0]).is_global for row in addresses):
        raise ValueError("non-public address refused")
    return urllib.parse.urlunsplit(parsed._replace(fragment=""))


class PinnedResponse:
    def __init__(self, response, connection):
        self.response = response
        self.connection = connection
        self.headers = response.headers

    def read(self, size):
        return self.response.read(size)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.response.close()
        self.connection.close()


class PinnedOpener:
    """Resolve and validate at connection time; never re-resolve an approved host.

    TLS still verifies the original hostname. Environment HTTP proxies are not
    used, and redirects are handled by Fetcher with a fresh robots check.
    """

    def open(self, request, timeout):
        parsed = urllib.parse.urlsplit(request.full_url)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        rows = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
        if not rows or any(not ipaddress.ip_address(row[4][0]).is_global for row in rows):
            raise ValueError("non-public address refused at connection")
        address = rows[0][4][0]
        connection_type = (
            http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
        )
        connection = connection_type(parsed.hostname, port, timeout=timeout)
        # HTTPConnection exposes this factory for alternate connection handling.
        connection._create_connection = lambda target, timeout, source_address=None: (
            socket.create_connection((address, port), timeout, source_address)
        )
        target = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
        try:
            connection.request("GET", target, headers=dict(request.header_items()))
            response = connection.getresponse()
            if not 200 <= response.status < 300:
                error = urllib.error.HTTPError(
                    request.full_url, response.status, response.reason, response.headers, None
                )
                response.close()
                connection.close()
                raise error
            return PinnedResponse(response, connection)
        except Exception:
            connection.close()
            raise


class Fetcher:
    def __init__(self, *, clock=time.monotonic, sleep=time.sleep, opener=None):
        self.clock = clock
        self.sleep = sleep
        self.opener = opener or PinnedOpener()
        self.robots = {}
        self.last = {}
        self.delays = {}

    def _request(self, url: str) -> tuple[bytes, str]:
        origin = urllib.parse.urlsplit(url)
        key = f"{origin.scheme}://{origin.netloc}"
        delay = self.delays.get(key, MIN_INTERVAL)
        if key in self.last:
            self.sleep(max(0.0, self.last[key] + delay - self.clock()))
        self.last[key] = self.clock()
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with self.opener.open(request, timeout=25) as response:
            body = response.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise ValueError("source exceeds snapshot size limit")
            return body, response.headers.get_content_charset() or "utf-8"

    def _allowed(self, url: str) -> None:
        parsed = urllib.parse.urlsplit(url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if origin not in self.robots:
            parser = urllib.robotparser.RobotFileParser()
            try:
                body, charset = self._request(origin + "/robots.txt")
                parser.parse(body.decode(charset, errors="replace").splitlines())
            except urllib.error.HTTPError as exc:
                if exc.code == 404:
                    parser.parse([])
                else:
                    raise ValueError(f"robots unavailable: HTTP {exc.code}") from exc
            self.robots[origin] = parser
            self.delays[origin] = max(MIN_INTERVAL, parser.crawl_delay(USER_AGENT) or 0)
        if not self.robots[origin].can_fetch(USER_AGENT, url):
            raise ValueError("robots disallows source")

    def fetch(self, url: str) -> Snapshot:
        for _ in range(6):
            url = public_url(url)
            self._allowed(url)
            try:
                body, charset = self._request(url)
                return Snapshot(
                    url,
                    datetime.now(UTC).isoformat(),
                    "sha256:" + hashlib.sha256(body).hexdigest(),
                    body.decode(charset, errors="strict"),
                    charset,
                )
            except urllib.error.HTTPError as exc:
                if exc.code not in (301, 302, 303, 307, 308) or not exc.headers.get("Location"):
                    raise
                url = urllib.parse.urljoin(url, exc.headers["Location"])
        raise ValueError("too many redirects")
