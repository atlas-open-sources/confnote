# Local AI Cat: transcription from the hosted confnote site

> **Status: not pursued, 2026-11-11.** It would need Local AI Cat to open the user's local AI server to a website
> (CORS and Local Network Access for confnote.si), so the Cat will not do it. The hosted page no longer calls the Cat:
> it transcribes only with the user's own OpenAI key (Profile → Your AI key), and otherwise says that on-device
> transcription runs in the confnote Mac app with Local AI Cat (localaicat.com), so audio stays on the Mac. The Mac
> app's server-side Cat transcription (`packages/local-app/transcription.py`) is unchanged. The rest of this page is
> kept as the record of what was asked.
>
> **Later the same day: hosted transcription is locked.** Conferences may not like recording and transcription, so
> the hosted Transcript tab stays visible but locked: no recording, no audio file, and the own-OpenAI-key path is
> gone from the hosted UI. An info button explains that transcription runs on device in the Mac app with Local AI
> Cat, and people can paste a transcript they already have. A narrower Cat ask (the transcription endpoint only, for
> confnote.si origins) is in the backlog: [`docs/internal/backlog.md`](../internal/backlog.md).

What Local AI Cat must do so that confnote's hosted web app (confnote.si) can transcribe audio through the Cat
running on the user's own computer, called **straight from the browser**. Hand this page to the Local AI Cat team.
Written 2026-11-10; browser facts checked that day (sources at the end).

## What confnote does

The Mac app already does this server-side (`packages/local-app/transcription.py`). The hosted site does the same
request from the page (`packages/core-ui/static/browser-transcribe.js`), so the audio never touches confnote's
servers:

| Step | Request from the page |
|---|---|
| Status and Settings → Test connection | `GET http://127.0.0.1:11434/health` (CORS mode, no headers, no credentials) |
| Transcribe a recording or an audio file | `POST http://127.0.0.1:11434/v1/audio/transcriptions`, `multipart/form-data` built by `FormData`: `model` (default `whisper-1`), `response_format=json`, `save=true\|false` (keep in Cat history, default `false`), `file` |
| Explain a failure | `GET http://127.0.0.1:11434/health` with `mode: "no-cors"` after a CORS failure, to tell "not running" from "running but refused" |

The base URL is the user's setting (default `http://127.0.0.1:11434`, the Mac app's default). The page sets no
request headers and no credentials, so both calls are CORS *simple requests*: today the browser sends **no
preflight**. It expects `{"text": "..."}` back, then appends the text to the note's `## Transcript` through
confnote's own note API.

## Origins to allow

Allow exactly these origins, compared as whole strings:

- `https://confnote.si`
- `https://www.confnote.si`
- `https://staging.confnote.si`

Localhost development origins are **not** needed: the e2e tests use a fake Cat, and confnote's local Mac app calls
the Cat server-side, where CORS does not apply. If the Cat team wants a developer toggle, keep it off by default and
limit it to `http://127.0.0.1:<port>` and `http://localhost:<port>`.

Preview deployments (`*.vercel.app`) are **not** wanted: anyone can create one, so allowing a pattern would let any
site call the Cat.

## Endpoints and headers

Handle these for an allowed origin:

| Method | Path | Why |
|---|---|---|
| `GET` | `/health` | status and the Test button |
| `POST` | `/v1/audio/transcriptions` | the transcription |
| `OPTIONS` | `/health`, `/v1/audio/transcriptions` | preflight: not sent today, but needed the day the page adds a header (for example `Authorization` for an App Store build with API auth on; see below) |

### Preflight response (`OPTIONS`)

When the request's `Origin` is on the list, answer `204 No Content` with:

```http
Access-Control-Allow-Origin: https://confnote.si
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Allow-Private-Network: true
Access-Control-Max-Age: 600
Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network
```

- `Access-Control-Allow-Origin` echoes the request's `Origin` when it is on the list. **Never `*`.**
- `Access-Control-Allow-Private-Network: true` only when the request carried
  `Access-Control-Request-Private-Network: true`. Chrome no longer requires it (see the browser state below), but it
  costs nothing and keeps older Chromium builds working.
- `Access-Control-Max-Age: 600`: the browsers cap it anyway (Chromium at 7200 s, Firefox at 86400 s, WebKit at
  600 s), and a short value lets an allow-list change take effect quickly.
- Do not send `Access-Control-Allow-Credentials`. The page sends no cookies and must not be able to.

When the `Origin` is **not** on the list, answer `403` with no `Access-Control-*` headers.

### Actual response (`GET /health`, `POST /v1/audio/transcriptions`)

For an allowed origin, add to the normal response, including error responses (4xx/5xx) so the page can read the
error:

```http
Access-Control-Allow-Origin: https://confnote.si
Vary: Origin
```

When the `Origin` is **not** on the list:

- `GET /health`: answer as today, without `Access-Control-*` headers. The browser then hides the response from the
  page, and confnote shows "Local AI Cat is running at … but does not allow https://… yet".
- `POST /v1/audio/transcriptions`: **reject with `403` before reading or transcribing the audio.** A multipart POST
  is a simple request: the browser sends it with no preflight, so leaving out the CORS header only hides the answer;
  the Cat would still do the work. Checking `Origin` server-side is what stops it.

Requests with no `Origin` header (curl, the Mac app's server, other native clients) are unaffected.

## API auth (App Store build)

The Cat's App Store build turns bearer-token auth on by default (Outdoor builds keep it off). The hosted page sends no
token today: neither the hosted page nor the Mac app's Settings has a field for a Local AI Cat token. With auth on, the
POST fails with 401 and confnote shows `transcription failed (HTTP 401)`. Two options, a product call for the Cat
team:

1. Treat a request from an allow-listed origin as authorised for `/v1/audio/transcriptions` only (the Local Network
   Access prompt below is the user's consent for that site).
2. Keep the token and add a token field to confnote's hosted Settings (kept in `localStorage`). Sending
   `Authorization` makes every POST preflighted, so `OPTIONS` must then answer as above.

## Browser state (checked 2026-11-10)

### Chrome and Edge: Local Network Access prompt

- The old Private Network Access (PNA) preflight (`Access-Control-Request-Private-Network`) ran in warning-only mode
  from Chrome 104. Its enforcement was put on hold in October 2024 and never shipped. Google's current guidance:
  "PNA preflights were never enforced as a blocking requirement and are not needed as a fallback."
- **Local Network Access (LNA)** replaced it. Since **Chrome 142** (stable 2025-10-28) a public site that reaches the
  user's own machine triggers a **permission prompt**. Since Chrome 145 the permission is split in two:
  `loopback-network` (127.0.0.1, localhost) and `local-network` (LAN). `https://confnote.si` → `http://127.0.0.1`
  asks for `loopback-network`, once per origin. confnote.si and staging.confnote.si are different origins, so each
  should ask on its own (our inference; not tested).
- **No mixed-content block**: Chrome treats `127.0.0.1` and `localhost` as potentially trustworthy, so an https page
  may fetch `http://127.0.0.1`. The `targetAddressSpace: "loopback"` fetch option is not needed for an IP literal.
- **CORS is still required** to read the response.
- If the user **denies** the prompt, `fetch()` rejects with a `TypeError`, just as when nothing is listening.
  confnote checks `navigator.permissions.query({name: "loopback-network"})` first and, if it says `denied`, tells the
  user to allow it in the site settings.
- Inside an iframe the permission needs `allow="local-network; loopback-network"`; confnote's app is a top-level
  page, so this does not apply.
- Managed browsers: admins can pre-allow the site with `LoopbackNetworkAllowedForUrls` (or
  `LocalNetworkAccessAllowedForUrls`).

### Firefox: same prompt

Firefox 84 and later treat `localhost` and `127.0.0.1` as secure (no mixed-content block). From **Firefox 151**
(2026-05-19) Local Network Access restrictions roll out to all users, with a permission prompt before a site reaches
"apps and services on your device". They are on by default for desktop from Firefox 153. The permission names are
the same (`loopback-network`, `local-network`). Firefox never sends PNA preflights. CORS is still required.

### Safari: blocked

Shipping Safari blocks `fetch()` from an https page to `http://127.0.0.1` (and to `http://localhost`) as **mixed
content**. WebKit's loopback exemption covers only upgradable loads (images, audio, video), not `fetch`. WebKit bug
171934 ("Treat http://localhost as potentially trustworthy") is still open, and WebKit's Local Network Access
implementation is behind an off-by-default setting. Nothing the Cat sends can fix this. Options:

- Safari users use the confnote Mac app (server-side, works today), Chrome or Firefox. confnote's "not reachable"
  message says so.
- Longer term, the Cat could serve HTTPS on loopback with a certificate the browser trusts. That is a bigger
  decision for the Cat team and not asked for here.

This comes from WebKit's source and bug threads, not a test on Safari 26.x.

## Security notes

- **Allow-list, never `*`.** With `Access-Control-Allow-Origin: *` every website the user visits could, once the
  user accepts the browser prompt or on a browser without one, read `/health` (fingerprint that the user runs the
  Cat, its version) and use the Cat as a free transcription service on the user's hardware. That spends battery and
  GPU, fills Cat history when `save=true`, and could transcribe any audio a malicious page holds.
- **Check `Origin` server-side on the POST**, not only in CORS headers, because simple requests are sent before CORS
  is checked (see above). The same applies to the recording endpoints (`/v1/local/transcription/recordings…`):
  confnote's hosted page does not use them, so they should refuse every browser origin. Starting the microphone from
  a website must never work.
- **No credentials.** Never send `Access-Control-Allow-Credentials: true`. The Cat's auth, if on, stays a bearer token,
  not a cookie.
- **Size and time limits.** Cap the upload (a request body limit, for example 200 MB, enough for a conference talk)
  and the transcription time per request, and answer `413` past the size limit. The page waits up to 300 s, like
  the Mac app.
- **Bind to loopback.** Keep listening on `127.0.0.1` only. The allow-list protects the browser path, not LAN access.
- **Exact matching.** Compare the whole `Origin` string (scheme, host, port). No suffix or substring checks:
  `https://confnote.si.evil.example` must not pass.

## How confnote reports each state

| State | What the user sees |
|---|---|
| Cat up and allowing the site | `ready · local`, then `transcribing <file>…`, then `added ✓`, with the text in `## Transcript` |
| Cat running but the site not allowed (CORS refused) | "Local AI Cat is running at http://127.0.0.1:11434 but does not allow https://confnote.si yet. Local AI Cat must allow this site…" |
| Cat not running, wrong port, or Safari | "Local AI Cat is not running at …, or this browser kept https://confnote.si from reaching it. Start Local AI Cat… allow the browser's local network prompt. Safari does not let https sites reach your computer…" |
| Browser prompt denied | "This browser blocked https://confnote.si from reaching apps on this computer. Allow it in the site settings…" |
| OpenAI chosen, tab key set | Audio goes from the page to `https://api.openai.com/v1/audio/transcriptions` with the key from Profile → Your AI key (held in the tab only) |

## Sources

- Chrome, PNA preflight warning mode: <https://developer.chrome.com/blog/private-network-access-preflight> (2022)
- Chrome, PNA on hold: <https://developer.chrome.com/blog/pna-on-hold> (2024-10-09)
- Chrome, Local Network Access: <https://developer.chrome.com/blog/local-network-access> (2025-06-09, updated
  2025-09-29) and <https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access>
- Chrome 142 release notes: <https://developer.chrome.com/release-notes/142>; chromestatus
  <https://chromestatus.com/feature/5152728072060928>
- Chrome 145 permission split (Intent to Ship, 2026-01-08):
  <https://groups.google.com/a/chromium.org/g/blink-dev/c/Zl3P6NHhMBw>
- WICG Local Network Access spec: <https://wicg.github.io/local-network-access/>
- Enterprise policies (Edge, Chromium-shared):
  <https://learn.microsoft.com/en-us/DeployEdge/microsoft-edge-browser-policies/localnetworkaccessallowedforurls>
- Firefox 151 release notes: <https://www.firefox.com/en-US/firefox/151.0/releasenotes/>; LNA meta bug
  <https://bugzilla.mozilla.org/show_bug.cgi?id=1481298>
- Firefox 84 localhost: <https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/84>
- MDN, secure contexts and mixed content:
  <https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts>,
  <https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content>
- MDN, `Access-Control-Max-Age` caps:
  <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Access-Control-Max-Age>
- WebKit, loopback mixed content: <https://bugs.webkit.org/show_bug.cgi?id=171934>; WebKit LNA:
  <https://bugs.webkit.org/show_bug.cgi?id=250607>
