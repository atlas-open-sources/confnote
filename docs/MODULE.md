# Writing a confnote module

A **module** is a self-contained side-panel feature that plugs into the
right-edge **drawer**. Modules are discovered by convention — a folder plus one
line of config — so **core never references a module by name** (enforced by a
grep test). Drop a module in, list it, reload; remove it and it's gone with no
residue.

This is the supported way to extend confnote **locally / from source** today.
You can write a module by hand, or paste this contract into your own coding
agent and have it scaffold one. (A sandboxed, permissioned marketplace for
*untrusted third-party* modules is a separate future effort — see
[`backlog.md`](internal/backlog.md). Locally-authored / from-source modules are trusted
code on your own machine.)

confnote's own modules — the **Concierge** (`chat`) and **Sketch** (`tldraw`) —
are built to this exact contract. There is no first-party special-casing.

---

## Anatomy

```
packages/core-ui/static/modules/<name>/      # frontend (required)
  <name>.js          # entry script — self-registers with the drawer
  manifest.json      # metadata
  <name>.css         # optional styles
  vendor/            # optional pre-built bundle (e.g. an esbuild island)

packages/local-app/modules/<name>/           # backend (optional)
  mcp.py             # exposes agent tools via make_server()
```

The frontend folder name, the backend folder name, the manifest `id`, and the
slot string in `modules.config.json` are **all the same `<name>`**. That string
is the only thing that ties the pieces together.

---

## 1. Frontend (required)

### `manifest.json`

```json
{
  "id": "speakers",
  "label": "Speakers",
  "entry": "speakers.js",
  "description": "One-line summary of what this module does.",
  "primitive": "drawer"
}
```

- `id` — must match the folder name and the `modules.config.json` slot.
- `label` — the text on the right-edge handle.
- `entry` — the script filename (loaded as `/modules/<id>/<entry>`).
- `primitive` — `"drawer"` (default surface) or `"fab"` (the legacy
  bottom-right floating panel; still supported).

### `<name>.js`

The entry script **self-registers** with the drawer. It must be safe to load in
any order (registration is order-free):

```js
(function () {
  if (!window.confnote || !window.confnote.drawer) return;
  window.confnote.drawer.register({
    id: "speakers",
    label: "Speakers",
    // Called when the panel opens. `host` is your panel's container element;
    // `ctx` is the current page context (conference slug, open note, …).
    render(host, ctx) {
      host.replaceChildren();
      const h = document.createElement("h3");
      h.textContent = "Speakers";
      host.append(h);
      // …build your UI from ctx / fetch from the server API…
    },
    // Optional: renderHead(headEl) to add controls to the panel header.
  });
})();
```

Context helpers on `window.confnote`:

- `window.confnote.context` — the current `{ slug, conf, noteTitle, … }`.
- `window.confnote.onContextChange(fn)` — subscribe to navigation changes so
  your panel can update when the user opens a different conference/session.

Modules talk to the backend through the normal HTTP API (`/api/conference`,
`/api/note`, `/api/actions`, …) — the same endpoints the core app uses.

**Minimal reference:** [`modules/module-2/`](../packages/core-ui/static/modules/module-2/)
is a complete frontend-only module in ~30 lines. [`modules/aggrid/`](../packages/core-ui/static/modules/aggrid/)
is a full one: a lazy-loaded vendor bundle (AG Grid Community) over the existing HTTP API.

---

## 2. Backend (optional) — agent tools

If your module wants the **Concierge to be able to do things** (drive a UI,
write files, call an API), add `packages/local-app/modules/<name>/mcp.py`
exposing a `make_server` function. `chat.py` auto-discovers it for any enabled
module and merges its tools into the agent — again, **zero references to your
module name in core**.

```python
# packages/local-app/modules/speakers/mcp.py
from claude_agent_sdk import create_sdk_mcp_server, tool

def make_server(*, emit, bridges) -> dict:
    @tool("rank_speakers", "Rank speakers by relevance", {"q": str})
    async def rank_speakers(args):
        ...
        return {"content": [{"type": "text", "text": "…"}]}

    return {
        "name": "speakers",
        "server": create_sdk_mcp_server("speakers", "1.0", [rank_speakers]),
        "allowed_tools": ["mcp__speakers__rank_speakers"],
        "tool_notices": {"rank_speakers": "✦ ranking speakers…"},  # optional
        "system_prompt_fragment": "You can rank speakers with rank_speakers.",  # optional
    }
```

- `emit` — push a `{"notice"|"toast"|…}` event to the live chat stream.
- `bridges` — per-module SSE bridge (`bridges["<name>"]`) for **calling into
  your live frontend island and awaiting a result** (this is how `tldraw`'s
  agent tools draw on the canvas). Use it only if your module has a frontend
  surface the agent needs to drive.

**Full reference:** [`tldraw`](../packages/core-ui/static/modules/tldraw/) +
[`packages/local-app/modules/tldraw/mcp.py`](../packages/local-app/modules/tldraw/mcp.py)
— a React island, a pre-built vendor bundle, an MCP server, and the bridge.

---

## 3. Enable it

Add the `<name>` to the `slots` array in
[`modules.config.json`](../packages/core-ui/static/modules.config.json):

```json
{ "slots": ["speakers", "module-2", "module-3", "chat"] }
```

- Max **4** slots (`MAX_DRAWER_SLOTS`).
- Convention: keep `chat` (Concierge) in the **last** slot so it anchors the
  bottom of the strip.
- Reload the app — the drawer reads the config on boot, loads each slot's entry
  script, and paints the handles.

---

## Rules (what keeps it a clean plug-in)

- **Core never names a module.** `grep -ri "<name>" packages/core-ui/static/app.js`
  (and `chat.py`, `server.py`) must return zero. A test enforces this. Core only
  iterates the config + filesystem.
- **Generic names in core.** Slots ship as `module-1/2/3`; vendor/feature names
  live only inside their own module directories.
- **Fully removable.** Delete the module dir(s) and remove the slot string —
  nothing else changes.
- **Vendor weight is web-only.** Heavy paid/trial bundles (AG Grid, Bryntum)
  ship only in the web target, never in the local `.app`.
- **Build a frontend bundle ahead of time.** If you use a framework (React,
  etc.), commit the built `vendor/` bundle; don't ship `node_modules`.

---

## Authoring with your own agent

Because the contract is small and convention-driven, you can hand it to a coding
agent: point it at this file, describe the panel you want ("a drawer panel that
pivots speakers by company"), and let it scaffold `modules/<name>/` + add the
slot. Then reload. Your agent runs under your own review and permissions — the
in-app Concierge stays sandboxed and never writes module code itself.
