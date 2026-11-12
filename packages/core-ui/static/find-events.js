/* Find events: the open catalogue (search, filters, Upcoming / Past, shortlist, trip, event detail) as one
   view. The app mounts it in its own shell (home → Find events); the public /catalogue/ page mounts the same
   view. It reads /api/catalogue once and filters here, so a server that answers the whole index (the Mac app,
   the Cat) and the hosted one show the same events. Hosted-only parts (Grid, calendar feed, the account's
   shortlist and workspaces) switch on with `hosted`.

   window.confnoteFindEvents.mount(root, {
     hosted,          // web build: Grid, calendar feed, account shortlist, "Open a workspace"
     detailHref(id),  // href for an event's detail
     detailId(),      // the event id the current URL asks for, or ""
     back(),          // leave the detail for the list
   }) → { render } */
(() => {
  const TRACK_OPTIONS = [
    ["", "Add to shortlist"],
    ["interested", "Interested"],
    ["going", "Going"],
    ["attended", "Attended"],
  ];
  const TRACKED = ["interested", "going", "attended"];
  const FEED_LABEL = {
    browse: "Calendar feed ↗",
    saved: "Your shortlist as a calendar ↗",
    trip: "Your trip as a calendar ↗",
  };
  const MAX_STOPS = 20;
  // The Grid layout is AG Grid, shipped only in the web build next to the public catalogue page.
  const GRID_SCRIPT = "/catalogue/grid.js";

  function esc(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
    );
  }
  function link(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? esc(url.href) : "#";
    } catch {
      return "#";
    }
  }
  function stored(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) || fallback;
    } catch {
      return fallback;
    }
  }
  // A day where the event happens: an evening in New York is still "today" after UTC midnight.
  function localDay(value, timezone) {
    if (!value) return "";
    if (value.length === 10 || !timezone) return value.slice(0, 10);
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(value));
    } catch {
      return value.slice(0, 10);
    }
  }
  function same(a, b) {
    return !b || (a || "").toLocaleLowerCase() === b.toLocaleLowerCase();
  }
  // The catalogue's own search (catalogue-web/src/catalogue.ts searchEvents), run in the page.
  function search(events, filters, now = new Date()) {
    const found = events
      .filter((event) => {
        if (filters.when) {
          const ended =
            localDay(event.end, event.timezone) < localDay(now.toISOString(), event.timezone);
          if (ended !== (filters.when === "past")) return false;
        }
        if (!same(event.country, filters.country) || !same(event.city, filters.city)) return false;
        if (!same(event.program, filters.program)) return false;
        if (filters.topic && !(event.topics || []).some((topic) => same(topic, filters.topic)))
          return false;
        if (filters.from && localDay(event.end, event.timezone) < filters.from) return false;
        if (filters.to && localDay(event.start, event.timezone) > filters.to) return false;
        const text = [
          event.name,
          event.city,
          event.country,
          event.program,
          ...(event.topics || []),
        ];
        if (
          filters.q &&
          !text.join(" ").toLocaleLowerCase().includes(filters.q.toLocaleLowerCase())
        )
          return false;
        return true;
      })
      .sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
    return filters.when === "past" ? found.reverse() : found;
  }
  function tripSearch(events, stops) {
    const found = new Set();
    for (const stop of stops) for (const event of search(events, stop)) found.add(event.id);
    return search(events, {}).filter((event) => found.has(event.id));
  }

  const MARKUP = `<p id="sample-notice" hidden>Sample catalogue · These are fictional events for trying confnote.</p>
    <div class="find-bar">
      <nav class="pill-row view-tabs" aria-label="Catalogue view">
        <button type="button" class="pill" data-view="browse" aria-current="page">Explore</button>
        <button type="button" class="pill" data-view="trip">Plan a trip</button>
        <button type="button" class="pill" data-view="saved">Your shortlist <span id="saved-count">0</span></button>
      </nav>
      <p class="find-updated"></p>
      <button type="button" class="catalogue-refresh" hidden>Refresh catalogue</button>
    </div>
    <section id="trip-panel" hidden aria-label="Trip planner">
      <div><h2>Plan a trip</h2><p>Add the cities and dates you’ll be there.</p></div>
      <form id="trip-form">
        <label>City<input name="city" required placeholder="e.g. London"></label>
        <label>Arrive<input name="from" type="date" required></label>
        <label>Leave<input name="to" type="date" required></label>
        <button class="primary" type="submit">Add stop +</button>
      </form>
      <ul id="trip-stops"></ul>
    </section>
    <form id="filters" class="filters" aria-label="Filter events">
      <label class="search-label">Find something<input name="q" type="search" placeholder="A city, community or idea…"></label>
      <label>Country<select name="country"><option value="">Everywhere</option></select></label>
      <label>City<select name="city"><option value="">All cities</option></select></label>
      <label>Program<select name="program"><option value="">Every community</option></select></label>
      <label>Topic<select name="topic"><option value="">All topics</option></select></label>
      <label>From<input name="from" type="date"></label>
      <label>Until<input name="to" type="date"></label>
      <button type="reset" class="reset">Reset filters</button>
    </form>
    <div class="results-heading">
      <p id="result-count" aria-live="polite">Finding events…</p>
      <div class="when" role="group" aria-label="Which events">
        <button type="button" class="pill on" data-when="upcoming" aria-pressed="true">Upcoming</button>
        <button type="button" class="pill" data-when="past" aria-pressed="false">Past events</button>
      </div>
      <div class="layout" role="group" aria-label="Show events as" hidden>
        <button type="button" class="pill on" data-layout="list" aria-pressed="true">List</button>
        <button type="button" class="pill" data-layout="grid" aria-pressed="false" title="The same events in a sortable grid">Grid</button>
      </div>
      <a id="calendar" href="/api/catalogue/calendar?when=upcoming" hidden>Calendar feed ↗</a>
    </div>
    <div id="message" role="status"></div>
    <section id="events" class="event-list" aria-label="Events"></section>
    <div id="events-grid" class="events-grid" hidden aria-label="Events grid"></div>
    <section id="event-detail" hidden aria-label="Event details"></section>`;

  function mount(root, options) {
    root.classList.add("catalogue");
    root.innerHTML = MARKUP;
    const $ = (selector) => root.querySelector(selector);
    const filters = $("#filters");
    const list = $("#events");
    const detail = $("#event-detail");
    const message = $("#message");
    const gridHost = $("#events-grid");
    const hosted = Boolean(options.hosted);
    let signedIn = false;
    let events = [];
    let loaded = null;
    let failed = false;
    let view = "browse";
    // Upcoming (from today, soonest first) unless the visitor asks for past events.
    let when = "upcoming";
    let layout =
      hosted && localStorage.getItem("confnote-catalogue-layout") === "grid" ? "grid" : "list";
    let tracking = stored("confnote-event-tracking", {});
    const stops = stored("confnote-trip", []);
    let gridScript = null;
    $(".layout").hidden = !hosted;
    $("#calendar").hidden = !hosted;

    function save() {
      localStorage.setItem("confnote-event-tracking", JSON.stringify(tracking));
      localStorage.setItem("confnote-trip", JSON.stringify(stops));
    }
    function trackOptions(id) {
      return TRACK_OPTIONS.map(
        ([value, label]) =>
          `<option value="${value}"${tracking[id] === value ? " selected" : ""}>${label}</option>`,
      ).join("");
    }
    function dateLabel(event) {
      return new Date(`${localDay(event.start, event.timezone)}T12:00:00Z`).toLocaleDateString(
        "en",
        {
          month: "short",
          year: "numeric",
          timeZone: "UTC",
        },
      );
    }
    function card(event) {
      const where = [event.city || "Online / TBA", event.country, event.format].filter(Boolean);
      const tags = [event.program, ...(event.topics || [])]
        .filter(Boolean)
        .map((topic) => `<span class="tag">${esc(topic)}</span>`)
        .join("");
      const until =
        event.end !== event.start
          ? `Through ${localDay(event.end, event.timezone)}`
          : event.timezone || "Local time TBA";
      return `<article class="event-card">
        <div class="date-block">${esc(localDay(event.start, event.timezone).slice(8, 10))}<small>${esc(dateLabel(event))}</small></div>
        <div class="event-info">
          <div class="event-meta">${esc(where.join(" / "))}</div>
          <h2><a href="${esc(options.detailHref(event.id))}">${esc(event.name)}</a></h2>
          <div class="tags">${tags}</div>
        </div>
        <div class="event-action">
          <select data-track="${esc(event.id)}" aria-label="Track ${esc(event.name)}">${trackOptions(event.id)}</select>
          <small>${esc(until)}</small>
        </div>
      </article>`;
    }
    function trackedIds() {
      return Object.keys(tracking).filter((id) => TRACKED.includes(tracking[id]));
    }
    function refreshPersonal() {
      $("#saved-count").textContent = trackedIds().length;
    }
    function currentFilters() {
      return Object.fromEntries([...new FormData(filters)].filter(([, value]) => value !== ""));
    }
    // The calendar feed is always the list on screen: the same filters, the shortlist's ids or the trip's stops.
    function refreshFeed(params) {
      const feed = $("#calendar");
      const query = new URLSearchParams(params);
      if (view === "saved") query.set("ids", trackedIds().join(",") || "none");
      feed.href = `/api/catalogue/calendar?${query}`;
      feed.textContent = FEED_LABEL[view];
    }
    function countLine(count) {
      const noun = count === 1 ? "event" : "events";
      if (view === "trip") return `${count} ${noun} on your trip`;
      if (view === "saved")
        return `${count} ${when === "past" ? "past " : ""}${noun} on your shortlist`;
      return `${count} ${when === "past" ? "past" : "upcoming"} ${noun}`;
    }
    function loadGrid() {
      if (window.confnoteCatalogueGrid) return Promise.resolve(window.confnoteCatalogueGrid);
      gridScript ||= new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = GRID_SCRIPT;
        script.onload = () => resolve(window.confnoteCatalogueGrid);
        script.onerror = () => {
          gridScript = null;
          reject(new Error("The grid could not load. Try the list."));
        };
        document.head.append(script);
      });
      return gridScript;
    }
    function showGrid(visible, empty) {
      return loadGrid()
        .then((grid) =>
          grid.show(gridHost, visible, {
            empty,
            detailHref: options.detailHref,
            sort: when === "past" && view !== "trip" ? "desc" : "asc",
            tracking: () => tracking,
            onTrack: track,
          }),
        )
        .catch((error) => {
          message.textContent = error.message;
        });
    }
    function syncControls() {
      for (const button of root.querySelectorAll("[data-view]")) {
        const on = button.dataset.view === view;
        button.classList.toggle("on", on);
        if (on) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      }
      for (const button of root.querySelectorAll("[data-layout]")) {
        button.classList.toggle("on", button.dataset.layout === layout);
        button.setAttribute("aria-pressed", String(button.dataset.layout === layout));
      }
      for (const button of root.querySelectorAll("[data-when]")) {
        button.classList.toggle("on", button.dataset.when === when);
        button.setAttribute("aria-pressed", String(button.dataset.when === when));
      }
    }
    async function render() {
      await loaded;
      if (failed) return;
      message.textContent = "";
      refreshPersonal();
      const id = options.detailId();
      if (id) {
        renderDetail(id);
        return;
      }
      detail.hidden = true;
      list.hidden = layout === "grid";
      gridHost.hidden = layout !== "grid";
      filters.hidden = view === "trip";
      $(".results-heading").hidden = false;
      $("#trip-panel").hidden = view !== "trip";
      $(".when").hidden = view === "trip";
      syncControls();
      const chosen = currentFilters();
      let params = new URLSearchParams({ ...chosen, when });
      let visible;
      try {
        if (chosen.from && chosen.to && chosen.from > chosen.to)
          throw new Error("The date range ends before it starts.");
        if (view === "trip") {
          params = new URLSearchParams({ stops: JSON.stringify(stops) });
          visible = tripSearch(events, stops);
        } else {
          visible = search(events, { ...chosen, when });
        }
      } catch (error) {
        message.textContent = error.message;
        visible = [];
      }
      if (view === "saved") visible = visible.filter((event) => tracking[event.id]);
      // The list, its count and its feed change together.
      $("#result-count").textContent = countLine(visible.length);
      refreshFeed(params);
      const empty =
        view === "trip" && !stops.length
          ? "Add a city and dates to see what’s on."
          : "Nothing here yet. Try another place or date.";
      if (layout === "grid") {
        list.innerHTML = "";
        await showGrid(visible, empty);
      } else {
        list.innerHTML = visible.map(card).join("") || `<p class="empty">${empty}</p>`;
      }
    }
    function renderDetail(id) {
      const event = events.find((item) => item.id === id);
      filters.hidden = true;
      list.hidden = true;
      gridHost.hidden = true;
      detail.hidden = false;
      $("#trip-panel").hidden = true;
      $(".results-heading").hidden = true;
      if (!event) {
        detail.innerHTML =
          '<button class="detail-back" id="back" type="button">← Back to events</button><p class="empty">Event not found.</p>';
        $("#back").onclick = options.back;
        return;
      }
      const evidence = Object.entries(event.provenance || {}).flatMap(([field, entries]) =>
        entries.map((entry) => ({ field, ...entry })),
      );
      const applications =
        (event.applications || [])
          .map(
            (app) => `<div class="application">
              <a href="${link(app.url)}" target="_blank" rel="noopener noreferrer">${esc(app.type)} ↗</a>
              <p>${esc(app.status || "Check with organizer")}${app.deadline ? ` · Deadline ${esc(app.deadline)}` : ""}${app.approval ? ` · ${esc(app.approval)} approval` : ""}</p>
              ${app.eligibility ? `<p>${esc(app.eligibility)}</p>` : ""}
            </div>`,
          )
          .join("") || "<p>No applications listed. See the organizer.</p>";
      const sources =
        evidence
          .map(
            (entry) =>
              `<li><a href="${link(entry.source_url)}" rel="noopener noreferrer" target="_blank">${esc(entry.field)} ↗</a><blockquote>${esc(entry.quote)}</blockquote></li>`,
          )
          .join("") || "<li>Fixture / unverified data. Confirm with the organizer.</li>";
      const signInHref = `/api/auth/signin?returnTo=${encodeURIComponent(`${location.pathname}${location.hash}`)}`;
      const workspace = hosted
        ? `<p>Keep notes, links and the people you meet in one place.</p><a class="primary workspace-link" data-open-workspace="${esc(event.id)}" href="${esc(signInHref)}">${signedIn ? "Open a workspace" : "Sign in to open a workspace"} ↗</a>`
        : "";
      detail.innerHTML = `<button class="detail-back" id="back" type="button">← Back to events</button>
        <p class="eyebrow">${esc(event.format)} / ${esc(event.program || event.category)}</p>
        <h2 class="detail-title">${esc(event.name)}</h2>
        <p>${esc(event.start)} — ${esc(event.end)} · ${esc(event.timezone || "Timezone unconfirmed")}</p>
        <p>${esc([event.city, event.country].filter(Boolean).join(", "))}</p>
        <div class="detail-grid">
          <div><h3>Make it happen</h3>${applications}<a href="${link(event.url)}" target="_blank" rel="noopener noreferrer">Organizer’s page ↗</a></div>
          <aside>
            <h3>Your plans</h3>
            <select data-track="${esc(event.id)}" aria-label="Track ${esc(event.name)}">${trackOptions(event.id)}</select>
            ${workspace}
            <h3>Source notes</h3><ul class="source-list">${sources}</ul>
          </aside>
        </div>`;
      $("#back").onclick = options.back;
    }
    function renderStops() {
      $("#trip-stops").innerHTML = stops
        .map(
          (stop, index) =>
            `<li>${esc(stop.city)} · ${esc(stop.from)} — ${esc(stop.to)}<button type="button" data-remove="${index}" aria-label="Remove ${esc(stop.city)}">×</button></li>`,
        )
        .join("");
    }
    // A line in the message area with a Sign in link that brings the visitor back to this view.
    function signInNote(text) {
      const signIn = document.createElement("a");
      signIn.href = `/api/auth/signin?returnTo=${encodeURIComponent(`${location.pathname}${location.hash}`)}`;
      signIn.textContent = "Sign in";
      message.replaceChildren(`${text} `, signIn, " to keep your shortlist with your account.");
    }
    // One shortlist write for the list's selects and the grid's Shortlist column; false when it didn't save.
    async function track(id, value) {
      if (signedIn) {
        let response;
        let result;
        try {
          response = await fetch("/api/tracking", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ eventId: id, status: value || null }),
          });
          result = await response.json();
        } catch {
          message.textContent = "Unable to save. Check your connection.";
          return false;
        }
        if (response.status === 401) {
          signInNote("Your session ended.");
          return false;
        }
        if (!response.ok) {
          message.textContent = result.error || "Unable to save.";
          return false;
        }
        if (result.url) {
          const ready = document.createElement("a");
          ready.href = result.url;
          ready.textContent = "Your notebook is ready. Open it ↗";
          message.replaceChildren(ready);
        }
      }
      // Signed out on the hosted site the shortlist lives on this device only; say so, with the way to keep it.
      if (hosted && !signedIn && value) signInNote("Saved on this device.");
      if (value) tracking[id] = value;
      else delete tracking[id];
      save();
      refreshPersonal();
      if (view === "saved") render();
      return true;
    }
    root.addEventListener("change", async (event) => {
      const id = event.target.dataset.track;
      if (!id) return;
      if (!(await track(id, event.target.value))) event.target.value = tracking[id] || "";
    });
    root.addEventListener("click", async (event) => {
      const workspaceLink = event.target.closest("[data-open-workspace]");
      if (workspaceLink && signedIn) {
        event.preventDefault();
        const response = await fetch("/api/going", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId: workspaceLink.dataset.openWorkspace }),
        });
        const result = await response.json();
        if (response.ok) location.href = result.url;
        else message.textContent = result.error || "Notebook unavailable.";
        return;
      }
      const viewButton = event.target.closest("[data-view]");
      if (viewButton) {
        view = viewButton.dataset.view;
        if (options.detailId()) options.back();
        else render();
      }
      const layoutButton = event.target.closest("[data-layout]");
      if (layoutButton) {
        layout = layoutButton.dataset.layout;
        localStorage.setItem("confnote-catalogue-layout", layout);
        render();
      }
      const whenButton = event.target.closest("[data-when]");
      if (whenButton) {
        when = whenButton.dataset.when;
        render();
      }
      const remove = event.target.closest("[data-remove]");
      if (remove) {
        stops.splice(Number(remove.dataset.remove), 1);
        save();
        renderStops();
        render();
      }
    });
    filters.addEventListener("input", render);
    filters.addEventListener("submit", (event) => event.preventDefault());
    filters.addEventListener("reset", () => {
      setTimeout(render, 0);
    });
    $("#trip-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.target;
      const data = Object.fromEntries(new FormData(form));
      if (data.from > data.to) {
        message.textContent = "Your departure must be after your arrival.";
        return;
      }
      if (stops.length >= MAX_STOPS) {
        message.textContent = `A trip supports up to ${MAX_STOPS} stops.`;
        return;
      }
      stops.push(data);
      save();
      renderStops();
      render();
      form.reset();
    });
    const refresh = $(".catalogue-refresh");
    refresh.onclick = async () => {
      refresh.disabled = true;
      message.textContent = "Refreshing catalogue…";
      try {
        const response = await fetch("/api/catalogue/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || "Refresh unavailable");
        failed = false;
        loaded = load();
        await render();
      } catch {
        message.textContent = "Refresh failed. The saved catalogue is still available.";
      } finally {
        refresh.disabled = false;
      }
    };
    function fillOptions() {
      for (const key of ["country", "city", "program", "topic"]) {
        const select = filters.elements[key];
        const values = [
          ...new Set(
            events.flatMap((event) => (key === "topic" ? event.topics || [] : [event[key]])),
          ),
        ]
          .filter(Boolean)
          .sort();
        select.replaceChildren(select.options[0]);
        select.insertAdjacentHTML(
          "beforeend",
          values.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join(""),
        );
      }
    }
    async function load() {
      if (hosted) {
        const me = await fetch("/api/me").catch(() => null);
        signedIn = Boolean(me?.ok);
        if (signedIn) {
          const response = await fetch("/api/tracking").catch(() => null);
          if (response?.ok) tracking = await response.json();
        }
      }
      const response = await fetch("/api/catalogue").catch(() => null);
      if (!response?.ok) throw new Error("The catalogue is unavailable. Try again shortly.");
      const catalogue = await response.json();
      events = Array.isArray(catalogue.events) ? catalogue.events : [];
      $("#sample-notice").hidden = !catalogue.sample;
      $(".find-updated").textContent = catalogue.catalogue_updated_at
        ? `Updated ${new Date(catalogue.catalogue_updated_at).toLocaleDateString()}`
        : "";
      refresh.hidden = !catalogue.refresh_available;
      if (catalogue.error || catalogue.message)
        message.textContent = catalogue.error || catalogue.message;
      fillOptions();
    }
    loaded = load().catch((error) => {
      failed = true;
      message.textContent = error.message;
      $("#result-count").textContent = "Catalogue unavailable";
    });
    renderStops();
    render();
    return { render };
  }

  window.confnoteFindEvents = { mount };
})();
