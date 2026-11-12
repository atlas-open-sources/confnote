"""Public-client ChatGPT OAuth. Secrets stay in the native macOS Keychain.

Protocol: https://developers.openai.com/siwc/token-sharing-open-source/sign-in
No use of another app's OAuth registration or ChatGPT private API endpoints.
"""

from __future__ import annotations

import base64
import contextlib
import fcntl
import hashlib
import http.server
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

import keychain

ISSUER = "https://auth.openai.com"
RESOURCE = "https://api.openai.com/v1"
TOKEN_URL = ISSUER + "/api/accounts/oauth/token"
LOGIN_SECONDS = 600
_lock = threading.RLock()
_pending = {}
_errors = {}


@contextlib.contextmanager
def _refresh_lock(channel):
    """Serialize rotating-token refresh across app processes; file has no secrets."""
    lock_dir = Path.home() / "Library/Application Support/confnote/oauth-locks"
    lock_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    filename = hashlib.sha256(str(channel).encode()).hexdigest() + ".lock"
    descriptor = os.open(lock_dir / filename, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def _query(channel):
    sec = keychain._sec
    if not keychain.available():
        raise RuntimeError("ChatGPT sign-in requires the macOS Keychain.")
    return {
        sec.kSecClass: sec.kSecClassGenericPassword,
        sec.kSecAttrService: "confnote-chatgpt-oauth-" + str(channel),
        sec.kSecAttrAccount: "confnote",
    }


def _load(channel):
    sec = keychain._sec
    query = _query(channel)
    query[sec.kSecReturnData] = True
    query[sec.kSecMatchLimit] = sec.kSecMatchLimitOne
    result, data = sec.SecItemCopyMatching(query, None)
    if result == -25300:
        return {}
    if result != 0:
        raise RuntimeError("Unable to read ChatGPT credentials from Keychain.")
    return json.loads(bytes(data).decode())


def _save(channel, record):
    sec = keychain._sec
    query = _query(channel)
    attrs = {sec.kSecValueData: json.dumps(record).encode()}
    result = sec.SecItemUpdate(query, attrs)
    if result == -25300:
        result, _ = sec.SecItemAdd({**query, **attrs}, None)
    if result != 0:
        raise RuntimeError("Unable to securely save ChatGPT credentials.")


def request_json(url, *, form=None, token=None):
    headers = {"Accept": "application/json"}
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    if token:
        headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        # Never include raw server responses: they can echo token material.
        raise RuntimeError(f"OpenAI request failed (HTTP {exc.code}).") from None
    except (urllib.error.URLError, TimeoutError):
        raise RuntimeError("OpenAI could not be reached. Please try again.") from None


def _verify_id_token(token, client_id, nonce=None):
    import jwt

    signing_key = jwt.PyJWKClient(
        ISSUER + "/.well-known/jwks.json", timeout=30
    ).get_signing_key_from_jwt(token)
    claims = jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256"],
        audience=client_id,
        issuer=ISSUER,
        options={"require": ["exp", "iss", "aud", "sub"]},
    )
    if not isinstance(claims["sub"], str) or not claims["sub"]:
        raise RuntimeError("ChatGPT identity is missing.")
    if nonce is not None and not secrets.compare_digest(str(claims.get("nonce", "")), nonce):
        raise RuntimeError("ChatGPT sign-in nonce did not match.")
    return claims


def _credentials(tokens, previous):
    if not tokens.get("access_token") or tokens.get("token_type", "").lower() != "bearer":
        raise RuntimeError("ChatGPT returned invalid access credentials.")
    scopes = tokens.get("scope", " ".join(previous.get("scopes", []))).split()
    if "chatgpt.tokens.use.direct" not in scopes:
        raise RuntimeError("ChatGPT plan use was not authorized. Sign in again.")
    expiry = int(tokens.get("expires_in", 0))
    if expiry <= 0:
        raise RuntimeError("ChatGPT returned invalid token expiry.")
    return {
        **previous,
        "access_token": tokens["access_token"],
        "refresh_token": tokens.get("refresh_token", previous.get("refresh_token", "")),
        "id_token": tokens.get("id_token", previous.get("id_token", "")),
        "scopes": scopes,
        "expires_at": time.time() + expiry,
    }


def _finish_login(channel, attempt, params):
    if time.time() > attempt["expires_at"]:
        raise RuntimeError("ChatGPT sign-in expired. Please start again.")
    if not secrets.compare_digest(params.get("state", ""), attempt["state"]):
        raise RuntimeError("ChatGPT sign-in state did not match.")
    if params.get("error"):
        raise RuntimeError("ChatGPT sign-in was declined or unavailable.")
    client_id = params.get("client_id", attempt.get("client_id", ""))
    if not client_id or client_id == "dynamic_agent_client":
        raise RuntimeError("ChatGPT registration did not return a client ID.")
    if attempt.get("client_id") and client_id != attempt["client_id"]:
        raise RuntimeError("ChatGPT registration changed unexpectedly.")
    if not params.get("code"):
        raise RuntimeError("ChatGPT sign-in did not return a code.")
    tokens = request_json(
        TOKEN_URL,
        form={
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": params["code"],
            "code_verifier": attempt["verifier"],
            "redirect_uri": attempt["redirect_uri"],
            "resource": RESOURCE,
        },
    )
    claims = _verify_id_token(tokens.get("id_token", ""), client_id, attempt["nonce"])
    old = _load(channel)
    if attempt.get("subject") and claims["sub"] != attempt["subject"]:
        raise RuntimeError("ChatGPT signed in to a different account. Sign out first.")
    record = _credentials(
        tokens,
        {
            "ext_agent_host_id": old["ext_agent_host_id"],
            "client_id": client_id,
            "subject": claims["sub"],
            "email": claims.get("email", ""),
        },
    )
    _save(channel, record)


def status(channel="prod"):
    with _lock:
        if not keychain.available():
            return {
                "available": False,
                "signed_in": False,
                "connected": False,
                "pending": False,
                "error": "ChatGPT sign-in requires the macOS Keychain.",
            }
        record = _load(channel)
        return {
            "available": True,
            "signed_in": bool(record.get("access_token")),
            "connected": bool(record.get("access_token")),
            "email": record.get("email", ""),
            "pending": channel in _pending,
            "error": _errors.get(channel, ""),
        }


def start_login(channel="prod"):
    with _lock:
        if channel in _pending:
            raise RuntimeError("A ChatGPT sign-in is already in progress.")
        record = _load(channel)
        if not record.get("ext_agent_host_id"):
            record["ext_agent_host_id"] = "urn:uuid:" + str(uuid.uuid4())
            _save(channel, record)
        attempt = {
            "state": secrets.token_urlsafe(32),
            "nonce": secrets.token_urlsafe(32),
            "verifier": secrets.token_urlsafe(64),
            "expires_at": time.time() + LOGIN_SECONDS,
            "client_id": record.get("client_id"),
            "subject": record.get("subject"),
        }

        class Callback(http.server.BaseHTTPRequestHandler):
            def setup(self):
                super().setup()
                self.connection.settimeout(5)

            def log_message(self, *_args):
                pass  # authorization codes and hints must never reach logs

            def do_GET(self):
                if len(self.path) > 16384:
                    self.send_error(414)
                    return
                parsed = urllib.parse.urlsplit(self.path)
                values = urllib.parse.parse_qs(parsed.query)
                if parsed.path != "/auth/callback" or any(len(v) != 1 for v in values.values()):
                    self.send_error(400)
                    return
                params = {k: v[0] for k, v in values.items()}
                # Unsolicited requests cannot consume the pending transaction.
                if not secrets.compare_digest(params.get("state", ""), attempt["state"]):
                    self.send_error(400)
                    return
                with _lock:
                    if _pending.get(channel) is not attempt:
                        self.send_error(400)
                        return
                    _pending.pop(channel, None)
                    try:
                        _finish_login(channel, attempt, params)
                        message = "Signed in. You can close this window and return to confnote."
                    except Exception:
                        message = "ChatGPT sign-in failed. Return to confnote and try again."
                        _errors[channel] = message
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(message.encode())

        listener = http.server.HTTPServer(("127.0.0.1", 0), Callback)
        listener.timeout = 1
        attempt["redirect_uri"] = f"http://127.0.0.1:{listener.server_port}/auth/callback"
        _pending[channel] = attempt
        _errors.pop(channel, None)

        def listen():
            try:
                while _pending.get(channel) is attempt and time.time() < attempt["expires_at"]:
                    listener.handle_request()
            finally:
                listener.server_close()
                with _lock:
                    if _pending.get(channel) is attempt:
                        _pending.pop(channel, None)
                        _errors[channel] = "ChatGPT sign-in expired. Please start again."

        threading.Thread(target=listen, daemon=True).start()
        challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(attempt["verifier"].encode()).digest())
            .decode()
            .rstrip("=")
        )
        params = {
            "client_id": record.get("client_id") or "dynamic_agent_client",
            "ext_agent_host_id": record["ext_agent_host_id"],
            "response_type": "code",
            "redirect_uri": attempt["redirect_uri"],
            "scope": "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
            "resource": RESOURCE,
            "state": attempt["state"],
            "nonce": attempt["nonce"],
            "code_challenge_method": "S256",
            "code_challenge": challenge,
        }
        if not record.get("client_id"):
            params["agent_name_hint"] = "confnote"
        elif record.get("id_token"):
            params["id_token_hint"] = record["id_token"]
        return {"auth_url": ISSUER + "/api/accounts/authorize?" + urllib.parse.urlencode(params)}


def access_token(channel="prod"):
    with _lock, _refresh_lock(channel):
        record = _load(channel)
        if not record.get("access_token"):
            raise RuntimeError("Continue with ChatGPT in Settings before chatting.")
        if record.get("expires_at", 0) <= time.time() + 60:
            if not record.get("refresh_token"):
                raise RuntimeError("ChatGPT sign-in expired. Please sign in again.")
            tokens = request_json(
                TOKEN_URL,
                form={
                    "grant_type": "refresh_token",
                    "client_id": record["client_id"],
                    "refresh_token": record["refresh_token"],
                    "resource": RESOURCE,
                },
            )
            if tokens.get("id_token"):
                claims = _verify_id_token(tokens["id_token"], record["client_id"])
                if claims["sub"] != record["subject"]:
                    raise RuntimeError("ChatGPT account changed during refresh.")
            record = _credentials(tokens, record)
            _save(channel, record)
        return record["access_token"]


def logout(channel="prod"):
    with _lock, _refresh_lock(channel):
        _pending.pop(channel, None)
        record = _load(channel)
        confirmed = not bool(record.get("refresh_token"))
        if record.get("refresh_token"):
            try:
                discovery = request_json(ISSUER + "/.well-known/openid-configuration")
                endpoint = discovery["revocation_endpoint"]
                if urllib.parse.urlsplit(
                    endpoint
                ).netloc != "auth.openai.com" or not endpoint.startswith("https://"):
                    raise RuntimeError("Invalid revocation endpoint.")
                request_json(
                    endpoint,
                    form={
                        "token": record["refresh_token"],
                        "token_type_hint": "refresh_token",
                        "client_id": record["client_id"],
                    },
                )
                confirmed = True
            except Exception:
                confirmed = False
        for key in ("access_token", "refresh_token", "id_token", "expires_at", "scopes"):
            record.pop(key, None)
        _save(channel, record)
        _errors.pop(channel, None)
        return {
            "signed_in": False,
            "revocation_confirmed": confirmed,
            "warning": ""
            if confirmed
            else "Remote revocation was not confirmed. Disconnect confnote in ChatGPT Settings.",
        }


def list_models(channel="prod"):
    data = request_json(RESOURCE + "/models", token=access_token(channel))
    return [
        {"slug": model["slug"], "display_name": model.get("display_name", model["slug"])}
        for model in data.get("models", [])
        if model.get("visibility") == "list" and model.get("slug")
    ]
