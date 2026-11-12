const LINKSFILES = "Links & Files";
const PRIVATE = "Private"; // client-encrypted, agent-invisible commentary
// Sections the note editor can edit (the save payload carries only the dirty
// ones). Brief/Debrief data is preserved on disk (server re-reads + keeps
// untouched sections) but no longer has a UI to edit.
const EDITABLE = { "Human notes": 1, Transcript: 1, Actions: 1 };
const TABS = [
  "Human notes",
  "Summary",
  "Research",
  "AI notes",
  "Transcript",
  "Actions",
  LINKSFILES,
  PRIVATE,
];
const READONLY = { Summary: 1, Research: 1, "AI notes": 1 }; // AI-driven / agent-owned
const ACTION_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/; // shared task-list contract

const app = document.getElementById("app");
const crumbs = document.getElementById("crumbs");
const statusEl = document.getElementById("status");
const PUBLIC_DEMO = Boolean(window.confnote && window.confnote.publicDemo);
// Public demo: the server is read-only, so visitors' notes live in their own
// browser (browser-notes.js). Only these sections are writable there.
const BROWSER_NOTES = PUBLIC_DEMO ? window.confnote.browserNotes : null;
const BROWSER_EDITABLE = BROWSER_NOTES ? { "Human notes": 1 } : {};
const DOWNLOAD_PAGE = "/download";

const S = {
  slug: null,
  conf: null,
  file: null,
  note: null,
  routeSeq: 0,
  // tab1: section shown in the (always-present) left pane.
  // tab2: section shown in the right pane when the user split — `null` = no split.
  tab1: "Human notes",
  tab2: null,
  dirty: false,
  // Note sections edited since the last save. saveNow sends only these, so a
  // stale in-memory copy of another section never overwrites a newer disk copy.
  dirtySections: new Set(),
  // Bumped when a note save starts and ends; a poll read that straddles a save
  // may predate it and is dropped.
  saveSeq: 0,
  // The note PUT in flight, if any: saves run one at a time.
  savePromise: null,
  saveTimer: null,
  poll: null,
  railTimer: null,
  scheduleTimer: null,
  scheduleRefresh: false,
  pendingTab: null,
  // Independent EasyMDE instance per pane (only present on editable tabs).
  mde1: null,
  mde2: null,
  // Private commentary: in-memory AES key (null = locked) + cached /api/private
  // metadata. The key never persists; it auto-locks on app close.
  privKey: null,
  privMeta: null,
};

// ---------- safe HTML mount (allowlist sanitizer, no innerHTML) ----------
const ALLOW = {
  DIV: ["class", "id", "style", "data-p", "data-note"],
  SECTION: ["class", "id"],
  ARTICLE: ["class", "id"],
  SPAN: ["class", "id", "style", "data-debrief", "data-count", "title"],
  NAV: ["class", "id"],
  I: ["class", "style"],
  BUTTON: [
    "class",
    "id",
    "data-t",
    "data-m",
    "data-p",
    "data-view",
    "data-filter",
    "data-template",
    "data-manifest",
    "data-star",
    "data-jump",
    "data-debrief",
    "data-actions",
    "data-confdebrief",
    "data-brief",
    "data-count",
    "data-act",
    "data-note",
    "data-rel",
    "data-img",
    "type",
    "title",
    "draggable",
    "disabled",
    "aria-label",
    "hidden",
    "aria-pressed",
  ],
  A: ["class", "href", "target", "rel", "title"],
  IMG: ["class", "alt", "src"],
  FIGURE: ["class"],
  FIGCAPTION: [],
  TEXTAREA: ["id", "class", "spellcheck", "placeholder", "rows"],
  INPUT: ["type", "class", "id", "placeholder", "value", "data-idx", "data-note"],
  LABEL: ["class", "data-idx", "data-note"],
  P: ["class"],
  H1: ["class"],
  H2: ["class"],
  H3: ["class"],
  UL: ["class"],
  OL: [],
  LI: ["class"],
  CODE: [],
  PRE: [],
  BLOCKQUOTE: [],
  STRONG: [],
  EM: [],
  BR: [],
  HR: [],
};
const safeUrl = (u) => /^(https?:|mailto:|\/|#)/i.test((u || "").trim());

function clean(srcNode, out) {
  for (const n of srcNode.childNodes) {
    if (n.nodeType === 3) {
      out.appendChild(document.createTextNode(n.nodeValue));
      continue;
    }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName;
    if (tag === "SCRIPT" || tag === "STYLE") continue;
    const allowed = ALLOW[tag];
    if (!allowed) {
      clean(n, out);
      continue;
    } // drop tag, keep safe children
    const el = document.createElement(tag);
    for (const a of allowed) {
      if (!n.hasAttribute(a)) continue;
      const v = n.getAttribute(a);
      if ((a === "href" || a === "src") && !safeUrl(v)) continue;
      if (a === "style" && /url\s*\(|expression/i.test(v)) continue;
      el.setAttribute(a, v);
    }
    if (tag === "TEXTAREA") el.value = n.textContent;
    else clean(n, el);
    out.appendChild(el);
  }
}
function mount(node, html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const frag = document.createDocumentFragment();
  clean(doc.body, frag);
  node.replaceChildren(frag);
}

// ---------- helpers ----------
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(r.status);
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
}
const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = "status" + (cls ? " " + cls : "");
}

// minimal markdown -> html (output is sanitized by mount())
function mdToHtml(src, slug) {
  if (!src || !src.trim()) return '<p class="empty" style="padding:20px">— empty —</p>';
  const lines = src.replace(/\r/g, "").split("\n");
  let html = "",
    i = 0;
  // A note's own files (`assets/<talk>/x`, what the Files tab's "link" button
  // inserts) are served by /assets; a bare relative href 404s against the page.
  const assetUrl = (u) => `/assets?slug=${slug}&path=${encodeURIComponent(u)}`;
  const inline = (t) =>
    esc(t)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(
        /!\[([^\]]*)\]\(([^)]+)\)/g,
        (_m, a, u) => `<img alt="${a}" src="${/^https?:|^\//.test(u) ? u : assetUrl(u)}">`,
      )
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_m, a, u) =>
          `<a href="${u.startsWith("assets/") ? assetUrl(u) : u}" target="_blank" rel="noopener">${a}</a>`,
      );
  // Consume a list, tolerating blank lines BETWEEN items. Without this, a list
  // whose items are separated by blank lines (e.g. a /debrief's numbered
  // takeaways) closes after every item, so each item becomes its own <ol> that
  // restarts the counter — rendering "1. 1. 1." instead of "1. 2. 3.".
  const consumeList = (tag, itemRe) => {
    let out = `<${tag}>`;
    while (i < lines.length) {
      if (itemRe.test(lines[i])) {
        out += `<li>${inline(lines[i].replace(itemRe, ""))}</li>`;
        i++;
      } else if (lines[i].trim() === "") {
        // Stay in the list only if a later line (past the blank gap) resumes
        // it; otherwise the blank ends the list.
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === "") j++;
        if (j < lines.length && itemRe.test(lines[j])) i = j;
        else break;
      } else break;
    }
    return out + `</${tag}>`;
  };
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      let b = "";
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) b += lines[i++] + "\n";
      i++;
      html += `<pre><code>${esc(b)}</code></pre>`;
      continue;
    }
    let m;
    if ((m = l.match(/^(#{1,3})\s+(.*)/))) {
      const k = m[1].length;
      html += `<h${k}>${inline(m[2])}</h${k}>`;
      i++;
      continue;
    }
    if (/^\s*>/.test(l)) {
      let b = "";
      while (i < lines.length && /^\s*>/.test(lines[i]))
        b += lines[i++].replace(/^\s*>\s?/, "") + " ";
      html += `<blockquote>${inline(b.trim())}</blockquote>`;
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      html += consumeList("ul", /^\s*[-*]\s+/);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(l)) {
      html += consumeList("ol", /^\s*\d+\.\s+/);
      continue;
    }
    if (/^\s*---\s*$/.test(l)) {
      html += "<hr>";
      i++;
      continue;
    }
    if (l.trim() === "") {
      i++;
      continue;
    }
    // notes-friendly: a single newline is a hard line break (not collapsed)
    const pl = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,3}\s|\s*[-*]\s|\s*\d+\.\s|```|\s*>)/.test(lines[i])
    )
      pl.push(inline(lines[i++]));
    html += `<p>${pl.join("<br>")}</p>`;
  }
  return html;
}

// ---------- debrief actions (shared parse/toggle on raw markdown) ----------
// Each action maps back to a line index so toggling rewrites in place and
// leaves the free-text portion of Debrief untouched.
function parseActions(src) {
  const out = [];
  (src || "")
    .replace(/\r/g, "")
    .split("\n")
    .forEach((line, idx) => {
      const m = line.match(ACTION_RE);
      if (m) out.push({ idx, text: m[2].trim(), done: m[1].toLowerCase() === "x" });
    });
  return out;
}
// Mirror of server.has_content / _section_has_real_content so the live
// in-editor marker agrees with the loaded sidebar state: a note counts as
// "has notes" when ANY content section holds real (non-seed) text, not just
// Human notes. Links is excluded (agenda-seeded + mirrored from Human notes).
const SEED_MARKERS = [
  "AI-driven — seeded from the agenda",
  "Speaker & company dossier — run tools/research.py",
  "Agent-owned. Live notes and follow-up research land here.",
  "Tasks and follow-ups — `- [ ] task` lines",
];
const CONTENT_SECTIONS = [
  "Human notes",
  "Summary",
  "Research",
  "AI notes",
  "Transcript",
  "Actions",
  "Scratchpad",
];
function sectionHasRealContent(name, body) {
  const text = (body || "").trim();
  if (!text) return false;
  if (name === "Actions") return parseActions(text).some((a) => a.text);
  return text.split("\n").some((line) => {
    const s = line.trim();
    if (!s || SEED_MARKERS.some((m) => s.includes(m))) return false;
    if (name === "Summary" && s.startsWith(">")) return false; // seeded description
    return true;
  });
}
function noteHasContent(sections) {
  return CONTENT_SECTIONS.some((name) => sectionHasRealContent(name, sections?.[name]));
}
function publicTabHasContent(name) {
  if (!PUBLIC_DEMO) return true;
  if (BROWSER_EDITABLE[name]) return true; // visitors write here, kept in their browser
  if (name === PRIVATE || name === "Transcript") return false;
  if (name === LINKSFILES) {
    return /https?:\/\//.test(Object.values(S.note?.sections || {}).join("\n"));
  }
  return sectionHasRealContent(name, S.note?.sections?.[name]);
}
function visibleNoteTabs() {
  if (!PUBLIC_DEMO) return TABS;
  const tabs = TABS.filter(publicTabHasContent);
  return tabs.length ? tabs : ["Human notes"];
}
// Is `name` the section currently shown in either editor pane? Used to avoid
// overwriting a live edit when the server returns a server-modified section.
function isSectionEditing(name) {
  return S.tab1 === name || S.tab2 === name;
}
function syncCurrentNoteMarker() {
  if (!S.conf || !S.file || !S.note) return;
  const has = noteHasContent(S.note.sections);
  const ev = S.conf.events.find((e) => e.note === S.file);
  if (ev) ev.has_notes = has;
  sidebar.querySelectorAll(".rl-row[href]").forEach((row) => {
    if (row.getAttribute("href") === `#/${S.slug}/${S.file}`) row.classList.toggle("has", has);
  });
}
function toggleActionLine(src, idx) {
  const lines = (src || "").replace(/\r/g, "").split("\n");
  const m = (lines[idx] || "").match(ACTION_RE);
  if (!m) return src;
  const flipped = m[1].toLowerCase() === "x" ? " " : "x";
  lines[idx] = lines[idx].replace(/\[([ xX])\]/, `[${flipped}]`);
  return lines.join("\n");
}
function appendActionLine(src, text) {
  const base = (src || "").replace(/\s+$/, "");
  const line = `- [ ] ${text.trim()}`;
  return base ? base + "\n" + line : line;
}

// ---------- routing ----------
function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  return h ? h.split("/") : [];
}
async function route() {
  const routeSeq = ++S.routeSeq;
  await flush();
  destroyMDE(1);
  destroyMDE(2);
  destroyConfDoc();
  closeDebriefModal();
  if (S.poll) {
    clearInterval(S.poll);
    S.poll = null;
  }
  if (S.scheduleTimer) {
    clearInterval(S.scheduleTimer);
    S.scheduleTimer = null;
  }
  if (S.railTimer) {
    clearInterval(S.railTimer);
    S.railTimer = null;
  }
  const [slug, file] = parseHash();
  // Moving between Find events and one of its events keeps the view (and its filters) in place.
  if (slug === FIND_ROUTE && S.findView && app.contains(S.findView.host)) {
    syncFindDetail();
    return S.findView.view.render();
  }
  if (!slug || slug === FIND_ROUTE) return renderHome(routeSeq);
  return renderConference(slug, file || null, routeSeq);
}
window.addEventListener("hashchange", route);
window.addEventListener("beforeunload", () => {
  if (S.dirty) saveNow();
});

// ---------- home: My events (Upcoming | Past) and Find events ----------
// Find events lives at #/~find (an event's details at #/~find/<id>); "~" never appears in a conference slug.
const FIND_ROUTE = "~find";
const MINE_WHEN_KEY = "confnote-myevents-when";
const todayISO = () => new Date().toISOString().slice(0, 10);
const prettyDate = (iso) => {
  const d = new Date(iso + "T00:00:00");
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
};
// A rail day-divider label: prefixes Today / Yesterday / Tomorrow when the
// date is within a day of now, so a multi-day agenda reads as distinct days.
// Compact date (no comma / year) so the label stays on one line in the rail.
const dayLabel = (iso) => {
  const d = new Date(iso + "T00:00:00");
  const t = new Date(todayISO() + "T00:00:00");
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Math.round((d - t) / 86400000);
  const rel = diff === 0 ? "Today" : diff === -1 ? "Yesterday" : diff === 1 ? "Tomorrow" : "";
  const short = d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return rel ? `${rel} · ${short}` : short;
};
const dateKey = (iso) => (iso || "").slice(0, 10);
const timeRange = (ev) => `${hhmm(ev.start || "")}–${hhmm(ev.end || "")}`;
const eventStartMs = (ev) => +new Date(ev.start || "");
const eventEndMs = (ev) => +new Date(ev.end || "");
const eventIsTimed = (ev) => Number.isFinite(eventStartMs(ev)) && Number.isFinite(eventEndMs(ev));
const eventIsNow = (ev, now = Date.now()) =>
  eventIsTimed(ev) && eventStartMs(ev) <= now && now < eventEndMs(ev);
const eventIsFuture = (ev, now = Date.now()) => eventIsTimed(ev) && eventStartMs(ev) > now;

function namedLookup(rows) {
  const out = {};
  for (const row of rows || []) {
    if (row && row.id) out[row.id] = row.name || row.id;
  }
  return out;
}

function roomLabel(ev) {
  const rooms = namedLookup(S.conf?.rooms || []);
  return rooms[ev.room] || ev.room || "";
}

function trackLabel(ev) {
  const tracks = namedLookup(S.conf?.tracks || []);
  return tracks[ev.track] || ev.track || "";
}

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item) || "";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

// Stars are picks: "attending: true" in each session note's frontmatter, read
// from the conference payload and written through PUT /api/picks on the Mac
// app and the hosted site alike, so they sync with the notebook and both
// Concierges can read them. The read-only public demo keeps them in this
// browser. Stars this browser kept before picks moved into the notes are
// filed into the notebook once (migrateLegacyStars).
const legacyStarKey = (slug) => `confnote-stars-${slug}`;
const picksCache = new Map(); // slug → Set of picked note files
const picksPending = new Map(); // slug → in-flight PUTs, so a stale read never undoes a click
function readLegacyStars(slug) {
  try {
    return new Set(JSON.parse(localStorage.getItem(legacyStarKey(slug)) || "[]"));
  } catch (_e) {
    return new Set();
  }
}
function starredNotes(slug = S.slug) {
  if (PUBLIC_DEMO) return readLegacyStars(slug);
  return new Set(picksCache.get(slug) || []);
}
function announcePicks(slug) {
  window.dispatchEvent(new CustomEvent("confnote-stars-changed", { detail: { slug } }));
}
function adoptPicks(slug, notes) {
  if (PUBLIC_DEMO || picksPending.get(slug)) return false;
  const next = new Set(notes);
  const prev = picksCache.get(slug);
  picksCache.set(slug, next);
  const same = prev && prev.size === next.size && [...next].every((note) => prev.has(note));
  if (!same) announcePicks(slug);
  return !same;
}
function adoptConferencePicks(slug, conf) {
  adoptPicks(
    slug,
    (conf?.events || []).filter((ev) => ev.note && ev.attending).map((ev) => ev.note),
  );
}
async function savePicks(slug, changes) {
  if (PUBLIC_DEMO) {
    const notes = readLegacyStars(slug);
    for (const [note, on] of Object.entries(changes)) {
      if (on) notes.add(note);
      else notes.delete(note);
    }
    localStorage.setItem(legacyStarKey(slug), JSON.stringify([...notes].sort()));
    announcePicks(slug);
    return true;
  }
  const before = new Set(picksCache.get(slug) || []);
  const optimistic = new Set(before);
  for (const [note, on] of Object.entries(changes)) {
    if (on) optimistic.add(note);
    else optimistic.delete(note);
  }
  picksCache.set(slug, optimistic);
  announcePicks(slug);
  picksPending.set(slug, (picksPending.get(slug) || 0) + 1);
  let saved = null;
  try {
    const r = await fetch(`/api/picks?slug=${encodeURIComponent(slug)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Confnote-Request": "1" },
      body: JSON.stringify({ picks: changes }),
    });
    if (r.ok) saved = await r.json();
  } catch (_e) {
    saved = null;
  } finally {
    picksPending.set(slug, picksPending.get(slug) - 1);
  }
  if (saved) {
    adoptPicks(slug, saved.notes || []);
    return true;
  }
  picksCache.set(slug, before);
  announcePicks(slug);
  window.confnote?.showToast?.({
    title: "Pick not saved",
    body: "Your notebook could not be reached. Try again.",
    kind: "error",
  });
  return false;
}
// Stars from before picks lived in the notes: file them once, then forget them.
async function migrateLegacyStars(slug, conf) {
  if (PUBLIC_DEMO) return;
  const legacy = readLegacyStars(slug);
  if (!legacy.size) return;
  const known = new Set((conf?.events || []).map((ev) => ev.note).filter(Boolean));
  const changes = {};
  for (const note of legacy) if (known.has(note)) changes[note] = true;
  if (Object.keys(changes).length && !(await savePicks(slug, changes))) return;
  localStorage.removeItem(legacyStarKey(slug));
  if (slug === S.slug) repaintStars(slug);
}
// Another device (or the Concierge) may have changed the picks: re-read them.
async function refreshPicks(slug = S.slug) {
  if (PUBLIC_DEMO || !slug) return;
  try {
    const data = await api(`/api/picks?slug=${encodeURIComponent(slug)}`);
    if (adoptPicks(slug, data.notes || [])) repaintStars(slug);
  } catch (_e) {}
}
function isStarred(ev, slug = S.slug) {
  return !!ev.note && starredNotes(slug).has(ev.note);
}
function setStarred(ev, on, slug = S.slug) {
  if (!ev.note) return;
  savePicks(slug, { [ev.note]: on }).then((saved) => {
    if (!saved) repaintStars(slug);
  });
}

// The event's own links under its name in the rail: the source page the agenda
// came from, the website, then conference.links ([{label, url}]: tickets,
// socials, livestream). Only http(s) URLs, each once.
function eventLinks(conf) {
  const links = [];
  const add = (label, url) => {
    if (!/^https?:\/\//i.test(url || "") || links.some((link) => link.url === url)) return;
    links.push({ label, url });
  };
  for (const source of conf.sources || []) add(source.label || "Source", source.url);
  add("Website", conf.conference?.url);
  for (const link of conf.conference?.links || []) add(link.label || "Link", link.url);
  return links;
}

function eventLinksRow(conf) {
  const links = eventLinks(conf);
  if (!links.length) return "";
  return `<div class="rl-links">${links
    .map(
      (link) =>
        `<a href="${esc(link.url)}" target="_blank" rel="noopener" title="${esc(link.url)}">${esc(link.label)} ↗</a>`,
    )
    .join("")}</div>`;
}

// The rail's rows map to events through S.railRows (DOM order); rows carry no
// data-* attributes because mount() strips them.
function railRowEvents() {
  const rows = [...document.querySelectorAll("#railTrack .rl-row")];
  return rows.map((row, i) => ({ row, ev: S.conf?.events[S.railRows?.[i]] }));
}

function eventsOverlap(a, b) {
  return eventStartMs(a) < eventEndMs(b) && eventStartMs(b) < eventEndMs(a);
}

// Starred = attending: the row gets a filled star; in parallel rooms, a session
// that overlaps a starred one in another room is dimmed as "not attending".
function paintRailStars() {
  const entries = railRowEvents().filter((item) => item.ev);
  const starred = entries.filter((item) => isStarred(item.ev));
  for (const { row, ev } of entries) {
    const on = isStarred(ev);
    row.classList.toggle("starred", on);
    const star = row.querySelector(".rl-star");
    if (star) star.textContent = on ? "★" : "☆";
    const lanes = row.closest(".rl-lanes");
    const lane = row.closest(".rl-lane");
    const skipped =
      !on &&
      !!lanes &&
      starred.some(
        (other) =>
          other.row.closest(".rl-lanes") === lanes &&
          other.row.closest(".rl-lane") !== lane &&
          eventsOverlap(other.ev, ev),
      );
    row.classList.toggle("skipped", skipped);
  }
}

function toggleStar(ev) {
  setStarred(ev, !isStarred(ev));
  paintRailStars();
  const attend = document.querySelector(".ehead .attend-star");
  if (attend && S.note && ev.note === S.file) paintAttendButton(attend, ev);
}

// The one plan: drawer modules (the Planner) read and set the same stars and
// hear every change, so a pick made in either place shows in both.
function repaintStars(slug) {
  if (slug !== S.slug) return;
  paintRailStars();
  const attend = document.querySelector(".ehead .attend-star");
  const open = S.file && S.conf?.events.find((item) => item.note === S.file);
  if (attend && open) paintAttendButton(attend, open);
  if (!S.file && document.getElementById("confView")) renderConferenceDashboard(slug);
}
window.confnote = window.confnote || {};
window.confnote.stars = {
  list: (slug) => [...starredNotes(slug)],
  set(slug, note, on) {
    savePicks(slug, { [note]: on }).then(() => repaintStars(slug));
    repaintStars(slug);
  },
};

function wireRailStars() {
  const track = document.getElementById("railTrack");
  if (!track || track.dataset.starsWired) return;
  track.dataset.starsWired = "1";
  track.addEventListener("click", (event) => {
    const star = event.target.closest(".rl-star");
    if (!star) return;
    event.preventDefault();
    event.stopPropagation();
    const match = railRowEvents().find((item) => item.row === star.closest(".rl-row"));
    if (match?.ev) toggleStar(match.ev);
  });
}

function paintAttendButton(btn, ev) {
  const on = isStarred(ev);
  btn.textContent = on ? "★ Attending" : "☆ Attend";
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

function eventMatches(ev, query, filter) {
  if (filter && filter !== "all") {
    const value = filter === "starred" ? (isStarred(ev) ? "starred" : "") : ev.type || "";
    if (value !== filter) return false;
  }
  const q = (query || "").trim().toLowerCase();
  if (!q) return true;
  return [
    ev.title,
    ev.description,
    ev.type,
    roomLabel(ev),
    trackLabel(ev),
    ...(ev.speakers || []),
    ...(ev.tags || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(q);
}

function sortedEvents(events = S.conf?.events || []) {
  return [...events].sort(
    (a, b) =>
      String(a.start || "").localeCompare(String(b.start || "")) ||
      String(roomLabel(a)).localeCompare(String(roomLabel(b))) ||
      String(a.title || "").localeCompare(String(b.title || "")),
  );
}

function currentAndNext(events = S.conf?.events || [], now = Date.now()) {
  const timed = sortedEvents(events).filter((ev) => ev.note && eventIsTimed(ev));
  const live = timed.filter((ev) => eventIsNow(ev, now));
  const upcoming = timed.filter((ev) => eventIsFuture(ev, now));
  const nextStart = upcoming[0]?.start || "";
  return {
    live,
    next: nextStart ? upcoming.filter((ev) => ev.start === nextStart) : [],
    upcoming,
  };
}

function conflictGroups(events) {
  return [
    ...groupBy(
      events.filter((ev) => ev.note),
      (ev) => ev.start,
    ).values(),
  ]
    .map((rows) => rows.filter((ev) => !isRest(ev)))
    .filter((rows) => rows.length > 1)
    .sort((a, b) => String(a[0].start).localeCompare(String(b[0].start)));
}

// The time-grid card: time, title, speakers and a star; the whole card opens
// the note. Breaks are a thin one-line row.
function compactSessionCard(ev) {
  if (isRest(ev))
    return `<button class="tg-rest" data-note="${esc(ev.note || "")}" type="button"><span>${esc(timeRange(ev))}</span><strong>${esc(ev.title)}</strong></button>`;
  const starred = isStarred(ev);
  const live = eventIsNow(ev);
  const speakers = (ev.speakers || []).join(", ");
  return `<div class="tg-card${live ? " live" : ""}" data-note="${esc(ev.note || "")}">
    <div class="tg-card-top">
      <span class="sc-time">${esc(timeRange(ev))}${live ? " · live" : ""}</span>
      <button class="tg-star${starred ? " on" : ""}" data-star="${esc(ev.note || "")}" type="button" title="Save to My Agenda" aria-label="Save to My Agenda" aria-pressed="${starred ? "true" : "false"}">${starred ? "★" : "☆"}</button>
    </div>
    <h3>${esc(ev.title || "Untitled session")}</h3>
    ${speakers ? `<p class="sc-speakers">${esc(speakers)}</p>` : ""}
  </div>`;
}

function sessionCard(ev, opts = {}) {
  if (opts.compact) return compactSessionCard(ev);
  // Breaks, lunch and logistics are plain rows: no star, no button; the row
  // itself still opens their notes (people met, links).
  if (isRest(ev))
    return `<button class="mini-event rest" data-note="${esc(ev.note || "")}" type="button"><span>${esc(timeRange(ev))}</span><strong>${esc(ev.title)}</strong><em>${esc(roomLabel(ev) || trackLabel(ev) || "")}</em></button>`;
  // Compact card: time, title, speakers and a small star; the whole card
  // opens the note. Room columns pass `hideRoom` since their header names it.
  const starred = isStarred(ev);
  const live = eventIsNow(ev);
  const speakers = (ev.speakers || []).slice(0, 3).join(", ");
  const extra = (ev.speakers || []).length > 3 ? ` +${ev.speakers.length - 3}` : "";
  const room = opts.hideRoom ? "" : roomLabel(ev) || trackLabel(ev);
  return `<div class="session-card${live ? " live" : ""}" data-note="${esc(ev.note || "")}">
    <div class="sc-top">
      <span class="sc-time">${esc(timeRange(ev))}${live ? " · live" : ""}</span>
      ${room ? `<span class="sc-room">${esc(room)}</span>` : ""}
      <button class="icon-star${starred ? " on" : ""}" data-star="${esc(ev.note || "")}" type="button" title="Save to My Agenda" aria-label="Save to My Agenda" aria-pressed="${starred ? "true" : "false"}">${starred ? "★" : "☆"}</button>
    </div>
    <h3>${esc(ev.title || "Untitled session")}</h3>
    ${speakers ? `<p class="sc-speakers">${esc(speakers + extra)}</p>` : ""}
    ${opts.detail && ev.description ? `<p class="sc-desc">${esc(ev.description)}</p>` : ""}
  </div>`;
}

const sidebar = document.getElementById("sidebar");

// Sidebar width is user-controlled (drag the right edge). Stored as a CSS
// custom property on the root + persisted in localStorage so it survives
// reloads. wireSidebarGrip() owns the drag pointer handlers.
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 520;
function applySidebarWidth(px) {
  const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(px)));
  document.documentElement.style.setProperty("--sidebar-w", w + "px");
  localStorage.setItem("confnote-sidebar-w", String(w));
}
(function initSidebarWidth() {
  const saved = parseInt(localStorage.getItem("confnote-sidebar-w") || "", 10);
  if (Number.isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) {
    document.documentElement.style.setProperty("--sidebar-w", saved + "px");
  }
})();

// ⌘+ / ⌘- / ⌘0 zoom. Uses the CSS `zoom` property on the root so the layout
// reflows cleanly (works in the WKWebView .app and the browser); the WKWebView
// doesn't honour native pinch-zoom shortcuts, so we handle them ourselves.
// Persisted to localStorage.
(function initZoom() {
  const KEY = "confnote-zoom";
  const MIN = 0.6;
  const MAX = 2.0;
  const STEP = 0.1;
  const clamp = (z) => Math.max(MIN, Math.min(MAX, Math.round(z * 100) / 100));
  let zoom = clamp(Number.parseFloat(localStorage.getItem(KEY) || "1") || 1);
  const apply = () => {
    document.documentElement.style.zoom = zoom === 1 ? "" : String(zoom);
    try {
      localStorage.setItem(KEY, String(zoom));
    } catch (e) {}
  };
  apply();
  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (e.key === "=" || e.key === "+") zoom = clamp(zoom + STEP);
    else if (e.key === "-" || e.key === "_") zoom = clamp(zoom - STEP);
    else if (e.key === "0") zoom = 1;
    else return;
    e.preventDefault();
    apply();
  });
})();

// ---------- keyboard shortcuts ----------
// Single source of truth for the Settings → Shortcuts help page (rendered from
// window.confnote.shortcuts) AND documentation of what the dispatcher below
// handles. Keep the two in sync — the dispatcher is the code, this is the doc.
const SHORTCUTS = [
  {
    group: "Concierge & drawer",
    items: [
      { keys: "⌘K", desc: "Open / focus the Concierge" },
      { keys: "⌘⇧K", desc: "Open the Sketch drawer" },
      { keys: "⌃N", desc: "New chat — when the Concierge is open" },
    ],
  },
  {
    group: "General",
    items: [
      { keys: "⌘,", desc: "Open Settings" },
      { keys: "⌘\\", desc: "Toggle the agenda sidebar" },
      { keys: "⌘= / ⌘− / ⌘0", desc: "Zoom in / out / reset" },
      { keys: "Esc", desc: "Close the open drawer, modal, or dialog" },
      { keys: "?", desc: "Show this shortcuts list" },
    ],
  },
  {
    group: "Conferences & notes",
    items: [
      { keys: "C", desc: "New conference (opens the Concierge)" },
      { keys: "/", desc: "Focus the Concierge input" },
      { keys: "1 – 8", desc: "Jump to a note section (Human notes → Private)" },
      { keys: "[ / ]", desc: "Previous / next note section" },
    ],
  },
];
window.confnote = window.confnote || {};
window.confnote.shortcuts = SHORTCUTS;

// Resolve the *effective* focused element, piercing open shadow roots (so a
// focused deep-chat input reports as the inner field, not the host).
function deepActiveElement() {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  return el;
}
function isTypingTarget() {
  const el = deepActiveElement();
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!(el.closest && el.closest(".CodeMirror"));
}
// True when the markdown editor (EasyMDE/CodeMirror) has focus — there ⌘K is
// the editor's "insert link", so the global Concierge shortcut yields to it.
function inMarkdownEditor() {
  const el = deepActiveElement();
  return !!(el && el.closest && el.closest(".CodeMirror"));
}

function focusConciergeInput() {
  const dc = document.querySelector(".chat-inner deep-chat");
  if (!dc) return;
  const input = findDeepInput(dc.shadowRoot) || findDeepInput(dc);
  input?.focus();
}
// Open a drawer slot by its position on the right-edge strip (0-based), reading
// the slot id from the rendered tab. Core stays module-name-agnostic — it never
// hardcodes a module id (boundary rule). Slot 3 (index 2) is the Sketch slot by
// the modules.config.json convention.
function openDrawerSlot(i) {
  const d = window.confnote && window.confnote.drawer;
  const open = () => {
    const id = document.querySelectorAll(".drawer-tab")[i]?.dataset.id;
    if (id && d && typeof d.toggle === "function" && !d.isOpen(id)) d.toggle(id, true);
  };
  if (d && d.ready && typeof d.ready.then === "function") d.ready.then(open);
  else open();
}
function newConciergeChat() {
  // The chat module's "+ new" head button archives the current thread + starts
  // fresh. Only meaningful while the Concierge is open (where the button lives).
  document.querySelector(".chat-head-btn[title^='Archive current']")?.click();
}
function toggleAgendaSidebar() {
  document.body.classList.toggle("sidebar-hidden");
}
function openShortcutsHelp() {
  window.confnote.openSettings?.({ focus: "shortcuts" });
}
function jumpToNoteSection(i) {
  if (S.file && TABS[i]) selectTab(TABS[i], 1);
}
function cycleNoteSection(dir) {
  if (!S.file) return;
  const i = Math.max(0, TABS.indexOf(S.tab1));
  selectTab(TABS[(i + dir + TABS.length) % TABS.length], 1);
}
// Esc closes the top-most transient surface. Modals own their own Esc handlers,
// so here we only collapse an open drawer (when no modal is up and the user
// isn't mid-type, to avoid nuking a chat draft).
function escCloseDrawer() {
  if (document.querySelector(".modal-ov")) return false;
  if (isTypingTarget()) return false;
  const d = window.confnote && window.confnote.drawer;
  if (d && d.openIds && d.openIds().length) {
    d.openIds().forEach((id) => d.close(id));
    return true;
  }
  return false;
}

window.addEventListener("keydown", (e) => {
  const cmd = e.metaKey && !e.ctrlKey && !e.altKey; // ⌘ only (macOS app target)
  const k = (e.key || "").toLowerCase();

  // ⌘-combos — active even while typing, except ⌘K which defers to the editor.
  if (cmd && !e.shiftKey && k === "k") {
    if (inMarkdownEditor()) return; // EasyMDE: insert link
    e.preventDefault();
    openConcierge(true);
    return;
  }
  if (cmd && e.shiftKey && k === "k") {
    e.preventDefault();
    openDrawerSlot(2); // Sketch slot (3rd on the strip)
    return;
  }
  if (cmd && k === ",") {
    e.preventDefault();
    window.confnote.openSettings?.();
    return;
  }
  if (cmd && k === "\\") {
    e.preventDefault();
    toggleAgendaSidebar();
    return;
  }
  // Ctrl+N → new chat, only while the Concierge drawer is open.
  if (e.ctrlKey && !e.metaKey && !e.altKey && k === "n") {
    const d = window.confnote && window.confnote.drawer;
    if (d && d.isOpen && d.isOpen("chat")) {
      e.preventDefault();
      newConciergeChat();
    }
    return;
  }
  if (e.key === "Escape") {
    if (escCloseDrawer()) e.preventDefault();
    return;
  }

  // Single-key shortcuts — only with no modifier and not while typing.
  if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget()) return;
  if (e.key === "?") {
    e.preventDefault();
    openShortcutsHelp();
  } else if (k === "c") {
    e.preventDefault();
    openConcierge(true);
  } else if (e.key === "/") {
    e.preventDefault();
    openConcierge(true);
  } else if (e.key >= "1" && e.key <= "8") {
    e.preventDefault();
    jumpToNoteSection(Number(e.key) - 1);
  } else if (e.key === "[") {
    e.preventDefault();
    cycleNoteSection(-1);
  } else if (e.key === "]") {
    e.preventDefault();
    cycleNoteSection(1);
  }
});

// pointer-events grip (works for mouse, trackpad, touch) — no library needed.
function wireSidebarGrip() {
  if (sidebar.querySelector(".sb-grip")) return; // already wired
  const grip = document.createElement("div");
  grip.className = "sb-grip";
  grip.setAttribute("aria-label", "Resize sidebar");
  grip.title = "Drag to resize";
  sidebar.appendChild(grip);
  let pid = null;
  grip.addEventListener("pointerdown", (e) => {
    pid = e.pointerId;
    grip.setPointerCapture(pid);
    grip.classList.add("dragging");
    document.body.classList.add("sb-resizing");
    e.preventDefault();
  });
  grip.addEventListener("pointermove", (e) => {
    if (pid === null) return;
    // sidebar sits flush to viewport left edge → clientX is the new width
    applySidebarWidth(e.clientX);
  });
  const end = () => {
    if (pid === null) return;
    try {
      grip.releasePointerCapture(pid);
    } catch (err) {}
    pid = null;
    grip.classList.remove("dragging");
    document.body.classList.remove("sb-resizing");
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
}

// Signed out, the sidebar's empty state is a way in, the same sign-in as the header's.
const SIDEBAR_SIGNED_OUT = `<div class="empty sb-signed-out">Sign in to see your events.
  <a class="primary sb-signin" href="/api/auth/signin?returnTo=%2F">Sign in</a>
  <button class="sb-demo try-demo" type="button" hidden>Try a demo event</button></div>`;

// The signed-out demo event looks unlike a real event: a dashed, faded card with this chip (product-shell.js
// sets demoEvent).
function demoChip() {
  if (!window.confnote.demoEvent) return "";
  const label = window.confnote.demoEvent === "starter" ? "Starter event" : "Demo event";
  return `<span class="starter-chip">${label}</span>`;
}

// Signed in on the hosted site, the sidebar also lists Beyond The Prompt as a starter event: a link into the
// browser-only demo (product-shell.js), never a conference in the workspace. Hide keeps it out of the list
// (this browser); "Show the starter event" under the list brings it back.
const STARTER_HIDDEN_KEY = "confnote-starter-hidden";
function starterEntry() {
  if (typeof window.confnote.startDemoEvent !== "function" || window.confnote.demoEvent) return "";
  if (localStorage.getItem(STARTER_HIDDEN_KEY) === "1")
    return '<button class="sb-starter-show" type="button">Show the starter event</button>';
  return `<div class="sb-conf starter sb-starter" role="link" tabindex="0">
    <span class="starter-chip">Starter event</span>
    <span class="sb-d">2026-05-19</span>
    <span class="sb-n">Beyond The Prompt</span>
    <span class="sb-v">IET London · a sample notebook in this browser</span>
    <button class="sb-starter-hide" type="button" title="Hide the starter event">Hide</button>
  </div>`;
}
// With the starter card in the list, "No events yet." would only push it down.
function emptyUnlessStarter(starter) {
  return starter.includes("sb-starter-hide") ? "" : '<div class="empty">No events yet.</div>';
}
function wireStarterEntry(root) {
  const card = root.querySelector(".sb-starter");
  if (card) {
    const open = () => window.confnote.startDemoEvent("starter");
    card.onclick = (event) => {
      if (!event.target.closest(".sb-starter-hide")) open();
    };
    card.onkeydown = (event) => {
      if (event.key === "Enter") open();
    };
    card.querySelector(".sb-starter-hide").onclick = () => {
      localStorage.setItem(STARTER_HIDDEN_KEY, "1");
      renderSidebarHome();
    };
  }
  const show = root.querySelector(".sb-starter-show");
  if (show)
    show.onclick = () => {
      localStorage.removeItem(STARTER_HIDDEN_KEY);
      renderSidebarHome();
    };
}
function demoClass() {
  return window.confnote.demoEvent ? " starter" : "";
}

// "Try a demo event" opens Beyond The Prompt in the browser-only demo (product-shell.js); only the hosted
// site offers it, so the button stays hidden elsewhere.
function wireDemoButtons(root) {
  const start = window.confnote.startDemoEvent;
  root.querySelectorAll(".try-demo").forEach((button) => {
    button.hidden = typeof start !== "function";
    button.onclick = () => start();
  });
}

// Persistent sidebar across both home + conference views — no layout jolt.
// Home renders a compact conferences list into the sidebar; the conference
// view replaces it with the agenda rail. Width is the same in both states.
async function renderSidebarHome() {
  const { list, signedOut } = await loadMyEvents();
  const starter = signedOut ? "" : starterEntry();
  const today = todayISO();
  const items = list
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((c) => {
      const when = c.date === today ? "today" : c.date < today ? "past" : "upcoming";
      return `<a class="sb-conf${demoClass()}" data-when="${when}" href="#/${esc(c.slug)}">${demoChip()}
        <span class="sb-d">${esc(c.date)}</span>
        <span class="sb-n">${esc(c.name)}</span>
        ${c.venue ? `<span class="sb-v">${esc(c.venue)}</span>` : ""}
      </a>`;
    })
    .join("");
  mount(
    sidebar,
    `<div class="sb-head">My events ${PUBLIC_DEMO || signedOut ? "" : '<button class="mini-add" type="button" title="New conference">+</button>'}</div>
     <div class="sb-confs">${items || (signedOut ? SIDEBAR_SIGNED_OUT : emptyUnlessStarter(starter))}${starter}</div>`,
  );
  const newBtn = sidebar.querySelector(".mini-add");
  if (newBtn) newBtn.onclick = openNewConferenceModal;
  wireDemoButtons(sidebar);
  wireStarterEntry(sidebar);
  wireSidebarGrip();
}

async function renderHome(routeSeq = S.routeSeq) {
  S.file = null;
  S.slug = null;
  S.conf = null;
  S.findView = null;
  refreshBrowserNotesBanner();
  await renderSidebarHome();
  if (routeSeq !== S.routeSeq) return;
  refreshConcierge();
  mount(crumbs, "");
  const which = parseHash()[0] === FIND_ROUTE ? "find" : "mine";
  mount(
    app,
    `<div class="hometabs">
    <a class="htab${which === "mine" ? " on" : ""}" href="#/">My events</a>
    <a class="htab${which === "find" ? " on" : ""}" href="#/${FIND_ROUTE}">Find events</a>
    ${PUBLIC_DEMO ? "" : '<button class="new-conf-btn" type="button">New conference</button>'}
    ${PUBLIC_DEMO || window.confnote.webMode ? "" : '<button class="import-conf-btn" type="button" title="Import a .confnote file, e.g. notes downloaded from the confnote website">Import notes</button>'}
  </div><div id="homeBody"></div>${PUBLIC_DEMO ? '<div id="publicDemoIntro"></div>' : ""}`,
  );
  const newConfBtn = app.querySelector(".new-conf-btn");
  if (newConfBtn) newConfBtn.onclick = openConcierge;
  const importBtn = app.querySelector(".import-conf-btn");
  if (importBtn) importBtn.onclick = pickConfnoteFile;
  if (which === "find") {
    await renderFindEvents(document.getElementById("homeBody"));
    return;
  }
  await renderMyEvents(document.getElementById("homeBody"));
  if (PUBLIC_DEMO && !window.confnote.demoEvent)
    renderPublicDemoIntro(document.getElementById("publicDemoIntro"));
}

function createWaitlistForm() {
  const form = document.createElement("form");
  form.className = "waitlist-form";
  form.noValidate = true;
  const email = document.createElement("input");
  email.type = "email";
  email.name = "email";
  email.placeholder = "Email";
  email.required = true;
  const name = document.createElement("input");
  name.type = "text";
  name.name = "name";
  name.placeholder = "Name (optional)";
  const note = document.createElement("input");
  note.type = "text";
  note.name = "note";
  note.placeholder = "What would you use it for? (optional)";
  const consentLabel = document.createElement("label");
  consentLabel.className = "waitlist-consent";
  const consent = document.createElement("input");
  consent.type = "checkbox";
  consent.name = "consent";
  consent.required = true;
  const consentText = document.createElement("span");
  consentText.textContent = "Email me confnote updates. I can unsubscribe any time.";
  consentLabel.append(consent, consentText);
  const btn = document.createElement("button");
  btn.type = "submit";
  btn.textContent = "Join waitlist";
  const msg = document.createElement("div");
  msg.className = "waitlist-msg";
  form.append(email, name, note, consentLabel, btn, msg);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    msg.textContent = "";
    if (!consent.checked) {
      msg.className = "waitlist-msg bad";
      msg.textContent = "Confirm email consent to join.";
      return;
    }
    btn.disabled = true;
    btn.textContent = "Joining…";
    try {
      const r = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.value,
          name: name.value,
          note: note.value,
          source: "public-demo-home",
          consent: consentText.textContent,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || "Could not join.");
      msg.className = "waitlist-msg ok";
      msg.textContent = "You're on the list. Check your email for the unsubscribe link.";
      form.reset();
    } catch (err) {
      msg.className = "waitlist-msg bad";
      msg.textContent = err && err.message ? err.message : "Could not join.";
    } finally {
      btn.disabled = false;
      btn.textContent = "Join waitlist";
    }
  });
  return form;
}

function mountWaitlistSignup(host) {
  if (!host) return;
  host.replaceChildren(createWaitlistForm());
}

window.confnote.mountWaitlistSignup = mountWaitlistSignup;

// ---------- import a .confnote file (local app; server.py /api/import) ----------
function pickConfnoteFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".confnote,application/json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (file) await importConfnoteText(await file.text());
  };
  input.click();
}

async function postImport(bundle, mode) {
  const r = await fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Confnote-Request": "1" },
    body: JSON.stringify({ bundle, mode }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// Never overwrites: an existing conference is offered as a copy (<slug>-2).
async function importConfnoteText(text) {
  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch (_e) {
    alert("This is not a confnote notes file.");
    return;
  }
  let { status, body } = await postImport(bundle, "new");
  if (status === 409) {
    const conf = (body.conferences || []).find((c) => c.exists) || {};
    const ok = confirm(
      `"${conf.name || conf.slug}" is already in your notes folder. ` +
        `Import these notes as a separate copy (${conf.copy_slug})? Your existing notes stay untouched.`,
    );
    if (!ok) return;
    ({ status, body } = await postImport(bundle, "copy"));
  }
  if (status !== 200) {
    alert(`Import failed: ${body.error || status}`);
    return;
  }
  const slug = body.conferences?.[0]?.slug;
  setStatus(`imported ${slug} ✓`, "saved");
  if (slug) location.hash = `#/${slug}`;
}
window.confnote.importConfnoteText = importConfnoteText;

function renderPublicDemoIntro(host) {
  if (!host) return;
  host.replaceChildren();
  const wrap = document.createElement("section");
  wrap.className = "demo-intro";
  const copy = document.createElement("div");
  copy.className = "demo-copy";
  const h = document.createElement("h1");
  h.textContent = "confnote";
  const p = document.createElement("p");
  p.textContent =
    "A public read-only view of a real conference notebook: agenda, session notes, links, actions, debrief, and a sketch surface. The local-first app remains available for private markdown-owned notes.";
  copy.append(h, p);
  const form = createWaitlistForm();
  wrap.append(copy, form);
  host.append(wrap);
}

function templateState(t) {
  const now = Date.now();
  const start = +new Date(t.starts || "");
  const end = +new Date(t.ends || "");
  if (Number.isFinite(start) && Number.isFinite(end) && now >= start && now <= end)
    return "Happening now";
  if (Number.isFinite(start) && now < start) return "Upcoming";
  if (Number.isFinite(end) && now > end) return "Ended";
  return "Template";
}

// Find events: curated templates as a Featured strip over the open catalogue (find-events.js).
async function renderFindEvents(host) {
  // Featured loads first, so the catalogue below never moves down when the strip arrives.
  const featured = await api("/discover/index.json").catch(() => null);
  if (!app.contains(host)) return; // the route moved on while it loaded
  mount(
    host,
    `<section class="find-events">
      <div class="featured">
        <h2 class="find-h">Featured</h2>
        <div class="featured-strip"></div>
      </div>
      <div id="findEventsView"></div>
      <p class="find-credit">Open catalogue from public sources · CC-BY-4.0 · check the organizer before making plans</p>
    </section>`,
  );
  const view = window.confnoteFindEvents.mount(host.querySelector("#findEventsView"), {
    // The Cat also sets webMode (its UI is the web build's), but it has no hosted catalogue routes.
    hosted: Boolean(window.confnote.webMode && !window.confnote.catMode),
    detailHref: (id) => `#/${FIND_ROUTE}/${encodeURIComponent(id)}`,
    detailId: () => {
      const [first, id] = parseHash();
      return first === FIND_ROUTE && id ? decodeURIComponent(id) : "";
    },
    back: () => {
      location.hash = `#/${FIND_ROUTE}`;
    },
  });
  S.findView = { host, view };
  renderFeatured(host.querySelector(".featured"), featured);
  syncFindDetail();
  resumePendingAdd(host.querySelector(".featured"));
}

// The Featured strip steps aside while one catalogue event is open.
function syncFindDetail() {
  const featured = S.findView && S.findView.host.querySelector(".featured");
  if (!featured) return;
  featured.hidden = !featured.dataset.ready || Boolean(parseHash()[1]);
}

function renderFeatured(box, data) {
  const cards = ((data && data.templates) || [])
    .map((t) => {
      const state = templateState(t);
      const stats = [
        [t.sessions, "sessions"],
        [t.speakers, "speakers"],
        [t.tracks, "tracks"],
      ]
        .filter(([n]) => n)
        .map(([n, label]) => `${esc(String(n))} ${label}`)
        .join(" · ");
      return `<article class="featured-card${state === "Happening now" ? " live" : ""}">
        <div class="fc-head"><span class="fc-status">${esc(state)}</span><span>${esc(t.location || "")}</span></div>
        <h3>${esc(t.title || "Conference template")}</h3>
        <p>${esc(t.subtitle || "")}</p>
        <div class="fc-stats">${stats}</div>
        <div class="fc-actions">
          <button class="primary fork-template" data-template="${esc(t.id || "")}" data-manifest="${esc(t.manifest || "")}" type="button">Add to My events</button>
          ${/^https?:\/\//i.test(t.source || "") ? `<a href="${esc(t.source)}" target="_blank" rel="noopener">Official schedule ↗</a>` : ""}
        </div>
      </article>`;
    })
    .join("");
  if (!cards) return;
  box.querySelector(".featured-strip").innerHTML = cards;
  box.dataset.ready = "1";
  box.querySelectorAll(".fork-template").forEach((btn) => {
    btn.onclick = () => forkTemplate(btn);
  });
}

// Signed out on the hosted site, adding an event asks the visitor to sign in instead of failing. The event
// waits in localStorage and is added when they come back to Find events signed in.
const PENDING_ADD_KEY = "confnote-pending-add";
const PENDING_ADD_TTL_MS = 30 * 60 * 1000;

function closeSignInPrompt() {
  document.getElementById("signInPrompt")?.remove();
  document.removeEventListener("keydown", signInPromptKeys);
}

function signInPromptKeys(event) {
  if (event.key === "Escape") closeSignInPrompt();
}

function openSignInPrompt(manifestUrl) {
  closeSignInPrompt();
  const returnTo = `/#/${FIND_ROUTE}`;
  const overlay = document.createElement("div");
  overlay.className = "modal-ov";
  overlay.id = "signInPrompt";
  overlay.innerHTML = `<div class="modal-box sign-in-prompt" role="dialog" aria-modal="true" aria-labelledby="signInPromptTitle">
    <div class="modal-head"><span class="modal-title" id="signInPromptTitle">Sign in to save events to My events</span>
      <button class="modal-x" type="button" aria-label="Close">✕</button></div>
    <div class="modal-body"><p>Your events, notes and plans live in your notebook. Sign in and this event is added for you.</p>
      <div class="sign-in-prompt-actions">
        <a class="primary sign-in-go" href="/api/auth/signin?returnTo=${encodeURIComponent(returnTo)}">Sign in</a>
        <button class="try-demo" type="button" hidden>Try a demo event</button>
        <button class="sign-in-cancel" type="button">Cancel</button>
      </div></div></div>`;
  document.body.appendChild(overlay);
  wireDemoButtons(overlay);
  overlay.querySelector(".modal-x").onclick = closeSignInPrompt;
  overlay.querySelector(".sign-in-cancel").onclick = closeSignInPrompt;
  overlay.onclick = (event) => {
    if (event.target === overlay) closeSignInPrompt();
  };
  overlay.querySelector(".sign-in-go").onclick = () => {
    localStorage.setItem(
      PENDING_ADD_KEY,
      JSON.stringify({ manifest: manifestUrl, at: Date.now() }),
    );
  };
  document.addEventListener("keydown", signInPromptKeys);
  overlay.querySelector(".sign-in-go").focus();
}

// The event a visitor chose before signing in, once, if it is recent.
function takePendingAdd() {
  let pending = null;
  try {
    pending = JSON.parse(localStorage.getItem(PENDING_ADD_KEY));
  } catch {
    pending = null;
  }
  localStorage.removeItem(PENDING_ADD_KEY);
  if (!pending || typeof pending.manifest !== "string") return null;
  if (!(Date.now() - pending.at < PENDING_ADD_TTL_MS)) return null;
  return pending;
}

async function resumePendingAdd(box) {
  if (!box || !localStorage.getItem(PENDING_ADD_KEY) || (await knownSignedOut())) return;
  const pending = takePendingAdd();
  if (!pending) return;
  const btn = [...box.querySelectorAll(".fork-template")].find(
    (b) => b.dataset.manifest === pending.manifest,
  );
  if (btn) forkTemplate(btn);
}

async function forkTemplate(btn) {
  const manifestUrl = btn.dataset.manifest;
  if (!manifestUrl) return;
  if (await knownSignedOut()) {
    openSignInPrompt(manifestUrl);
    return;
  }
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Adding…";
  try {
    const agenda = await api(manifestUrl);
    const r = await fetch("/api/conferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agenda }),
    });
    // A session that ran out since the page loaded: the same sign-in prompt, never "Try again".
    if (r.status === 401) {
      btn.disabled = false;
      btn.textContent = old;
      openSignInPrompt(manifestUrl);
      return;
    }
    const data = await r.json();
    if (!r.ok || !data.ok)
      throw new Error(data.error || (data.errors || []).join(", ") || r.status);
    btn.textContent = "Added";
    location.hash = "#/" + data.slug;
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Try again";
    setStatus(`Could not add this event: ${e.message || e}`, "err");
    setTimeout(() => {
      btn.textContent = old;
    }, 1800);
  }
}

// A session's time · room · speakers line, leaving out the parts it doesn't have.
function sessionMeta(fm, event) {
  const speakers = event.speakers ? event.speakers.join(", ") : fm.speakers || "";
  return [fm.time, fm.room, speakers].filter(Boolean).join(" · ");
}

// A shell that already knows nobody is signed in (the web's `signedIn` probe) spares the notebook routes
// a request that can only answer 401.
async function knownSignedOut() {
  return Boolean(window.confnote.signedIn) && !(await window.confnote.signedIn);
}

// The conference list, or why there is none: the web answers 401 when nobody is signed in.
async function loadMyEvents() {
  if (await knownSignedOut()) return { list: [], signedOut: true };
  try {
    return { list: await api("/api/conferences") };
  } catch (e) {
    const signedOut = String(e && e.message) === "401";
    return { list: [], signedOut, failed: !signedOut };
  }
}

const MINE_EMPTY = {
  signedOut: {
    title: "Sign in to see your events",
    text: "Your conferences, notes and plans live in your notebook.",
    action: '<a class="primary" href="/api/auth/signin">Sign in</a>',
  },
  none: {
    title: "No events yet",
    text: "Paste a conference website or agenda link into the Concierge and it sets everything up, or pick one from Find events.",
    action: '<button class="primary mine-import" type="button">Import a conference</button>',
  },
  failed: {
    title: "Your events could not load",
    text: "Check your connection, then reload the page.",
    action: "",
  },
};

// No events at all: one calm block with the next step, instead of an empty timeline.
function renderMyEventsEmpty(host, state) {
  const copy = MINE_EMPTY[state];
  const action = state === "none" && PUBLIC_DEMO ? "" : copy.action;
  mount(
    host,
    `<div class="mine-start">
      <h2>${esc(copy.title)}</h2>
      <p>${esc(copy.text)}</p>
      <div class="mine-start-actions">${action}<a class="mine-find" href="#/${FIND_ROUTE}">Find events</a></div>
    </div>`,
  );
  const importButton = host.querySelector(".mine-import");
  if (importButton) importButton.onclick = () => openConcierge(true);
  // Nothing to add to while signed out.
  if (state === "signedOut") app.querySelector(".new-conf-btn")?.remove();
}

// My events: a timeline anchored at today. Upcoming runs soonest first, Past most recent first,
// so in both the distance from today grows down the page.
async function renderMyEvents(host) {
  const { list, signedOut, failed } = await loadMyEvents();
  if (!list.length) {
    renderMyEventsEmpty(host, signedOut ? "signedOut" : failed ? "failed" : "none");
    return;
  }
  const today = todayISO();
  const byDate = (a, b) => (a.date || "").localeCompare(b.date || "");
  const upcoming = list.filter((c) => (c.date || "") >= today).sort(byDate);
  const past = list
    .filter((c) => (c.date || "") < today)
    .sort(byDate)
    .reverse();
  const when = localStorage.getItem(MINE_WHEN_KEY) === "past" ? "past" : "upcoming";
  const shown = when === "past" ? past : upcoming;

  const node = (c) => {
    const pct = c.sessions ? Math.round((c.with_notes / c.sessions) * 100) : 0;
    return `<a class="trow" href="#/${esc(c.slug)}">
      <div class="tr-date">${esc(prettyDate(c.date))}</div>
      <div class="tr-card">
        <h2>${esc(c.name)}</h2>
        <div class="tr-meta">${esc(c.venue || c.tagline || "")}</div>
        <div class="tr-prog">${c.with_notes}/${c.sessions} sessions noted</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
        <span class="tr-debrief" data-debrief="${esc(c.slug)}" title="Open actions across this conference">
          <span class="td-ic">✔</span> Actions <span class="td-n" data-count="${esc(c.slug)}">…</span>
        </span>
      </div></a>`;
  };
  const marker = `<div class="trow tnow">
    <div class="tr-date"></div>
    <div class="tr-card tnow-card"><span class="tnow-dot">●</span> Today — ${esc(prettyDate(today))}</div></div>`;
  const empty =
    when === "past"
      ? '<p class="mine-empty">No past events yet.</p>'
      : `<div class="mine-empty"><p>No upcoming events.</p><a class="primary" href="#/${FIND_ROUTE}">Find events</a>${PUBLIC_DEMO ? "" : '<button class="new-empty-conf" type="button">New conference</button>'}</div>`;
  const pill = (key, label, count) =>
    `<button class="pill${when === key ? " on" : ""}" data-t="${key}" type="button" aria-pressed="${when === key}">${label} <span class="pill-n">${count}</span></button>`;

  mount(
    host,
    `<div class="pill-row mine-when">
      ${pill("upcoming", "Upcoming", upcoming.length)}${pill("past", "Past", past.length)}
    </div>
    <div class="timeline">
    ${marker}
    ${shown.map(node).join("")}
    ${shown.length ? "" : empty}
  </div>`,
  );
  host.querySelectorAll(".mine-when .pill").forEach((b) => {
    b.onclick = () => {
      localStorage.setItem(MINE_WHEN_KEY, b.dataset.t);
      renderMyEvents(host);
    };
  });
  const create = host.querySelector(".new-empty-conf");
  if (create) create.onclick = openConcierge;
  wireDebriefBadges(host, list);
}

function localIso(date, time) {
  if (!date || !time) return "";
  return `${date}T${time.length === 5 ? time + ":00" : time}`;
}

function draftFromManual(box) {
  const name = box.querySelector("#ncName").value.trim();
  const date = box.querySelector("#ncDate").value.trim();
  const tz = box.querySelector("#ncTimezone").value.trim();
  const venue = box.querySelector("#ncVenue").value.trim();
  const url = box.querySelector("#ncUrl").value.trim();
  const sessionTitle = box.querySelector("#ncSessionTitle").value.trim() || "Opening session";
  const startTime = box.querySelector("#ncStart").value.trim() || "09:00";
  const endTime = box.querySelector("#ncEnd").value.trim() || "10:00";
  return {
    schema_version: "confnote.agenda.v1",
    conference: {
      name,
      date,
      timezone: tz,
      url,
      venue: { name: venue },
    },
    rooms: venue ? [{ id: "main-room", name: venue }] : [],
    tracks: [],
    speakers: {},
    events: [
      {
        id: slugish(sessionTitle) || "opening-session",
        type: "talk",
        title: sessionTitle,
        start: localIso(date, startTime),
        end: localIso(date, endTime),
        room: venue ? "main-room" : "",
        speakers: [],
        tags: [],
        links: url ? [{ url, label: "Source" }] : [],
      },
    ],
    sources: url ? [{ url }] : [],
  };
}

function slugish(text) {
  return (text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Route conference creation through the Concierge: both home CTAs ("New
// conference" and the empty-state "Create one") open the chat drawer so the
// user names a conference or pastes a URL and the agent imports it. Falls back
// to the manual modal only if the drawer isn't available (e.g. a target with
// no chat module mounted).
function openConcierge(focusInput) {
  if (PUBLIC_DEMO) {
    const email = document.querySelector(".waitlist-form input[type='email']");
    if (email) email.focus();
    return;
  }
  const d = window.confnote && window.confnote.drawer;
  if (d && typeof d.toggle === "function") {
    const open = () => {
      if (!d.isOpen("chat")) d.toggle("chat", true);
      if (focusInput) setTimeout(focusConciergeInput, 80);
    };
    if (d.ready && typeof d.ready.then === "function") d.ready.then(open);
    else open();
    return;
  }
  openNewConferenceModal();
}

// Manual conference-entry modal. Intentionally NOT wired to any visible button
// for now — all adds go via the Concierge (see openConcierge). Kept intact so
// the manual path still exists and can be re-surfaced later.
function openNewConferenceModal() {
  closeNewConferenceModal();
  const overlay = document.createElement("div");
  overlay.className = "modal-ov";
  overlay.id = "newConfModal";
  overlay.innerHTML = `<div class="modal-box new-conf-modal" role="dialog" aria-modal="true" aria-labelledby="newConfTitle">
    <div class="modal-head">
      <div>
        <span class="modal-title" id="newConfTitle">New conference</span>
        <span class="modal-sub">Create a confnote.agenda.v1 manifest, validate it, then import.</span>
      </div>
      <button class="modal-x" type="button" aria-label="Close">✕</button>
    </div>
    <div class="modal-body">
      <div class="new-conf-grid">
        <label>Name <input id="ncName" class="set-input" value=""></label>
        <label>Date <input id="ncDate" class="set-input" type="date"></label>
        <label>Timezone <input id="ncTimezone" class="set-input" value="Europe/London"></label>
        <label>Venue <input id="ncVenue" class="set-input" value=""></label>
        <label class="wide">Source URL <input id="ncUrl" class="set-input" value="" placeholder="https://..."></label>
        <label>First session <input id="ncSessionTitle" class="set-input" value="Opening session"></label>
        <label>Starts <input id="ncStart" class="set-input" type="time" value="09:00"></label>
        <label>Ends <input id="ncEnd" class="set-input" type="time" value="10:00"></label>
      </div>
      <div class="manifest-row">
        <div class="manifest-head">
          <span>Manifest JSON</span>
          <button id="ncRefreshJson" type="button">Refresh from form</button>
        </div>
        <textarea id="ncJson" spellcheck="false"></textarea>
      </div>
      <div id="ncResult" class="new-conf-result"></div>
    </div>
    <div class="modal-foot">
      <button id="ncValidate" type="button">Validate</button>
      <button id="ncCreate" class="primary" type="button">Create</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const box = overlay.querySelector(".modal-box");
  const jsonEl = box.querySelector("#ncJson");
  const refreshJson = () => {
    jsonEl.value = JSON.stringify(draftFromManual(box), null, 2);
  };
  refreshJson();
  overlay.onclick = (e) => {
    if (e.target === overlay) closeNewConferenceModal();
  };
  box.querySelector(".modal-x").onclick = closeNewConferenceModal;
  box.querySelector("#ncRefreshJson").onclick = refreshJson;
  box.querySelector("#ncValidate").onclick = () => validateConferenceDraft(box);
  box.querySelector("#ncCreate").onclick = () => createConferenceDraft(box);
}

function closeNewConferenceModal() {
  document.getElementById("newConfModal")?.remove();
}

function draftPayload(box) {
  const text = box.querySelector("#ncJson").value.trim();
  return { agenda: text ? JSON.parse(text) : draftFromManual(box) };
}

function renderDraftResult(box, data, isError) {
  const out = box.querySelector("#ncResult");
  const errors = data.errors || (data.error ? [data.error] : []);
  const warnings = data.warnings || [];
  const s = data.summary || {};
  const bits = [];
  if (data.ok) {
    bits.push(`<strong>Ready:</strong> ${esc(s.name || "")} ${s.slug ? `→ ${esc(s.slug)}` : ""}`);
    bits.push(`${s.event_count || 0} events · ${s.speaker_count || 0} speakers`);
  } else {
    bits.push("<strong>Not ready.</strong>");
  }
  if (errors.length) bits.push(`<div class="err">${errors.map(esc).join("<br>")}</div>`);
  if (warnings.length) bits.push(`<div class="warn">${warnings.map(esc).join("<br>")}</div>`);
  out.className = "new-conf-result" + (isError || !data.ok ? " bad" : " ok");
  out.innerHTML = bits.join("<br>");
}

async function validateConferenceDraft(box) {
  try {
    const r = await fetch("/api/conference/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draftPayload(box)),
    });
    const data = await r.json();
    renderDraftResult(box, data, false);
    return data;
  } catch (e) {
    renderDraftResult(box, { ok: false, error: e.message || String(e) }, true);
    return null;
  }
}

async function createConferenceDraft(box) {
  try {
    const r = await fetch("/api/conferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draftPayload(box)),
    });
    const data = await r.json();
    if (!r.ok) {
      renderDraftResult(box, data, true);
      return;
    }
    renderDraftResult(
      box,
      { ok: true, summary: data.summary || {}, warnings: data.warnings || [] },
      false,
    );
    closeNewConferenceModal();
    location.hash = "#/" + data.slug;
  } catch (e) {
    renderDraftResult(box, { ok: false, error: e.message || String(e) }, true);
  }
}

async function handleConferenceImported(event) {
  if (event?.workspaceId) {
    window.dispatchEvent(new CustomEvent("confnote-workspace", { detail: event.workspaceId }));
  }
  const slug = event && event.slug ? String(event.slug) : "";
  if (!S.slug && slug) {
    location.hash = "#/" + slug;
    return;
  }
  if (!S.slug) {
    await renderHome(++S.routeSeq);
    return;
  }
  refreshConcierge();
}
// Exposed so the concierge stream path can be exercised in e2e without driving
// the live agent (the chat stream calls the same handler on conference_imported).
window.confnote = window.confnote || {};
window.confnote.handleConferenceImported = handleConferenceImported;

// Fetch open-action counts for each conf badge; click opens the modal.
function wireDebriefBadges(scope, list) {
  scope.querySelectorAll("[data-debrief]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openDebriefModal(el.dataset.debrief);
    });
  });
  scope.querySelectorAll("[data-count]").forEach(async (el) => {
    try {
      const d = await api(`/api/actions?slug=${encodeURIComponent(el.dataset.count)}`);
      const open = d.open || 0;
      el.textContent = open;
      el.closest(".tr-debrief")?.classList.toggle("has-open", open > 0);
    } catch (e) {
      el.textContent = "0";
    }
  });
}

// ---------- conference-wide Actions modal ----------
// Tick a single open action in one note: fetch its Actions section, find
// the Nth open action line, flip it, PUT back. `openPos` = index among
// open items (matches the order /api/actions returns). With `expectedText`
// it refuses (returns false) when that line no longer holds the same action,
// so a stale list can't complete a different item.
//
// Action items live in `## Actions` per-session (since the v0.1 schema
// rename — Debrief is now reserved for the conference-level DEBRIEF.md
// narrative; see docs/internal/archive/planning).
async function tickRemoteAction(slug, note, openPos, expectedText) {
  const n = await api(`/api/note?slug=${slug}&file=${note}`);
  const src = n.sections?.Actions || "";
  // Empty `- [ ]` placeholders are not actions server-side either.
  const open = parseActions(src).filter((a) => !a.done && a.text);
  const target = open[openPos];
  if (!target) return false;
  if (expectedText !== undefined && target.text !== expectedText) return false;
  const next = toggleActionLine(src, target.idx);
  await api(`/api/note?slug=${slug}&file=${note}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sections: { Actions: next } }),
  });
  // keep the open editor in sync if it's the same note
  if (S.note && S.slug === slug && S.file === note) S.note.sections.Actions = next;
  refreshActionCount(slug); // live-update the ✔ Actions badge
  return true;
}
// Drawer modules tick actions through the same write path as the modal.
window.confnote = window.confnote || {};
window.confnote.tickAction = tickRemoteAction;

function closeDebriefModal() {
  document.getElementById("debriefModal")?.remove();
  document.removeEventListener("keydown", onDebriefKey);
}
function onDebriefKey(e) {
  if (e.key === "Escape") closeDebriefModal();
}

// ---------- Brief / Debrief: inline editable conf-level docs --------
// Opened inline in the editor pane (route #/<slug>/~brief|~debrief), NOT a
// modal — same EasyMDE editing surface as a session note. Single free-form
// body (no canonical sections). Autosaves via PUT /api/conf-doc with an mtime
// guard so an agent regeneration under the editor reconciles instead of being
// silently clobbered.
const CONF_DOCS = {
  "~brief": { field: "brief", name: "BRIEF.md", label: "Brief", sub: "pre-conference primer" },
  "~debrief": {
    field: "debrief",
    name: "DEBRIEF.md",
    label: "Debrief",
    sub: "post-conference recap",
  },
};

function teardownConfMde() {
  if (S.confMde) {
    try {
      S.confMde.toTextArea();
    } catch (e) {}
    S.confMde = null;
  }
}

function destroyConfDoc() {
  teardownConfMde();
  S.confDoc = null;
}

// Render the conf-doc pane for the current mode. Default "read" is the pretty
// rendered markdown (Brief/Debrief are usually consumed, not edited); "edit"
// swaps in EasyMDE. The header toggle flips between them.
function renderConfDocMode() {
  const pane = document.getElementById("confDocPane");
  const toggle = document.getElementById("confDocToggle");
  if (!pane || !S.confDoc) return;
  if (!PUBLIC_DEMO && S.confDoc.mode === "edit") {
    teardownConfMde();
    mount(pane, `<div class="pane mde-pane"><textarea id="confDocTa"></textarea></div>`);
    const ta = document.getElementById("confDocTa");
    ta.value = S.confDoc.text || "";
    if (window.EasyMDE) {
      const mde = new EasyMDE({
        element: ta,
        autoDownloadFontAwesome: false,
        spellChecker: false,
        status: false,
        minHeight: "320px",
        // no maxHeight — let the editor grow and #confDocPane be the single
        // scroll container (avoids a clipped tail + double scrollbars).
        placeholder: `Write the ${(S.confDoc.label || "document").toLowerCase()}…`,
        previewRender: (plain) => mdString(plain),
        uploadImage: true,
        imageUploadFunction: (file, onSuccess, onError) => {
          uploadImage(file)
            .then((r) => onSuccess(r.markdown.slice(4, -1)))
            .catch((e) => onError(String(e)));
        },
        toolbar: [
          "bold",
          "italic",
          "heading",
          "|",
          "quote",
          "unordered-list",
          "ordered-list",
          "|",
          "link",
          "image",
          "code",
          "|",
          "preview",
          "side-by-side",
          "guide",
        ],
      });
      S.confMde = mde;
      mde.codemirror.on("change", () => {
        S.confDoc.text = mde.value();
        markDirty();
      });
      mde.codemirror.on("blur", flush);
    } else {
      ta.addEventListener("input", () => {
        S.confDoc.text = ta.value;
        markDirty();
      });
      ta.addEventListener("blur", flush);
    }
    if (toggle) toggle.textContent = "✓ Done";
  } else {
    teardownConfMde();
    const body = (S.confDoc.text || "").trim()
      ? `<div class="md sp-prose">${mdToHtml(S.confDoc.text, S.slug)}</div>`
      : `<div class="md sp-prose"><p class="empty">Empty — hit Edit to write it, or ask the Concierge.</p></div>`;
    mount(pane, body);
    if (toggle) toggle.textContent = "✎ Edit";
  }
}

async function setConfDocMode(mode) {
  if (!S.confDoc) return;
  if (PUBLIC_DEMO) return;
  if (mode === "read") {
    if (S.confMde) S.confDoc.text = S.confMde.value();
    await flush(); // persist any pending edit before showing the rendered view
  }
  S.confDoc.mode = mode;
  renderConfDocMode();
}

async function openConfDoc(slug, token, routeSeq = S.routeSeq) {
  const meta = CONF_DOCS[token];
  if (!meta) return;
  let data;
  try {
    data = await api(`/api/conf-doc?slug=${encodeURIComponent(slug)}`);
  } catch (e) {
    mount(
      document.getElementById("editor"),
      `<div class="placeholder">Could not load ${esc(meta.label.toLowerCase())}.</div>`,
    );
    return;
  }
  if (routeSeq !== S.routeSeq) return;
  S.note = null; // saveNow dispatches to the conf-doc path while this is open
  S.confDoc = {
    token,
    name: meta.name,
    label: meta.label,
    mtime: data[`${meta.field}_mtime`] || 0,
    text: data[meta.field] || "",
    mode: "read", // default to the pretty rendered view
  };
  mount(
    crumbs,
    `<a href="#/">My events</a> &nbsp;›&nbsp; <a href="#/${esc(slug)}">${esc(S.conf.conference.name)}</a> &nbsp;›&nbsp; <span>${esc(meta.label)}</span>`,
  );
  mount(
    document.getElementById("editor"),
    `<div class="editor"><div class="ehead">
      ${PUBLIC_DEMO ? '<span class="demo-readonly-pill">Read-only demo</span>' : '<button class="brief-btn confdoc-toggle" id="confDocToggle" type="button">✎ Edit</button>'}
      <h1>${esc(meta.label)}</h1>
      <div class="m">${esc(meta.sub)}</div>
    </div><div class="pane" id="confDocPane"></div></div>`,
  );
  const toggle = document.getElementById("confDocToggle");
  if (toggle) toggle.onclick = () => setConfDocMode(S.confDoc.mode === "read" ? "edit" : "read");
  renderConfDocMode();
  refreshConcierge();
}

async function openDebriefModal(slug) {
  closeDebriefModal();
  const overlay = document.createElement("div");
  overlay.id = "debriefModal";
  overlay.className = "modal-ov";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDebriefModal();
  });
  const box = document.createElement("div");
  box.className = "modal-box";
  overlay.append(box);
  document.body.append(overlay);
  document.addEventListener("keydown", onDebriefKey);
  mount(
    box,
    `<div class="modal-head">
      <span class="modal-title">Debrief — open actions</span>
      <button class="modal-x" type="button" title="Close">✕</button>
    </div><div class="modal-body"><div class="empty">loading…</div></div>`,
  );
  box.querySelector(".modal-x").onclick = closeDebriefModal;
  const bodyEl = box.querySelector(".modal-body");

  let data;
  try {
    data = await api(`/api/actions?slug=${encodeURIComponent(slug)}`);
  } catch (e) {
    mount(bodyEl, '<div class="empty">Could not load actions.</div>');
    return;
  }
  paintDebriefModal(box, slug, data);
}

function paintDebriefModal(box, slug, data) {
  const titleEl = box.querySelector(".modal-title");
  if (titleEl) titleEl.textContent = `Actions — ${data.open || 0} open · ${data.total || 0} total`;
  const bodyEl = box.querySelector(".modal-body");
  bodyEl.replaceChildren();

  const sessions = (data.sessions || []).filter((s) => s.items.some((it) => !it.done));
  if (!sessions.length) {
    const done = document.createElement("div");
    done.className = "empty";
    done.textContent = data.total ? "All actions done. 🎉" : "No action items captured yet.";
    bodyEl.append(done);
    return;
  }

  sessions.forEach((s) => {
    const grp = document.createElement("div");
    grp.className = "mg";
    const h = document.createElement("button");
    h.type = "button";
    h.className = "mg-head mg-open";
    h.textContent = `${s.time || ""}  ${s.title || s.note}`.trim();
    h.title = "Open this session's Actions section";
    h.addEventListener("click", () => openNoteSection(slug, s.note, "Actions"));
    grp.append(h);
    const ul = document.createElement("ul");
    ul.className = "actionlist";
    // position among OPEN items only — matches tickRemoteAction's indexing
    let openPos = -1;
    s.items.forEach((it) => {
      if (it.done) return;
      openPos += 1;
      const pos = openPos;
      const li = document.createElement("li");
      li.className = "act act-jump";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "act-cb";
      cb.setAttribute("aria-label", `Complete action: ${it.text}`);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "act-txt act-open";
      btn.textContent = it.text;
      btn.title = "Open this action's source session";
      btn.addEventListener("click", () => openNoteSection(slug, s.note, "Actions"));
      li.append(cb, btn);
      cb.addEventListener("change", async () => {
        cb.disabled = true;
        li.classList.add("done"); // optimistic resolve
        try {
          if (!(await tickRemoteAction(slug, s.note, pos, it.text))) {
            // The note changed since this list was painted: show it as it is now.
            paintDebriefModal(
              box,
              slug,
              await api(`/api/actions?slug=${encodeURIComponent(slug)}`),
            );
            return;
          }
          li.classList.add("vanish");
          setTimeout(async () => {
            try {
              const fresh = await api(`/api/actions?slug=${encodeURIComponent(slug)}`);
              syncDebriefCount(slug, fresh.open || 0);
              paintDebriefModal(box, slug, fresh);
            } catch (e) {
              li.remove();
            }
          }, 220);
        } catch (e) {
          li.classList.remove("done");
          cb.checked = false;
          cb.disabled = false;
        }
      });
      ul.append(li);
    });
    grp.append(ul);
    bodyEl.append(grp);
  });
}

// reflect a new open-count onto any visible badges for this conf
function syncDebriefCount(slug, open) {
  document.querySelectorAll(`[data-count="${CSS.escape(slug)}"]`).forEach((el) => {
    el.textContent = open;
    el.closest(".tr-debrief, .agenda-debrief")?.classList.toggle("has-open", open > 0);
  });
}
function openNoteSection(slug, file, tab) {
  if (!file || file === "INBOX.md") {
    closeDebriefModal();
    location.hash = `#/${slug}`;
    return;
  }
  closeDebriefModal();
  S.pendingTab = tab;
  S.tab2 = null;
  if (S.slug === slug && S.file === file && S.note) {
    selectTab(tab, 1);
    S.pendingTab = null;
    return;
  }
  location.hash = `#/${slug}/${file}`;
}

// ---------- conference + editor ----------
const isLive = (ev) => {
  const n = Date.now();
  return n >= +new Date(ev.start) && n < +new Date(ev.end);
};
const hhmm = (iso) => iso.slice(11, 16);
// breaks / networking / lunch / logistics are "rest", not real talks
const REST_TYPES = { break: 1, networking: 1, logistics: 1 };
const isRest = (ev) => !!REST_TYPES[ev.type];
// Group agenda events by calendar date, keeping the order dates first appear.
// An event without a start stays with the day before it.
function agendaDays(events) {
  const days = [];
  const byDay = new Map();
  for (const e of events) {
    const day = (e.start || "").slice(0, 10) || days[days.length - 1]?.day || "";
    if (!byDay.has(day)) {
      byDay.set(day, { day, events: [] });
      days.push(byDay.get(day));
    }
    byDay.get(day).events.push(e);
  }
  return days;
}

// One day's rail blocks: `{ event }` for a single-column row, `{ lanes }` for
// a run where sessions in different rooms (or tracks) overlap in time.
// Overlapping sessions chain into stretches; back-to-back multi-room
// stretches form one run with a column per room, in the agenda's room order
// (a session without a room joins the first column). Rooms that never
// overlap (talks, then breaks next door) stay one column, and a day with one
// room (or none) keeps its agenda order.
function agendaDayBlocks(events, rooms = [], tracks = []) {
  const laneOf = (e) => e.room || e.track || "";
  const keys = [...new Set(events.map(laneOf).filter(Boolean))];
  if (keys.length < 2) return events.map((event) => ({ event }));
  const known = [...(rooms || []), ...(tracks || [])];
  const place = (key) => known.find((r) => r.id === key || r.name === key);
  const rank = (key) => (place(key) ? known.indexOf(place(key)) : known.length + keys.indexOf(key));
  keys.sort((a, b) => rank(a) - rank(b));
  const t = (iso) => +new Date(iso) || 0;
  const sorted = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => t(a.e.start) - t(b.e.start) || a.i - b.i)
    .map((o) => o.e);
  const stretches = [];
  let stretchEnd = 0;
  for (const e of sorted) {
    const start = t(e.start);
    if (!start || start >= stretchEnd) {
      stretches.push([]);
      stretchEnd = 0;
    }
    stretches[stretches.length - 1].push(e);
    stretchEnd = Math.max(stretchEnd, t(e.end));
  }
  const blocks = [];
  let run = null;
  for (const stretch of stretches) {
    if (new Set(stretch.map(laneOf).filter(Boolean)).size < 2) {
      run = null;
      blocks.push(...stretch.map((event) => ({ event })));
      continue;
    }
    if (!run) {
      run = [];
      blocks.push({ run });
    }
    run.push(...stretch);
  }
  const lanesFor = (run) => {
    const present = keys.filter((key) => run.some((e) => laneOf(e) === key));
    const lanes = present.map((key) => ({ key, label: place(key)?.name || key, events: [] }));
    for (const e of run) {
      const lane = lanes.find((l) => l.key === laneOf(e)) || lanes[0];
      lane.events.push(e);
    }
    return lanes;
  };
  return blocks.map((block) => (block.run ? { lanes: lanesFor(block.run) } : block));
}

function currentAgendaEvent(events) {
  const live = events.filter(isLive);
  live.sort(
    (a, b) => Number(isRest(a)) - Number(isRest(b)) || +new Date(b.start) - +new Date(a.start),
  );
  return live[0];
}

// Anchor the ● now-marker to a REAL agenda row, not a time-of-day percentage.
// The rail is an equal-height row list — it isn't scaled to time — so a % of
// its pixel height is meaningless (it lands on an arbitrary row). Instead pin
// the dot to: the live row if a session is on now, else the next upcoming row,
// else the last row. The .off class dims it when now is outside the
// conference's actual span (before it starts / after it ends).
function paintNowMarker() {
  const dot = document.getElementById("railNow");
  const track = document.getElementById("railTrack");
  if (!dot || !track) return;
  // Rows render 1:1 with S.conf.events; S.railRows holds each row's event
  // index in DOM order (parallel rooms render side by side, out of event
  // order) — the now-dot's time data lives in JS, not DOM attributes (which
  // clean() would strip).
  const evs = S.conf?.events || [];
  const rowAt = new Map();
  [...track.querySelectorAll(".rl-row")].forEach((row, k) => rowAt.set(S.railRows?.[k], row));
  if (!rowAt.size || rowAt.size !== evs.length) return;
  const rowEls = evs.map((e, i) => rowAt.get(i));
  const t = (s) => +new Date(s);
  const timed = evs
    .map((e, i) => ({ e, i }))
    .filter(
      (o) => o.e.start && o.e.end && !Number.isNaN(t(o.e.start)) && !Number.isNaN(t(o.e.end)),
    );
  if (!timed.length) return;
  const now = Date.now();
  const firstStart = t(timed[0].e.start);
  const lastEnd = Math.max(...timed.map((o) => t(o.e.end)));
  const current = currentAgendaEvent(evs);
  const target =
    timed.find((o) => o.e === current) || // live now
    timed.find((o) => t(o.e.start) > now) || // next upcoming
    timed[timed.length - 1]; // conference over → rest at the last row
  const rowEl = rowEls[target.i];
  rowEls.forEach((row, i) => row.classList.toggle("live", isLive(evs[i])));
  const jump = document.querySelector(".agenda-acts .jump");
  const linkedLive = currentAgendaEvent(evs.filter((event) => event.note));
  if (jump) {
    jump.hidden = !linkedLive;
    if (linkedLive) {
      jump.dataset.jump = linkedLive.note;
      jump.textContent = `● Jump to live: ${linkedLive.title}`;
    }
  }
  if (!rowEl) return;
  // Centre on the row's node. Row top-padding (11px) + node margin/half-height
  // is a fixed offset, so this stays aligned without measuring the node.
  const NODE_CENTER = 17;
  // A row inside a parallel-room column has its own rail line: measure its node.
  const node = rowEl.closest(".rl-lane") && rowEl.querySelector(".rl-node");
  if (node) {
    dot.style.left = `${rowEl.offsetLeft + node.offsetLeft + node.offsetWidth / 2}px`;
    dot.style.top = `${rowEl.offsetTop + node.offsetTop + node.offsetHeight / 2}px`;
  } else {
    dot.style.left = "";
    dot.style.top = `${rowEl.offsetTop + NODE_CENTER}px`;
  }
  dot.classList.toggle("off", now < firstStart || now >= lastEnd);
}

// Client-side fallback for the status line (used if /api/conf-doc is
// unreachable, e.g. an older server process).
function deriveRailStatus() {
  const evs = (S.conf?.events || []).filter((e) => e.start && e.end);
  if (!evs.length) return "";
  const now = Date.now();
  const t0 = +new Date(evs[0].start);
  const t1 = Math.max(...evs.map((e) => +new Date(e.end)));
  if (now < t0) return `Starts ${hhmm(evs[0].start)} · ${evs[0].title}`;
  if (now >= t1) return "Conference has ended.";
  const cur = currentAgendaEvent(evs);
  const nextBreak = evs.find((e) => isRest(e) && +new Date(e.start) > now);
  const parts = [];
  if (cur) {
    const leftM = Math.max(0, Math.round((+new Date(cur.end) - now) / 60000));
    parts.push(`Now: ${cur.title} · ${leftM}m left`);
  } else {
    const next = evs.find((e) => +new Date(e.start) > now);
    if (next) parts.push(`Next: ${next.title} at ${hhmm(next.start)}`);
  }
  if (nextBreak && !(cur && isRest(cur))) {
    const inM = Math.max(0, Math.round((+new Date(nextBreak.start) - now) / 60000));
    parts.push(`next break in ${inM}m`);
  }
  return parts.join(" · ");
}

// Prefer the backend's canonical time-aware status string so the rail header
// reads the same as the concierge; fall back to the client derivation.
async function refreshRailStatus() {
  const box = document.getElementById("railStatus");
  if (!box || !S.slug) return;
  let text = "";
  try {
    const d = await api(`/api/conf-doc?slug=${encodeURIComponent(S.slug)}`);
    text = (d && d.status) || "";
  } catch (e) {}
  if (!text) text = deriveRailStatus();
  // guard against a late response after the user navigated away
  if (document.getElementById("railStatus") === box) {
    box.textContent = text;
    // a live/now session lights the status chip green; otherwise it's neutral
    box.classList.toggle("live", /^(LIVE\b|Now:)/.test(text));
  }
}

function railTick() {
  paintNowMarker();
  refreshRailStatus();
  refreshConferenceSchedule();
  refreshPicks();
}
window.addEventListener("focus", railTick);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) railTick();
});

async function applyConferenceSchedule(slug, payload) {
  if (S.slug !== slug || S.conf?._slug !== slug) return;
  if (payload.schedule_revision < S.conf.schedule_revision) return;
  const routeSeq = S.routeSeq;
  const file = S.file;
  S.conf = { ...payload, _slug: slug };
  adoptConferencePicks(slug, payload);
  await renderConference(slug, file, routeSeq, true);
  if (!file || CONF_DOCS[file]) return;
  const fresh = await api(
    `/api/note?slug=${encodeURIComponent(slug)}&file=${encodeURIComponent(file)}`,
  );
  if (S.slug !== slug || S.file !== file || S.routeSeq !== routeSeq) return;
  const fm = fresh.frontmatter || {};
  const event = payload.events.find((entry) => entry.note === file) || {};
  const header = app.querySelector(".ehead .m");
  if (header) header.textContent = sessionMeta(fm, event);
  // Updating metadata must never replace unsaved note sections or the editor.
  if (S.note) S.note.frontmatter = fm;
}

async function refreshConferenceSchedule() {
  if (!S.slug || S.conf?.schedule_revision === undefined || S.scheduleRefresh) return;
  S.scheduleRefresh = true;
  const slug = S.slug;
  const routeSeq = S.routeSeq;
  try {
    const payload = await api(`/api/conference?slug=${encodeURIComponent(slug)}`);
    if (S.slug !== slug || S.routeSeq !== routeSeq) return;
    if (payload.schedule_revision !== S.conf.schedule_revision)
      await applyConferenceSchedule(slug, payload);
  } catch {
    // The next poll retries after a temporary connection failure.
  } finally {
    S.scheduleRefresh = false;
  }
}

function handleConferenceRescheduled(change) {
  if (change?.slug === S.slug && change.conference)
    applyConferenceSchedule(change.slug, change.conference).catch(() =>
      refreshConferenceSchedule(),
    );
}

function openScheduleModal(slug) {
  document.getElementById("scheduleModal")?.remove();
  const offset = S.conf.schedule_offset_minutes || 0;
  const revision = S.conf.schedule_revision;
  const overlay = document.createElement("div");
  overlay.className = "modal-ov";
  overlay.id = "scheduleModal";
  overlay.innerHTML = `<form class="modal-box" role="dialog" aria-modal="true" aria-labelledby="scheduleTitle">
    <div class="modal-head"><span class="modal-title" id="scheduleTitle">Adjust schedule</span>
      <button class="modal-x" type="button" aria-label="Close">✕</button></div>
    <div class="modal-body"><label>Minutes later than the published agenda
      <input class="set-input" name="offset" type="number" min="-1440" max="1440" step="1" required></label>
      <p>Applies to every session. Use 0 to restore the published times. Your notes stay attached.</p>
      <p class="schedule-error" role="alert"></p>
      <button type="submit">Apply schedule</button></div></form>`;
  document.body.appendChild(overlay);
  overlay.querySelector(".modal-x").onclick = () => overlay.remove();
  overlay.onclick = (event) => {
    if (event.target === overlay) overlay.remove();
  };
  const input = overlay.querySelector("input");
  // Set as a property, never interpolated: the offset comes from an agenda file, which may be a shared vault's.
  input.value = String(Number.isInteger(offset) ? offset : 0);
  input.focus();
  overlay.querySelector("form").onsubmit = async (event) => {
    event.preventDefault();
    const button = overlay.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      const payload = await api("/api/conference/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Confnote-Request": "1" },
        body: JSON.stringify({
          slug,
          offset_minutes: Number(input.value),
          expected_offset: offset,
          expected_revision: revision,
        }),
      });
      await applyConferenceSchedule(slug, payload);
      overlay.remove();
    } catch (error) {
      overlay.querySelector(".schedule-error").textContent =
        error.message === "409"
          ? "The schedule changed elsewhere. Close this window and try again using the updated times."
          : "Could not update the schedule. Please try again.";
      await refreshConferenceSchedule();
    } finally {
      button.disabled = false;
    }
  };
}

function startNowMarker() {
  if (S.railTimer) clearInterval(S.railTimer);
  railTick();
  S.railTimer = setInterval(railTick, 30000);
  if (S.scheduleTimer) clearInterval(S.scheduleTimer);
  S.scheduleTimer = setInterval(refreshConferenceSchedule, 5000);
}

const confViewKey = (slug) => `confnote-confview-${slug}`;
function activeConfView(slug) {
  const allowed = new Set(["schedule", "agenda", "now", "speakers"]);
  const value = localStorage.getItem(confViewKey(slug)) || "schedule";
  return allowed.has(value) ? value : "schedule";
}

function renderConferenceDashboard(slug) {
  const view = activeConfView(slug);
  const events = sortedEvents().filter((ev) => ev.note);
  const stars = starredNotes(slug);
  const conflicts = conflictGroups(events);
  mount(
    app,
    `<section class="conf-dashboard">
      <div class="conf-hero">
        <div>
          ${demoChip()}
          <h1>${esc(S.conf.conference.name)}</h1>
          <p>${esc(S.conf.conference.tagline || S.conf.conference.description || "Plan, capture, and follow up from one conference workspace.")}</p>
        </div>
        <div class="conf-metrics">
          <span><b>${events.length}</b> sessions</span>
          <span><b>${stars.size}</b> saved</span>
          <span><b>${conflicts.length}</b> conflict slots</span>
        </div>
      </div>
      <div class="block-rec" id="blockRec"></div>
      <div class="conf-tabs" role="tablist">
        <button class="conf-tab${view === "schedule" ? " on" : ""}" data-view="schedule" type="button">Schedule</button>
        <button class="conf-tab${view === "agenda" ? " on" : ""}" data-view="agenda" type="button">My Agenda</button>
        <button class="conf-tab${view === "now" ? " on" : ""}" data-view="now" type="button">Now / Next</button>
        <button class="conf-tab${view === "speakers" ? " on" : ""}" data-view="speakers" type="button">Speakers</button>
      </div>
      <div id="confView"></div>
    </section>`,
  );
  app.querySelectorAll(".conf-tab").forEach((btn) => {
    btn.onclick = () => {
      localStorage.setItem(confViewKey(slug), btn.dataset.view);
      renderConferenceDashboard(slug);
    };
  });
  paintConferenceView(view);
  paintBlockRecorder(slug);
}

// ---------- block recording: one recording over the block, cut per session ----------
// The Cat records continuously; Stop transcribes it with segment times and
// the server files one padded slice + transcript beside each session's note.
// Each paint also pushes the starred notes for the server's auto-record timer.
const blockRecState = new Map(); // slug → { busy, status, results }

async function recordingPost(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Confnote-Request": "1" },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || String(r.status));
  return data;
}

function blockResultList(slug, results) {
  const titleOf = (note) => S.conf?.events?.find((ev) => ev.note === note)?.title || note;
  return results
    .map(
      (row) =>
        `<li><a href="#/${esc(slug)}/${esc(row.note)}">${esc(titleOf(row.note))}</a> <span>${esc(row.status)}${row.confidence ? ` · ${esc(row.confidence)}` : ""}${row.error ? ` · ${esc(row.error)}` : ""}</span></li>`,
    )
    .join("");
}

async function paintBlockRecorder(slug) {
  const host = document.getElementById("blockRec");
  if (!host || PUBLIC_DEMO) return;
  const notes = [...starredNotes(slug)];
  const local = blockRecState.get(slug) || { busy: false, status: "", results: [] };
  let server = { recording: false };
  try {
    server = await recordingPost("/api/recording/auto", { slug, notes });
  } catch (_e) {
    // No recording routes here (the web target): a Record button that can't
    // record would only mislead, so leave the slot empty.
    return;
  }
  if (S.slug !== slug || !document.body.contains(host)) return;
  const recording = !!server.recording;
  let status = local.status;
  if (!status && recording) {
    const since = new Date(server.started_at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    status = `Recording the block since ${since}${server.auto ? " (auto)" : ""}.`;
  }
  if (!status && server.enabled) status = "Auto-record is on for today's starred sessions.";
  mount(
    host,
    `<button class="pill${recording ? " on" : ""}" id="blockRecBtn" type="button"${local.busy ? " disabled" : ""}>${recording ? "Stop &amp; split" : "Record block"}</button>
     <span class="block-rec-status" id="blockRecStatus">${esc(status)}</span>
     <ul class="block-rec-results">${blockResultList(slug, local.results)}</ul>`,
  );
  document.getElementById("blockRecBtn").onclick = async () => {
    const next = { busy: true, status: "", results: [] };
    blockRecState.set(slug, next);
    try {
      if (recording) {
        next.status = "Stopping. The Cat transcribes the block, then it is cut per session…";
        paintBlockRecorder(slug);
        const out = await recordingPost("/api/recording/block/stop", { slug });
        next.results = out.results || [];
        const filed = next.results.filter((row) => row.status === "filed").length;
        next.status = `Split into ${filed} session${filed === 1 ? "" : "s"}.${out.detail ? ` ${out.detail}` : ""}`;
      } else {
        await recordingPost("/api/recording/block/start", { slug, notes });
        next.status = "";
      }
    } catch (error) {
      next.status = `Recording failed: ${error.message}`;
    }
    next.busy = false;
    paintBlockRecorder(slug);
  };
}

function paintConferenceView(view) {
  const host = document.getElementById("confView");
  if (!host) return;
  if (view === "agenda") return renderMyAgendaView(host);
  if (view === "now") return renderNowView(host);
  if (view === "speakers") return renderSpeakersView(host);
  return renderScheduleView(host);
}

function wireSessionCards(host) {
  host.querySelectorAll("[data-note]").forEach((btn) => {
    btn.onclick = () => {
      const note = btn.dataset.note;
      if (note) location.hash = `#/${S.slug}/${note}`;
    };
  });
  host.querySelectorAll("[data-star]").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const note = btn.dataset.star;
      const ev = S.conf.events.find((item) => item.note === note);
      if (!ev) return;
      setStarred(ev, !isStarred(ev));
      renderConferenceDashboard(S.slug);
      paintRailStars();
    };
  });
}

// Up to this many parallel rooms render as side-by-side columns in Schedule.
const MAX_ROOM_COLUMNS = 3;
// One row of the room-column time grid covers this many minutes.
const TIME_GRID_STEP_MINUTES = 5;

function renderScheduleView(host) {
  const filter = host.dataset.filter || "all";
  const query = host.dataset.query || "";
  const events = sortedEvents().filter((ev) => ev.note && eventMatches(ev, query, filter));
  const days = [...groupBy(events, (ev) => dateKey(ev.start)).entries()];
  const filterButtons = ["all", "starred", "keynote", "workshop", "talk", "other"]
    .map(
      (value) =>
        `<button class="pill${filter === value ? " on" : ""}" data-filter="${value}" type="button">${esc(value === "all" ? "All" : value)}</button>`,
    )
    .join("");
  const startSlots = (slotRows, day) =>
    [...groupBy(slotRows, (ev) => ev.start).entries()].map(
      ([start, slotEvents]) => `<div class="schedule-slot">
          <div class="slot-time">
            <strong>${esc(hhmm(start))}</strong>
            <span>${esc(dayLabel(day))}</span>
            ${slotEvents.length > 1 ? `<em>${slotEvents.length} concurrent</em>` : ""}
          </div>
          <div class="slot-sessions">${slotEvents.map((ev) => sessionCard(ev)).join("")}</div>
        </div>`,
    );
  // A stretch where a few rooms run in parallel (a main stage and a breakout)
  // reads best as one slot with a column per room; with many rooms (a big
  // multi-track fair) the start-time slots stay, since columns get too narrow.
  // Each room is a column on one shared time grid (a row per
  // TIME_GRID_STEP_MINUTES), so sessions that start together sit on one line.
  const roomSlot = (lanes, day) => {
    const all = lanes.flatMap((lane) => lane.events);
    const from = Math.min(...all.map(eventStartMs));
    const to = Math.max(...all.map(eventEndMs));
    const first = all.find((ev) => eventStartMs(ev) === from);
    const last = all.find((ev) => eventEndMs(ev) === to);
    const stepMs = TIME_GRID_STEP_MINUTES * 60_000;
    const rowCount = Math.max(1, Math.ceil((to - from) / stepMs));
    const columns = `repeat(${lanes.length}, minmax(0, 1fr))`;
    const placed = lanes
      .flatMap((lane, index) =>
        lane.events.map((ev) => {
          const startRow = Math.floor((eventStartMs(ev) - from) / stepMs) + 1;
          const endRow = Math.max(startRow + 1, Math.ceil((eventEndMs(ev) - from) / stepMs) + 1);
          return `<div class="tg-cell" style="grid-column:${index + 1};grid-row:${startRow} / ${endRow}">${sessionCard(ev, { compact: true })}</div>`;
        }),
      )
      .join("");
    return `<div class="schedule-slot rooms">
          <div class="tg-head">
            <div class="tg-range">
              <strong>${esc(hhmm(first.start))}–${esc(hhmm(last.end))}</strong>
              <span>${esc(dayLabel(day))} · ${lanes.length} concurrent rooms</span>
            </div>
            <div class="tg-rooms" style="grid-template-columns:${columns}">${lanes
              .map((lane) => `<div class="slot-room-h">${esc(lane.label)}</div>`)
              .join("")}</div>
          </div>
          <div class="time-grid" style="grid-template-columns:${columns};grid-template-rows:repeat(${rowCount}, minmax(var(--tg-row), auto))">${placed}</div>
        </div>`;
  };
  const body = days
    .map(([day, rows]) => {
      const slots = [];
      let pending = [];
      const flush = () => {
        slots.push(...startSlots(sortedEvents(pending), day));
        pending = [];
      };
      for (const block of agendaDayBlocks(rows, S.conf.rooms, S.conf.tracks)) {
        if (!block.lanes) {
          pending.push(block.event);
        } else if (block.lanes.length > MAX_ROOM_COLUMNS) {
          pending.push(...block.lanes.flatMap((lane) => lane.events));
        } else {
          flush();
          slots.push(roomSlot(block.lanes, day));
        }
      }
      flush();
      return `<section class="schedule-day"><h2>${esc(dayLabel(day))}</h2>${slots.join("")}</section>`;
    })
    .join("");
  mount(
    host,
    `<div class="schedule-tools">
      <input id="scheduleSearch" class="schedule-search" type="search" placeholder="Search sessions, speakers, tracks, rooms" value="${esc(query)}">
      <div class="pill-row">${filterButtons}</div>
    </div>
    <div class="schedule-list">${body || '<div class="empty">No sessions match this view.</div>'}</div>`,
  );
  const search = host.querySelector("#scheduleSearch");
  if (search) {
    search.oninput = () => {
      host.dataset.query = search.value;
      renderScheduleView(host);
    };
  }
  host.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.onclick = () => {
      host.dataset.filter = btn.dataset.filter;
      renderScheduleView(host);
    };
  });
  wireSessionCards(host);
}

function renderMyAgendaView(host) {
  const starred = starredNotes(S.slug);
  const events = sortedEvents().filter((ev) => ev.note && starred.has(ev.note));
  const conflicts = conflictGroups(events);
  const rows = events.map((ev) => sessionCard(ev, { detail: true })).join("");
  const conflictRows = conflicts
    .map(
      (group) => `<div class="conflict-group">
      <div class="conflict-head">${esc(dayLabel(dateKey(group[0].start)))} · ${esc(timeRange(group[0]))} · ${group.length} saved sessions overlap</div>
      <div class="compare-grid">${group.map((ev) => sessionCard(ev, { detail: true })).join("")}</div>
    </div>`,
    )
    .join("");
  mount(
    host,
    `<div class="agenda-view">
      ${events.length ? `<div class="session-grid">${rows}</div>` : '<div class="placeholder compact"><span class="big">★</span>Save sessions from the Schedule view to build your agenda.</div>'}
      ${conflictRows ? `<h2>Conflicts to decide</h2>${conflictRows}` : ""}
    </div>`,
  );
  wireSessionCards(host);
}

function renderNowView(host) {
  const state = currentAndNext();
  const upcoming = state.upcoming.slice(0, 12);
  mount(
    host,
    `<div class="now-view">
      <section>
        <h2>Now</h2>
        <div class="session-grid">${state.live.length ? state.live.map((ev) => sessionCard(ev, { detail: true })).join("") : '<div class="empty">No session is live right now.</div>'}</div>
      </section>
      <section>
        <h2>Next</h2>
        <div class="session-grid">${state.next.length ? state.next.map((ev) => sessionCard(ev, { detail: true })).join("") : '<div class="empty">No upcoming session found.</div>'}</div>
      </section>
      <section>
        <h2>Coming Up</h2>
        <div class="mini-agenda">${upcoming.map((ev) => `<button class="mini-event" data-note="${esc(ev.note || "")}" type="button"><span>${esc(timeRange(ev))}</span><strong>${esc(ev.title)}</strong><em>${esc(roomLabel(ev) || trackLabel(ev) || "")}</em></button>`).join("")}</div>
      </section>
    </div>`,
  );
  wireSessionCards(host);
}

// The Concierge's speaker notes ("prepare a brief and research each speaker"), kept per conference in the
// vault as module state. Loaded once per conference; hosts without them answer {} or 404.
async function loadSpeakerResearch(slug) {
  if (S.speakerResearch && S.speakerResearch.slug === slug) return S.speakerResearch.data;
  let data = {};
  try {
    data = await api(`/api/module/speaker-research/state?slug=${encodeURIComponent(slug)}`);
  } catch (e) {}
  S.speakerResearch = { slug, data: data || {} };
  return S.speakerResearch.data;
}

// A Concierge turn may have just written the notes: drop the cached copy and repaint an open Speakers view.
window.addEventListener("confnote-concierge-turn", () => {
  S.speakerResearch = null;
  const host = document.getElementById("confView");
  if (host && host.querySelector(".speaker-view")) renderSpeakersView(host);
});

function speakerResearchHtml(note) {
  if (!note) return "";
  return `<div class="speaker-research">
      ${note.who ? `<p>${esc(note.who)}</p>` : ""}
      ${note.talk ? `<p>${esc(note.talk)}</p>` : ""}
      ${note.ask ? `<p class="speaker-ask">Ask: ${esc(note.ask)}</p>` : ""}
    </div>`;
}

function renderSpeakersView(host) {
  const q = host.dataset.query || "";
  const slug = S.slug;
  const research =
    S.speakerResearch && S.speakerResearch.slug === slug ? S.speakerResearch.data : null;
  if (!research) {
    loadSpeakerResearch(slug).then(() => {
      if (host.isConnected && S.slug === slug && host.querySelector(".speaker-view")) {
        renderSpeakersView(host);
      }
    });
  }
  const notes = (research && research.speakers) || {};
  const people = new Map();
  for (const ev of S.conf.events || []) {
    for (const name of ev.speakers || []) {
      if (!people.has(name)) people.set(name, []);
      people.get(name).push(ev);
    }
  }
  const rows = [...people.entries()]
    .filter(([name, evs]) =>
      [
        name,
        notes[name] ? notes[name].who : "",
        ...evs.map((ev) => `${ev.title} ${trackLabel(ev)} ${roomLabel(ev)}`),
      ]
        .join(" ")
        .toLowerCase()
        .includes(q.trim().toLowerCase()),
    )
    .sort((a, b) => a[0].localeCompare(b[0]));
  const researched = Object.keys(notes).length;
  const basis = researched
    ? `<p class="speaker-research-basis">Speaker notes by the Concierge, ${esc(String(research.generated_at || "").slice(0, 10))}. ${esc(research.basis || "")}</p>`
    : "";
  mount(
    host,
    `<div class="speaker-view">
      <input id="speakerSearch" class="schedule-search" type="search" placeholder="Search speakers, companies, sessions" value="${esc(q)}">
      ${basis}
      <div class="speaker-list">
        ${
          rows
            .map(
              ([name, evs]) => `<div class="speaker-row">
            <div class="speaker-name">${esc(name)}</div>
            <div class="speaker-detail">
              <div class="speaker-sessions">${evs
                .map(
                  (ev) =>
                    `<button class="speaker-session" data-note="${esc(ev.note || "")}" type="button"><span>${esc(timeRange(ev))}</span>${esc(ev.title)}</button>`,
                )
                .join("")}</div>
              ${speakerResearchHtml(notes[name])}
            </div>
          </div>`,
            )
            .join("") || '<div class="empty">No speakers match.</div>'
        }
      </div>
    </div>`,
  );
  const search = host.querySelector("#speakerSearch");
  if (search) {
    search.oninput = () => {
      host.dataset.query = search.value;
      renderSpeakersView(host);
    };
  }
  wireSessionCards(host);
}

async function renderConference(slug, file, routeSeq = S.routeSeq, railOnly = false) {
  S.slug = slug;
  refreshBrowserNotesBanner();
  if (!S.conf || S.conf._slug !== slug) {
    const conf = await api(`/api/conference?slug=${slug}`);
    if (routeSeq !== S.routeSeq) return;
    S.conf = conf;
    S.conf._slug = slug;
    adoptConferencePicks(slug, conf);
    migrateLegacyStars(slug, conf);
  }
  if (!railOnly)
    mount(
      crumbs,
      `<a href="#/">My events</a> &nbsp;›&nbsp; <span>${esc(S.conf.conference.name)}</span>`,
    );
  const live = currentAgendaEvent(S.conf.events.filter((e) => e.note));
  const railCol = collapsed("rail-collapsed");
  const todayDay = todayISO();
  // No data-* attrs on rows: mount()'s clean() sanitizer would strip them.
  // paintNowMarker maps rows → S.conf.events through S.railRows (event index
  // per row, in DOM order), since parallel tracks render out of event order.
  S.railRows = [];
  // Inside a room column the column header names the room, so a leading
  // "[Breakout] " style tag on the title is dropped there.
  const row = (e, inLane = false) => {
    S.railRows.push(S.conf.events.indexOf(e));
    const rest = isRest(e);
    const shown = inLane ? e.title.replace(/^\[[^\]]+\]\s*/, "") || e.title : e.title;
    const node = `<span class="rl-node${rest ? " rest" : ""}"></span>`;
    const meta = `<span class="rl-meta">
        <span class="rl-ti">${esc(shown)}</span>
        ${e.speakers && e.speakers.length ? `<span class="rl-sp">${esc(e.speakers.join(", "))}</span>` : ""}
      </span>`;
    if (!e.note)
      return `<div class="rl-row passive${rest ? " rest" : ""}">
          <span class="rl-t">${hhmm(e.start)}</span>${node}${meta}</div>`;
    const cls = [
      "rl-row",
      rest ? "rest" : "",
      file === e.note ? "active" : "",
      e.has_notes ? "has" : "",
      isLive(e) ? "live" : "",
    ].join(" ");
    const star = rest ? "" : `<span class="rl-star" title="Attending: click to star">☆</span>`;
    return `<a class="${cls}" href="#/${esc(slug)}/${esc(e.note)}" title="${esc(e.title)}">
        <span class="rl-t">${hhmm(e.start)}</span>${node}${meta}${star}</a>`;
  };
  // Room columns share one time grid (header row, then a row per
  // TIME_GRID_STEP_MINUTES), so sessions that start together sit on one line.
  // Each .rl-lane is display:contents; rows keep lane order in the DOM, which
  // S.railRows relies on.
  const lanesBlock = (lanes) => {
    const all = lanes.flatMap((lane) => lane.events);
    const from = Math.min(...all.map(eventStartMs));
    const to = Math.max(...all.map(eventEndMs));
    const stepMs = TIME_GRID_STEP_MINUTES * 60_000;
    const rowCount = Math.max(1, Math.ceil((to - from) / stepMs));
    const dividers = lanes
      .slice(1)
      .map(
        (_, i) =>
          `linear-gradient(var(--line), var(--line)) ${((i + 1) / lanes.length) * 100}% 0 / 1px 100% no-repeat`,
      )
      .join(", ");
    const style = `grid-template-columns:repeat(${lanes.length}, minmax(0, 1fr));grid-template-rows:auto repeat(${rowCount}, minmax(4px, auto))${dividers ? `;background:${dividers}` : ""}`;
    const laneHtml = (lane, index) => {
      const cells = lane.events.map((e) => {
        const startRow = Math.floor((eventStartMs(e) - from) / stepMs) + 2;
        const endRow = Math.max(startRow + 1, Math.ceil((eventEndMs(e) - from) / stepMs) + 2);
        return `<div class="rl-cell" style="grid-column:${index + 1};grid-row:${startRow} / ${endRow}">${row(e, true)}</div>`;
      });
      return `<div class="rl-lane"><div class="rl-lane-h" title="${esc(lane.label)}" style="grid-column:${index + 1};grid-row:1">${esc(lane.label)}</div>${cells.join("")}</div>`;
    };
    return `<div class="rl-lanes" style="${style}">${lanes.map(laneHtml).join("")}</div>`;
  };
  // A divider per calendar date so a multi-day agenda is visibly split into
  // days; parallel rooms inside a day sit side by side (agendaDayBlocks).
  const nodes = agendaDays(S.conf.events)
    .map(({ day, events }) => {
      const dayHdr = day
        ? `<div class="rl-day${day === todayDay ? " today" : ""}">${esc(dayLabel(day))}</div>`
        : "";
      const body = agendaDayBlocks(events, S.conf.rooms, S.conf.tracks)
        .map((block) => (block.lanes ? lanesBlock(block.lanes) : row(block.event)))
        .join("");
      return dayHdr + body;
    })
    .join("");
  const rail = `<div class="rail${railCol ? " collapsed" : ""}">
    <div class="rl-head${demoClass()}">
      <div class="rl-titles">
        ${demoChip()}
        <h1>${esc(S.conf.conference.name)}</h1>
        <div class="sub">${esc(prettyDate(S.conf.conference.date))}${S.conf.conference.venue?.name ? ` · ${esc(S.conf.conference.venue.name)}` : ""}</div>
        ${eventLinksRow(S.conf)}
      </div>
      <button class="rl-toggle" type="button" title="Collapse / expand the rail" aria-label="Toggle rail">⇔</button>
    </div>
    <div class="rl-status" id="railStatus"></div>
    <div class="agenda-acts">
      <button class="jump" data-jump="${esc(live?.note || "")}" ${live ? "" : "hidden"}>${live ? `● Jump to live: ${esc(live.title)}` : "Jump to live"}</button>
      <button class="brief-btn agenda-brief" data-brief="${esc(slug)}" type="button">
        <span class="td-ic">★</span> Brief
      </button>
      <button class="debrief-btn agenda-actions" data-actions="${esc(slug)}" type="button">
        <span class="td-ic">✔</span> Actions <span class="td-n" data-count="${esc(slug)}">…</span>
      </button>
      <button class="brief-btn agenda-confdebrief" data-confdebrief="${esc(slug)}" type="button">
        <span class="td-ic">✎</span> Debrief
      </button>
      ${PUBLIC_DEMO ? "" : '<button class="brief-btn agenda-daygoals" id="daySetupBtn" type="button" title="What would make today worthwhile? Saved to the Brief, no AI request"><span class="td-ic">◎</span> Day goals</button>'}
      ${S.conf.schedule_revision !== undefined ? `<button class="brief-btn agenda-schedule" type="button">Schedule · ${S.conf.schedule_offset_minutes ? `${S.conf.schedule_offset_minutes > 0 ? "+" : ""}${S.conf.schedule_offset_minutes}m` : "published times"}</button>` : ""}
    </div>
    <div class="rl-track" id="railTrack">
      <span class="rl-now" id="railNow" style="top:0%"><span class="rl-now-dot">●</span></span>
      ${nodes}
    </div>
  </div>`;

  // sidebar holds the rail across both "conference picked, no session" and
  // "session open" states; #app holds only the main content. The sidebar
  // itself is always present (avoids the layout jolt of appearing/vanishing).
  // Re-rendering the same conference's rail keeps its scroll position, so
  // clicking a session doesn't make the agenda jump.
  const previousTrack = document.getElementById("railTrack");
  const railScroll = S.railSlug === slug && previousTrack ? previousTrack.scrollTop : null;
  mount(sidebar, rail);
  S.railSlug = slug;
  if (railScroll !== null) document.getElementById("railTrack").scrollTop = railScroll;
  wireSidebarGrip();
  paintRailStars();
  wireRailStars();
  if (!railOnly && !file) {
    renderConferenceDashboard(slug);
  } else if (!railOnly) {
    mount(app, `<div id="editor"></div>`);
  }
  const jb = sidebar.querySelector("[data-jump]");
  if (jb)
    jb.onclick = () => {
      location.hash = `#/${slug}/${jb.dataset.jump}`;
    };
  const tg = sidebar.querySelector(".rl-toggle");
  if (tg)
    tg.onclick = () => {
      const r = sidebar.querySelector(".rail");
      const now = !r.classList.contains("collapsed");
      r.classList.toggle("collapsed", now);
      setCollapsed("rail-collapsed", now);
      paintNowMarker(); // row heights (and room columns) change when collapsing
    };
  startNowMarker();
  // rl-track is its own scroll container. Opening a conference centres the
  // active (or live) row; moving between its sessions keeps the scroll where
  // the user left it and only nudges a row that is out of view.
  requestAnimationFrame(() => {
    const track = document.getElementById("railTrack");
    if (!track) return;
    const target = track.querySelector(".rl-row.active") || track.querySelector(".rl-row.live");
    if (!target) return;
    if (railScroll === null) target.scrollIntoView({ block: "center", behavior: "instant" });
    else target.scrollIntoView({ block: "nearest", behavior: "instant" });
  });
  const br = sidebar.querySelector(".agenda-brief");
  if (br) {
    br.onclick = () => {
      location.hash = `#/${slug}/~brief`;
    };
    br.classList.toggle("active", file === "~brief");
  }
  const cd = sidebar.querySelector(".agenda-confdebrief");
  if (cd) {
    cd.onclick = () => {
      location.hash = `#/${slug}/~debrief`;
    };
    cd.classList.toggle("active", file === "~debrief");
  }
  const db = sidebar.querySelector(".agenda-actions");
  if (db) {
    db.onclick = () => openDebriefModal(slug);
    (async () => {
      try {
        const d = await api(`/api/actions?slug=${encodeURIComponent(slug)}`);
        syncDebriefCount(slug, d.open || 0);
      } catch (e) {
        syncDebriefCount(slug, 0);
      }
    })();
  }
  const dayGoals = sidebar.querySelector(".agenda-daygoals");
  if (dayGoals) dayGoals.onclick = () => window.confnote.openDayGoals?.(slug);
  const scheduleButton = sidebar.querySelector(".agenda-schedule");
  if (scheduleButton) scheduleButton.onclick = () => openScheduleModal(slug);
  if (railOnly) return;
  if (file && CONF_DOCS[file]) {
    S.file = file;
    await openConfDoc(slug, file, routeSeq);
  } else if (file) {
    await openSession(slug, file, routeSeq);
  } else {
    S.file = null;
    refreshConcierge();
  }
}

async function openSession(slug, file, routeSeq = S.routeSeq) {
  destroyConfDoc(); // leaving any inline Brief/Debrief editor
  S.debriefRaw = false;
  const note = await api(`/api/note?slug=${slug}&file=${file}`);
  if (BROWSER_NOTES) {
    const mine = await BROWSER_NOTES.get(slug, file).catch(() => null);
    if (mine) Object.assign(note.sections, mine.sections);
  }
  if (routeSeq !== S.routeSeq) return;
  S.file = file;
  S.note = note;
  S.dirtySections.clear();
  syncCurrentNoteMarker();
  const ev = S.conf.events.find((e) => e.note === file) || {};
  const fm = S.note.frontmatter || {};
  mount(
    crumbs,
    `<a href="#/">My events</a> &nbsp;›&nbsp; <a href="#/${esc(slug)}">${esc(S.conf.conference.name)}</a> &nbsp;›&nbsp; <span>${esc(ev.title || S.note.title)}</span>`,
  );
  // editor scaffold — tabs are a single bar, content sits inside .panes which
  // holds one (full) or two (split) .pane-col children.
  mount(
    document.getElementById("editor"),
    `<div class="editor">
    <div class="ehead">
      <div class="ehead-title">
        <h1>${esc(ev.title || S.note.title)}</h1>
        ${ev.note && !isRest(ev) ? `<button class="attend-star" type="button" title="Star the session you're attending">☆ Attend</button>` : ""}
      </div>
      <div class="m">${esc(sessionMeta(fm, ev))}</div>
      <div class="tags">${(ev.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
    </div>
    <div class="tabbar" id="tabbar"></div>
    <div class="panes" id="panes"></div>
  </div>`,
  );
  const attend = document.querySelector(".ehead .attend-star");
  if (attend) {
    paintAttendButton(attend, ev);
    attend.onclick = () => toggleStar(ev);
  }
  // legacy state cleanup: prior versions stored S.tab; map it forward.
  if (S.tab && !S.tab1) S.tab1 = S.tab;
  const availableTabs = visibleNoteTabs();
  if (S.pendingTab && availableTabs.includes(S.pendingTab)) {
    S.tab1 = S.pendingTab;
    S.pendingTab = null;
  }
  if (!availableTabs.includes(S.tab1) || (READONLY[S.tab1] && !S.note.sections[S.tab1]))
    S.tab1 = availableTabs[0] || "Human notes";
  if (S.tab2 && !availableTabs.includes(S.tab2)) S.tab2 = null;
  paintTabBar();
  ensurePaneDOM();
  renderPaneInto(1);
  if (S.tab2) renderPaneInto(2);
  wirePanesDnD();

  S.poll = setInterval(refreshNoteFromDisk, 5000);
  SESSIONCHAT.key = null; // force a fresh session chat for this file
  refreshConcierge();
}

// ---------- tab bar + split-pane plumbing ----------

function paintTabBar() {
  const bar = document.getElementById("tabbar");
  if (!bar) return;
  const html = visibleNoteTabs()
    .map((t) => {
      const cls = ["tab"];
      if (t === S.tab1) cls.push("on1");
      if (t === S.tab2) cls.push("on2");
      const locked = READONLY[t] || t === PRIVATE || (t === "Transcript" && transcriptLocked());
      const lock = locked ? ' <span class="lock">🔒</span>' : "";
      return `<button class="${cls.join(" ")}" data-t="${esc(t)}" draggable="true" type="button">${esc(t)}${lock}</button>`;
    })
    .join("");
  mount(bar, html);
  bar.querySelectorAll(".tab").forEach((b) => {
    b.onclick = () => selectTab(b.dataset.t, 1);
    b.addEventListener("dragstart", (e) => {
      // dataTransfer is required (some browsers cancel the drag without it)
      // but we keep the actual tab in module scope — custom MIME types in
      // `dataTransfer.types` are unreliable during dragover, and `getData`
      // is privacy-blocked there too.
      try {
        e.dataTransfer.setData("text/plain", b.dataset.t);
        e.dataTransfer.effectAllowed = "move";
      } catch (err) {}
      DRAGGING_TAB = b.dataset.t;
      b.classList.add("dragging");
    });
    b.addEventListener("dragend", () => {
      b.classList.remove("dragging");
      DRAGGING_TAB = null;
      // belt + braces: clear any stuck drop indicator
      const panes = document.getElementById("panes");
      if (panes) panes.classList.remove("drop-left", "drop-right");
    });
  });
}

// Set which section a given pane displays. paneN = 1 (left) or 2 (right).
// Setting pane 2 opens the split if it isn't already open. Only the pane(s)
// actually affected re-render — the unrelated pane keeps its editor state.
function selectTab(t, paneN) {
  if (!visibleNoteTabs().includes(t)) return;
  const prev = paneN === 2 ? S.tab2 : S.tab1;
  if (paneN === 2) S.tab2 = t;
  else S.tab1 = t;
  paintTabBar();
  // always reconcile pane DOM: opens / closes the split, OR syncs the
  // pane-2 label when it's just a section swap inside an existing split.
  ensurePaneDOM();
  if (prev === t) return; // same section selected → no content re-render
  renderPaneInto(paneN);
  // if the OTHER pane is showing the same tab, refresh it so the read-only
  // preview matches the freshly edited section.
  const other = paneN === 1 ? 2 : 1;
  const otherTab = other === 1 ? S.tab1 : S.tab2;
  if (otherTab === t) renderPaneInto(other);
}

function closeSplit() {
  destroyMDE(2);
  S.tab2 = null;
  paintTabBar();
  ensurePaneDOM();
  // pane 1 may have been a read-only preview because pane 2 owned the
  // EasyMDE for the same tab — refresh it so it picks the editor back up.
  renderPaneInto(1);
}

// Tear down the EasyMDE instance for a given pane (if any). Idempotent.
function destroyMDE(paneN) {
  const key = paneN === 2 ? "mde2" : "mde1";
  if (S[key]) {
    try {
      S[key].toTextArea();
    } catch (e) {}
    S[key] = null;
  }
}

// Reconcile the .panes DOM with S.tab2 (null = single pane, non-null = split).
// Only touches the SECOND pane-col — pane 1 always exists and we never tear
// it down here, so its EasyMDE state survives a split toggle.
function ensurePaneDOM() {
  const panes = document.getElementById("panes");
  if (!panes) return;
  let p1 = panes.querySelector('.pane-col[data-p="1"]');
  if (!p1) {
    // first-time mount: create pane 1 as the sole child
    mount(
      panes,
      `<div class="pane-col" data-p="1"><div class="pane-body" id="paneBody1"></div></div>`,
    );
    p1 = panes.querySelector('.pane-col[data-p="1"]');
  }
  const have2 = !!panes.querySelector('.pane-col[data-p="2"]');
  const want2 = !!S.tab2;
  if (want2 && !have2) {
    // append pane 2 next to pane 1
    const frag = document.createDocumentFragment();
    const tmp = document.createElement("div");
    mount(
      tmp,
      `<div class="pane-col" data-p="2">
         <div class="pane-head"><span class="pane-name">${esc(S.tab2)}</span>
           <button class="pane-x" type="button" aria-label="Close split">×</button>
         </div>
         <div class="pane-body" id="paneBody2"></div>
       </div>`,
    );
    while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    panes.appendChild(frag);
    const x = panes.querySelector('.pane-col[data-p="2"] .pane-x');
    if (x) x.onclick = closeSplit;
  } else if (!want2 && have2) {
    panes.querySelector('.pane-col[data-p="2"]').remove();
  } else if (want2 && have2) {
    // keep DOM, just sync the displayed name
    const n = panes.querySelector('.pane-col[data-p="2"] .pane-name');
    if (n) n.textContent = S.tab2;
  }
}

// Module-level state for tab drags. `DRAGGING_TAB` is the only reliable way
// to know what's mid-drag — custom MIME types in dataTransfer.types vary
// across browsers, and `getData` during dragover is blocked for privacy.
let DRAGGING_TAB = null;

// Drag a tab over .panes → highlight the half it will drop into. Drop →
// route to selectTab(tab, 1|2). Dropping on the right half opens (or targets)
// pane 2; dropping on the left half targets pane 1.
function wirePanesDnD() {
  const panes = document.getElementById("panes");
  if (!panes) return;
  const sideFor = (e) => {
    const r = panes.getBoundingClientRect();
    return e.clientX - r.left > r.width / 2 ? "right" : "left";
  };
  const clearDropClasses = () => panes.classList.remove("drop-right", "drop-left");
  panes.addEventListener("dragenter", (e) => {
    if (!DRAGGING_TAB) return;
    e.preventDefault();
  });
  panes.addEventListener("dragover", (e) => {
    if (!DRAGGING_TAB) return;
    // preventDefault is REQUIRED on dragover for `drop` to fire later.
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const side = sideFor(e);
    panes.classList.toggle("drop-right", side === "right");
    panes.classList.toggle("drop-left", side === "left");
  });
  panes.addEventListener("dragleave", (e) => {
    // only clear when the cursor leaves .panes entirely (not into a child)
    if (!panes.contains(e.relatedTarget)) clearDropClasses();
  });
  panes.addEventListener("drop", (e) => {
    e.preventDefault();
    const tab = DRAGGING_TAB;
    clearDropClasses();
    if (!tab) return;
    selectTab(tab, sideFor(e) === "right" ? 2 : 1);
  });
}

// ---------- Brief / Debrief panels (bracket the tabbed editor) ----------
const collapsed = (key, def = false) => {
  const v = localStorage.getItem("confnote-" + key);
  return v === null ? def : v === "1";
};
const setCollapsed = (key, v) => localStorage.setItem("confnote-" + key, v ? "1" : "0");

// shared chrome: a collapsible card with a header; body filled by `fill(bodyEl)`
function buildPanel(host, opts, fill) {
  if (!host) return;
  const isCol = collapsed(opts.key, opts.defaultCollapsed);
  mount(
    host,
    `<div class="sidepanel${isCol ? " collapsed" : ""}">
    <button class="sp-head" type="button">
      <span class="sp-caret">▾</span>
      <span class="sp-title">${esc(opts.title)}</span>
      <span class="sp-sub">${esc(opts.sub || "")}</span>
    </button>
    <div class="sp-body"></div>
  </div>`,
  );
  const sec = host.querySelector(".sidepanel");
  const head = host.querySelector(".sp-head");
  const body = host.querySelector(".sp-body");
  head.onclick = () => {
    const now = !sec.classList.contains("collapsed");
    sec.classList.toggle("collapsed", now);
    setCollapsed(opts.key, now);
  };
  fill(body);
}

function renderBrief() {
  const host = document.getElementById("briefPanel");
  buildPanel(
    host,
    { key: "brief-collapsed", title: "Brief", sub: "before the talk", defaultCollapsed: true },
    (body) => {
      const ta = document.createElement("textarea");
      ta.className = "sp-ta";
      ta.spellcheck = true;
      ta.placeholder = "What do you want out of this talk? Questions to ask, things to watch for…";
      ta.value = S.note.sections["Brief"] || "";
      ta.addEventListener("input", () => {
        S.note.sections["Brief"] = ta.value;
        markDirty("Brief");
      });
      ta.addEventListener("blur", flush);
      body.replaceChildren(ta);
    },
  );
}

// Debrief = free text + action lines. Two modes: list (parsed) / raw (textarea).
function renderDebrief() {
  const host = document.getElementById("debriefPanel");
  if (!host) return;
  const open = parseActions(S.note.sections["Debrief"]).filter((a) => !a.done).length;
  buildPanel(
    host,
    {
      key: "debrief-collapsed",
      title: "Debrief",
      sub: "after the talk" + (open ? ` · ${open} open` : ""),
      defaultCollapsed: true,
    },
    (body) => fillDebrief(body),
  );
}

function fillDebrief(body) {
  const raw = S.debriefRaw === true;
  const src = S.note.sections["Debrief"] || "";
  const actions = parseActions(src);

  const bar = document.createElement("div");
  bar.className = "sp-modebar";
  const mkBtn = (label, on) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sp-mode" + (on ? " on" : "");
    b.textContent = label;
    return b;
  };
  const listBtn = mkBtn("List", !raw);
  const rawBtn = mkBtn("Raw", raw);
  listBtn.onclick = () => {
    S.debriefRaw = false;
    fillDebrief(body);
  };
  rawBtn.onclick = () => {
    S.debriefRaw = true;
    fillDebrief(body);
  };
  bar.append(listBtn, rawBtn);

  body.replaceChildren(bar);

  if (raw) {
    const ta = document.createElement("textarea");
    ta.className = "sp-ta";
    ta.spellcheck = true;
    ta.placeholder = "Takeaways, follow-ups…  Action items:  - [ ] thing to do";
    ta.value = src;
    ta.addEventListener("input", () => {
      S.note.sections["Debrief"] = ta.value;
      markDirty("Debrief");
    });
    ta.addEventListener("blur", flush);
    body.append(ta);
    return;
  }

  // free-text portion (everything that is not an action line) rendered read-only
  const actionIdx = new Set(actions.map((a) => a.idx));
  const prose = src
    .replace(/\r/g, "")
    .split("\n")
    .filter((_, i) => !actionIdx.has(i))
    .join("\n")
    .trim();
  if (prose) {
    const md = document.createElement("div");
    md.className = "md sp-prose";
    mount(md, mdToHtml(prose, S.slug));
    body.append(md);
  }

  const list = document.createElement("ul");
  list.className = "actionlist";
  if (!actions.length) {
    const e = document.createElement("li");
    e.className = "act-empty";
    e.textContent = "No action items yet — add one below.";
    list.append(e);
  }
  actions.forEach((a) => list.append(actionRow(a, () => fillDebrief(body))));
  body.append(list);

  const add = document.createElement("div");
  add.className = "act-add";
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "act-input";
  inp.placeholder = "Add an action…  (Enter)";
  const go = () => {
    const v = inp.value.trim();
    if (!v) return;
    S.note.sections["Debrief"] = appendActionLine(S.note.sections["Debrief"] || "", v);
    inp.value = "";
    markDirty("Debrief");
    saveNow();
    fillDebrief(body);
    refreshDebriefSub();
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      go();
    }
  });
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "act-go";
  addBtn.textContent = "Add";
  addBtn.onclick = go;
  add.append(inp, addBtn);
  body.append(add);
}

// one checkbox row; flips its source line, saves optimistically, then re-renders
function actionRow(a, rerender) {
  const li = document.createElement("li");
  li.className = "act" + (a.done ? " done" : "");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "act-cb";
  cb.checked = a.done;
  const span = document.createElement("span");
  span.className = "act-txt";
  span.textContent = a.text;
  cb.addEventListener("change", () => {
    li.classList.toggle("done", cb.checked); // optimistic
    S.note.sections["Debrief"] = toggleActionLine(S.note.sections["Debrief"] || "", a.idx);
    markDirty("Debrief");
    saveNow();
    refreshDebriefSub();
    if (rerender) rerender();
  });
  const lbl = document.createElement("label");
  lbl.className = "act-lbl";
  lbl.append(cb, span);
  li.append(lbl);
  return li;
}

// keep the "· N open" header subtitle in sync without a full rebuild
function refreshDebriefSub() {
  const sub = document.querySelector("#debriefPanel .sp-sub");
  if (!sub) return;
  const open = parseActions(S.note.sections["Debrief"]).filter((a) => !a.done).length;
  sub.textContent = "after the talk" + (open ? ` · ${open} open` : "");
}

// ---------- Actions tab (the dedicated task list — human + AI add here) ----------
function actionRowOn(a, sectionKey, rerender) {
  const li = document.createElement("li");
  li.className = "act" + (a.done ? " done" : "");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "act-cb";
  cb.checked = a.done;
  cb.disabled = PUBLIC_DEMO;
  const span = document.createElement("span");
  span.className = "act-txt";
  span.textContent = a.text;
  cb.addEventListener("change", () => {
    if (PUBLIC_DEMO) return;
    li.classList.toggle("done", cb.checked);
    S.note.sections[sectionKey] = toggleActionLine(S.note.sections[sectionKey] || "", a.idx);
    markDirty(sectionKey);
    saveNow();
    if (rerender) rerender();
  });
  const lbl = document.createElement("label");
  lbl.className = "act-lbl";
  lbl.append(cb, span);
  li.append(lbl);
  return li;
}

function renderActionsTab(wrap) {
  mount(wrap, '<div class="pane act-pane"></div>');
  const body = wrap.querySelector(".act-pane");
  const render = () => {
    body.replaceChildren();
    const src = S.note.sections["Actions"] || "";
    const actions = parseActions(src);
    const bar = document.createElement("div");
    bar.className = "sp-modebar";
    const mk = (label, on, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sp-mode" + (on ? " on" : "");
      b.textContent = label;
      b.onclick = onClick;
      return b;
    };
    bar.append(
      mk("List", !S.actionsRaw, () => {
        S.actionsRaw = false;
        render();
      }),
      mk("Raw", !!S.actionsRaw, () => {
        S.actionsRaw = true;
        render();
      }),
    );
    body.append(bar);
    if (S.actionsRaw) {
      const ta = document.createElement("textarea");
      ta.className = "sp-ta";
      ta.spellcheck = true;
      ta.placeholder = "Actions — `- [ ] task` lines (human or AI add here)";
      ta.value = src;
      ta.addEventListener("input", () => {
        S.note.sections["Actions"] = ta.value;
        markDirty("Actions");
      });
      ta.addEventListener("blur", flush);
      body.append(ta);
      return;
    }
    // prose between actions, read-only
    const idx = new Set(actions.map((a) => a.idx));
    const prose = src
      .replace(/\r/g, "")
      .split("\n")
      .filter((_, i) => !idx.has(i))
      .join("\n")
      .trim();
    if (prose) {
      const md = document.createElement("div");
      md.className = "md sp-prose";
      mount(md, mdToHtml(prose, S.slug));
      body.append(md);
    }
    const list = document.createElement("ul");
    list.className = "actionlist";
    if (!actions.length) {
      const e = document.createElement("li");
      e.className = "act-empty";
      e.textContent = PUBLIC_DEMO
        ? "No public actions captured."
        : "No actions yet — add one below.";
      list.append(e);
    }
    actions.forEach((a) => list.append(actionRowOn(a, "Actions", render)));
    body.append(list);
    if (PUBLIC_DEMO) return;
    const add = document.createElement("div");
    add.className = "act-add";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.className = "act-input";
    inp.placeholder = "Add an action…  (Enter)";
    const go = () => {
      const v = inp.value.trim();
      if (!v) return;
      S.note.sections["Actions"] = appendActionLine(S.note.sections["Actions"] || "", v);
      inp.value = "";
      markDirty("Actions");
      saveNow();
      render();
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        go();
      }
    });
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "act-go";
    btn.textContent = "Add";
    btn.onclick = go;
    add.append(inp, btn);
    body.append(add);
  };
  render();
}

// ---------- Links & Files tab (files + URLs auto-extracted from all text) ----------
// ---------- private commentary (client-side encrypted, agent-invisible) ----------
// The passphrase and derived key live ONLY in this tab and in memory. Plaintext
// never leaves the browser: we PUT only AES-GCM ciphertext, and the server
// strips the Private section from everything the agent reads. Key derivation is
// PBKDF2-SHA256; the server stores salt + iterations + a verifier so a later
// session can re-derive and confirm the passphrase. Forgetting it is, by
// design, unrecoverable.
const ENC_PREFIX = "confnote-enc:v1:";
const PRIV_VERIFIER = "confnote-private-verifier-v1";
const PRIV_ITERATIONS = 200000;
const _te = new TextEncoder();
const _td = new TextDecoder();
function _b64e(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function _b64d(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
async function _privDeriveKey(passphrase, saltBytes, iterations) {
  const base = await crypto.subtle.importKey("raw", _te.encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function _aesEnc(key, plaintext) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, _te.encode(plaintext));
  return { iv: _b64e(iv), ct: _b64e(ct) };
}
async function _aesDec(key, iv, ct) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: _b64d(iv) }, key, _b64d(ct));
  return _td.decode(pt);
}
async function privEncrypt(key, plaintext) {
  return ENC_PREFIX + _b64e(_te.encode(JSON.stringify(await _aesEnc(key, plaintext))));
}
async function privDecrypt(key, blob) {
  const { iv, ct } = JSON.parse(_td.decode(_b64d(blob.slice(ENC_PREFIX.length))));
  return _aesDec(key, iv, ct);
}
async function privMeta(force) {
  if (!force && S.privMeta) return S.privMeta;
  S.privMeta = await api("/api/private");
  return S.privMeta;
}
function privLock() {
  S.privKey = null; // drop the in-memory key; re-render any open Private pane
  if (S.tab1 === PRIVATE) renderPaneInto(1);
  if (S.tab2 === PRIVATE) renderPaneInto(2);
}
window.addEventListener("beforeunload", privLock); // auto-lock on app close
async function savePrivate(plaintext) {
  if (!S.privKey || !S.note) return;
  const blob = plaintext.trim() ? await privEncrypt(S.privKey, plaintext) : "";
  S.note.sections[PRIVATE] = blob;
  await api(`/api/note?slug=${S.slug}&file=${S.file}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sections: { Private: blob } }),
  });
  syncCurrentNoteMarker();
  setStatus("private saved ✓ " + new Date().toLocaleTimeString(), "saved");
}
// Small DOM helpers (createElement, so handlers survive the mount sanitizer).
function _pel(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function _pinput(placeholder) {
  const e = document.createElement("input");
  e.type = "password";
  e.className = "priv-input";
  e.placeholder = placeholder;
  e.autocomplete = "off";
  return e;
}
function renderPrivate(wrap) {
  if (PUBLIC_DEMO) {
    mount(
      wrap,
      '<div class="pane priv-pane"><div class="priv-box"><div class="priv-title">Private notes are not included in the public demo.</div></div></div>',
    );
    return;
  }
  mount(wrap, `<div class="pane priv-pane"><div class="priv-host"></div></div>`);
  privRenderInto(wrap.querySelector(".priv-host"));
}
async function privRenderInto(host) {
  if (!host) return;
  host.replaceChildren(_pel("div", "priv-loading", "…"));
  let meta;
  try {
    meta = await privMeta();
  } catch (e) {
    host.replaceChildren(_pel("div", "priv-err", "Couldn't reach the private store."));
    return;
  }
  host.replaceChildren();
  if (!meta.configured) return privRenderSetup(host);
  if (!S.privKey) return privRenderUnlock(host);
  return privRenderEditor(host);
}
function privRenderSetup(host) {
  const box = _pel("div", "priv-box");
  box.append(_pel("div", "priv-title", "🔒 Set a private passphrase"));
  box.append(
    _pel(
      "div",
      "priv-warn",
      "Encrypts your Private section on this device. The passphrase is never stored and never sent to the AI. If you forget it, private notes are permanently unrecoverable.",
    ),
  );
  const p1 = _pinput("Passphrase");
  const p2 = _pinput("Confirm passphrase");
  const err = _pel("div", "priv-err");
  const btn = _pel("button", "priv-btn", "Set passphrase");
  btn.type = "button";
  btn.addEventListener("click", async () => {
    err.textContent = "";
    if (p1.value.length < 6) {
      err.textContent = "Use at least 6 characters.";
      return;
    }
    if (p1.value !== p2.value) {
      err.textContent = "Passphrases don't match.";
      return;
    }
    btn.disabled = true;
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await _privDeriveKey(p1.value, salt, PRIV_ITERATIONS);
      const v = await _aesEnc(key, PRIV_VERIFIER);
      await api("/api/private/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          v: 1,
          salt: _b64e(salt),
          iterations: PRIV_ITERATIONS,
          kdf: "PBKDF2-SHA256",
          verifier_iv: v.iv,
          verifier_ct: v.ct,
        }),
      });
      S.privKey = key;
      S.privMeta = null;
      privRenderInto(host);
    } catch (e) {
      err.textContent = "Could not set passphrase: " + e;
      btn.disabled = false;
    }
  });
  box.append(p1, p2, err, btn);
  host.append(box);
}
function privRenderUnlock(host) {
  const box = _pel("div", "priv-box");
  box.append(_pel("div", "priv-title", "🔒 Private — locked"));
  box.append(_pel("div", "priv-warn", "Enter your passphrase to read or edit private notes."));
  const p = _pinput("Passphrase");
  const err = _pel("div", "priv-err");
  const btn = _pel("button", "priv-btn", "Unlock");
  btn.type = "button";
  const tryUnlock = async () => {
    err.textContent = "";
    btn.disabled = true;
    try {
      const meta = await privMeta();
      const params = meta.params || {};
      const key = await _privDeriveKey(p.value, _b64d(params.salt), params.iterations);
      const ok = (await _aesDec(key, params.verifier_iv, params.verifier_ct)) === PRIV_VERIFIER;
      if (!ok) throw new Error("bad");
      S.privKey = key;
      privRenderInto(host);
    } catch (e) {
      err.textContent = "Wrong passphrase.";
      btn.disabled = false;
      p.value = "";
      p.focus();
    }
  };
  btn.addEventListener("click", tryUnlock);
  p.addEventListener("keydown", (e) => {
    if (e.key === "Enter") tryUnlock();
  });
  box.append(p, err, btn);
  host.append(box);
}
async function privRenderEditor(host) {
  let plaintext = "";
  const blob = S.note.sections[PRIVATE] || "";
  if (blob.startsWith(ENC_PREFIX)) {
    try {
      plaintext = await privDecrypt(S.privKey, blob);
    } catch (e) {
      host.replaceChildren();
      const box = _pel("div", "priv-box");
      box.append(_pel("div", "priv-err", "Could not decrypt this note with the current key."));
      const lock = _pel("button", "priv-btn", "Lock");
      lock.type = "button";
      lock.addEventListener("click", privLock);
      box.append(lock);
      host.append(box);
      return;
    }
  }
  host.replaceChildren();
  const bar = _pel("div", "priv-bar");
  bar.append(_pel("span", "priv-badge", "🔓 Private — only you can read this"));
  const lock = _pel("button", "priv-lock-btn", "Lock");
  lock.type = "button";
  lock.addEventListener("click", privLock);
  bar.append(lock);
  const ta = document.createElement("textarea");
  ta.className = "priv-ta";
  ta.spellcheck = true;
  ta.placeholder = "Private notes — encrypted on this device, never seen by the AI…";
  ta.value = plaintext;
  let t = null;
  ta.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => savePrivate(ta.value), 800);
  });
  ta.addEventListener("blur", () => {
    clearTimeout(t);
    savePrivate(ta.value);
  });
  host.append(bar, ta);
}

function renderLinksFiles(wrap) {
  mount(
    wrap,
    `<div class="pane lf-pane">
      <div class="lf-section">
        <div class="lf-h">Files</div>
        <div class="lf-files"></div>
      </div>
      <div class="lf-section">
        <div class="lf-h">Links</div>
        <div class="lf-links"></div>
      </div>
    </div>`,
  );
  // scope to this pane so the two split panes can both show Links & Files
  renderGallery(wrap.querySelector(".lf-files"));
  // aggregate URLs across every section's text
  const urlRe = /\bhttps?:\/\/[^\s)>\]"']+/g;
  const seen = new Set();
  const chips = [];
  for (const sec of Object.values(S.note.sections || {})) {
    const m = (sec || "").match(urlRe) || [];
    for (const u of m) {
      const clean = u.replace(/[.,;:!?]+$/, "");
      if (!seen.has(clean)) {
        seen.add(clean);
        chips.push(clean);
      }
    }
  }
  const links = wrap.querySelector(".lf-links");
  if (!chips.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No links yet — any URL in your notes will appear here.";
    links.append(e);
    return;
  }
  for (const url of chips) {
    const a = document.createElement("a");
    a.className = "lf-chip";
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    let host = url;
    try {
      host = new URL(url).host.replace(/^www\./, "");
    } catch (e) {}
    const ic = document.createElement("img");
    ic.className = "lf-fav";
    ic.alt = "";
    ic.src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`;
    const t = document.createElement("span");
    t.className = "lf-host";
    t.textContent = host;
    const u2 = document.createElement("span");
    u2.className = "lf-url";
    u2.textContent = url.replace(/^https?:\/\//, "");
    a.append(ic, t, u2);
    links.append(a);
  }
}

// sanitized markdown -> HTML string (no innerHTML; reuses the allowlist)
function mdString(src) {
  const d = document.createElement("div");
  mount(d, mdToHtml(src, S.slug));
  return new XMLSerializer().serializeToString(d);
}

// Render the section assigned to pane N (1 or 2) into its .pane-body.
// Tears down any prior EasyMDE in that pane first. If both panes show the
// same editable section, only pane 1 hosts an EasyMDE — pane 2 falls back
// to a read-only markdown preview to avoid two editors fighting for one
// section's text.
function renderPaneInto(paneN) {
  destroyMDE(paneN);
  const wrap = document.getElementById("paneBody" + paneN);
  if (!wrap) return;
  const t = paneN === 2 ? S.tab2 : S.tab1;
  if (!t) return;
  if (t === "Actions") {
    renderActionsTab(wrap);
    return;
  }
  if (t === LINKSFILES) {
    renderLinksFiles(wrap);
    return;
  }
  if (t === PRIVATE) {
    renderPrivate(wrap);
    return;
  }
  if (t === "Transcript" && transcriptLocked()) {
    renderLockedTranscript(wrap, paneN);
    return;
  }
  const val = S.note.sections[t] || "";
  // read-only sections (AI-driven) + the "same editable tab in both panes"
  // case both render as a plain markdown preview.
  const duplicateEditable = paneN === 2 && EDITABLE[t] && S.tab1 === t;
  if ((PUBLIC_DEMO && !BROWSER_EDITABLE[t]) || READONLY[t] || duplicateEditable) {
    mount(wrap, `<div class="pane"><div class="md">${mdToHtml(val, S.slug)}</div></div>`);
    return;
  }
  // editable: mount EasyMDE (or a plain textarea if the bundle didn't load)
  const taId = "ta-" + paneN;
  if (window.EasyMDE) {
    // The Transcript tab gets a recording / audio-drop toolbar above the editor.
    const tbar = t === "Transcript" ? `<div class="transcribe-bar" id="tbar${paneN}"></div>` : "";
    mount(wrap, `<div class="pane mde-pane">${tbar}<textarea id="${taId}"></textarea></div>`);
    const ta = document.getElementById(taId);
    ta.value = val;
    const mde = new EasyMDE({
      element: ta,
      autoDownloadFontAwesome: false,
      spellChecker: false,
      status: false,
      minHeight: "220px",
      maxHeight: "calc(100vh - 360px)",
      placeholder: PUBLIC_DEMO ? "Your notes, saved in this browser…" : `${t}…`,
      previewRender: (plain) => mdString(plain),
      uploadImage: !PUBLIC_DEMO,
      imageUploadFunction: (file, onSuccess, onError) => {
        uploadImage(file)
          .then((r) => onSuccess(r.markdown.slice(4, -1)))
          .catch((e) => onError(String(e)));
      },
      toolbar: [
        "bold",
        "italic",
        "heading",
        "|",
        "quote",
        "unordered-list",
        "ordered-list",
        "|",
        "link",
        "image",
        "code",
        "|",
        "preview",
        "side-by-side",
        "guide",
      ],
    });
    S["mde" + paneN] = mde;
    mde.codemirror.on("change", () => {
      S.note.sections[t] = mde.value();
      markDirty(t);
      // mirror live edits to the other pane if it's showing the same section
      // as a read-only preview (the duplicate-editable case above).
      const other = paneN === 1 ? 2 : 1;
      const otherTab = other === 1 ? S.tab1 : S.tab2;
      if (otherTab === t && !S["mde" + other]) renderPaneInto(other);
    });
    mde.codemirror.on("blur", flush);
    if (t === "Transcript") wireTranscribe(paneN, mde);
    return;
  }
  // fallback: plain textarea + Edit/Preview toggle (EasyMDE bundle absent)
  mount(
    wrap,
    `
    <div class="toolbar">
      <button data-m="edit" class="on">Edit</button>
      <button data-m="prev">Preview</button>
      <span class="hint">paste or drop an image to attach</span>
    </div>
    <div class="pane">
      <textarea id="${taId}" spellcheck="true">${esc(val)}</textarea>
      <div class="md" id="pv-${paneN}" style="display:none"></div>
    </div>`,
  );
  const ta = document.getElementById(taId),
    pv = document.getElementById("pv-" + paneN);
  const btns = wrap.querySelectorAll(".toolbar button");
  btns[0].onclick = () => {
    ta.style.display = "";
    pv.style.display = "none";
    btns[0].classList.add("on");
    btns[1].classList.remove("on");
  };
  btns[1].onclick = () => {
    mount(pv, mdToHtml(ta.value, S.slug));
    pv.style.display = "";
    ta.style.display = "none";
    btns[1].classList.add("on");
    btns[0].classList.remove("on");
  };
  ta.addEventListener("input", () => {
    S.note.sections[t] = ta.value;
    markDirty(t);
  });
  ta.addEventListener("blur", flush);
  ta.addEventListener("paste", (e) => handleImage(e, ta, e.clipboardData));
  ta.addEventListener("dragover", (e) => e.preventDefault());
  ta.addEventListener("drop", (e) => {
    e.preventDefault();
    handleImage(e, ta, e.dataTransfer);
  });
}

// ---------- Transcript tab: record / drop-audio → transcribe ----------
// Local (AI Cat) does app-owned recording + file transcription; remote
// (OpenAI) is file-only. Availability is probed so controls disable
// gracefully when the provider isn't reachable (Cat not installed, etc.).
const AUDIO_RE = /\.(m4a|mp3|wav|aiff?|caf|ogg|oga|webm|flac|mp4)$/i;
const REC_TICK_MS = 500;

// One recording at a time, app-wide. It lives outside the Transcript pane
// because switching tabs or notes re-renders the pane: the new pane
// re-attaches to the running take instead of orphaning it, and the audio
// lands in the note it was started in. `view` is the latest bar's UI.
const REC = {
  recorder: null,
  stream: null,
  chunks: [],
  t0: 0,
  target: null,
  timer: null,
  view: null,
};

// Hosted site (musa, 2026-11-11): conferences may not like recording and
// transcription, so the Transcript tab is locked there. No recording, no audio
// file, no transcription call; an info button explains why, and a transcript
// can be pasted by hand. The Cat also sets webMode but is not the hosted site,
// and the Mac app never sets it: both keep the recording toolbar.
function transcriptLocked() {
  return Boolean(window.confnote?.webMode && !window.confnote?.catMode);
}

function renderLockedTranscript(wrap, paneN) {
  const copy = window.confnote.browserTranscription;
  const target = { slug: S.slug, file: S.file };
  const pane = document.createElement("div");
  pane.className = "pane tx-locked-pane";

  const bar = document.createElement("div");
  bar.className = "transcribe-bar tx-locked";
  const label = document.createElement("span");
  label.className = "tx-lock-label";
  label.textContent = "🔒 Transcription is locked on the web";
  // Info button: the round "?"-link look Settings uses for its hints.
  const infoBtn = document.createElement("button");
  infoBtn.type = "button";
  infoBtn.className = "set-help-link tx-info";
  infoBtn.textContent = "i";
  infoBtn.title = "Why is transcription locked?";
  infoBtn.setAttribute("aria-label", "Why is transcription locked?");
  infoBtn.setAttribute("aria-expanded", "false");
  const pop = document.createElement("div");
  pop.className = "tx-info-pop";
  pop.id = `txInfo${paneN}`;
  pop.setAttribute("role", "note");
  pop.hidden = true;
  if (copy) pop.append(...copy.infoNodes());
  infoBtn.setAttribute("aria-controls", pop.id);
  const status = document.createElement("span");
  status.className = "tx-status";
  bar.append(label, infoBtn, status, pop);

  // the popover closes on a second click, Escape, or a click elsewhere
  const setPop = (open) => {
    pop.hidden = !open;
    infoBtn.setAttribute("aria-expanded", String(open));
  };
  infoBtn.onclick = (e) => {
    e.stopPropagation();
    setPop(pop.hidden);
  };
  const onDocClick = (e) => {
    if (!bar.isConnected) {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
      return;
    }
    if (!pop.hidden && !pop.contains(e.target)) setPop(false);
  };
  const onKey = (e) => {
    if (e.key === "Escape" && !pop.hidden) setPop(false);
  };
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onKey);

  const body = document.createElement("div");
  body.className = "md tx-locked-body";
  const paint = () => {
    const val = S.note.sections.Transcript || "";
    if (val.trim()) mount(body, mdToHtml(val, S.slug));
    else mount(body, '<div class="empty">No transcript yet.</div>');
  };
  paint();
  pane.append(bar);

  // Paste a transcript: the text joins `## Transcript` through the note API.
  if (!PUBLIC_DEMO) {
    const pasteBtn = document.createElement("button");
    pasteBtn.type = "button";
    pasteBtn.className = "tx-paste";
    pasteBtn.textContent = "Paste a transcript";
    bar.insertBefore(pasteBtn, status);
    const box = document.createElement("div");
    box.className = "tx-paste-box";
    box.hidden = true;
    const ta = document.createElement("textarea");
    ta.className = "tx-paste-input";
    ta.rows = 8;
    ta.placeholder = "Paste the transcript text here";
    ta.setAttribute("aria-label", "Transcript text");
    const actions = document.createElement("div");
    actions.className = "tx-paste-actions";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "tx-paste-save";
    saveBtn.textContent = "Save to transcript";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "tx-paste-cancel";
    cancelBtn.textContent = "Cancel";
    actions.append(saveBtn, cancelBtn);
    box.append(ta, actions);
    pane.append(box);

    const setStatusText = (msg, cls) => {
      status.textContent = msg || "";
      status.className = "tx-status" + (cls ? " " + cls : "");
    };
    pasteBtn.onclick = () => {
      box.hidden = false;
      ta.focus();
    };
    cancelBtn.onclick = () => {
      ta.value = "";
      box.hidden = true;
    };
    saveBtn.onclick = async () => {
      const text = ta.value.trim();
      if (!text) {
        setStatusText("paste some text first", "warn");
        return;
      }
      saveBtn.disabled = true;
      setStatusText("saving…");
      try {
        await appendTranscriptSection(target, text);
        const sameNote = () => S.slug === target.slug && S.file === target.file;
        const fresh = sameNote()
          ? await api(
              `/api/note?slug=${encodeURIComponent(target.slug)}&file=${encodeURIComponent(target.file)}`,
            )
          : null;
        // checked again after the read: the user may have opened another note meanwhile
        if (fresh && sameNote()) {
          S.note.sections.Transcript = fresh.sections.Transcript || "";
          syncCurrentNoteMarker();
          const other = paneN === 1 ? 2 : 1;
          if ((other === 1 ? S.tab1 : S.tab2) === "Transcript") renderPaneInto(other);
        }
        ta.value = "";
        box.hidden = true;
        paint();
        setStatusText("added ✓", "ok");
      } catch (e) {
        setStatusText(`failed: ${e.message || e}`, "err");
      } finally {
        saveBtn.disabled = false;
      }
    };
  }
  pane.append(body);
  wrap.replaceChildren(pane);
}

// Append text to a note's Transcript through the note API, the way server.py
// append_transcript does on the Mac: a blank line between takes, never
// replacing what is there. The PUT carries the note's mtime, so a write that
// raced it is re-read and appended again.
const TRANSCRIPT_APPEND_TRIES = 3;
async function appendTranscriptSection(target, text) {
  // a pending Transcript edit in this tab lands first, so the append keeps it
  if (S.slug === target.slug && S.file === target.file) await saveNow();
  const url = `/api/note?slug=${encodeURIComponent(target.slug)}&file=${encodeURIComponent(target.file)}`;
  for (let i = 0; i < TRANSCRIPT_APPEND_TRIES; i++) {
    const note = await api(url);
    const existing = (note.sections.Transcript || "").trimEnd();
    const body = existing ? `${existing}\n\n${text}`.trim() : text;
    const r = await fetch(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sections: { Transcript: body }, mtime: note.mtime }),
    });
    if (r.ok) return;
    if (r.status !== 409) throw new Error(`could not save the transcript (HTTP ${r.status})`);
  }
  throw new Error("could not save the transcript: the note kept changing");
}

async function wireTranscribe(paneN, mde) {
  const bar = document.getElementById("tbar" + paneN);
  if (!bar) return;
  mount(
    bar,
    `<button class="tx-rec" type="button" disabled>● Record</button>
     <button class="tx-file" type="button">⤓ Audio file</button>
     <input class="tx-input" type="file" accept="audio/*" hidden>
     <span class="tx-status"></span>`,
  );
  const recBtn = bar.querySelector(".tx-rec");
  const fileBtn = bar.querySelector(".tx-file");
  const input = bar.querySelector(".tx-input");
  // set in JS — mount() strips both attrs, and a visible input shows a stray "Choose File" in the toolbar
  if (input) {
    input.accept = "audio/*";
    input.hidden = true;
  }
  const setS = (msg, cls) => {
    const s = bar.querySelector(".tx-status");
    s.textContent = msg || "";
    s.className = "tx-status" + (cls ? " " + cls : "");
  };
  // raw fetch so the server's {error} detail surfaces (api() drops the body)
  const post = async (path, body) => {
    const r = await fetch(path, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    return d;
  };
  const here = { slug: S.slug, file: S.file };
  const qs = (target) =>
    `slug=${encodeURIComponent(target.slug)}&file=${encodeURIComponent(target.file)}`;

  // pull the Transcript section from disk into the editor after a write
  async function refreshFromDisk() {
    try {
      const fresh = await api(`/api/note?slug=${S.slug}&file=${S.file}`);
      const v = fresh.sections.Transcript || "";
      S.note.sections.Transcript = v;
      mde.value(v);
    } catch (e) {}
  }

  // availability → enable/disable controls. Recording is now in-app
  // (MediaRecorder) + transcribed via the provider, so Record + file are
  // both enabled whenever the provider can transcribe — no Cat-only gate.
  // A web build (webMode: the hosted site, which shows the locked tab instead,
  // and the Cat) never uploads audio, whatever the status says.
  const webBuild = Boolean(window.confnote?.webMode);
  try {
    const st = await api("/api/transcription/status");
    if (!st.available || webBuild) {
      setS(st.detail || "transcription unavailable", "warn");
      recBtn.disabled = true;
      fileBtn.disabled = true;
    } else {
      setS("ready · " + st.provider);
      recBtn.disabled = false;
      fileBtn.disabled = false;
    }
  } catch (e) {
    setS("transcription offline", "warn");
    recBtn.disabled = true;
    fileBtn.disabled = true;
  }

  async function sendToServer(file, target) {
    const data = await new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.readAsDataURL(file);
    });
    return post(`/api/transcription/file?${qs(target)}`, {
      filename: file.name,
      mime: file.type || "application/octet-stream",
      data,
    });
  }
  async function sendFile(file, target = { slug: S.slug, file: S.file }) {
    if (!file) return;
    if (webBuild) {
      setS("transcription is not available here", "warn");
      return;
    }
    setS(`transcribing ${file.name}…`);
    try {
      const r = await sendToServer(file, target);
      if (S.slug === target.slug && S.file === target.file) await refreshFromDisk();
      setS(r.text ? "added ✓" : r.note || "no text", r.text ? "ok" : "warn");
    } catch (e) {
      setS(`failed: ${e.message || e}`, "err");
    }
  }
  fileBtn.onclick = () => input.click();
  input.onchange = () => {
    sendFile(input.files[0]);
    input.value = "";
  };

  // record toggle — in-app capture via the browser's MediaRecorder, then
  // the recorded audio goes through the same file path as a drop/upload, so
  // it works for BOTH providers (local Cat AND remote OpenAI).
  function pickExt(type) {
    if (type.includes("webm")) return "webm";
    if (type.includes("ogg")) return "ogg";
    if (type.includes("wav")) return "wav";
    if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
    return "m4a"; // WebKit MediaRecorder emits mp4/aac
  }
  function showRecording() {
    recBtn.textContent = "■ Stop";
    recBtn.classList.add("recording");
    recBtn.disabled = false;
  }
  REC.view = {
    paint: () => {
      const elsewhere = REC.target.slug !== here.slug || REC.target.file !== here.file;
      const secs = Math.floor((Date.now() - REC.t0) / 1000);
      setS(`recording ${secs}s${elsewhere ? " · in another session" : ""}`, "rec");
    },
    idle: () => {
      recBtn.textContent = "● Record";
      recBtn.classList.remove("recording");
    },
    send: sendFile,
  };
  if (REC.recorder) {
    showRecording();
    REC.view.paint();
  }
  recBtn.onclick = async () => {
    if (REC.recorder) {
      if (REC.recorder.state === "recording") REC.recorder.stop(); // → onstop does the rest
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setS("recording not supported here — use Audio file", "warn");
      return;
    }
    try {
      REC.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setS("mic blocked — allow microphone access (or use Audio file)", "err");
      return;
    }
    REC.chunks = [];
    REC.target = { slug: S.slug, file: S.file };
    const recorder = new MediaRecorder(REC.stream);
    REC.recorder = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) REC.chunks.push(e.data);
    };
    recorder.onstop = async () => {
      clearInterval(REC.timer);
      REC.stream.getTracks().forEach((t) => t.stop());
      const type = recorder.mimeType || "audio/mp4";
      const blob = new Blob(REC.chunks, { type });
      const { target, view } = REC;
      Object.assign(REC, { recorder: null, stream: null, chunks: [], target: null, timer: null });
      view.idle();
      const file = new File([blob], `recording-${Date.now()}.${pickExt(type)}`, { type });
      await view.send(file, target);
    };
    recorder.start();
    REC.t0 = Date.now();
    showRecording();
    REC.timer = setInterval(() => REC.view.paint(), REC_TICK_MS);
  };

  // drag-drop an audio file ANYWHERE on the transcript pane (toolbar +
  // editor). We listen in the CAPTURE phase so we intercept before
  // CodeMirror/EasyMDE's own drop handling swallows the event, and
  // stopPropagation so it never reaches the editor (which would otherwise
  // try to drop the file as text / do nothing).
  const pane = bar.closest(".mde-pane");
  if (pane) {
    const hasFile = (e) => [...(e.dataTransfer?.items || [])].some((x) => x.kind === "file");
    const onOver = (e) => {
      if (!hasFile(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      pane.classList.add("tx-drop");
    };
    pane.addEventListener("dragenter", onOver, true);
    pane.addEventListener("dragover", onOver, true);
    pane.addEventListener(
      "dragleave",
      (e) => {
        if (e.target === pane) pane.classList.remove("tx-drop");
      },
      true,
    );
    pane.addEventListener(
      "drop",
      (e) => {
        if (!hasFile(e)) return;
        e.preventDefault();
        e.stopPropagation();
        pane.classList.remove("tx-drop");
        const f = [...(e.dataTransfer?.files || [])].find(
          (x) => (x.type && x.type.startsWith("audio/")) || AUDIO_RE.test(x.name),
        );
        if (f) sendFile(f);
        else setS("that's not an audio file", "warn");
      },
      true,
    );
  }
}

// folder-driven: everything dumped in notes/assets/<talk>/ — manual or via the app
async function renderGallery(wrap) {
  mount(wrap, '<div class="pane"><div class="empty">loading files…</div></div>');
  let data;
  try {
    data = await api(`/api/files?slug=${S.slug}&file=${S.file}`);
  } catch (e) {
    mount(wrap, '<div class="pane"><div class="empty">could not read folder</div></div>');
    return;
  }
  const drop = `<div class="gdrop" id="gdrop">⬇ drop images here, or dump files straight into <code>${esc(data.dir)}</code></div>`;
  if (!data.files.length) {
    mount(
      wrap,
      `<div class="pane">${drop}<div class="empty">No files yet for this talk.</div></div>`,
    );
  } else {
    const cells = data.files
      .map((f) =>
        f.is_image
          ? `<figure class="gcell"><a href="${f.url}" target="_blank" rel="noopener"><img src="${f.url}" alt="${esc(f.name)}"></a>
           <figcaption><span>${esc(f.name)}</span><button class="gins" data-rel="${esc(f.rel)}" data-img="1">insert</button></figcaption></figure>`
          : `<figure class="gcell file"><a href="${f.url}" target="_blank" rel="noopener"><div class="fic">${esc(f.name.split(".").pop().toUpperCase())}</div></a>
           <figcaption><span>${esc(f.name)}</span><button class="gins" data-rel="${esc(f.rel)}">link</button></figcaption></figure>`,
      )
      .join("");
    mount(
      wrap,
      `<div class="pane">${drop}
      <div class="ginfo">${data.files.length} file(s) in <code>${esc(data.dir)}</code> · <button id="grefresh" class="gbtn">refresh</button></div>
      <div class="gallery">${cells}</div></div>`,
    );
  }
  const rf = document.getElementById("grefresh");
  if (rf) rf.onclick = () => renderGallery(wrap);
  wrap.querySelectorAll(".gins").forEach(
    (b) =>
      (b.onclick = () => {
        const rel = b.dataset.rel;
        const md = b.dataset.img ? `\n![](${rel})\n` : `\n- [${rel.split("/").pop()}](${rel})\n`;
        // Files land in Human notes too: the old "Links" section has no tab
        // since Links & Files replaced it, so a link written there was invisible.
        const dest = "Human notes";
        S.note.sections[dest] = (S.note.sections[dest] || "") + md;
        markDirty(dest);
        saveNow();
        selectTab(dest, 1);
      }),
  );
  const gd = document.getElementById("gdrop");
  if (gd) {
    gd.addEventListener("dragover", (e) => {
      e.preventDefault();
      gd.classList.add("over");
    });
    gd.addEventListener("dragleave", () => gd.classList.remove("over"));
    gd.addEventListener("drop", async (e) => {
      e.preventDefault();
      gd.classList.remove("over");
      const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
      for (const file of files) await uploadImage(file);
      renderGallery(wrap);
    });
  }
}

// ---------- browser notes (public demo) ----------
async function saveBrowserNote() {
  if (!S.dirty || !S.note || !S.file) return;
  clearTimeout(S.saveTimer);
  const sections = {};
  for (const k of Object.keys(BROWSER_EDITABLE)) sections[k] = S.note.sections[k] || "";
  try {
    await BROWSER_NOTES.put(S.slug, S.file, sections);
    S.dirty = false;
    setStatus("saved in this browser ✓ " + new Date().toLocaleTimeString(), "saved");
    refreshBrowserNotesBanner();
  } catch (_e) {
    setStatus("could not save in this browser", "saving");
  }
}

async function downloadBrowserNotes(slug, thenOpenApp) {
  try {
    const bundle = await BROWSER_NOTES.exportBundle(slug, S.conf?.events || []);
    BROWSER_NOTES.download(bundle, `${slug}.confnote`);
    if (thenOpenApp) window.open(DOWNLOAD_PAGE, "_blank", "noopener");
  } catch (_e) {
    setStatus("download failed, try again", "saving");
  }
}

// The honest warning: shown on a conference whenever this browser holds notes for it.
async function refreshBrowserNotesBanner() {
  if (!BROWSER_NOTES) return;
  const slug = S.slug;
  const mine = slug ? await BROWSER_NOTES.list(slug).catch(() => []) : [];
  const count = mine.filter((r) =>
    Object.values(r.sections || {}).some((text) => (text || "").trim()),
  ).length;
  let banner = document.getElementById("browserNotesBanner");
  if (!count || slug !== S.slug) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "browserNotesBanner";
    banner.className = "browser-notes-banner";
    banner.setAttribute("role", "status");
    document.body.append(banner);
  }
  banner.replaceChildren();
  const text = document.createElement("p");
  const strong = document.createElement("strong");
  strong.textContent = `${count} ${count === 1 ? "note" : "notes"} in this browser. `;
  text.append(
    strong,
    "Your notes are saved only in this browser. Clearing site data deletes them. " +
      "Download them or open them in the confnote app to keep them.",
  );
  const download = document.createElement("button");
  download.type = "button";
  download.className = "primary";
  download.textContent = "Download notes";
  download.onclick = () => downloadBrowserNotes(slug, false);
  const open = document.createElement("button");
  open.type = "button";
  open.textContent = "Open in confnote app";
  open.title = "Downloads the notes file and opens the Mac app download page";
  open.onclick = () => downloadBrowserNotes(slug, true);
  banner.append(text, download, open);
}

// ---------- save ----------
// `section` names the note section the edit touched; the conf-doc editor
// passes none.
function markDirty(section) {
  if (PUBLIC_DEMO && !BROWSER_NOTES) return;
  if (section) S.dirtySections.add(section);
  S.dirty = true;
  setStatus("editing…");
  syncCurrentNoteMarker();
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveNow, 800);
}
async function saveNow() {
  if (BROWSER_NOTES) return saveBrowserNote();
  if (PUBLIC_DEMO) return;
  if (!S.dirty) return;
  if (S.confDoc) return saveConfDocNow();
  if (!S.note) return;
  clearTimeout(S.saveTimer);
  if (S.savePromise) {
    // one PUT at a time, so an older write never lands after a newer one
    await S.savePromise;
    return saveNow();
  }
  S.savePromise = saveNoteSections();
  try {
    await S.savePromise;
  } finally {
    S.savePromise = null;
  }
}
async function saveNoteSections() {
  const note = S.note;
  const target = `/api/note?slug=${S.slug}&file=${S.file}`;
  // Only the sections edited here: another writer (agent, importer,
  // transcription) may have changed the rest on disk since this note loaded.
  const sections = {};
  for (const k of S.dirtySections) sections[k] = note.sections[k] || "";
  if (!Object.keys(sections).length) {
    S.dirty = false;
    return;
  }
  setStatus("saving…", "saving");
  S.saveSeq++;
  try {
    const r = await api(target, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sections }),
    });
    if (note !== S.note) return; // navigated away; the next note's state is its own
    // A section edited again while the PUT was in flight stays dirty.
    for (const [k, sent] of Object.entries(sections)) {
      if ((S.note.sections[k] || "") === sent) S.dirtySections.delete(k);
    }
    // The server mirrors inline URLs from Human notes into Links on save; adopt
    // the returned Links so opening the Links tab shows them immediately (no
    // reload). Skip if Links is the active editor to avoid clobbering a live edit.
    if (
      typeof r.links === "string" &&
      r.links !== S.note.sections.Links &&
      !isSectionEditing("Links")
    ) {
      S.note.sections.Links = r.links;
    }
    syncCurrentNoteMarker();
    S.dirty = S.dirtySections.size > 0;
    if (S.dirty) {
      clearTimeout(S.saveTimer);
      S.saveTimer = setTimeout(saveNow, 800);
    } else {
      setStatus("saved ✓ " + new Date().toLocaleTimeString(), "saved");
    }
  } catch (e) {
    setStatus("save failed — retrying", "saving");
    S.saveTimer = setTimeout(saveNow, 2000);
  } finally {
    S.saveSeq++;
  }
}

// Poll the open note and adopt every section another writer changed on disk,
// except ones with unsaved edits here or an editor that has focus. Compares
// content rather than mtime: a skipped section is picked up on a later poll,
// and our own save's mtime never hides someone else's change.
async function refreshNoteFromDisk() {
  if (!S.slug || !S.file || !S.note) return;
  const note = S.note;
  const seq = S.saveSeq;
  try {
    const fresh = await api(`/api/note?slug=${S.slug}&file=${S.file}`);
    // a save started or finished meanwhile: this read may predate it
    if (note !== S.note || seq !== S.saveSeq || S.savePromise) return;
    const changed = new Set();
    const names = new Set([...Object.keys(READONLY), ...Object.keys(fresh.sections)]);
    for (const k of names) {
      if (k === PRIVATE || S.dirtySections.has(k) || sectionHasFocus(k)) continue;
      if (sameSectionText(S.note.sections[k], fresh.sections[k])) continue;
      S.note.sections[k] = fresh.sections[k];
      changed.add(k);
    }
    if (!changed.size) return;
    // only re-render a pane if it's showing a section that changed; Links &
    // Files lists URLs from every section
    for (const n of [1, 2]) {
      const t = n === 2 ? S.tab2 : S.tab1;
      if (!t || paneHasFocus(n)) continue;
      if (t === LINKSFILES || changed.has(t)) renderPaneInto(n);
    }
  } catch (e) {}
}
// The server stores sections without leading/trailing newlines; a local copy
// that only differs there is not a change from another writer.
function sameSectionText(a, b) {
  const trim = (s) => (s || "").replace(/^\n+|\n+$/g, "");
  return trim(a) === trim(b);
}
// The note section a pane shows (the Links & Files tab shows `Links`).
function paneSection(paneN) {
  const t = paneN === 2 ? S.tab2 : S.tab1;
  return t === LINKSFILES ? "Links" : t;
}
function paneHasFocus(paneN) {
  const body = document.getElementById("paneBody" + paneN);
  return Boolean(body && body.contains(document.activeElement));
}
function sectionHasFocus(name) {
  const active = document.activeElement;
  return [1, 2].some((n) => {
    const body = document.getElementById("paneBody" + n);
    return paneSection(n) === name && body && body.contains(active);
  });
}
// Save the inline Brief/Debrief doc. Raw fetch (not api()) so we can handle a
// 409 mtime conflict — e.g. the agent regenerated the doc under the editor —
// by reloading the server's copy instead of overwriting it.
async function saveConfDocNow() {
  if (PUBLIC_DEMO) return;
  if (!S.confDoc) return;
  clearTimeout(S.saveTimer);
  setStatus("saving…", "saving");
  const text = S.confMde
    ? S.confMde.value()
    : document.getElementById("confDocTa")?.value || S.confDoc.text || "";
  try {
    const r = await fetch(
      `/api/conf-doc?slug=${encodeURIComponent(S.slug)}&name=${encodeURIComponent(S.confDoc.name)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, mtime: S.confDoc.mtime }),
      },
    );
    const d = await r.json();
    if (r.status === 409) {
      S.confDoc.mtime = d.mtime;
      S.confDoc.text = d.text || "";
      if (S.confMde) S.confMde.value(d.text || "");
      S.dirty = false;
      setStatus("reloaded — changed elsewhere", "saved");
      if (window.confnote?.showToast) {
        window.confnote.showToast({
          title: "Reloaded",
          body: "This doc was changed elsewhere; loaded the latest version.",
          kind: "warn",
        });
      }
      return;
    }
    S.confDoc.mtime = d.mtime;
    S.confDoc.text = text;
    S.dirty = false;
    setStatus("saved ✓ " + new Date().toLocaleTimeString(), "saved");
  } catch (e) {
    setStatus("save failed — retrying", "saving");
    S.saveTimer = setTimeout(saveNow, 2000);
  }
}

// Edits typed while a save is in flight stay dirty, so drain them before the
// caller moves on (bounded: a failing server must not spin this forever).
const FLUSH_MAX_SAVES = 3;
async function flush() {
  for (let i = 0; i < FLUSH_MAX_SAVES && S.dirty; i++) await saveNow();
}

// ---------- image attach ----------
async function uploadImage(file) {
  if (PUBLIC_DEMO) throw new Error("Public demo is read-only.");
  setStatus("uploading image…", "saving");
  const data = await new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(file);
  });
  const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
  const r = await api(`/api/asset?slug=${S.slug}&file=${S.file}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: `shot-${Date.now()}.${ext}`, data }),
  });
  setStatus("uploaded ✓", "saved");
  return r;
}
async function handleImage(e, ta, dt) {
  const cand =
    [...(dt?.items || [])].find((x) => x.type && x.type.startsWith("image/")) ||
    [...(dt?.files || [])].find((x) => x.type && x.type.startsWith("image/"));
  const file = cand?.getAsFile ? cand.getAsFile() : cand;
  if (!file) return;
  e.preventDefault();
  const r = await uploadImage(file);
  const p = ta.selectionStart;
  ta.value = ta.value.slice(0, p) + `\n${r.markdown}\n` + ta.value.slice(p);
  // attribute the paste to whichever pane the textarea lives in
  const paneEl = ta.closest(".pane-col");
  const tab = paneEl && paneEl.dataset.p === "2" ? S.tab2 : S.tab1;
  if (tab) S.note.sections[tab] = ta.value;
  markDirty(tab);
}

// ---------- chat surfaces (deep-chat → command-gated agents) ----------
// Two surfaces share one B&W theme + one NDJSON handler:
//   • Concierge  — conference-wide, toggled from the top bar, persists across
//     views, follows whichever conference is in scope.
//   • Session chat — an isolated in-pane tab per session/file.
// Built with createElement (NOT the mount() sanitizer) because they host the
// trusted <deep-chat> custom element, which an allowlist would strip.

// Apply the shared monochrome boxy theme to a <deep-chat> element.
function themeDeepChat(dc, placeholder) {
  dc.style.cssText = "width:100%;height:100%;border:none;background-color:var(--panel)";
  // Links inside chat bubbles render in deep-chat's shadow DOM, out of reach
  // of our global CSS — inject link styling here. CSS custom properties DO
  // inherit across the shadow boundary, so var(--link) resolves to the theme.
  dc.auxiliaryStyle = `
    a, a:link, a:visited {
      color: var(--link, #a78bfa);
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    a:hover { text-decoration-thickness: 2px; }
    /* Pending image attachments: deep-chat defaults to a grey bar + a white
       tile behind each thumbnail, both jarring on the dark theme. Re-skin to
       match the panel — transparent strip, themed tile, themed remove button.
       (CSS vars inherit across the shadow boundary, so these resolve.) */
    #file-attachment-container {
      background-color: transparent !important;
      padding: 6px 0 2px 0 !important;
      margin: 0 !important;
    }
    .file-attachment {
      background-color: var(--bg) !important;
      border: 1px solid var(--line) !important;
      border-radius: 4px !important;
      overflow: hidden;
    }
    .image-attachment { border-radius: 3px !important; object-fit: cover; }
    .remove-file-attachment-button {
      background-color: var(--panel) !important;
      border: 1px solid var(--line) !important;
      color: var(--ink) !important;
    }
    .remove-file-attachment-button:hover {
      background-color: var(--accent-soft) !important;
    }
    .remove-file-attachment-button .x-icon { color: var(--ink) !important; }
    /* failed-turn message with an inline retry button (see runChatStream) */
    .cn-err {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      color: var(--ink);
    }
    .cn-retry,
    .cn-demo {
      font: inherit;
      color: var(--ink);
      background: var(--bg);
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 3px 10px;
      cursor: pointer;
    }
    .cn-retry:hover { background: var(--accent-soft); border-color: var(--ink); }
    /* Messages and the composer carry their own 16px inset (the Concierge drawer body has none), so
       they line up with the drawer header and the context line. */
    #messages { padding: 8px 16px 4px; box-sizing: border-box; }
    .inner-message-container { width: 100%; }
    #input { padding: 0 16px 14px; box-sizing: border-box; }
    /* Attach and send sit on the composer's last line, so they stay put as a long message grows. */
    .input-button.inside-start,
    .input-button.inside-end {
      top: auto !important;
      bottom: 6px !important;
    }
    .ai-message-text p { margin: 0 0 8px; }
    .ai-message-text p:last-child { margin-bottom: 0; }
    .ai-message-text code {
      font-family: var(--mono);
      font-size: 12.5px;
      background: var(--accent-soft);
      border: 1px solid var(--line);
      border-radius: var(--r1);
      padding: 0 4px;
    }
    /* Tool steps arrive as one-line quotes (see conciergeNotice) and show as chips: what the Concierge
       did, in the app's mono label style, with a live dot. */
    .ai-message-text blockquote {
      display: flex;
      align-items: center;
      gap: 7px;
      width: fit-content;
      max-width: 100%;
      box-sizing: border-box;
      margin: 6px 0;
      padding: 3px 10px 3px 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--muted);
      font: 500 11.5px/1.4 var(--mono);
    }
    .ai-message-text blockquote::before {
      content: "";
      flex: none;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--live);
    }
    .ai-message-text blockquote p { margin: 0; }
  `;
  // The Concierge reads as a calm document: its replies are plain text on the panel, the person's turns
  // are soft blocks on the right, both on the app's tokens in light and dark.
  dc.messageStyles = {
    default: {
      shared: {
        bubble: {
          fontSize: "14px",
          lineHeight: "1.55",
          borderRadius: "var(--r2)",
          padding: "8px 12px",
          marginTop: "12px",
        },
      },
      user: {
        bubble: {
          maxWidth: "85%",
          backgroundColor: "var(--accent-soft)",
          color: "var(--ink)",
          border: "1px solid var(--line)",
        },
      },
      ai: {
        bubble: {
          maxWidth: "100%",
          padding: "2px 0",
          backgroundColor: "transparent",
          color: "var(--ink)",
        },
      },
    },
    loading: {
      message: {
        styles: {
          bubble: { backgroundColor: "transparent", padding: "8px 0" },
        },
      },
    },
  };
  dc.textInput = {
    placeholder: { text: placeholder, style: { color: "var(--faint)" } },
    styles: {
      text: { color: "var(--ink)", fontSize: "14px", padding: "10px 44px 10px 40px" },
      container: {
        width: "100%",
        boxSizing: "border-box",
        backgroundColor: "var(--bg)",
        border: "1px solid var(--line)",
        borderRadius: "var(--r2)",
        boxShadow: "none",
        margin: "0",
      },
      focus: { border: "1px solid var(--ink)" },
    },
  };
  dc.submitButtonStyles = {
    position: "inside-end",
    submit: {
      container: { default: { backgroundColor: "transparent" } },
      svg: { styles: { default: { filter: "grayscale(1) opacity(0.7)" } } },
    },
  };
  // Inline images — adds the attach button and enables paste / drag of images
  // into the chat. deep-chat hands each image to our handler as a base64 data
  // URL in body.messages[i].files; runChatStream forwards those verbatim and
  // chat.py turns the latest turn's images into model content blocks. `true`
  // already means image-only (vs. `mixedFiles`); cap the count so a stray
  // multi-select can't balloon a single turn past the model's image budget.
  // The attach button sits inside the composer, left of the text, so it never spills past the edge.
  dc.images = {
    files: { acceptedFormats: "image/*", maxNumberOfFiles: 4 },
    button: { position: "inside-start" },
  };
  // Wire the ↻ Retry button rendered inside a failed-turn message (see fail()
  // in runChatStream). htmlClassUtilities is deep-chat's sanctioned hook for
  // event handlers on html-message content.
  dc.htmlClassUtilities = {
    "cn-retry": {
      events: { click: () => retryLastConcierge() },
      styles: { default: { cursor: "pointer" } },
    },
    "cn-demo": {
      events: { click: () => tryDemoConference() },
      styles: { default: { cursor: "pointer" } },
    },
  };
}

const SLASH_COMMANDS = [
  { name: "brief", usage: "/brief", desc: "Draft or refresh the conference brief." },
  { name: "debrief", usage: "/debrief", desc: "Draft or refresh the conference debrief." },
  { name: "action", usage: "/action", desc: "Add a checkbox action to this session." },
];

function findDeepInput(root) {
  if (!root) return null;
  const direct = root.querySelector?.(
    "textarea, input[type='text'], input:not([type]), [contenteditable='true']",
  );
  if (direct) return direct;
  const all = root.querySelectorAll ? [...root.querySelectorAll("*")] : [];
  for (const el of all) {
    const found = findDeepInput(el.shadowRoot);
    if (found) return found;
  }
  return null;
}

function inputText(input) {
  if (!input) return "";
  if (input.isContentEditable) return input.textContent || "";
  return input.value || "";
}

function inputCursor(input) {
  if (!input) return 0;
  if (typeof input.selectionStart === "number") return input.selectionStart;
  return inputText(input).length;
}

function slashToken(input) {
  const text = inputText(input);
  const cursor = inputCursor(input);
  const before = text.slice(0, cursor);
  const match = before.match(/(^|\s)\/([^\s/]*)$/);
  if (!match) return null;
  const query = match[2].toLowerCase();
  return {
    text,
    query,
    start: before.length - query.length - 1,
    end: cursor,
  };
}

function setInputText(input, text, cursor) {
  if (input.isContentEditable) {
    input.textContent = text;
    const range = document.createRange();
    const textNode = input.firstChild;
    if (textNode) {
      range.setStart(textNode, Math.min(cursor, text.length));
    } else {
      range.selectNodeContents(input);
    }
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    input.value = text;
    if (typeof input.setSelectionRange === "function") input.setSelectionRange(cursor, cursor);
  }
  input.dispatchEvent(
    new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText" }),
  );
}

function installSlashPicker(dc, host) {
  if (!dc || !host) return;
  if (dc._slashPickerController) dc._slashPickerController.abort();
  const controller = new AbortController();
  dc._slashPickerController = controller;
  const { signal } = controller;
  host.classList.add("slash-host");

  const picker = document.createElement("div");
  picker.className = "slash-picker";
  picker.hidden = true;
  picker.setAttribute("role", "listbox");
  host.appendChild(picker);

  // `.kbd` (set while arrowing) suppresses the CSS hover highlight so only the
  // keyboard-selected option shows as active; real mouse movement clears it so
  // hover takes over again.
  picker.addEventListener("mousemove", () => picker.classList.remove("kbd"), { signal });

  let input = null;
  let active = 0;
  let matches = [];

  const resolveInput = () => {
    if (input?.isConnected) return input;
    input = findDeepInput(dc.shadowRoot) || findDeepInput(dc);
    return input;
  };

  const close = () => {
    picker.hidden = true;
    picker.replaceChildren();
    matches = [];
    active = 0;
  };

  const render = () => {
    if (!resolveInput()) return close();
    const token = slashToken(input);
    if (!token) return close();
    matches = SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(token.query));
    if (!matches.length) return close();
    if (active >= matches.length) active = 0;
    picker.replaceChildren();
    matches.forEach((cmd, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slash-opt" + (idx === active ? " on" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", idx === active ? "true" : "false");
      const name = document.createElement("span");
      name.className = "slash-cmd";
      name.textContent = cmd.usage;
      const desc = document.createElement("span");
      desc.className = "slash-desc";
      desc.textContent = cmd.desc;
      btn.append(name, desc);
      btn.onmousedown = (e) => {
        e.preventDefault();
        apply(cmd);
      };
      // Hovering moves the selection to this option (and exits keyboard mode),
      // so mouse and keyboard share one active item rather than highlighting two.
      btn.onmousemove = () => {
        picker.classList.remove("kbd");
        if (active === idx) return;
        active = idx;
        setActive();
      };
      picker.appendChild(btn);
    });
    // render() only ever fires from keyboard input (typing/keyup), so default
    // to keyboard mode — the cursor merely resting over an option won't add a
    // second highlight until the mouse actually moves.
    picker.classList.add("kbd");
    picker.hidden = false;
  };

  // Repaint the `.on`/aria-selected state on the existing option buttons
  // without rebuilding them (used by arrow nav + hover).
  const setActive = () => {
    Array.from(picker.children).forEach((btn, i) => {
      const on = i === active;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
  };

  const apply = (cmd) => {
    if (!resolveInput()) return close();
    const token = slashToken(input);
    if (!token) return close();
    const replacement = cmd.usage + " ";
    const next = token.text.slice(0, token.start) + replacement + token.text.slice(token.end);
    setInputText(input, next, token.start + replacement.length);
    close();
    input.focus();
  };

  const handleKeydown = (e) => {
    if (picker.hidden) return;
    if (e.key === "Escape") {
      close();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      active = (active + delta + matches.length) % matches.length;
      picker.classList.add("kbd"); // suppress hover highlight until the mouse moves
      setActive();
      return;
    }
    if ((e.key === "Enter" || e.key === "Tab") && matches[active]) {
      e.preventDefault();
      apply(matches[active]);
    }
  };

  dc.addEventListener("input", render, { signal, capture: true });
  dc.addEventListener("keyup", render, { signal, capture: true });
  dc.addEventListener("focusout", () => setTimeout(close, 120), { signal });
  dc.addEventListener("keydown", handleKeydown, { signal, capture: true });

  const bind = () => {
    input = resolveInput();
    if (!input) return false;
    input.addEventListener("input", render, { signal });
    input.addEventListener("keyup", render, { signal });
    input.addEventListener("blur", () => setTimeout(close, 120), { signal });
    input.addEventListener("keydown", handleKeydown, { signal });
    return true;
  };

  if (bind()) return;
  const timer = setInterval(() => {
    if (bind()) clearInterval(timer);
  }, 50);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
  setTimeout(() => clearInterval(timer), 5000);
}

// Serialize chat runs across BOTH surfaces (concierge + session chat).
// deep-chat invokes the handler on every submit, so a message sent while a
// reply is still streaming would fire a SECOND concurrent /api/chat request
// that races the first server-side (same JSONL + resume id) → one stream
// errors ("Error, please try again.") while the other carries on. Instead we
// run one stream at a time and queue any submit that arrives mid-flight,
// flushing the queue when the active run closes.
let chatRunActive = false;
const chatRunQueue = [];

const IMAGE_EXT_MEDIA = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

// Read an image File/Blob into the {src,type,name} descriptor the server +
// chat.py expect (a base64 data URL). deep-chat's blob sometimes arrives
// without a MIME type, so a non-image data URL is repaired from the filename
// extension; anything we can't resolve to an image resolves to null and is
// dropped by the caller.
function fileToImageDescriptor(file) {
  return new Promise((resolve) => {
    if (!file) {
      resolve(null);
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      let src = String(r.result);
      if (!/^data:image\//.test(src)) {
        const ext = (file.name || "").split(".").pop().toLowerCase();
        const media = IMAGE_EXT_MEDIA[ext];
        const comma = src.indexOf(",");
        const b64 = comma >= 0 ? src.slice(comma + 1) : "";
        if (!media || !b64) {
          resolve(null);
          return;
        }
        src = `data:${media};base64,${b64}`;
      }
      resolve({ src, type: "image", name: file.name || "" });
    };
    r.onerror = () => resolve(null);
    r.readAsDataURL(file);
  });
}

// Normalise deep-chat's handler `body` into the JSON message array the server
// expects. Text-only turns arrive as {messages:[…]}; turns with attachments
// arrive as multipart FormData (`message<N>` JSON parts + raw `files` blobs).
// For the FormData case we read each image blob to base64 and attach it to the
// latest turn — the one the user just sent.
async function buildChatMessages(body) {
  const tidy = (m) => {
    const out = { role: m.role || "user", text: m.text || "" };
    if (Array.isArray(m.files) && m.files.length) out.files = m.files;
    return out;
  };
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const messages = [];
    for (const [key, value] of body.entries()) {
      if (key.startsWith("message") && typeof value === "string") {
        try {
          messages.push(JSON.parse(value));
        } catch (e) {}
      }
    }
    const images = (await Promise.all(body.getAll("files").map(fileToImageDescriptor))).filter(
      Boolean,
    );
    if (images.length) {
      if (!messages.length) messages.push({ role: "user", text: "" });
      const last = messages[messages.length - 1];
      last.files = (last.files || []).concat(images);
    }
    return messages.map(tidy);
  }
  return ((body && body.messages) || []).map(tidy);
}

// Run a single NDJSON stream to completion, then drain the queue. The agent
// may write notes server-side; on every {"notice"} we ping the readonly poll
// so Summary / Research / AI notes refresh without the user leaving the chat.
function runChatStream(url, body, deepChatSignals) {
  // deep-chat's onResponse is async and its onClose is not, so a last reply line and the end of the stream
  // that arrive in one read would close the message before the text lands (an import's "Imported …" reply
  // vanished that way). A close waits for every text sent before it, in whatever order they settle.
  let responses = Promise.resolve();
  const signals = {
    ...deepChatSignals,
    onResponse: (payload) => {
      const settled = Promise.resolve(deepChatSignals.onResponse(payload)).catch(() => {});
      responses = Promise.all([responses, settled]);
      return settled;
    },
    onClose: () => responses.then(() => deepChatSignals.onClose()),
  };
  chatRunActive = true;
  const ctrl = new AbortController();
  let stopped = false;
  let reader = null;
  let finished = false;
  // Release the lock + start the next queued run. Idempotent: every terminal
  // path calls it, but only the first call advances the queue.
  const finish = () => {
    if (finished) return;
    finished = true;
    chatRunActive = false;
    // Shells that meter the Concierge (the web account menu) refresh after each turn.
    window.dispatchEvent(new Event("confnote-concierge-turn"));
    const next = chatRunQueue.shift();
    if (next) runChatStream(next.url, next.body, next.signals);
  };
  // deep-chat shows a stop button while streaming; this halts it AND the
  // server agent: aborting the fetch closes the socket → the server's
  // write fails → chat.py BrokenPipe → the claude run is torn down.
  const stop = () => {
    stopped = true;
    try {
      ctrl.abort();
    } catch (e) {}
    try {
      if (reader) reader.cancel();
    } catch (e) {}
    try {
      signals.onClose();
    } catch (e) {}
    finish();
  };
  if (signals.stopClicked) signals.stopClicked.listener = stop;

  let opened = false;
  let gotText = false; // any text streamed → past the point a retry is safe
  const open1 = () => {
    if (!opened) {
      opened = true;
      signals.onOpen();
    }
  };
  // Surface a final, non-recoverable error. On the Concierge surface we end the
  // stream and append a themed message with a CLICKABLE ↻ Retry (deep-chat html
  // message + htmlClassUtilities wire the button to retryLastConcierge). On the
  // session-chat surface (no .chat-inner host) we fall back to deep-chat's own
  // error pill.
  const fail = (msg) => {
    open1();
    const safe = String(msg == null ? "Something went wrong." : msg)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;");
    const dc = document.querySelector(".chat-inner deep-chat");
    if (dc && typeof dc.addMessage === "function") {
      finish();
      signals
        .onClose()
        .catch(() => {})
        .then(() =>
          dc.addMessage({
            role: "ai",
            html: `<div class="cn-err">⚠ ${safe}<button type="button" class="cn-retry">↻ Retry</button></div>`,
          }),
        );
    } else {
      signals.onResponse({ error: String(msg == null ? "Something went wrong." : msg) });
      finish();
    }
  };

  // Transient model/infra errors worth a silent retry (the 529 "overloaded"
  // the model throws under load, plus the usual rate-limit / gateway family).
  const TRANSIENT = /\b(429|500|502|503|504|529)\b|overload|rate.?limit|temporar|timeout/i;
  const MAX_RETRIES = 2;
  const BACKOFF = [700, 1800];
  const retryLater = (outMessages, n) => {
    if (stopped || finished || n >= MAX_RETRIES) return false;
    setTimeout(() => {
      if (!stopped && !finished) attempt(outMessages, n + 1);
    }, BACKOFF[n]);
    return true;
  };

  function attempt(outMessages, n) {
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: outMessages }),
      signal: ctrl.signal,
    })
      .then((r) => {
        open1();
        reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        const pump = () =>
          reader
            .read()
            .then(({ done, value }) => {
              if (stopped) return;
              if (done) {
                signals.onClose();
                finish();
                return;
              }
              buf += dec.decode(value, { stream: true });
              let nl;
              while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                let o;
                try {
                  o = JSON.parse(line);
                } catch (e) {
                  continue;
                }
                if (o.text) {
                  gotText = true;
                  signals.onResponse({ text: o.text });
                } else if (o.open_module) {
                  // The agent wants to drive a drawer module but its panel isn't
                  // open — open it ALONGSIDE the chat (additive) so the user
                  // watches it work, without closing the Concierge. The module
                  // id comes from the stream; core stays module-agnostic.
                  const d = window.confnote && window.confnote.drawer;
                  if (d && !d.isOpen(o.open_module)) d.toggle(o.open_module, true);
                } else if (o.notice) {
                  signals.onResponse({ text: conciergeNotice(o.notice) });
                  pollReadonlyNow(); // agent likely rewrote a readonly section
                } else if (o.conference_rescheduled) {
                  handleConferenceRescheduled(o.conference_rescheduled);
                } else if (o.conference_imported) {
                  handleConferenceImported(o.conference_imported);
                } else if (o.picks_changed) {
                  refreshPicks(o.picks_changed.slug);
                } else if (o.toast) {
                  // Slash-command completion (and anything else that
                  // wants a top-right confirmation). Doesn't interrupt
                  // the message stream — just surfaces a notification.
                  if (window.confnote && typeof window.confnote.showToast === "function") {
                    window.confnote.showToast(o.toast);
                  }
                  pollReadonlyNow(); // brief/debrief/action all wrote to disk
                } else if (o.error && o.status === 402) {
                  // Out of credits: a shell that sells credits renders its own card
                  // in the Concierge (it cancels the event); otherwise show the error.
                  const unhandled = window.dispatchEvent(
                    new CustomEvent("confnote-credits-required", { detail: o, cancelable: true }),
                  );
                  if (unhandled) {
                    fail(o.error);
                    return;
                  }
                  open1();
                  try {
                    signals.onClose();
                  } catch (e) {}
                  finish();
                  return;
                } else if (o.error) {
                  // Auto-retry transient overloads before any text has shown;
                  // once tokens are on screen we can't safely re-run.
                  if (!gotText && TRANSIENT.test(o.error) && retryLater(outMessages, n)) {
                    try {
                      reader.cancel();
                    } catch (e) {}
                    return; // drop this stream; ignore the trailing {done}
                  }
                  fail(o.error);
                  return;
                } else if (o.done) {
                  signals.onClose();
                  pollReadonlyNow();
                  finish();
                  return;
                }
              }
              pump();
            })
            .catch(() => {
              if (stopped) return;
              // Mid-stream socket drop: retry if nothing rendered yet.
              if (!gotText && retryLater(outMessages, n)) return;
              try {
                signals.onClose();
              } catch (e) {}
              finish();
            });
        pump();
      })
      .catch((e) => {
        if (stopped || (e && e.name === "AbortError")) {
          finish();
          return;
        }
        // fetch itself rejected (network) — transient, retry then give up.
        if (retryLater(outMessages, n)) return;
        fail(String(e));
      });
  }

  // deep-chat hands the handler one of two body shapes:
  //   - text-only turn  -> a plain object {messages:[{role,text}], ...}
  //   - turn with files -> multipart FormData: each text turn as a `message<N>`
  //     JSON part, and the raw image File blob(s) under the `files` field.
  // buildChatMessages normalises both to the JSON the server expects
  // ({messages:[{role,text,files:[{src:dataURL,...}]}]}), reading any File
  // blobs to base64 first. chat.py attaches only the latest turn's images.
  buildChatMessages(body).then((outMessages) => {
    // Remember the normalised request so the ↻ Retry button can re-send it
    // verbatim — crucially preserving any attached image the user can't re-pick.
    CONCIERGE.lastRequest = { url, messages: outMessages };
    if (!stopped) attempt(outMessages, 0);
  });
}

// A tool step ("Wrote BRIEF.md.") as its own one-line quote, which themeDeepChat shows as a chip. Markdown
// in the notice is escaped so a file name like my_note.md stays literal.
function conciergeNotice(notice) {
  const text = String(notice).replace(/[\\`*_[\]<>#|]/g, "\\$&");
  return `\n\n> ${text}\n\n`;
}

// Manual retry behind the ↻ Retry button on a failed concierge turn. Re-sends
// the stored request (image and all), collects the reply, and appends it as a
// fresh AI message via deep-chat's API.
// The agenda the demo video's Concierge imports (Beyond The Prompt's own published agenda file).
const DEMO_AGENDA_URL =
  "https://www.ag-grid.com/downloads/beyond-the-prompt/beyond-the-prompt-agenda.json";

// The greeting's demo button: signed out, the browser-only demo event; signed in, import the real agenda.
async function tryDemoConference() {
  if ((await knownSignedOut()) && typeof window.confnote.startDemoEvent === "function") {
    window.confnote.startDemoEvent();
    return;
  }
  const dc = document.querySelector(".chat-inner deep-chat");
  if (dc && typeof dc.submitUserMessage === "function")
    dc.submitUserMessage({ text: `Import this agenda: ${DEMO_AGENDA_URL}` });
}

async function retryLastConcierge() {
  const last = CONCIERGE.lastRequest;
  const dc = document.querySelector(".chat-inner deep-chat");
  if (!last || !dc || typeof dc.addMessage !== "function") return;
  try {
    const res = await fetch(last.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: last.messages }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch (e) {
          continue;
        }
        if (o.text) out += o.text;
        else if (o.notice) out += conciergeNotice(o.notice);
        else if (o.conference_rescheduled) handleConferenceRescheduled(o.conference_rescheduled);
        else if (o.conference_imported) handleConferenceImported(o.conference_imported);
        else if (o.picks_changed) refreshPicks(o.picks_changed.slug);
        else if (o.error) throw new Error(typeof o.error === "string" ? o.error : "error");
      }
    }
    if (out.trim()) dc.addMessage({ role: "ai", text: out });
    pollReadonlyNow();
  } catch (e) {
    dc.addMessage({ role: "ai", text: `Still failing — ${e.message || e}. Try again shortly.` });
  }
}

// deep-chat handler factory. If a run is already active, queue this submit
// (deep-chat keeps the pending reply bubble in its loading state) instead of
// starting a concurrent request; otherwise run it now.
function streamHandler(url) {
  return (body, signals) => {
    if (chatRunActive) {
      chatRunQueue.push({ url, body, signals });
      return;
    }
    runChatStream(url, body, signals);
  };
}

// Pull fresh readonly sections once (used after the agent acts; mirrors the
// 5s poll body in openSession so the Chat tab stays current).
// Live-refresh the ✔ Actions badge for the conference in scope. Cheap aggregate
// GET, debounced so a burst of agent notices (e.g. /brief researching every
// session) coalesces into one refresh. Event-driven — never polled.
let _actionCountTimer = null;
function refreshActionCount(slug) {
  if (!slug) return;
  clearTimeout(_actionCountTimer);
  _actionCountTimer = setTimeout(async () => {
    try {
      const d = await api(`/api/actions?slug=${encodeURIComponent(slug)}`);
      syncDebriefCount(slug, d.open || 0);
    } catch (e) {}
  }, 500);
}

async function pollReadonlyNow() {
  // The Actions badge can change with no note open (e.g. /debrief files items
  // while you're viewing the Brief), so refresh it whenever a conf is in scope.
  refreshActionCount(S.slug);
  await refreshNoteFromDisk();
}

// ---------- global concierge (top-bar toggle, conference-wide) ----------
const CONCIERGE = { built: false, scope: null };

// The conference in scope: the one being viewed, else today's / most recent.
async function conciergeScopeSlug() {
  if (S.slug) return S.slug;
  if (await knownSignedOut()) return null;
  try {
    const list = await api("/api/conferences");
    if (!list.length) return null;
    const today = todayISO();
    const sorted = [...list].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const todayConf = sorted.find((c) => (c.date || "") === today);
    if (todayConf) return todayConf.slug;
    const upcoming = sorted.find((c) => (c.date || "") >= today);
    return (upcoming || sorted[sorted.length - 1]).slug;
  } catch (e) {
    return null;
  }
}

function buildConcierge() {
  if (CONCIERGE.built) return;
  CONCIERGE.built = true;
  const btn = document.createElement("button"); // bottom-right launcher
  btn.id = "conciergeFab";
  btn.type = "button";
  btn.title = "Concierge — ask about this conference";
  btn.setAttribute("aria-label", "Toggle concierge chat");
  btn.textContent = "✦";
  document.body.append(btn);
  const pop = document.createElement("div");
  pop.id = "chatPop";
  pop.style.display = "none";
  const head = document.createElement("div");
  head.className = "chatHead";
  const title = document.createElement("span");
  title.className = "chatTitle";
  title.textContent = "Concierge";
  const x = document.createElement("button");
  x.className = "chatX";
  x.textContent = "✕";
  x.onclick = toggleConcierge;
  head.append(title, x);
  const cbody = document.createElement("div");
  cbody.className = "chatBody";
  pop.append(head, cbody);
  document.body.append(pop);
  btn.onclick = toggleConcierge;
  Object.assign(CONCIERGE, { btn, pop, title, body: cbody, dc: null });
}

function toggleConcierge() {
  buildConcierge();
  const show = CONCIERGE.pop.style.display === "none";
  CONCIERGE.pop.style.display = show ? "" : "none";
  CONCIERGE.btn?.classList.toggle("on", show);
  if (show) {
    // refresh the "Concierge · <talk>" chip every open to reflect current session
    if (CONCIERGE.title)
      CONCIERGE.title.textContent =
        S.file && S.note?.title ? `Concierge · ${S.note.title}` : "Concierge";
    if (!CONCIERGE.dc) mountConcierge(); // keep history across open/close
  }
}

// Re-point the concierge at the conference now in scope. Called on every
// route change; rebuilds the deep-chat only when the scope actually moves.
// If a drawer chat module has claimed the chat surface (chat.js calls
// window.confnote.fab.disable() during drawer bootstrap) we skip building
// the legacy FAB entirely — no double-surface, no flash. We wait briefly
// for drawer bootstrap so modules get a chance to register first.
async function refreshConcierge() {
  // Wait for drawer.js to finish loading its modules — but cap the wait
  // so a missing/late drawer never blocks the FAB indefinitely.
  if (window.confnote && window.confnote.drawer && window.confnote.drawer.ready) {
    await Promise.race([window.confnote.drawer.ready, new Promise((r) => setTimeout(r, 250))]);
  }
  if (window.confnote && window.confnote.fab && window.confnote.fab.suppressed) {
    CONCIERGE.scope = await conciergeScopeSlug();
    pushDrawerContext();
    return;
  }
  buildConcierge();
  const slug = await conciergeScopeSlug();
  pushDrawerContext();
  if (slug === CONCIERGE.scope) return;
  CONCIERGE.scope = slug;
  CONCIERGE.dc = null;
  if (CONCIERGE.pop.style.display !== "none") mountConcierge();
}

// Push the current scope to any drawer modules listening for context.
// Drawer modules (chat, Module 1, Module 2, etc.) read this on their
// render() call and via window.confnote.onContextChange.
function pushDrawerContext() {
  if (!window.confnote || typeof window.confnote.setContext !== "function") return;
  window.confnote.setContext({
    slug: S.slug || null,
    file: S.file || null,
    conf: S.conf || null,
    noteTitle: (S.note && S.note.title) || null,
  });
}

function conciergeNote(text) {
  const m = document.createElement("div");
  m.className = "chatMsg";
  m.textContent = text;
  CONCIERGE.body.replaceChildren(m);
}

async function mountConcierge() {
  if (!CONCIERGE.scope) CONCIERGE.scope = await conciergeScopeSlug();
  const slug = CONCIERGE.scope;
  if (!slug) return conciergeNote("No conference yet. Run the importer, then reload.");
  // chat availability tracks the Agent SDK; reuse S.conf when it's the scope
  const chatOk = S.conf && S.conf._slug === slug ? S.conf.chat : true;
  // "Concierge — Selected: <talk>" so the chat shows which talk you're on
  CONCIERGE.title.textContent =
    S.file && S.note?.title ? `Concierge · ${S.note.title}` : "Concierge";
  if (!customElements.get("deep-chat"))
    return conciergeNote("Chat component didn't load (offline first run?).");
  if (!chatOk)
    return conciergeNote(
      "Chat needs the Claude CLI. Install it: claude.ai/install.sh — then relaunch.",
    );
  const dc = document.createElement("deep-chat");
  themeDeepChat(dc, "Ask about this conference…");
  dc.connect = {
    stream: true,
    handler: (body, signals) => {
      const params = new URLSearchParams({ slug });
      window.confnote.agentQuery?.(params);
      return streamHandler(`/api/chat/global?${params}`)(body, signals);
    },
  };
  dc.introMessage = {
    text: "Concierge for this conference — ask about the agenda, speakers, rooms, breaks, or your notes across sessions.",
  };
  CONCIERGE.dc = dc;
  CONCIERGE.body.replaceChildren(dc);
  installSlashPicker(dc, CONCIERGE.body);
}

// ---------- per-session chat tab (isolated per session/file) ----------
const SESSIONCHAT = { dc: null, key: null };

function mountSessionChat(wrap) {
  mount(wrap, '<div class="pane chatpane"></div>');
  const host = wrap.querySelector(".chatpane");
  if (!S.conf?.chat) {
    const m = document.createElement("div");
    m.className = "chatMsg";
    m.textContent = "Chat needs the Claude CLI. Install it: claude.ai/install.sh — then relaunch.";
    host.replaceChildren(m);
    return;
  }
  if (!customElements.get("deep-chat")) {
    const m = document.createElement("div");
    m.className = "chatMsg";
    m.textContent = "Chat component didn't load (offline first run?).";
    host.replaceChildren(m);
    return;
  }
  const slug = S.slug,
    file = S.file;
  const key = slug + "|" + file;
  // fresh element whenever the session/file changes
  if (SESSIONCHAT.key !== key) {
    SESSIONCHAT.key = key;
    SESSIONCHAT.dc = null;
  }
  if (!SESSIONCHAT.dc) {
    const dc = document.createElement("deep-chat");
    themeDeepChat(dc, "Ask about this talk…");
    dc.connect = {
      stream: true,
      handler: (body, signals) => {
        const params = new URLSearchParams({ slug, file });
        window.confnote.agentQuery?.(params);
        return streamHandler(`/api/chat/session?${params}`)(body, signals);
      },
    };
    dc.introMessage = {
      text: `Ask about **${S.note?.title || "this talk"}** — I have the agenda, speakers and your notes, and can update the Summary / Research / AI notes if you ask.`,
    };
    SESSIONCHAT.dc = dc;
  }
  host.replaceChildren(SESSIONCHAT.dc);
  installSlashPicker(SESSIONCHAT.dc, host);
}

route();

// ---------- drawer-module integration hooks ----------------------------
// The drawer primitive (drawer.js) and any chat-in-drawer module reach
// into app.js through these public hooks. Kept at the bottom so the rest
// of this file is unchanged.

window.confnote = window.confnote || {};
window.confnote.fab = window.confnote.fab || {};

// Chat module calls this on script-load to make refreshConcierge() skip
// building the legacy bottom-right FAB. If a deploy doesn't include the
// chat module, suppressed stays false and the FAB renders as before.
window.confnote.fab.disable = function () {
  window.confnote.fab.suppressed = true;
  if (CONCIERGE.btn) CONCIERGE.btn.style.display = "none";
  if (CONCIERGE.pop) CONCIERGE.pop.style.display = "none";
};
window.confnote.fab.enable = function () {
  window.confnote.fab.suppressed = false;
  if (CONCIERGE.btn) CONCIERGE.btn.style.display = "";
};

// Build a deep-chat element pointing at the current conference scope and
// mount it into `host`. Reused by the drawer chat module to put the
// concierge inside drawer slot 1 (instead of the bottom-right FAB).
//
// The handler reads `window.confnote.context` at REQUEST TIME (not at
// mount), so the agent always sees the latest slug + file the user is
// viewing — switching conferences or opening a session updates the
// scope on the next chat turn without re-mounting the chat. Falls back to
// CONCIERGE.scope (the "most relevant" conf — today / upcoming) when the
// user is on the home view and no specific conference is selected.
window.confnote.mountConciergeInto = async function (host) {
  if (!CONCIERGE.scope) CONCIERGE.scope = await conciergeScopeSlug();
  if (!customElements.get("deep-chat")) {
    const m = document.createElement("div");
    m.className = "chatMsg";
    m.textContent = "Chat component didn't load (offline first run?).";
    host.replaceChildren(m);
    return;
  }
  const dc = document.createElement("deep-chat");
  themeDeepChat(dc, "Ask about this conference…");
  // Dynamic-URL handler — read live slug + file + thinking-level each turn.
  const buildUrl = () => {
    const ctx = window.confnote.context || {};
    const slug = ctx.slug || CONCIERGE.scope || "";
    const file = ctx.file || "";
    const thinking = (() => {
      try {
        return localStorage.getItem("confnote-thinking") || "off";
      } catch (e) {
        return "off";
      }
    })();
    const model = (() => {
      try {
        return localStorage.getItem("confnote-model") || "haiku";
      } catch (e) {
        return "haiku";
      }
    })();
    const qp = new URLSearchParams();
    if (slug) qp.set("slug", slug);
    if (file) qp.set("file", file);
    qp.set("thinking", thinking);
    qp.set("model", model);
    window.confnote.agentQuery?.(qp);
    return "/api/chat/global?" + qp.toString();
  };
  dc.connect = {
    stream: true,
    handler: (body, signals) => streamHandler(buildUrl())(body, signals),
  };
  // Adaptive intro: a fresh vault (no conferences) gets an action-first prompt
  // (search / paste a URL to import); existing users also get the "ask across
  // your conferences" framing. Best-effort — falls back to the existing copy.
  let hasConfs = false;
  try {
    if (!(await knownSignedOut())) {
      const cr = await fetch("/api/conferences");
      if (cr.ok) hasConfs = ((await cr.json()) || []).length > 0;
    }
  } catch (e) {}
  // The hosted site has no paid web search, so a conference name alone can't be found there: its first
  // greeting asks for a link and offers Beyond The Prompt in one click.
  const hosted = Boolean(window.confnote.webMode && !window.confnote.catMode);
  if (hosted && !hasConfs) {
    dc.introMessage = {
      html:
        "<p>Hi! Paste a conference website or agenda link and I'll import every session. " +
        'Or try the demo: <button type="button" class="cn-demo">Beyond The Prompt ' +
        "(19 May 2026, IET London)</button></p>",
    };
  } else {
    dc.introMessage = {
      text: hasConfs
        ? "Your concierge. Ask about any of your conferences — agenda, " +
          "speakers, rooms, your notes across sessions — or add a new one: " +
          "name a conference or paste its URL and I'll find the agenda and " +
          "import it."
        : "Hi — let's add your first conference. Tell me a conference name " +
          "(e.g. “find Beyond the Prompt 2026”) or paste its URL, and I'll " +
          "track down the agenda and import it. Once you've got conferences, " +
          "I can answer anything across them too.",
    };
  }
  // Hydrate from the durable JSONL so previous turns survive quit/relaunch
  // and conference switches. Server returns last-200 by default; the agent
  // gets last-20 in immediate context (server caps that separately).
  try {
    const r = await fetch("/api/chat/history?limit=200");
    if (r.ok) {
      const data = await r.json();
      const past = (data.history || [])
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role === "assistant" ? "ai" : "user",
          text: m.text || "",
        }));
      if (past.length) dc.history = past;
    }
  } catch (e) {
    // first-run with no JSONL yet is the expected silent path
  }
  host.replaceChildren(dc);
  installSlashPicker(dc, host);
};
