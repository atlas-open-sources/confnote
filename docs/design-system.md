# confnote design system

One stylesheet family serves every surface: the Mac app (the local server inside a native window), the hosted
web app, the public site pages, the catalogue page and the Cat bridge. They load the same
`packages/core-ui/static/style.css`, so a change there shows up everywhere at once, and web and Mac stay
identical by construction.

The look is monochrome: ink, lines and one inverting accent. Colour means status, never decoration.

## Tokens

All tokens are CSS custom properties on `:root` in [`style.css`](../packages/core-ui/static/style.css). Rules
use the token, never the literal.

### Theme tokens (change with light / dark)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#ffffff` | `#000000` | Page background, input and button fill |
| `--panel` | `#ffffff` | `#0a0a0a` | Cards, drawer, modal and menu surfaces |
| `--ink` | `#000000` | `#ffffff` | Primary text, hover borders |
| `--muted` | `#666666` | `#8f8f8f` | Secondary text |
| `--faint` | `#8f8f8f` | `#666666` | Labels, mono captions, placeholders |
| `--line` | `#eaeaea` | `#2e2e2e` | Every 1px border and divider |
| `--accent` | `#000000` | `#ffffff` | Primary button fill (inverts per theme) |
| `--accent-soft` | `#f4f4f4` | `#161616` | Hover and selected fills |
| `--live` | `#0a7d33` | `#4ad17e` | Now / live / has-notes: the rail node, the context dot, progress bars |
| `--link` | `#7c3aed` | `#a78bfa` | Hyperlinks |
| `--shadow`, `--shadow-lg` | | | Hairline ring; ring plus a soft drop for popovers |

The dark values appear twice in `style.css`: once under `:root[data-theme="dark"]` (the user pinned dark) and
once under `prefers-color-scheme: dark` for "auto". CSS has no way to share one block between a selector and
a media query, so keep the two in step when a dark value changes.

### Status tokens (the same in both themes)

| Token | Value | Use |
|---|---|---|
| `--ok` | `#34c759` | Success: saved, connected, a toast's edge, the audio drop zone |
| `--ok-strong` | `#2bb14e` | Hover on an `--ok` fill |
| `--danger` | `#ff3b30` | Errors, failed checks, destructive confirms, recording |
| `--warn` | `#c77700` | Needs attention, not failed |
| `--on-status` | `#ffffff` | Text on an `--ok` or `--danger` fill |
| `--scrim` | 55% black | The backdrop behind a modal |

`--live` and `--ok` are both green on purpose: `--live` follows the theme and marks *now*; `--ok` is a fixed
system green for *it worked*.

### Shape and type

| Token | Value | Use |
|---|---|---|
| `--r1` | 4px | Buttons, inputs, chips |
| `--r2` | 6px | Cards, panels, modal boxes |
| `--r3` | 6px | Reserved for large surfaces (same as `--r2` today) |
| `--sans` | system UI stack | Body text |
| `--mono` | system mono stack | Times, labels, tabs, counters |
| `--content-max` | 1180px | Width cap of the main column |

### Layout variables

Set at runtime or by one component, read by others: `--sidebar-w` (sidebar width, written by `app.js` from the
resize grip), `--drawer-w` / `--drawer-tab-w` / `--drawer-tab-h` (drawer primitive, `drawer.css`), `--open-w`
(the open drawer's width, written by `drawer.js`), `--tg-row` (one row of the room-column time grid).

## Themes

- `index.html` sets `data-theme` before first paint from `localStorage["confnote-theme"]`; the ◐ button cycles
  auto → light → dark. "Auto" means no attribute, so the `prefers-color-scheme` block applies.
- `color-scheme` follows the theme, so native controls (selects, date pickers, scrollbars) match.
- **The Cat theme** ([`packages/cat-app/static/cat-theme.css`](../packages/cat-app/static/cat-theme.css)) maps
  the theme tokens onto the Cat's `--cat-light-*` / `--cat-dark-*` colours. Its selectors mirror `style.css`'s
  three theme blocks one for one and it loads later, so it wins at equal specificity. It only redefines theme
  tokens; status tokens stay as they are.

## Components

Each component is defined once. Reuse the class rather than restyling a new one.

| Component | Classes | Where |
|---|---|---|
| Top bar, brand, window controls | `#topbar`, `.brand`, `#winctl`, `#rightctl`, `.themebtn` | `style.css` (topbar) |
| Primary button | `.primary` (filled `--accent`, text `--bg`) | `style.css` (rich conference schedule) |
| Quiet button | `.gbtn`, `.themebtn`, `.chat-head-btn` | `style.css`, `drawer.css` |
| Settings buttons | `.set-btn`, `.set-btn-primary` (`--ok` fill), `.set-btn-ghost` | `style.css` (settings modal) |
| Pills and filters | `.pill`, `.pill.on`, `.pill-row`, `.conf-tab` | `style.css` |
| Tabs | `.tabbar .tab` (editor, with pane 1/2 markers), `.htab` (home) sharing `.tab:hover` / `.tab.on` | `style.css` |
| Timeline rail | `.rl-row` (agenda rail), `.trow` + `.tr-card` (My events) | `style.css` |
| Modal | `.modal-ov` (on `--scrim`), `.modal-box`, `.modal-head`, `.modal-foot` | `style.css` |
| Toast | `.toast-strip`, `.toast`, `.toast-err` | `style.css` (`toast.js`) |
| Resize grip | `.sb-grip`, `.drawer-grip` share one `::after` hairline | `style.css` |
| Drawer primitive | `.drawer-strip`, `.drawer-tab`, `.drawer-host`, `.drawer-head`, `.drawer-body` | `drawer.css` |
| Profile menu and wallet | `.product-account`, `.product-controls`, `.pa-*`, `.wallet-*` | `product-shell.css` |

## Where each file's CSS lives

| File | Loaded by | Holds |
|---|---|---|
| [`core-ui/static/style.css`](../packages/core-ui/static/style.css) | every surface | Tokens, base, shell grid, top bar, sidebar rail, editor, modals, settings, toasts, home, conference schedule |
| [`core-ui/static/drawer.css`](../packages/core-ui/static/drawer.css) | `index.html` | The right-edge drawer primitive and its head buttons |
| [`core-ui/static/agent-settings.css`](../packages/core-ui/static/agent-settings.css) | `index.html` | Agent picker row in the Concierge (Mac) |
| [`core-ui/static/day-setup.css`](../packages/core-ui/static/day-setup.css) | `index.html` | Day goals modal |
| [`core-ui/static/find-events.css`](../packages/core-ui/static/find-events.css) | `index.html`, catalogue page | Find events view, scoped to `.catalogue` |
| [`core-ui/static/mobile-shell.css`](../packages/core-ui/static/mobile-shell.css) | `index.html` (after the rest) | Narrow-screen shell (≤650px) |
| [`core-ui/static/product-shell.css`](../packages/core-ui/static/product-shell.css) | `index.html` (after the rest) | Web profile menu, wallet and 402 top-up card |
| `core-ui/static/modules/<name>/<name>.css` | the module's own JS, on mount | One module's chrome: `chat`, `aggrid`, `bryntum`, `tldraw` |
| [`web-app/site/site.css`](../packages/web-app/site/site.css) | `/demo`, `/download`, `/terms`, `/catalogue/` | Undoes the app shell grid; reading-width page layout |
| [`catalogue-web/static/style.css`](../packages/catalogue-web/static/style.css) | `/catalogue/` | The catalogue page's intro and footer |
| [`cat-app/static/cat-theme.css`](../packages/cat-app/static/cat-theme.css) | the Cat, when "Cat theme" is on | Token remap onto the Cat's colours |

Vendor modules (AG Grid, Bryntum, tldraw) theme their widgets from these tokens: AG Grid through its theme
params, Bryntum by seating the svalbard theme on `--panel` / `--line` / `--ink` / `--muted`. The Planner's bar
colours (going, plan, charge, grant, clash) are a module palette kept in `bryntum.css`, not app tokens.

## Rules

- No colour literal outside the token blocks. A new status colour becomes a token here first.
- No fallback in `var()` for a core token (`var(--muted)`, not `var(--muted, #71717a)`): the tokens are always
  defined, and a fallback hides a typo such as an undefined token.
- A module's CSS lives in its module folder and is loaded by its JS; `app.js` never references a vendor module.
- Before and after any CSS change, render every screen in light and dark and diff the pixels; list each visible
  change in the commit or PR.
