"""Provider routing and browser-origin authorization without live accounts."""

import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest
import server


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "BASE_DIR", tmp_path)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_port}"
    finally:
        httpd.shutdown()
        thread.join(timeout=3)
        httpd.server_close()


def test_login_rejects_cross_origin(api, monkeypatch):
    called = []
    monkeypatch.setattr(server.chatgpt_auth, "start_login", lambda channel: called.append(channel))
    request = urllib.request.Request(
        api + "/api/chat/chatgpt/login",
        data=b"",
        headers={"Origin": "https://other.example", "X-Confnote-Request": "1"},
    )
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(request)
    assert error.value.code == 403
    assert called == []


def test_login_returns_only_public_auth_url(api, monkeypatch):
    monkeypatch.setattr(
        server.chatgpt_auth,
        "start_login",
        lambda channel: {"auth_url": "https://auth.openai.com/api/accounts/authorize"},
    )
    request = urllib.request.Request(
        api + "/api/chat/chatgpt/login",
        data=b"",
        headers={"Origin": api, "X-Confnote-Request": "1"},
    )
    with urllib.request.urlopen(request) as response:
        assert json.load(response) == {"auth_url": "https://auth.openai.com/api/accounts/authorize"}


def test_chatgpt_works_without_claude_cli(api, monkeypatch):
    monkeypatch.setattr(server, "CHAT_OK", False)
    captured = []

    def reply(**kwargs):
        captured.append(kwargs)
        kwargs["emit"]({"text": "Hello from ChatGPT"})
        kwargs["emit"]({"done": True})

    monkeypatch.setattr(server.chatgpt_agent, "global_reply", reply)
    request = urllib.request.Request(
        api + "/api/chat/global?provider=chatgpt&model=account-model",
        data=json.dumps({"messages": [{"role": "user", "text": "Hello"}]}).encode(),
        headers={"Content-Type": "application/json", "Origin": api},
    )
    with urllib.request.urlopen(request) as response:
        events = [json.loads(line) for line in response]
    assert events == [{"text": "Hello from ChatGPT"}, {"done": True}]
    assert captured[0]["model"] == "account-model"
    assert captured[0]["bridges"] == {}


def test_unknown_provider_rejected(api):
    request = urllib.request.Request(
        api + "/api/chat/global?provider=unknown", data=b"{}", headers={"Origin": api}
    )
    with urllib.request.urlopen(request) as response:
        events = [json.loads(line) for line in response]
    assert events[0] == {"error": "Unknown agent provider."}
    assert events[-1] == {"done": True}


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", "/api/conferences"),
        ("POST", "/api/settings"),
        ("POST", "/api/chat/chatgpt/login"),
        ("POST", "/api/chat/chatgpt/logout"),
        ("PUT", "/api/note"),
    ],
)
def test_rebinding_host_rejected_before_route(api, method, path, monkeypatch):
    monkeypatch.setattr(server.chatgpt_auth, "start_login", lambda *_: pytest.fail("auth called"))
    monkeypatch.setattr(server.chatgpt_auth, "logout", lambda *_: pytest.fail("auth called"))
    request = urllib.request.Request(
        api + path,
        data=b"{}" if method != "GET" else None,
        method=method,
        headers={"Host": "evil.test", "Origin": "http://evil.test", "X-Confnote-Request": "1"},
    )
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(request)
    assert error.value.code == 403


@pytest.mark.parametrize("origin", [None, "null", "https://evil.test"])
@pytest.mark.parametrize(
    "method,path",
    [
        ("POST", "/api/settings"),
        ("POST", "/api/vault/switch"),
        ("POST", "/api/private/setup"),
        ("PUT", "/api/note"),
    ],
)
def test_all_mutations_reject_missing_or_foreign_origin(api, method, path, origin):
    headers = {}
    if origin is not None:
        headers["Origin"] = origin
    request = urllib.request.Request(api + path, data=b"{}", method=method, headers=headers)
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(request)
    assert error.value.code == 403


@pytest.mark.parametrize("method", ["_chat_session", "_chat_global"])
def test_chat_drains_request_before_early_stream_response(method):
    """Unread body bytes can reset a closing socket and lose its error event."""
    import io

    handler = object.__new__(server.Handler)
    handler.headers = {"Content-Length": "2"}
    handler.rfile = io.BytesIO(b"{}")
    observed = []

    def open_stream(provider):
        observed.append((provider, handler.rfile.tell()))
        return None

    handler._open_ndjson = open_stream
    getattr(handler, method)({"provider": ["unknown"]})
    assert observed == [("unknown", 2)]
