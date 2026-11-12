/* Grids — AG Grid Community drawer module.
 *
 * Three grids over existing endpoints, no new write paths:
 *   Actions  — every open `- [ ]` action across conferences (/api/actions per
 *              conference); Done routes through core's tickRemoteAction.
 *   Events   — the published catalogue (/api/catalogue) with tracking
 *              (/api/tracking) where the target has signed-in tracking.
 *   Ledger   — the Router wallet's ledger (/api/wallet/usage, every page): top-ups,
 *              AI usage steps, bonuses, refunds, with a CSV export. Hosted only:
 *              the Mac app has no wallet, so it says so instead of showing rows.
 *
 * The vendored Community bundle (MIT, no key) is lazy-loaded on first open.
 * Never import an enterprise module: it needs a commercial licence key.
 */
(function () {
  if (!window.confnote || !window.confnote.drawer) return;

  const ID = "aggrid";
  const BUNDLE_SRC = "/modules/aggrid/vendor/ag-grid-community.min.js";
  // AG Charts Community (MIT), loaded only when the Ledger view opens: the balance over time above the grid.
  const CHARTS_SRC = "/modules/aggrid/vendor/ag-charts-community.min.js";
  const CHART_HEIGHT_PX = 200;
  const CHART_EMPTY = "The balance chart appears with your first ledger entry.";
  const STYLE_HREF = "/modules/aggrid/aggrid.css";
  const TRACKING_STATUSES = ["", "interested", "going", "attended"];
  // Narrower than this, a grid shows only its view's `narrow` columns, fitted to the
  // width; the rest come back when the drawer is dragged wider.
  const WIDE_GRID_PX = 640;
  // A date floating filter needs this much to show dd/mm/yyyy beside its icon.
  const DATE_COLUMN_MIN_PX = 140;
  const SIGN_IN_PROBLEM = "Sign in to see your own data here.";
  const VIEWS = [
    { id: "actions", label: "Actions" },
    { id: "events", label: "Events" },
    { id: "ledger", label: "Ledger" },
  ];

  let bundle = null;
  let chartsBundle = null;
  let chart = null;
  let chartHost = null;
  let grid = null;
  let view = "actions";
  // Set once the visitor picks a tab; until then an Actions view with nothing in it gives way to Events.
  let chosenView = false;
  let tabsEl = null;
  // Each show() takes a token; a load that a newer show() superseded (a tab
  // clicked mid-load) drops its result instead of mounting a stale grid.
  let showToken = 0;

  function loadBundle() {
    if (window.agGrid) return Promise.resolve(window.agGrid);
    if (bundle) return bundle;
    bundle = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = BUNDLE_SRC;
      script.async = true;
      script.onload = () => resolve(window.agGrid);
      script.onerror = () => {
        bundle = null;
        reject(new Error("grid bundle failed to load"));
      };
      document.head.appendChild(script);
    });
    return bundle;
  }

  function loadCharts() {
    if (window.agCharts) return Promise.resolve(window.agCharts);
    if (chartsBundle) return chartsBundle;
    chartsBundle = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = CHARTS_SRC;
      script.async = true;
      script.onload = () => resolve(window.agCharts);
      script.onerror = () => {
        chartsBundle = null;
        reject(new Error("chart bundle failed to load"));
      };
      document.head.appendChild(script);
    });
    return chartsBundle;
  }

  function destroyChart() {
    if (chart) chart.destroy();
    chart = null;
  }

  // The chart reads real colours: AG Charts can't resolve CSS variables, so take the app's current tokens.
  function token(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  // Ledger rows → points in time order: the balance after each entry; top-ups and purchases also as markers.
  function balancePoints(rows) {
    return rows
      .filter((row) => row.at && row.balanceAfter != null)
      .map((row) => ({
        time: new Date(row.at),
        balance: row.balanceAfter,
        kind: row.kind,
        amount: row.amount,
        topup: row.amount > 0 ? row.balanceAfter : undefined,
      }))
      .filter((point) => !Number.isNaN(point.time.getTime()))
      .sort((a, b) => a.time - b.time);
  }

  // The balance line (spend steps make it fall) with green markers where credits came in.
  async function renderLedgerChart(chartEl, rows, current) {
    destroyChart();
    chartEl.replaceChildren();
    const points = balancePoints(rows);
    chartEl.hidden = false;
    if (!points.length) {
      chartEl.classList.add("empty");
      chartEl.textContent = CHART_EMPTY;
      return;
    }
    chartEl.classList.remove("empty");
    let charts;
    try {
      charts = await loadCharts();
    } catch (e) {
      if (current()) chartEl.textContent = e.message;
      return;
    }
    if (!current()) return;
    const ink = token("--ink", "#111");
    const muted = token("--muted", "#666");
    const line = token("--line", "#ddd");
    const ok = token("--ok", "#34c759");
    const money = (value) => usd(value, false);
    chart = charts.AgCharts.create({
      container: chartEl,
      height: CHART_HEIGHT_PX,
      data: points,
      background: { visible: false },
      padding: { top: 8, right: 12, bottom: 4, left: 4 },
      legend: { enabled: false },
      series: [
        {
          type: "line",
          xKey: "time",
          yKey: "balance",
          yName: "Balance",
          stroke: ink,
          strokeWidth: 1.5,
          marker: { enabled: false },
          tooltip: {
            renderer: ({ datum }) => ({
              heading: datum.time.toLocaleString(),
              title: datum.kind,
              data: [{ label: "Balance after", value: money(datum.balance) }],
            }),
          },
        },
        {
          type: "scatter",
          xKey: "time",
          yKey: "topup",
          yName: "Top-up",
          fill: ok,
          stroke: ok,
          size: 9,
          tooltip: {
            renderer: ({ datum }) => ({
              heading: datum.time.toLocaleString(),
              title: datum.kind,
              data: [
                { label: "Added", value: usd(datum.amount, true) },
                { label: "Balance after", value: money(datum.balance) },
              ],
            }),
          },
        },
      ],
      // AG Charts 14 takes axes as a map keyed x / y.
      axes: {
        x: {
          type: "time",
          position: "bottom",
          label: { color: muted, fontSize: 11 },
          line: { stroke: line },
          gridLine: { enabled: false },
        },
        y: {
          type: "number",
          position: "left",
          label: { color: muted, fontSize: 11, formatter: ({ value }) => money(value) },
          gridLine: { style: [{ stroke: line, lineDash: [2, 3] }] },
        },
      },
    });
  }

  function loadStyle() {
    if (document.querySelector('link[data-confnote-grids="css"]')) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = STYLE_HREF;
    link.dataset.confnoteGrids = "css";
    document.head.appendChild(link);
  }

  async function getJson(path, opts) {
    const r = await fetch(path, opts);
    if (!r.ok) {
      const error = new Error(String(r.status));
      error.status = r.status;
      throw error;
    }
    return r.json();
  }

  // Theme params point at confnote's CSS variables, so the grid follows the
  // app's light/dark switch without rebuilding.
  function theme(ag) {
    return ag.themeQuartz.withParams({
      backgroundColor: "var(--panel)",
      foregroundColor: "var(--ink)",
      borderColor: "var(--line)",
      chromeBackgroundColor: "var(--bg)",
      accentColor: "var(--link)",
      fontFamily: "var(--sans)",
      fontSize: 12,
      headerFontWeight: 600,
      spacing: 6,
      wrapperBorderRadius: 6,
    });
  }

  // ISO strings sort and compare as dates in the date filter.
  const dateFilter = {
    minWidth: DATE_COLUMN_MIN_PX,
    filter: "agDateColumnFilter",
    filterParams: {
      comparator(filterDate, cell) {
        if (!cell) return -1;
        const day = new Date(cell.slice(0, 10) + "T00:00:00");
        if (day < filterDate) return -1;
        if (day > filterDate) return 1;
        return 0;
      },
    },
  };

  // ---------- Actions ----------------------------------------------------

  async function actionRowsFor(conf) {
    const data = await getJson(`/api/actions?slug=${encodeURIComponent(conf.slug)}`);
    const rows = [];
    for (const s of data.sessions || []) {
      // position among OPEN items only — matches tickRemoteAction's indexing
      let openPos = -1;
      for (const item of s.items || []) {
        if (item.done) continue;
        openPos += 1;
        rows.push({
          id: `${conf.slug}/${s.note}/${openPos}`,
          slug: conf.slug,
          conference: conf.name,
          date: conf.date,
          note: s.note,
          session: s.title || s.note,
          time: s.time || "",
          text: item.text,
          openPos,
        });
      }
    }
    return rows;
  }

  async function actionRows() {
    const confs = await getJson("/api/conferences");
    const lists = await Promise.all(confs.map((c) => actionRowsFor(c).catch(() => [])));
    return lists.flat();
  }

  function doneRenderer(params) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "grids-done";
    cb.setAttribute("aria-label", `Complete action: ${params.data.text}`);
    cb.addEventListener("change", async () => {
      cb.disabled = true;
      const row = params.data;
      try {
        // Passing the text makes core refuse if the note changed under us;
        // either way this conference's rows are stale now and get reloaded.
        await window.confnote.tickAction(row.slug, row.note, row.openPos, row.text);
      } catch (e) {
        cb.checked = false;
        cb.disabled = false;
        return;
      }
      const fresh = await actionRowsFor({ slug: row.slug, name: row.conference, date: row.date });
      const keep = [];
      params.api.forEachNode((node) => {
        if (node.data.slug !== row.slug) keep.push(node.data);
      });
      params.api.setGridOption("rowData", keep.concat(fresh));
    });
    return cb;
  }

  function actionsOptions() {
    return {
      columnDefs: [
        { field: "conference", filter: true, minWidth: 140 },
        { field: "date", width: 140, ...dateFilter },
        { field: "session", filter: true, minWidth: 120 },
        { field: "time", width: 80 },
        {
          field: "text",
          headerName: "Action",
          filter: true,
          flex: 2,
          minWidth: 180,
          wrapText: true,
          autoHeight: true,
        },
        {
          colId: "done",
          headerName: "Done",
          width: 70,
          minWidth: 70,
          cellRenderer: doneRenderer,
          sortable: false,
          pinned: "right",
        },
      ],
      narrow: ["session", "text", "done"],
      getRowId: (p) => p.data.id,
      overlayNoRowsTemplate: "No open actions. Capture some under ## Actions in a session note.",
      load: actionRows,
    };
  }

  // ---------- Events -----------------------------------------------------

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  }

  // Only http(s) links leave the grid; javascript:, data: and the rest become plain text.
  function webUrl(url) {
    if (!url) return "";
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
    } catch (e) {
      return "";
    }
  }

  function eventSource(event) {
    for (const evidence of Object.values(event.provenance || {})) {
      const first = Array.isArray(evidence) ? evidence[0] : null;
      if (first && first.source_url) return hostOf(first.source_url) || first.source_type || "";
    }
    return hostOf(event.url || "");
  }

  function nextDeadline(event) {
    const deadlines = (event.applications || [])
      .filter((a) => a.deadline && a.status !== "closed")
      .map((a) => a.deadline)
      .sort();
    return deadlines[0] || "";
  }

  async function eventRows() {
    const catalogue = await getJson("/api/catalogue");
    let tracking = null;
    try {
      tracking = await getJson("/api/tracking");
    } catch (e) {
      tracking = null; // local target or signed out: tracking is read-only
    }
    return (catalogue.events || []).map((e) => ({
      id: e.id,
      name: e.name,
      url: e.url || "",
      start: e.start,
      end: e.end,
      city: e.city || "",
      country: e.country || "",
      organiser: (e.organizers && e.organizers.join(", ")) || e.program || "",
      source: eventSource(e),
      deadline: nextDeadline(e),
      topics: (e.topics || []).join(", "),
      status: tracking ? tracking[e.id] || "" : null,
    }));
  }

  const rollingBack = new WeakSet();

  async function saveTracking(params) {
    if (rollingBack.delete(params.node)) return;
    const status = params.newValue || null;
    try {
      const reply = await getJson("/api/tracking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: params.data.id, status }),
      });
      // "going" answers with the event's new workspace: open it, as the
      // planner does. Same-origin paths only; the reply is server data.
      const target = reply && reply.url ? new URL(reply.url, location.origin) : null;
      if (target && target.origin === location.origin) {
        location.href = target.href;
      }
    } catch (e) {
      // The rollback fires onCellValueChanged again (possibly later); the
      // marker makes that one change skip the POST.
      rollingBack.add(params.node);
      params.node.setDataValue("status", params.oldValue);
    }
  }

  function eventsOptions() {
    return {
      columnDefs: [
        {
          field: "name",
          filter: true,
          minWidth: 160,
          flex: 2,
          // The catalogue is scraped: build DOM nodes, never return a string
          // (AG Grid inserts renderer strings as HTML).
          cellRenderer: (p) => {
            const href = webUrl(p.data.url);
            const el = document.createElement(href ? "a" : "span");
            el.textContent = p.value == null ? "" : String(p.value);
            if (href) {
              el.href = href;
              el.target = "_blank";
              el.rel = "noopener noreferrer";
            }
            return el;
          },
        },
        { field: "start", width: 120, sort: "asc", ...dateFilter },
        { field: "end", width: 120, ...dateFilter },
        { field: "city", filter: true, width: 130 },
        { field: "country", filter: true, width: 90 },
        { field: "organiser", filter: true, minWidth: 140 },
        { field: "source", filter: true, width: 140 },
        { field: "deadline", headerName: "Apply by", width: 130, ...dateFilter },
        { field: "topics", filter: true, minWidth: 140 },
        {
          field: "status",
          headerName: "Tracking",
          width: 110,
          minWidth: 110,
          pinned: "right",
          editable: (p) => p.data.status !== null,
          cellEditor: "agSelectCellEditor",
          cellEditorParams: { values: TRACKING_STATUSES },
          valueFormatter: (p) => (p.value === null ? "sign in" : p.value || "—"),
          onCellValueChanged: saveTracking,
        },
      ],
      narrow: ["name", "start", "status"],
      getRowId: (p) => p.data.id,
      singleClickEdit: true,
      overlayNoRowsTemplate: "The catalogue is empty.",
      load: eventRows,
    };
  }

  // ---------- Ledger -----------------------------------------------------
  // The Router wallet's ledger, every page of it: top-ups, auto top-ups, AI
  // usage steps, bonuses, refunds. Hosted only: the Mac app has no wallet.

  // The Router's usage kinds (wallet.history.ts) in words.
  const LEDGER_KINDS = {
    charge: "Usage step",
    grant: "Top-up",
    purchase: "Top-up",
    autotopup: "Auto top-up",
    promo: "Bonus",
    refund: "Refund",
    clawback: "Clawback",
  };
  // A PayPal order id: 12–24 upper-case letters and digits (the Router's own ledger ids start "crd_").
  const PAYPAL_ORDER = /^[A-Z0-9]{12,24}$/;
  const LEDGER_MAX_PAGES = 20;
  const SHORT_REF_CHARS = 8;
  // A spreadsheet runs a cell that starts with one of these; text that does gets a leading quote.
  const CSV_FORMULA_START = /^[=+@\t\r-]/;

  function ledgerKind(row) {
    if (row.reason === "grant" && (row.auto === true || row.trigger === "auto")) {
      return LEDGER_KINDS.autotopup;
    }
    return LEDGER_KINDS[row.reason] || row.reason || "";
  }

  function tokens(count) {
    if (count == null) return "";
    return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
  }

  // What the entry was for: the model and its tokens for a usage step.
  function ledgerStep(row) {
    if (!row.model) return "";
    const used = [];
    if (row.inputTokens != null) used.push(`${tokens(row.inputTokens)} in`);
    if (row.outputTokens != null) used.push(`${tokens(row.outputTokens)} out`);
    return used.length ? `${row.model} · ${used.join(" / ")}` : row.model;
  }

  function ledgerRow(row, index) {
    const ref = typeof row.ref === "string" ? row.ref : "";
    const amount = Number(row.charged);
    const balance = row.balanceAfter == null ? null : Number(row.balanceAfter);
    const credit = amount > 0;
    let order = typeof row.orderId === "string" ? row.orderId : "";
    if (!order && credit && PAYPAL_ORDER.test(ref)) order = ref;
    return {
      id: ref || `row-${index}`,
      at: row.at || "",
      kind: ledgerKind(row),
      amount: Number.isFinite(amount) ? amount : null,
      balanceAfter: Number.isFinite(balance) ? balance : null,
      step: ledgerStep(row),
      paypalOrder: order,
      short: ref.slice(-SHORT_REF_CHARS),
      ref,
      unit: row.unit || "USD",
    };
  }

  // Follows the Router's `next` cursor so the grid sorts and filters the whole ledger.
  async function ledgerRows() {
    const rows = [];
    let cursor = null;
    for (let page = 0; page < LEDGER_MAX_PAGES; page += 1) {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const data = await getJson(`/api/wallet/usage${query}`);
      rows.push(...(data.rows || []));
      if (!data.next || data.next === cursor) break;
      cursor = data.next;
    }
    return rows.map(ledgerRow);
  }

  function usd(value, signed) {
    if (value == null) return "";
    const abs = Math.abs(value);
    const digits = abs > 0 && abs < 1 ? 4 : 2;
    const text = `$${abs.toFixed(digits)}`;
    if (!signed) return value < 0 ? `−${text}` : text;
    if (value < 0) return `−${text}`;
    return `+${text}`;
  }

  function ledgerSummary(rows) {
    if (!rows.length) return "";
    const newest = rows.reduce((a, b) => (a.at > b.at ? a : b));
    let spent = 0;
    let added = 0;
    for (const row of rows) {
      if (row.amount < 0) spent -= row.amount;
      else if (row.amount > 0) added += row.amount;
    }
    const balance = newest.balanceAfter == null ? "" : ` · balance ${usd(newest.balanceAfter)}`;
    return `${rows.length} entries${balance} · added ${usd(added)} · spent ${usd(spent)}`;
  }

  function ledgerOptions() {
    const when = (p) =>
      p.value
        ? new Date(p.value).toLocaleString([], {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
    // The drawer is narrow: when, what and how much come first; the PayPal order and refs last.
    return {
      columnDefs: [
        {
          field: "at",
          headerName: "Date",
          sort: "desc",
          width: 170,
          valueFormatter: when,
          ...dateFilter,
        },
        { field: "kind", filter: true, width: 120 },
        {
          field: "amount",
          type: "numericColumn",
          width: 110,
          filter: "agNumberColumnFilter",
          valueFormatter: (p) => usd(p.value, true),
          cellClass: (p) => (p.value < 0 ? "grids-debit" : "grids-credit"),
        },
        {
          field: "balanceAfter",
          headerName: "Balance after",
          type: "numericColumn",
          width: 130,
          filter: "agNumberColumnFilter",
          valueFormatter: (p) => usd(p.value, false),
        },
        { field: "step", headerName: "Model / step", filter: true, minWidth: 180, flex: 1 },
        { field: "paypalOrder", headerName: "PayPal order", filter: true, width: 170 },
        {
          field: "short",
          headerName: "Short",
          width: 100,
          filter: true,
          tooltipField: "ref",
        },
      ],
      narrow: ["at", "kind", "amount"],
      getRowId: (p) => p.data.id,
      overlayNoRowsTemplate: "No ledger entries yet.",
      unavailable: "The ledger appears here once the Router wallet is connected for this account.",
      // The Mac app has no /api/wallet/usage: AI there runs on your own key or Local AI Cat.
      missing: "The ledger is the hosted app's AI credits wallet; the Mac app has none.",
      summary: ledgerSummary,
      load: ledgerRows,
    };
  }

  const OPTIONS = { actions: actionsOptions, events: eventsOptions, ledger: ledgerOptions };

  // ---------- CSV export (Community) ---------------------------------------

  // Raw values (ISO dates, plain numbers) so a spreadsheet sorts and sums them.
  function csvCell(params) {
    const value = params.value;
    if (value == null) return "";
    if (typeof value === "number") return value;
    const text = String(value);
    return CSV_FORMULA_START.test(text) ? `'${text}` : text;
  }

  // The rows as filtered and sorted, every column (hidden narrow-drawer ones too).
  function exportCsv() {
    if (!grid) return;
    const stamp = new Date().toISOString().slice(0, 10);
    grid.exportDataAsCsv({
      fileName: `confnote-${view}-${stamp}.csv`,
      columnKeys: grid
        .getColumns()
        .map((c) => c.getColId())
        .filter((id) => id !== "done"),
      processCellCallback: csvCell,
    });
  }

  // ---------- Panel ------------------------------------------------------

  // A signed-out visitor gets a sign-in hint, not an HTTP status.
  function markTabs() {
    if (!tabsEl) return;
    tabsEl.querySelectorAll(".grids-tab").forEach((t) => {
      t.classList.toggle("on", t.dataset.view === view);
    });
  }

  // The status line with one way forward: a link, or a button that runs `action`.
  function statusWith(status, text, label, action) {
    status.replaceChildren(`${text} `);
    let control;
    if (typeof action === "string") {
      control = document.createElement("a");
      control.href = action;
    } else {
      control = document.createElement("button");
      control.type = "button";
      control.addEventListener("click", action);
    }
    control.className = "grids-status-action";
    control.textContent = label;
    status.append(control);
  }

  function loadProblem(error, unavailable, missing) {
    if (error.status === 401) return SIGN_IN_PROBLEM;
    if (error.status === 404 && missing) return missing;
    return unavailable || `Could not load (${error.message}).`;
  }

  function escapeHtml(text) {
    return String(text).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  // Drawer-narrow: the view's key columns fill the width. Wider: every column, scrolling past the edge.
  function fitColumns(api, narrow, width) {
    if (!width) return;
    const wide = width >= WIDE_GRID_PX;
    const others = api
      .getColumns()
      .map((c) => c.getColId())
      .filter((id) => !narrow.includes(id));
    api.setColumnsVisible(others, wide);
    if (!wide) api.sizeColumnsToFit();
  }

  async function show(gridEl, status, quick) {
    const showId = ++showToken;
    const current = () => showId === showToken && gridEl.isConnected;
    const chartEl = chartHost;
    if (chartEl && view !== "ledger") {
      destroyChart();
      chartEl.hidden = true;
      chartEl.replaceChildren();
    }
    if (grid) {
      grid.destroy();
      grid = null;
    }
    gridEl.replaceChildren();
    status.textContent = "Loading…";
    const { load, unavailable, missing, narrow, summary, ...options } = OPTIONS[view]();
    let ag;
    try {
      ag = await loadBundle();
    } catch (e) {
      if (current()) status.textContent = e.message;
      return;
    }
    if (!current()) return;
    if (ag.ModuleRegistry && ag.AllCommunityModule) {
      ag.ModuleRegistry.registerModules([ag.AllCommunityModule]);
    }
    let rows = [];
    let problem = null;
    try {
      rows = await load();
    } catch (e) {
      problem = loadProblem(e, unavailable, missing);
    }
    if (!current()) return;
    // A new account (or a visitor signed out) has no actions: the first open shows the catalogue instead.
    if (view === "actions" && !chosenView && (problem || rows.length === 0)) {
      view = "events";
      markTabs();
      show(gridEl, status, quick);
      return;
    }
    const showEvents = () => {
      chosenView = true;
      view = "events";
      markTabs();
      show(gridEl, status, quick);
    };
    if (problem) {
      status.textContent = problem;
      if (problem === SIGN_IN_PROBLEM) {
        const back = `${location.pathname}${location.hash}`;
        statusWith(
          status,
          problem,
          "Sign in",
          `/api/auth/signin?returnTo=${encodeURIComponent(back)}`,
        );
      }
      // The empty grid says the same as the status line, never "no rows yet".
      options.overlayNoRowsTemplate = `<span>${escapeHtml(problem)}</span>`;
    } else if (view === "actions" && rows.length === 0) {
      statusWith(
        status,
        "No open actions yet. They come from “- [ ]” lines under ## Actions in a session note.",
        "Show events",
        showEvents,
      );
    } else if (view === "ledger" && rows.length === 0) {
      statusWith(
        status,
        "Each AI step and top-up appears here, with its cost and your balance, once you use the Concierge.",
        "Open the Concierge",
        () => window.confnote.drawer.open("chat"),
      );
    } else {
      status.textContent = (summary && summary(rows)) || `${rows.length} rows`;
    }
    grid = ag.createGrid(gridEl, {
      theme: theme(ag),
      rowData: rows,
      defaultColDef: { sortable: true, resizable: true, floatingFilter: true, filter: false },
      quickFilterText: quick.value,
      animateRows: true,
      onGridSizeChanged: (e) => fitColumns(e.api, narrow, e.clientWidth),
      ...options,
    });
    gridEl.dataset.view = view;
    if (view === "ledger" && chartEl) {
      if (problem) {
        destroyChart();
        chartEl.hidden = true;
      } else renderLedgerChart(chartEl, rows, current);
    }
  }

  window.confnote.drawer.register({
    id: ID,
    label: "Grids",
    render(host) {
      loadStyle();
      host.replaceChildren();
      const wrap = document.createElement("div");
      wrap.className = "grids";

      const bar = document.createElement("div");
      bar.className = "grids-bar";
      const tabs = document.createElement("div");
      tabs.className = "grids-tabs";
      tabsEl = tabs;
      tabs.setAttribute("role", "tablist");
      const quick = document.createElement("input");
      quick.type = "search";
      quick.className = "grids-quick";
      quick.placeholder = "Filter…";
      quick.addEventListener("input", () => {
        if (grid) grid.setGridOption("quickFilterText", quick.value);
      });
      const csv = document.createElement("button");
      csv.type = "button";
      csv.className = "grids-csv";
      csv.textContent = "CSV";
      csv.title = "Export the rows as filtered and sorted to a CSV file";
      csv.addEventListener("click", exportCsv);
      bar.append(tabs, quick, csv);

      const status = document.createElement("div");
      status.className = "grids-status";
      const gridEl = document.createElement("div");
      gridEl.className = "grids-grid";
      const chartEl = document.createElement("div");
      chartEl.className = "grids-chart";
      chartEl.hidden = true;
      chartEl.setAttribute("aria-label", "Balance over time");
      chartHost = chartEl;

      VIEWS.forEach((v) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "grids-tab";
        b.dataset.view = v.id;
        b.setAttribute("role", "tab");
        b.textContent = v.label;
        b.classList.toggle("on", v.id === view);
        b.addEventListener("click", () => {
          chosenView = true;
          view = v.id;
          markTabs();
          show(gridEl, status, quick);
        });
        tabs.append(b);
      });

      wrap.append(bar, status, chartEl, gridEl);
      host.append(wrap);
      show(gridEl, status, quick);
    },
  });
})();
