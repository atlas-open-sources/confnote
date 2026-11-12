/* Bryntum drawer module — the Planner in slot 2.
 *
 * Four views over data confnote already owns (no new source of truth):
 *   Rooms    — Scheduler: the open conference's day as rooms (or packed parallel
 *              tracks) × time. Picks are the agenda's stars, as in Day; breaks
 *              and lunch are grey bands, and two picks at once are a red Clash
 *              band across every row. The default for a multi-track day.
 *   Day      — Calendar's day view of the open conference, rooms as columns
 *              (one column with parallel sessions side by side when the agenda
 *              names no rooms), read like a printed programme. Its picks ARE
 *              the agenda's stars (window.confnote.stars): click a session to
 *              pick or unpick it and the sidebar, Schedule and My Agenda follow;
 *              star one there and it fills in here. Clashes show in both.
 *   Trip     — Scheduler: the catalogue events in "<city> <from>–<to>", one lane
 *              per event so clashes line up side by side. Click → mark going.
 *              "Plan my days" asks the Concierge (the metered web agent) to
 *              place the trip's events on a "My plan" row (drag/resize, kept
 *              per workspace); "Spend" adds a Credits row with each AI charge
 *              and each PayPal purchase or top-up from /api/wallet/usage.
 *   Calendar — Calendar month/week of interested/going/attended events, with
 *              application deadlines as flag markers.
 *
 * Tracking goes through the platform API (/api/tracking, /api/going) when the
 * user is signed in on the web target, and through the catalogue's own
 * localStorage keys otherwise, so the catalogue page and this module agree.
 *
 * The vendor bundle (vendor/bryntum-island.bundle.*) is lazy-loaded on the
 * first open. An optional gitignored license.local.js sets the licence key
 * first; without it Bryntum runs in trial mode (watermark).
 *
 * Remove this directory and the "bryntum" slot in modules.config.json and the
 * feature is gone; core never names it.
 */
(() => {
  if (!window.confnote || !window.confnote.drawer) return;

  const MODULE_ID = "bryntum";
  const BASE = "modules/bryntum/";
  const LICENSE_JS = BASE + "license.local.js";
  const MAP_JS = BASE + "plan-map.js";
  const VENDOR_JS = BASE + "vendor/bryntum-island.bundle.js";
  const VENDOR_CSS = BASE + "vendor/bryntum-island.bundle.css";
  const STYLE_HREF = BASE + "bryntum.css";
  const TRACKING_KEY = "confnote-event-tracking";
  const TRIP_KEY = "confnote-trip";
  // A new key, so a Planner last left on Day or Trip opens on its new default:
  // Rooms for a multi-track conference, Day otherwise. A tab click is remembered.
  const VIEW_KEY = "confnote-planner-view-v2";
  const PLAN_KEY = "confnote-bryntum-plan:";
  // A trip day is never narrower than this, so a one-day bar shows its name;
  // a trip that doesn't fit the drawer at this width scrolls sideways.
  const MIN_DAY_TICK_PX = 96;
  const EVENT_COLUMN_PX = 130;
  // Zoomed to spend: the 20 minutes around the latest ledger entry, so each
  // bar is wide enough to show its amount.
  const SPEND_BEFORE_MS = 15 * 60000;
  const SPEND_AFTER_MS = 5 * 60000;
  // Five-minute ticks: the stock minute preset snaps to half hours.
  const SPEND_PRESET = {
    base: "minuteAndHour",
    headers: [
      { unit: "hour", dateFormat: "ddd DD/MM HH:mm" },
      { unit: "minute", increment: 5, dateFormat: "HH:mm" },
    ],
    timeResolution: { unit: "minute", increment: 1 },
  };
  const RESIZE_HANDLE_PX = 3;
  const TRIP_EVENT_FIELDS = [
    "kind",
    "why",
    "eventId",
    "format",
    "status",
    "clashesWith",
    "reason",
    "model",
    "amount",
    "balanceAfter",
    "paypalRef",
    "ref",
  ];
  const DAY_MS = 86400000;
  const HOUR_MS = 3600000;
  // The hour is sized so the day's typical talk is DAY_TALK_PX tall (its
  // time, two lines of title and the speakers), within these bounds.
  const DAY_TALK_PX = 90;
  const DAY_HOUR_MIN_PX = 120;
  const DAY_HOUR_MAX_PX = 240;
  const DAY_MIN_EVENT_PX = 22;
  const DEFAULT_TRIP_DAYS = 7;
  // Rooms: a typical talk is ROOMS_TALK_PX wide (two lines of title), the hour within these bounds.
  const ROOMS_TALK_PX = 170;
  const ROOMS_HOUR_MIN_PX = 160;
  const ROOMS_HOUR_MAX_PX = 480;
  const ROOMS_ROW_PX = 66;
  const ROOM_COLUMN_PX = 110;
  // Hour ticks labelled HH:mm, snapping to five minutes.
  const ROOMS_PRESET = {
    base: "hourAndDay",
    headers: [{ unit: "hour", dateFormat: "HH:mm" }],
    timeResolution: { unit: "minute", increment: 5 },
  };
  const TRACKED_STATUSES = ["interested", "going", "attended"];
  // The app's rest types (app.js REST_TYPES): shown, never starred.
  const REST_TYPES = ["break", "networking", "logistics"];
  // Rooms draws these as bands across every row too: lunch spans the rooms, it is no track.
  const BAND_TYPES = REST_TYPES.concat(["lunch"]);
  // A band's label is its type in our words, never the agenda's (scraped) title:
  // Bryntum draws a time range's name into the DOM, and whether it encodes it is
  // its business, not a contract. Any other untyped rest is a "Break".
  const BAND_LABELS = {
    break: "Break",
    lunch: "Lunch",
    networking: "Networking",
    logistics: "Logistics",
  };
  const STARS_EVENT = "confnote-stars-changed";
  const STAR_KEY_PREFIX = "confnote-stars-";
  const MY_DAY_HEADING = /^## My day[ \t]*$/m;
  const MY_DAY_MIGRATED_KEY = "confnote-planner-myday-migrated:";
  const VIEWS = [
    { id: "rooms", label: "Rooms" },
    { id: "day", label: "Day" },
    { id: "trip", label: "Trip" },
    { id: "calendar", label: "Calendar" },
  ];

  let bundleLoaded = null;
  let widget = null;
  let hostEl = null;
  // null until a tab is clicked: the conference decides (Rooms when multi-track).
  let view = localStorage.getItem(VIEW_KEY);
  let tabsEl = null;
  // The Day view's repaint, set while it is on screen: a star changed in the
  // app (or another tab) repaints the picks without rebuilding the calendar.
  let dayRepaint = null;
  let catalogue = null;
  let tracking = null;
  let signedIn = null;
  let contextSlug = null;
  // Each view's shell takes a token. A view still loading when another opens
  // (Trip waiting on the catalogue and the ledger while Day is clicked) stops
  // at its next await instead of destroying the newer view's scheduler.
  let viewToken = 0;

  // ------------------------------------------------------------ loading --

  function addStylesheet(href) {
    if (document.querySelector(`link[data-confnote-bryntum="${href}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.confnoteBryntum = href;
    document.head.appendChild(link);
  }

  function addScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = false;
      s.onload = resolve;
      s.onerror = () => reject(new Error("failed to load " + src));
      document.head.appendChild(s);
    });
  }

  function loadBundle() {
    if (bundleLoaded) return bundleLoaded;
    addStylesheet(VENDOR_CSS);
    addStylesheet(STYLE_HREF);
    bundleLoaded = (async () => {
      // The licence file is optional (gitignored); a 404 means trial mode.
      await addScript(LICENSE_JS).catch(() => {});
      if (!window.confnoteBryntumMap) await addScript(MAP_JS);
      if (!window.__confnoteBryntum) await addScript(VENDOR_JS);
      if (!window.__confnoteBryntum) throw new Error("Bryntum bundle did not load");
      return window.__confnoteBryntum;
    })();
    bundleLoaded.catch(() => {
      bundleLoaded = null;
    });
    return bundleLoaded;
  }

  // --------------------------------------------------------------- data --

  function readJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) || fallback;
    } catch {
      return fallback;
    }
  }

  async function loadCatalogue() {
    if (catalogue) return catalogue;
    const r = await fetch("/api/catalogue");
    if (!r.ok) throw new Error("The catalogue is unavailable.");
    const d = await r.json();
    catalogue = Array.isArray(d.events) ? d.events : [];
    return catalogue;
  }

  async function loadTracking() {
    if (tracking) return tracking;
    if (signedIn === null) {
      try {
        signedIn = (await fetch("/api/me")).ok;
      } catch {
        signedIn = false;
      }
    }
    if (signedIn) {
      const r = await fetch("/api/tracking");
      tracking = r.ok ? await r.json() : {};
    } else {
      tracking = readJson(TRACKING_KEY, {});
    }
    return tracking;
  }

  async function markGoing(eventId) {
    await loadTracking();
    if (!signedIn) {
      tracking[eventId] = "going";
      localStorage.setItem(TRACKING_KEY, JSON.stringify(tracking));
      return { ok: true };
    }
    const r = await fetch("/api/tracking", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId, status: "going" }),
    });
    const result = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: result.error || "Unable to save." };
    tracking[eventId] = "going";
    const going = await fetch("/api/going", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId }),
    });
    const workspace = await going.json().catch(() => ({}));
    return { ok: true, url: going.ok ? workspace.url : result.url };
  }

  // The plan is kept per workspace, the way the trip is kept: in localStorage.
  function planKey() {
    return PLAN_KEY + (new URL(location.href).searchParams.get("workspace") || "personal");
  }

  function readPlan() {
    const plan = readJson(planKey(), []);
    return Array.isArray(plan) ? plan : [];
  }

  function writePlan(days) {
    localStorage.setItem(planKey(), JSON.stringify(days));
  }

  // The wallet ledger; null where there is no wallet (local app, signed out).
  async function loadLedger() {
    try {
      const r = await fetch("/api/wallet/usage");
      if (!r.ok) return null;
      const d = await r.json();
      return Array.isArray(d.rows) ? d.rows : null;
    } catch {
      return null;
    }
  }

  function fetchConference(slug) {
    return fetch("/api/conference?slug=" + encodeURIComponent(slug))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }

  // One Concierge step through /api/chat/plan: the server owns the prompt and
  // calls the model with no tools (the event names are scraped, untrusted
  // text), metered by the Router wallet like any Concierge step. Returns the
  // reply text, or { outOfCredits } after handing the 402 to the shell's
  // buy-more card.
  async function askConcierge(trip, candidates) {
    const r = await fetch("/api/chat/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trip, candidates }),
    });
    if (!r.ok || !r.body) throw new Error("The Concierge is unavailable.");
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let reply = "";
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
        } catch {
          continue;
        }
        if (o.text) reply += o.text;
        else if (o.error && o.status === 402) {
          window.dispatchEvent(
            new CustomEvent("confnote-credits-required", { detail: o, cancelable: true }),
          );
          return { outOfCredits: true };
        } else if (o.error) throw new Error(String(o.error));
      }
    }
    window.dispatchEvent(new CustomEvent("confnote-concierge-turn"));
    return { reply };
  }

  // ---------------------------------------------------------- date helpers --

  function isoDay(date) {
    return date.toISOString().slice(0, 10);
  }

  function dayStart(iso) {
    return new Date(iso.slice(0, 10) + "T00:00:00");
  }

  // Catalogue end dates are inclusive days; Bryntum end dates are exclusive.
  function dayEndExclusive(iso) {
    return new Date(dayStart(iso).getTime() + DAY_MS);
  }

  function overlaps(a, b) {
    return a.startDate < b.endDate && b.startDate < a.endDate;
  }

  // ------------------------------------------------------- untrusted data --
  // Catalogue and agenda strings are scraped: they reach Bryntum only as
  // encoded text, and only http(s) URLs are ever followed.

  function safeUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
    } catch {
      return null;
    }
  }

  function textRenderer(B) {
    return ({ eventRecord }) =>
      `<span class="cn-bar-name">${B.StringHelper.encodeHtml(eventRecord.name)}</span>`;
  }

  // ------------------------------------------------------------ UI chrome --

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function setMessage(text) {
    const msg = hostEl && hostEl.querySelector(".cn-bry-msg");
    if (msg) msg.textContent = text || "";
  }

  function destroyWidget() {
    if (widget && !widget.isDestroyed) widget.destroy();
    widget = null;
    dayRepaint = null;
  }

  function markTab(current) {
    if (!tabsEl) return;
    for (const tab of tabsEl.children) {
      tab.setAttribute("aria-selected", String(tab.dataset.view === current));
    }
  }

  function renderViewTabs(headEl) {
    const tabs = el("div", "cn-bry-tabs");
    tabsEl = tabs;
    tabs.setAttribute("role", "tablist");
    for (const v of VIEWS) {
      const b = el("button", "cn-bry-tab", v.label);
      b.type = "button";
      b.dataset.view = v.id;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(v.id === view));
      b.onclick = () => {
        view = v.id;
        localStorage.setItem(VIEW_KEY, view);
        markTab(view);
        if (hostEl) renderView(hostEl, window.confnote.context || {});
      };
      tabs.append(b);
    }
    headEl.append(tabs);
  }

  // The hosted site runs Bryntum on a trial licence for the PayPal AI Hackathon judging period (musa,
  // 2026-11-13); the note says so and how to reach us. The Mac app and the Cat never show it.
  function licenceNote() {
    if (!window.confnote.webMode || window.confnote.catMode) return null;
    const note = el(
      "p",
      "cn-licence-note",
      "Bryntum and tldraw run on confnote.si for the PayPal AI Hackathon judging period. If you represent Bryntum or tldraw, tell us whether to remove them or to align licences, and we will: ",
    );
    const mail = el("a", null, "support@atlascodes.ai");
    mail.href = "mailto:support@atlascodes.ai";
    note.append(mail, ".");
    return note;
  }

  function shell(host, name) {
    // The chrome is styled even when a view stops before loading the bundle
    // (Day from the home view): without this the drawer showed a bare stage.
    addStylesheet(VENDOR_CSS);
    addStylesheet(STYLE_HREF);
    destroyWidget();
    host.replaceChildren();
    const root = el("div", "cn-bry");
    root.dataset.view = name;
    const bar = el("div", "cn-bry-bar");
    const stage = el("div", "cn-bry-stage");
    const msg = el("p", "cn-bry-msg");
    msg.setAttribute("aria-live", "polite");
    const note = licenceNote();
    if (note) root.append(note);
    root.append(bar, stage, msg);
    host.append(root);
    const token = ++viewToken;
    return { bar, stage, live: () => token === viewToken };
  }

  // -------------------------------------------------------------- Trip --

  function defaultTrip(events) {
    const stops = readJson(TRIP_KEY, []);
    if (stops.length && stops[0].city) return { ...stops[0] };
    const today = isoDay(new Date());
    const upcoming = events.find((e) => e.city && e.start >= today) || events[0];
    // Published starts are full ISO timestamps; a date input only takes the day.
    const from = upcoming ? upcoming.start.slice(0, 10) : today;
    const to = isoDay(new Date(dayStart(from).getTime() + (DEFAULT_TRIP_DAYS - 1) * DAY_MS));
    return { city: upcoming ? upcoming.city : "", from, to };
  }

  function tripEvents(events, trip) {
    const from = dayStart(trip.from);
    const to = dayEndExclusive(trip.to);
    const rows = events
      .filter((e) => e.city === trip.city && e.start && e.end)
      .map((e) => ({
        id: e.id,
        resourceId: e.id,
        name: e.name,
        startDate: dayStart(e.start),
        endDate: dayEndExclusive(e.end),
        format: e.format || "",
        status: (tracking && tracking[e.id]) || "",
        draggable: false,
        resizable: false,
      }))
      .filter((e) => e.startDate < to && from < e.endDate)
      .sort((a, b) => a.startDate - b.startDate);
    for (const row of rows) {
      const clashes = rows.filter((other) => other !== row && overlaps(row, other));
      row.clashesWith = clashes.map((c) => c.name);
      const classes = [];
      if (clashes.length) classes.push("cn-clash");
      if (row.status) classes.push("cn-status-" + row.status);
      row.cls = classes.join(" ");
    }
    return rows;
  }

  async function renderTrip(host) {
    const { bar, stage, live } = shell(host, "trip");
    const [B, events] = await Promise.all([loadBundle(), loadCatalogue(), loadTracking()]);
    if (!live()) return;
    const trip = defaultTrip(events);
    const cities = [...new Set(events.map((e) => e.city).filter(Boolean))].sort();

    const form = el("form", "cn-bry-trip");
    const city = el("select");
    city.name = "city";
    city.title = "The city you're in";
    city.setAttribute("aria-label", "City");
    for (const c of cities) {
      const o = el("option", null, c);
      o.value = c;
      city.append(o);
    }
    city.value = trip.city;
    const from = el("input");
    from.type = "date";
    from.name = "from";
    from.value = trip.from;
    from.setAttribute("aria-label", "From");
    const to = el("input");
    to.type = "date";
    to.name = "to";
    to.value = trip.to;
    to.setAttribute("aria-label", "To");
    form.append(city, from, el("span", "cn-bry-label", "–"), to);
    const planButton = el("button", "cn-bry-action", "Plan my days");
    planButton.type = "button";
    planButton.dataset.action = "plan";
    const spendButton = el("button", "cn-bry-action", "Spend");
    spendButton.type = "button";
    spendButton.dataset.action = "spend";
    spendButton.title = "Show each AI charge and PayPal purchase on a Credits row";
    bar.append(form, planButton, spendButton);

    const M = window.confnoteBryntumMap;
    let ledger = await loadLedger();
    if (!live()) return;
    let showSpend = false;

    const currentTrip = () => ({ city: city.value, from: from.value, to: to.value });

    // The trip's catalogue events as the Concierge sees them: days, not timestamps.
    const candidatesFor = (rows) =>
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        format: r.format,
        status: r.status,
        start: isoDayOf(r.startDate),
        end: isoDayOf(new Date(r.endDate.getTime() - DAY_MS)),
      }));

    const savePlan = (store) => {
      const kept = readPlan().filter((day) => !store.getById(`plan:${day.date}:${day.eventId}`));
      const moved = store.records.filter((r) => r.kind === "plan").map(M.eventToPlanDay);
      writePlan(kept.concat(moved));
      setMessage("My plan saved.");
    };

    const tooltipLines = (record) => {
      if (record.kind === "charge" || record.kind === "grant") return M.ledgerLines(record);
      if (record.kind === "plan") {
        const time = (d) => d.toTimeString().slice(0, 5);
        return [
          record.name,
          `${time(record.startDate)}–${time(record.endDate)}`,
          record.why && "Concierge: " + record.why,
        ];
      }
      const lines = [record.name, record.format];
      if (record.status) lines.push("Status: " + record.status);
      if (record.clashesWith.length) lines.push("Clashes with: " + record.clashesWith.join(", "));
      return lines;
    };

    const draw = () => {
      if (!live()) return;
      destroyWidget();
      const current = currentTrip();
      if (!current.from || !current.to || current.from > current.to) {
        setMessage("Your departure must be after your arrival.");
        return;
      }
      const rows = tripEvents(events, current);
      const planned = M.planToEvents(readPlan(), candidatesFor(rows));
      const credits = ledger ? M.ledgerToEvents(ledger) : [];
      const clashCount = rows.filter((r) => r.clashesWith.length).length;
      setMessage(
        rows.length
          ? `${rows.length} event${rows.length === 1 ? "" : "s"} in ${current.city}` +
              (clashCount ? ` · ${clashCount} clashing` : "") +
              " · click one to mark going"
          : `Nothing in ${current.city} for those dates.`,
      );
      spendButton.hidden = !credits.length;
      spendButton.setAttribute("aria-pressed", String(showSpend));
      const span = timeSpan(current, credits, showSpend, stage.clientWidth - EVENT_COLUMN_PX);
      const resources = [{ id: M.PLAN_RESOURCE, name: "My plan", cls: "cn-plan-row" }];
      // The Credits row is not part of the trip: Spend adds it, zoomed to its minutes.
      if (showSpend && credits.length) {
        resources.unshift({
          id: M.CREDITS_RESOURCE,
          name: "Credits",
          cls: "cn-credits-row",
          eventLayout: "stack",
        });
      }
      widget = new B.Scheduler({
        appendTo: stage,
        startDate: span.startDate,
        endDate: span.endDate,
        viewPreset: span.preset,
        // Fit the trip into the drawer width; a long one scrolls at a readable day width.
        forceFit: span.fit,
        ...(span.fit ? {} : { tickSize: span.tickSize }),
        rowHeight: 44,
        barMargin: 6,
        columns: [{ text: "Event", field: "name", width: EVENT_COLUMN_PX, htmlEncode: true }],
        eventRenderer: textRenderer(B),
        resources: resources.concat(rows.map((r) => ({ id: r.id, name: r.name }))),
        // Three kinds of bar share one store: declare every field so none is
        // dropped because the first record lacked it.
        eventStore: { fields: TRIP_EVENT_FIELDS },
        events: [...credits, ...planned, ...rows],
        features: {
          // Only My plan bars move: along their own row, longer or shorter.
          eventDrag: { constrainDragToResource: true },
          // Narrow handles: an hour-level bar on the trip's day scale is only a few pixels wide.
          eventResize: { handleSize: RESIZE_HANDLE_PX },
          eventEdit: false,
          eventMenu: false,
          scheduleMenu: false,
          eventDragCreate: false,
          cellEdit: false,
          eventTooltip: {
            template: ({ eventRecord }) =>
              tooltipLines(eventRecord)
                .filter(Boolean)
                .map((line) => B.StringHelper.encodeHtml(line))
                .join("<br>"),
          },
        },
        listeners: {
          beforeEventDrag: ({ eventRecord }) => eventRecord.kind === "plan",
          beforeEventResize: ({ eventRecord }) => eventRecord.kind === "plan",
          eventDrop: ({ source }) => savePlan(source.eventStore),
          eventResizeEnd: ({ source, changed }) => {
            if (changed !== false) savePlan(source.eventStore);
          },
          eventClick: async ({ eventRecord }) => {
            if (eventRecord.kind) return;
            setMessage("Marking " + eventRecord.name + " as going…");
            const result = await markGoing(eventRecord.id);
            if (!result.ok) {
              setMessage(result.error);
              return;
            }
            eventRecord.set({ status: "going", cls: eventRecord.cls + " cn-status-going" });
            const url = result.url && safeUrl(result.url);
            if (url) {
              location.href = url;
              return;
            }
            setMessage(
              "Going to " +
                eventRecord.name +
                (result.url ? ". The workspace link was not a web address." : "."),
            );
          },
        },
      });
    };

    planButton.onclick = async () => {
      const current = currentTrip();
      const candidates = candidatesFor(tripEvents(events, current));
      if (!candidates.length) {
        setMessage(`Nothing in ${current.city} to plan for those dates.`);
        return;
      }
      planButton.disabled = true;
      setMessage("The Concierge is planning your days…");
      try {
        const answer = await askConcierge(current, candidates);
        if (answer.outOfCredits) {
          setMessage("Out of AI credits. Add credits, then plan again.");
          return;
        }
        const days = M.parsePlan(answer.reply, current, candidates);
        if (!days || !days.length) {
          // A workspace with no conference yet gets the Concierge's import hint, not a plan.
          const going = candidates.some((c) => c.status === "going");
          setMessage(
            going
              ? "The Concierge did not return a plan. Try again."
              : "Mark one of these events going (click it), then plan your days.",
          );
          return;
        }
        // The new plan replaces this trip's days; plans for other trips stay.
        const ids = new Set(candidates.map((c) => c.id));
        writePlan(
          readPlan()
            .filter((day) => !ids.has(day.eventId))
            .concat(days),
        );
        ledger = await loadLedger();
        draw();
        setMessage(
          `The Concierge planned ${days.length} day${days.length === 1 ? "" : "s"}` +
            (ledger ? " · Spend shows its charges" : "") +
            " · drag or resize to adjust",
        );
      } catch (error) {
        setMessage(error && error.message ? error.message : String(error));
      } finally {
        planButton.disabled = false;
      }
    };
    spendButton.onclick = () => {
      showSpend = !showSpend;
      draw();
    };
    form.addEventListener("change", draw);
    form.addEventListener("submit", (e) => e.preventDefault());
    draw();
  }

  function isoDayOf(date) {
    return window.confnoteBryntumMap.localDay(date);
  }

  // The trip's days; or, showing spend, the minutes around the latest ledger entry.
  function timeSpan(trip, credits, showSpend, timelinePx) {
    if (showSpend && credits.length) {
      const latest = Math.max(...credits.map((c) => c.startDate.getTime()));
      return {
        startDate: new Date(latest - SPEND_BEFORE_MS),
        endDate: new Date(latest + SPEND_AFTER_MS),
        preset: SPEND_PRESET,
        fit: true,
      };
    }
    const startDate = dayStart(trip.from);
    const endDate = dayEndExclusive(trip.to);
    const days = Math.round((endDate - startDate) / DAY_MS);
    return {
      startDate,
      endDate,
      preset: "dayAndWeek",
      fit: days * MIN_DAY_TICK_PX <= timelinePx,
      tickSize: MIN_DAY_TICK_PX,
    };
  }

  // --------------------------------------------------------------- Day --
  // One plan, two UIs: the Day view's picks are the agenda's stars, read and
  // set through the app (window.confnote.stars). Breaks and logistics have no
  // note, so they show but are not picks, as in the sidebar.

  // The Day view used to keep its picks as a "## My day" list in BRIEF.md
  // (one "<!-- id:<session id> -->" per line). Those picks become stars once
  // per conference, so nobody loses a plan; the brief text is left as it is.
  async function migrateMyDay(slug, stars, byId) {
    const doneKey = MY_DAY_MIGRATED_KEY + slug;
    if (!stars || localStorage.getItem(doneKey)) return;
    let brief = null;
    try {
      const r = await fetch("/api/conf-doc?slug=" + encodeURIComponent(slug));
      if (r.status === 404) brief = "";
      else if (r.ok) brief = ((await r.json()) || {}).brief || "";
    } catch {
      brief = null;
    }
    // Unreadable now: try again on the next open rather than mark it done.
    if (brief === null) return;
    // The exact heading: "## My day goals" (day-setup.js) is a different section.
    const heading = MY_DAY_HEADING.exec(brief);
    if (heading) {
      const section = brief.slice(heading.index + heading[0].length).split(/\n## /)[0];
      const picks = new Set(stars.list(slug));
      for (const m of section.matchAll(/<!-- id:([^ ]+) -->/g)) {
        const session = byId.get(m[1]);
        if (session && isPickable(session) && !picks.has(session.note)) {
          stars.set(slug, session.note, true);
        }
      }
    }
    localStorage.setItem(doneKey, "1");
  }

  function starsApi() {
    const api = window.confnote.stars;
    return api && typeof api.list === "function" && typeof api.set === "function" ? api : null;
  }

  function dayLabel(iso) {
    return dayStart(iso).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  }

  // Agenda events → sessions on the venue's wall clock (agenda times carry
  // the venue's offset), with room ids turned into the agenda's room names.
  function agendaSessions(conf) {
    const roomNames = new Map((conf.rooms || []).map((r) => [r.id, r.name || r.id]));
    return conf.events
      .filter((e) => e.start && e.end)
      .map((e) => ({
        id: e.id,
        // Breaks, networking and logistics are never picks, as in the sidebar.
        note: REST_TYPES.includes(e.type) ? "" : e.note || "",
        band: BAND_TYPES.includes(e.type),
        bandLabel: BAND_LABELS[e.type] || BAND_LABELS.break,
        name: e.title,
        room: roomNames.get(e.room) || e.room || "",
        speakers: (e.speakers || []).join(", "),
        day: e.start.slice(0, 10),
        startDate: new Date(e.start.slice(0, 19)),
        endDate: new Date(e.end.slice(0, 19)),
      }));
  }

  function hourHeightFor(sessions) {
    const minutes = sessions
      .filter(isPickable)
      .map((s) => (s.endDate - s.startDate) / 60000)
      .filter((m) => m > 0)
      .sort((a, b) => a - b);
    if (!minutes.length) return DAY_HOUR_MIN_PX;
    const median = minutes[Math.floor(minutes.length / 2)];
    const px = Math.round((DAY_TALK_PX * 60) / median);
    return Math.min(DAY_HOUR_MAX_PX, Math.max(DAY_HOUR_MIN_PX, px));
  }

  // The day's rooms in the agenda's own order, then any it does not list.
  function dayRooms(conf, sessions) {
    const used = new Set(sessions.map((s) => s.room).filter(Boolean));
    if (!used.size) return [];
    const listed = (conf.rooms || []).map((r) => r.name || r.id).filter((name) => used.has(name));
    const rest = [...used].filter((name) => !listed.includes(name)).sort();
    const rooms = listed.concat(rest);
    if (sessions.some((s) => !s.room)) rooms.push("");
    return rooms;
  }

  function isPickable(session) {
    return Boolean(session.note);
  }

  // A pick, a clash (two picks overlap), skipped (overlaps a pick: dimmed, as
  // in the sidebar) or a break (never a pick).
  function pickState(session, picks, sessions) {
    if (!isPickable(session)) return { picked: false, cls: "cn-rest" };
    const picked = picks.has(session.note);
    const overlapsPick = sessions.some(
      (other) =>
        other !== session && other.note && picks.has(other.note) && overlaps(other, session),
    );
    if (picked)
      return { picked, cls: overlapsPick ? "cn-pick cn-picked cn-clash" : "cn-pick cn-picked" };
    return { picked, cls: overlapsPick ? "cn-pick cn-skipped" : "cn-pick" };
  }

  // Day needs a conference. From the home view the stage offers the user's
  // conferences instead of standing empty; picking one navigates into it and
  // the context change redraws the Day view.
  async function renderDayPicker(bar, stage, live) {
    const confs = await fetch("/api/conferences")
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
    if (!live()) return;
    if (!Array.isArray(confs) || !confs.length) {
      stage.append(el("p", "cn-bry-empty", "Add a conference to plan its day here."));
      return;
    }
    const pick = el("select", "cn-bry-dayselect");
    pick.setAttribute("aria-label", "Conference");
    pick.append(el("option", null, "Pick a conference…"));
    pick.firstChild.value = "";
    for (const c of confs) {
      const o = el("option", null, c.name || c.slug);
      o.value = c.slug;
      pick.append(o);
    }
    pick.onchange = () => {
      if (pick.value) location.hash = "#/" + encodeURIComponent(pick.value);
    };
    bar.append(el("span", "cn-bry-label", "Plan the day of"), pick);
    stage.append(el("p", "cn-bry-empty", "Pick a conference to see its rooms and sessions here."));
  }

  async function renderDay(host, ctx, prefetched) {
    const { bar, stage, live } = shell(host, "day");
    const slug = ctx && ctx.slug;
    if (!slug) {
      await renderDayPicker(bar, stage, live);
      return;
    }
    const [B, conf] = await Promise.all([loadBundle(), prefetched || fetchConference(slug)]);
    if (!live()) return;
    if (!conf || !Array.isArray(conf.events)) {
      setMessage("This conference has no agenda yet.");
      return;
    }
    const stars = starsApi();
    const sessions = agendaSessions(conf);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    await migrateMyDay(slug, stars, byId);
    if (!live()) return;
    const days = [...new Set(sessions.map((s) => s.day))].sort();
    if (!days.length) {
      setMessage("This conference has no timed sessions.");
      return;
    }
    const picker = el("select", "cn-bry-dayselect");
    picker.setAttribute("aria-label", "Day");
    for (const d of days) {
      const o = el("option", null, dayLabel(d));
      o.value = d;
      picker.append(o);
    }
    const today = isoDayOf(new Date());
    picker.value = days.includes(today) ? today : days[0];
    const mine = el("button", "cn-bry-action", "Only my picks");
    mine.type = "button";
    mine.dataset.action = "mine";
    mine.setAttribute("aria-pressed", "false");
    bar.append(
      el("span", "cn-bry-label cn-bry-conf", (conf.conference && conf.conference.name) || slug),
      picker,
      mine,
    );
    let onlyMine = false;

    const readPicks = () => new Set(stars ? stars.list(slug) : []);
    const roomId = (room) => "room:" + room;

    const describe = (daySessions, picks) => {
      if (!stars) return "Picks are read-only here.";
      const mineToday = daySessions.filter((s) => s.note && picks.has(s.note));
      const clashes = mineToday.filter((s) =>
        pickState(s, picks, daySessions).cls.includes("cn-clash"),
      );
      if (!mineToday.length) {
        return onlyMine
          ? "No picks on this day yet."
          : "Click a session to pick it; your picks are the agenda's stars.";
      }
      return (
        `${mineToday.length} picked` +
        (clashes.length ? ` · ${clashes.length} clashing` : "") +
        " · click a session to pick or unpick it"
      );
    };

    // A star changed (here, in the app or in another tab): repaint the
    // records in place, or redraw when only picks are shown.
    const repaint = () => {
      if (!live() || !widget || widget.isDestroyed) return;
      if (onlyMine) {
        draw();
        return;
      }
      const picks = readPicks();
      const daySessions = sessions.filter((s) => s.day === picker.value);
      widget.eventStore.forEach((record) => {
        const session = byId.get(record.id);
        if (session) record.set(pickState(session, picks, daySessions));
      });
      setMessage(describe(daySessions, picks));
    };

    const toggle = (record) => {
      const session = byId.get(record.id);
      if (!stars || !session || !session.note) return;
      stars.set(slug, session.note, !readPicks().has(session.note));
      repaint();
    };

    const renderEvent = ({ eventRecord }) => {
      const encode = B.StringHelper.encodeHtml;
      const star = eventRecord.note
        ? `<span class="cn-star" aria-hidden="true">${eventRecord.picked ? "★" : "☆"}</span>`
        : "";
      const meta = eventRecord.speakers
        ? `<span class="cn-day-meta">${encode(eventRecord.speakers)}</span>`
        : "";
      return `<span class="cn-day-head">${star}<span class="cn-bar-name">${encode(eventRecord.name)}</span></span>${meta}`;
    };

    const tooltip = (record) => {
      const time = (d) => d.toTimeString().slice(0, 5);
      const lines = [record.name, `${time(record.startDate)}–${time(record.endDate)}`];
      if (record.room) lines.push(record.room);
      if (record.speakers) lines.push(record.speakers);
      if (record.note) lines.push(record.picked ? "Picked: click to unpick" : "Click to pick");
      return lines.map((line) => B.StringHelper.encodeHtml(line)).join("<br>");
    };

    const draw = () => {
      if (!live()) return;
      destroyWidget();
      const day = picker.value;
      const picks = readPicks();
      const daySessions = sessions.filter((s) => s.day === day);
      const shown = onlyMine ? daySessions.filter((s) => s.note && picks.has(s.note)) : daySessions;
      const rooms = dayRooms(conf, daySessions);
      const mode = rooms.length ? "dayresource" : "day";
      const firstHour = Math.min(...daySessions.map((s) => s.startDate.getHours()));
      const lastHour = Math.max(
        ...daySessions.map((s) => Math.ceil((s.endDate - dayStart(day)) / HOUR_MS)),
      );
      // Open on the first talk, not on a two-hour breakfast; scrolling up shows it.
      const talks = daySessions.filter(isPickable);
      const firstTalk = talks.length
        ? Math.min(...talks.map((s) => s.startDate.getHours()))
        : firstHour;
      const viewConfig = {
        dayStartTime: firstHour,
        dayEndTime: Math.min(24, Math.max(lastHour, firstHour + 1)),
        visibleStartTime: firstTalk,
        hourHeight: hourHeightFor(daySessions),
        minEventHeight: DAY_MIN_EVENT_PX,
        fitHours: false,
        range: "1d",
        // The day picker names the date; the header names only the rooms.
        showHeaderAvatars: false,
        // The app's clock: 24-hour, as in the sidebar and Schedule.
        timeFormat: "HH:mm",
        timeAxisTimeFormat: "HH:mm",
        // A past conference reads the same as a coming one.
        pastEventCls: "",
        eventRenderer: renderEvent,
        // No rooms: no header row at all, the parallel sessions sit side by side.
        ...(rooms.length ? {} : { allDayEvents: null }),
      };
      mine.setAttribute("aria-pressed", String(onlyMine));
      setMessage(describe(daySessions, picks));
      widget = new B.Calendar({
        appendTo: stage,
        date: dayStart(day),
        mode,
        modes: {
          day: mode === "day" ? viewConfig : null,
          dayresource: mode === "dayresource" ? viewConfig : null,
          week: null,
          month: null,
          year: null,
          agenda: null,
        },
        sidebar: false,
        tbar: null,
        readOnly: true,
        resources: rooms.map((room) => ({ id: roomId(room), name: room || "Other" })),
        eventStore: { fields: ["note", "room", "speakers", "picked"] },
        events: shown.map((s) => ({
          id: s.id,
          name: s.name,
          startDate: s.startDate,
          endDate: s.endDate,
          note: s.note,
          room: s.room,
          speakers: s.speakers,
          ...(rooms.length ? { resourceId: roomId(s.room) } : {}),
          ...pickState(s, picks, daySessions),
        })),
        features: {
          eventEdit: false,
          eventMenu: false,
          scheduleMenu: false,
          scheduleTooltip: false,
          drag: false,
          eventTooltip: {
            showOn: "hover",
            titleRenderer: () => "",
            renderer: ({ eventRecord }) => tooltip(eventRecord),
          },
        },
        listeners: {
          eventClick: ({ eventRecord }) => toggle(eventRecord),
        },
      });
      dayRepaint = repaint;
    };

    picker.addEventListener("change", draw);
    mine.onclick = () => {
      onlyMine = !onlyMine;
      draw();
    };
    draw();
  }

  // -------------------------------------------------------------- Rooms --
  // The conference day as rooms × time on Scheduler: a row per room (or, when
  // the agenda names no rooms, per parallel track), talks as bars along the
  // day. Picks are the agenda's stars, as in Day. Scheduler's time ranges do
  // the rest: breaks are grey bands across every row, and two picks at once
  // mark their overlap as a red band, so a clash reads across tracks at a glance.

  // Pack sessions into the fewest tracks: each goes on the first track that is free by its start.
  function packTracks(sessions) {
    const ends = [];
    const trackOf = new Map();
    for (const s of [...sessions].sort((a, b) => a.startDate - b.startDate)) {
      let track = ends.findIndex((end) => end <= s.startDate);
      if (track < 0) {
        track = ends.length;
        ends.push(s.endDate);
      } else {
        ends[track] = s.endDate;
      }
      trackOf.set(s.id, track);
    }
    return { count: ends.length, trackOf };
  }

  // A bar on a room's row: a talk, never a break or lunch.
  function isTalk(session) {
    return isPickable(session) && !session.band;
  }

  // A day is multi-track when it has two rooms, or two talks at once.
  function isMultiTrack(conf) {
    const talks = agendaSessions(conf).filter((s) => isPickable(s) && !s.band);
    const rooms = new Set(talks.map((s) => s.room).filter(Boolean));
    if (rooms.size > 1) return true;
    return talks.some((a) => talks.some((b) => a !== b && a.day === b.day && overlaps(a, b)));
  }

  // The overlaps between picks, merged: each is one red band.
  function clashSpans(daySessions, picks) {
    const picked = daySessions
      .filter((s) => s.note && picks.has(s.note))
      .sort((a, b) => a.startDate - b.startDate);
    const spans = [];
    for (const [i, a] of picked.entries()) {
      for (const b of picked.slice(i + 1)) {
        if (!overlaps(a, b)) continue;
        spans.push({
          startDate: new Date(Math.max(a.startDate, b.startDate)),
          endDate: new Date(Math.min(a.endDate, b.endDate)),
        });
      }
    }
    spans.sort((a, b) => a.startDate - b.startDate);
    const merged = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && span.startDate <= last.endDate) {
        last.endDate = new Date(Math.max(last.endDate, span.endDate));
      } else {
        merged.push({ ...span });
      }
    }
    return merged;
  }

  function roomsHourWidth(sessions) {
    const minutes = sessions
      .filter(isPickable)
      .map((s) => (s.endDate - s.startDate) / 60000)
      .filter((m) => m > 0)
      .sort((a, b) => a - b);
    if (!minutes.length) return ROOMS_HOUR_MIN_PX;
    const median = minutes[Math.floor(minutes.length / 2)];
    const px = Math.round((ROOMS_TALK_PX * 60) / median);
    return Math.min(ROOMS_HOUR_MAX_PX, Math.max(ROOMS_HOUR_MIN_PX, px));
  }

  function describePicks(daySessions, picks, stars) {
    if (!stars) return "Picks are read-only here.";
    const mineToday = daySessions.filter((s) => s.note && picks.has(s.note));
    const clashes = mineToday.filter((s) =>
      pickState(s, picks, daySessions).cls.includes("cn-clash"),
    );
    if (!mineToday.length) return "Click a talk to pick it; your picks are the agenda's stars.";
    return (
      `${mineToday.length} picked` +
      (clashes.length ? ` · ${clashes.length} clashing` : "") +
      " · click a talk to pick or unpick it"
    );
  }

  async function renderRooms(host, ctx, prefetched) {
    const { bar, stage, live } = shell(host, "rooms");
    const slug = ctx && ctx.slug;
    if (!slug) {
      await renderDayPicker(bar, stage, live);
      return;
    }
    const [B, conf] = await Promise.all([loadBundle(), prefetched || fetchConference(slug)]);
    if (!live()) return;
    if (!conf || !Array.isArray(conf.events)) {
      setMessage("This conference has no agenda yet.");
      return;
    }
    const stars = starsApi();
    const sessions = agendaSessions(conf);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const days = [...new Set(sessions.map((s) => s.day))].sort();
    if (!days.length) {
      setMessage("This conference has no timed sessions.");
      return;
    }
    const picker = el("select", "cn-bry-dayselect");
    picker.setAttribute("aria-label", "Day");
    for (const d of days) {
      const o = el("option", null, dayLabel(d));
      o.value = d;
      picker.append(o);
    }
    const today = isoDayOf(new Date());
    picker.value = days.includes(today) ? today : days[0];
    bar.append(
      el("span", "cn-bry-label cn-bry-conf", (conf.conference && conf.conference.name) || slug),
      picker,
    );

    const readPicks = () => new Set(stars ? stars.list(slug) : []);
    const encode = B.StringHelper.encodeHtml;
    const time = (d) => d.toTimeString().slice(0, 5);

    const ranges = (daySessions, picks) => {
      const breaks = daySessions
        .filter((s) => s.band || !isPickable(s))
        .map((s) => ({
          id: "rest:" + s.id,
          name: s.bandLabel,
          startDate: s.startDate,
          endDate: s.endDate,
          cls: "cn-rest-range",
        }));
      const clashes = clashSpans(daySessions.filter(isTalk), picks).map((span, i) => ({
        id: "clash:" + i,
        name: "Clash",
        startDate: span.startDate,
        endDate: span.endDate,
        cls: "cn-clash-range",
      }));
      return breaks.concat(clashes);
    };

    const repaint = () => {
      if (!live() || !widget || widget.isDestroyed) return;
      const picks = readPicks();
      const daySessions = sessions.filter((s) => s.day === picker.value);
      const talks = daySessions.filter(isTalk);
      widget.eventStore.forEach((record) => {
        const session = byId.get(record.id);
        if (session) record.set(pickState(session, picks, talks));
      });
      widget.timeRangeStore.data = ranges(daySessions, picks);
      setMessage(describePicks(talks, picks, stars));
    };

    const draw = () => {
      if (!live()) return;
      destroyWidget();
      const day = picker.value;
      const picks = readPicks();
      const daySessions = sessions.filter((s) => s.day === day);
      const talks = daySessions.filter(isTalk);
      const rooms = dayRooms(conf, talks);
      let resources;
      let rowOf;
      if (rooms.length) {
        resources = rooms.map((room) => ({ id: "room:" + room, name: room || "Other" }));
        rowOf = (s) => "room:" + s.room;
      } else {
        const { count, trackOf } = packTracks(talks);
        resources = Array.from({ length: count }, (_, i) => ({
          id: "track:" + i,
          name: `Track ${i + 1}`,
        }));
        rowOf = (s) => "track:" + trackOf.get(s.id);
      }
      const firstHour = Math.min(...daySessions.map((s) => s.startDate.getHours()));
      const lastHour = Math.max(
        ...daySessions.map((s) => Math.ceil((s.endDate - dayStart(day)) / HOUR_MS)),
      );
      setMessage(describePicks(talks, picks, stars));
      widget = new B.Scheduler({
        // Bars show at once: the stock fade-in reads as a blank stage on a redraw.
        useInitialAnimation: false,
        appendTo: stage,
        startDate: new Date(dayStart(day).getTime() + firstHour * HOUR_MS),
        endDate: new Date(dayStart(day).getTime() + Math.min(24, lastHour) * HOUR_MS),
        viewPreset: ROOMS_PRESET,
        tickSize: roomsHourWidth(daySessions),
        rowHeight: ROOMS_ROW_PX,
        barMargin: 4,
        readOnly: true,
        columns: [{ text: "Room", field: "name", width: ROOM_COLUMN_PX, htmlEncode: true }],
        resources,
        eventStore: { fields: ["note", "room", "speakers", "picked"] },
        events: talks.map((s) => ({
          id: s.id,
          resourceId: rowOf(s),
          name: s.name,
          startDate: s.startDate,
          endDate: s.endDate,
          note: s.note,
          room: s.room,
          speakers: s.speakers,
          ...pickState(s, picks, talks),
        })),
        timeRanges: ranges(daySessions, picks),
        eventRenderer: ({ eventRecord }) => {
          const star = eventRecord.picked ? "★" : "☆";
          const meta = eventRecord.speakers
            ? `<span class="cn-day-meta">${encode(eventRecord.speakers)}</span>`
            : "";
          return `<span class="cn-day-head"><span class="cn-star" aria-hidden="true">${star}</span><span class="cn-bar-name">${encode(eventRecord.name)}</span></span>${meta}`;
        },
        features: {
          // The "now" line shows only while the day is on.
          timeRanges: { showCurrentTimeLine: day === today, showHeaderElements: false },
          eventDrag: false,
          eventResize: false,
          eventEdit: false,
          eventMenu: false,
          scheduleMenu: false,
          eventDragCreate: false,
          cellEdit: false,
          eventTooltip: {
            template: ({ eventRecord }) =>
              [
                eventRecord.name,
                `${time(eventRecord.startDate)}–${time(eventRecord.endDate)}`,
                eventRecord.room,
                eventRecord.speakers,
                eventRecord.picked ? "Picked: click to unpick" : "Click to pick",
              ]
                .filter(Boolean)
                .map((line) => encode(line))
                .join("<br>"),
          },
        },
        listeners: {
          eventClick: ({ eventRecord }) => {
            const session = byId.get(eventRecord.id);
            if (!stars || !session || !session.note) return;
            stars.set(slug, session.note, !readPicks().has(session.note));
            repaint();
          },
        },
      });
      // Open on the first talk, not on breakfast; scrolling left shows it.
      if (talks.length) {
        const first = talks.reduce((a, b) => (a.startDate < b.startDate ? a : b));
        widget.scrollToDate(first.startDate, { block: "start", animate: false });
      }
      dayRepaint = repaint;
    };

    picker.addEventListener("change", draw);
    draw();
  }

  // ----------------------------------------------------------- Calendar --

  async function renderCalendar(host) {
    const { stage, live } = shell(host, "calendar");
    const [B, events] = await Promise.all([loadBundle(), loadCatalogue(), loadTracking()]);
    if (!live()) return;
    const byId = new Map(events.map((e) => [e.id, e]));
    const tracked = Object.entries(tracking)
      .filter(([id, status]) => byId.has(id) && TRACKED_STATUSES.includes(status))
      .map(([id, status]) => ({ event: byId.get(id), status }));
    const rows = [];
    for (const { event, status } of tracked) {
      rows.push({
        id: event.id,
        name: event.name,
        resourceId: status,
        startDate: dayStart(event.start),
        endDate: dayEndExclusive(event.end || event.start),
        allDay: true,
      });
      for (const [index, app] of (event.applications || []).entries()) {
        if (!app.deadline) continue;
        rows.push({
          id: `${event.id}:deadline:${index}`,
          name: `${(app.type || "application").toUpperCase()} deadline · ${event.name}`,
          resourceId: "deadline",
          startDate: dayStart(app.deadline),
          endDate: dayEndExclusive(app.deadline),
          allDay: true,
          iconCls: "fa fa-flag",
          cls: "cn-deadline",
        });
      }
    }
    const first = rows.length
      ? rows.reduce((a, b) => (a.startDate < b.startDate ? a : b)).startDate
      : new Date();
    setMessage(
      tracked.length
        ? `${tracked.length} tracked event${tracked.length === 1 ? "" : "s"} · flags mark deadlines`
        : "Nothing tracked yet. Mark events going from the Trip view.",
    );
    widget = new B.Calendar({
      appendTo: stage,
      date: first,
      mode: "month",
      modes: { day: null, year: null, agenda: null },
      sidebar: false,
      readOnly: true,
      eventRenderer: textRenderer(B),
      resources: [
        { id: "going", name: "Going", eventColor: "green" },
        { id: "interested", name: "Interested", eventColor: "blue" },
        { id: "attended", name: "Attended", eventColor: "gray" },
        { id: "deadline", name: "Deadline", eventColor: "red" },
      ],
      events: rows,
    });
  }

  // ------------------------------------------------------------- render --

  async function renderView(host, ctx) {
    hostEl = host;
    contextSlug = ctx && ctx.slug;
    const renderers = {
      rooms: renderRooms,
      trip: renderTrip,
      day: renderDay,
      calendar: renderCalendar,
    };
    let current = view;
    let prefetched = null;
    try {
      // No tab chosen yet: a multi-track conference opens on Rooms, any other on Day.
      if (!renderers[current]) {
        current = "day";
        if (contextSlug) {
          prefetched = fetchConference(contextSlug);
          const conf = await prefetched;
          if (conf && Array.isArray(conf.events) && isMultiTrack(conf)) current = "rooms";
        }
        if (hostEl !== host) return;
      }
      markTab(current);
      const renderer = renderers[current];
      await renderer(host, ctx, prefetched);
    } catch (error) {
      setMessage(error && error.message ? error.message : String(error));
    }
  }

  window.confnote.drawer.register({
    id: MODULE_ID,
    label: "Planner",
    renderHead: renderViewTabs,
    render(host, ctx) {
      renderView(host, ctx);
    },
  });

  if (window.confnote.drawer.onClose) {
    window.confnote.drawer.onClose(MODULE_ID, () => {
      // A view still loading stops at its next await instead of drawing into a closed drawer.
      viewToken++;
      destroyWidget();
      hostEl = null;
    });
  }

  if (window.confnote.onContextChange) {
    window.confnote.onContextChange((ctx) => {
      // Context broadcasts fire on every navigation; redraw only on a new conference.
      const daily = !view || view === "day" || view === "rooms";
      if (hostEl && daily && ctx && ctx.slug !== contextSlug) renderView(hostEl, ctx);
    });
  }

  // A star set anywhere in the app, or in another tab, repaints the Day view's picks.
  window.addEventListener(STARS_EVENT, (e) => {
    if (dayRepaint && e.detail && e.detail.slug === contextSlug) dayRepaint();
  });
  window.addEventListener("storage", (e) => {
    if (dayRepaint && e.key === STAR_KEY_PREFIX + contextSlug) dayRepaint();
  });
})();
