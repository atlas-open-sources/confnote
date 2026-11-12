"""Public-web fetch for the Concierge's fetch_url, the Mac twin of
packages/web-app/lib/webResearch.ts (fetchUrlText).

The Concierge runs on the user's Mac, next to confnote's own server, Local AI
Cat and the home network, so a prompt-injected page must not steer it at
them: only http(s), no local hostnames, and every address the name resolves to
must be public. The connection then goes to the address that was checked (not
a second lookup), so a name cannot answer the check with a public address and
the connection with 127.0.0.1 (DNS rebinding). Redirects are followed by hand,
each hop checked again. stdlib only.
"""

from __future__ import annotations

import html
import http.client
import ipaddress
import re
import socket
import ssl
from urllib.parse import urljoin, urlsplit

# Conference sites can carry hundreds of KB of inline CSS before any text (gitnation.com: 670 KB, text from 294 KB);
# stripping is linear, so reading 1 MB is cheap. Same cap as webResearch.ts.
MAX_FETCH_BYTES = 1_000_000
# The raw body (fetch_public's default, for agenda JSON) keeps the old cap, as fetchUrlRaw does in webResearch.ts.
MAX_RAW_FETCH_BYTES = 160_000
MAX_TEXT_CHARS = 18_000
MAX_REDIRECTS = 3
TIMEOUT_S = 12
USER_AGENT = "confnote-mac-concierge/0.1"
REDIRECT_CODES = {301, 302, 303, 307, 308}
LOCAL_HOSTNAMES = {"localhost", "localhost.localdomain"}
# The same ranges as PRIVATE_ADDRESSES in webResearch.ts.
_BLOCKED = [
    ipaddress.ip_network(net)
    for net in (
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.0.0.0/24",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "224.0.0.0/3",
        "::/128",
        "::1/128",
        "::/96",
        "64:ff9b::/96",
        "fc00::/7",
        "fe80::/10",
        "fec0::/10",
        "ff00::/8",
    )
]


class FetchError(ValueError):
    pass


def is_private_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return True
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return any(ip.version == net.version and ip in net for net in _BLOCKED)


def _public_address(url: str) -> tuple[object, str]:
    """(parsed url, the vetted address to connect to) or FetchError."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise FetchError("Only http(s) URLs can be fetched.")
    host = (parts.hostname or "").lower()
    if not host or host in LOCAL_HOSTNAMES:
        raise FetchError("Local hostnames cannot be fetched.")
    try:
        ipaddress.ip_address(host)
        literal = True
    except ValueError:
        literal = False
    if literal:
        if is_private_address(host):
            raise FetchError("Private IP addresses cannot be fetched.")
        return parts, host
    try:
        infos = socket.getaddrinfo(host, parts.port or 443, proto=socket.IPPROTO_TCP)
    except OSError:
        raise FetchError("Host did not resolve.") from None
    addresses = [info[4][0] for info in infos]
    if not addresses:
        raise FetchError("Host did not resolve.")
    if any(is_private_address(a) for a in addresses):
        raise FetchError("Host resolves to a private IP address.")
    return parts, addresses[0]


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host, address, **kw):
        super().__init__(host, **kw)
        self._address = address

    def connect(self):
        self.sock = socket.create_connection((self._address, self.port), self.timeout)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, address, **kw):
        super().__init__(host, context=ssl.create_default_context(), **kw)
        self._address = address

    def connect(self):
        raw = socket.create_connection((self._address, self.port), self.timeout)
        # Certificate and SNI are checked against the real hostname.
        self.sock = self._context.wrap_socket(raw, server_hostname=self.host)


def _get(url: str, max_bytes: int) -> tuple[int, str, str, bytes]:
    parts, address = _public_address(url)
    cls = _PinnedHTTPSConnection if parts.scheme == "https" else _PinnedHTTPConnection
    conn = cls(parts.hostname, address, port=parts.port, timeout=TIMEOUT_S)
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    try:
        conn.request(
            "GET",
            path,
            headers={
                "Accept": "text/html,text/plain,application/xhtml+xml,application/json;q=0.7,*/*;q=0.2",
                "User-Agent": USER_AGENT,
            },
        )
        resp = conn.getresponse()
        body = resp.read(max_bytes)
        return resp.status, resp.getheader("Content-Type", ""), resp.getheader("Location", ""), body
    except (OSError, http.client.HTTPException) as e:
        raise FetchError(f"Fetch failed: {type(e).__name__}") from None
    finally:
        conn.close()


def fetch_public(url: str, max_bytes: int = MAX_RAW_FETCH_BYTES) -> dict:
    """{url, content_type, raw} of a public page, following up to
    MAX_REDIRECTS checked redirects. Raises FetchError."""
    current = url
    for _hop in range(MAX_REDIRECTS + 1):
        status, ctype, location, body = _get(current, max_bytes)
        if status in REDIRECT_CODES:
            if not location:
                raise FetchError("Fetch redirect missing Location header.")
            current = urljoin(current, location)
            continue
        if not 200 <= status <= 299:
            raise FetchError(f"Fetch returned HTTP {status}.")
        return {
            "url": current,
            "content_type": ctype,
            "raw": body.decode("utf-8", "replace"),
            "cut": len(body) >= max_bytes,
        }
    raise FetchError("Too many redirects.")


_BLOCK_OPEN_RE = re.compile(r"<(script|style)", re.I)
_SPACE_RE = re.compile(r"\s+")

# Fetched pages are untrusted, so the HTML is stripped with str.find scans that touch each character a bounded number
# of times. Lazy regexes like <(script|style)[\s\S]*?</\1> or <[^>]+> rescan to the end of the page for every unclosed
# opener, which is quadratic: a 160 KB page of "<script" took about 12 s.


def _drop_blocks(raw: str, cut: bool = False) -> str:
    """Replace each <script>…</script> and <style>…</style> block with a space. An unclosed block is left as it is,
    unless the body was cut at MAX_FETCH_BYTES (`cut`): then the cap fell inside the block and the rest is not text."""
    lower = raw.lower()
    out: list[str] = []
    pos = 0
    while True:
        opener = _BLOCK_OPEN_RE.search(raw, pos)
        if not opener:
            out.append(raw[pos:])
            return "".join(out)
        closer = "</" + opener.group(1).lower() + ">"
        end = lower.find(closer, opener.end())
        if end == -1:
            out.append(raw[pos : opener.start()] + " " if cut else raw[pos:])
            return "".join(out)
        out.append(raw[pos : opener.start()])
        out.append(" ")
        pos = end + len(closer)


def _drop_tags(raw: str) -> str:
    """Replace each <…> tag with a space."""
    out: list[str] = []
    pos = 0
    while True:
        start = raw.find("<", pos)
        end = raw.find(">", start + 1) if start != -1 else -1
        if end == -1:
            out.append(raw[pos:])
            return "".join(out)
        out.append(raw[pos:start])
        out.append(" ")
        pos = end + 1


def _title(raw: str) -> str:
    lower = raw.lower()
    start = lower.find("<title")
    open_end = lower.find(">", start) if start != -1 else -1
    close = lower.find("</title>", open_end) if open_end != -1 else -1
    if close == -1:
        return ""
    return _SPACE_RE.sub(" ", html.unescape(raw[open_end + 1 : close])).strip()


def page_text(raw: str, content_type: str, cut: bool = False) -> tuple[str, str]:
    """(title, readable text) the way webResearch.ts stripHtml reads a page."""
    if not re.search(r"html|xml", content_type or "", re.I):
        return "", _SPACE_RE.sub(" ", raw).strip()
    text = _drop_tags(_drop_blocks(raw, cut))
    return _title(raw), _SPACE_RE.sub(" ", html.unescape(text)).strip()


def fetch_url_text(url: str) -> dict:
    """The fetch_url tool result: {url, title, text, truncated, trust} or {error}."""
    try:
        page = fetch_public(url, MAX_FETCH_BYTES)
    except FetchError as e:
        return {"error": str(e)}
    title, text = page_text(page["raw"], page["content_type"], page.get("cut", False))
    return {
        "url": page["url"],
        "title": title,
        "text": text[:MAX_TEXT_CHARS],
        "truncated": len(text) > MAX_TEXT_CHARS,
        "trust": "untrusted_data",
    }
