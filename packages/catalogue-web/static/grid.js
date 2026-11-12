/* The catalogue's Grid view: the same filtered events as the list, in AG Grid Community (MIT, the bundle the
   web build already ships for the Grids drawer). The page's own filters, shortlist and count drive it; the
   grid adds sorting and the shortlist column, never filters of its own, so both views always agree.
   find-events.js calls window.confnoteCatalogueGrid.show(host, events, { detailHref, tracking, onTrack, empty, sort }). */
(() => {
  "use strict";
  const BUNDLE_SRC = "/modules/aggrid/vendor/ag-grid-community.min.js";
  const TRACKING = ["", "interested", "going", "attended"];
  let bundle = null;
  let grid = null;
  let gridHost = null;
  const pending = {};

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function loadBundle() {
    if (window.agGrid) return Promise.resolve(window.agGrid);
    if (bundle) return bundle;
    bundle = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = BUNDLE_SRC;
      script.async = true;
      script.onload = () => resolve(window.agGrid);
      script.onerror = () => { bundle = null; reject(new Error("The grid could not load. Try the list.")); };
      document.head.appendChild(script);
    });
    return bundle;
  }

  // The Grids drawer's theme params (modules/aggrid/aggrid.js), so the grid follows the app's tokens and theme.
  function theme(ag) {
    return ag.themeQuartz.withParams({
      backgroundColor: "var(--panel)", foregroundColor: "var(--ink)", borderColor: "var(--line)",
      chromeBackgroundColor: "var(--bg)", accentColor: "var(--link)", fontFamily: "var(--sans)", fontSize: 13,
      headerFontWeight: 600, spacing: 7, wrapperBorderRadius: 6,
    });
  }

  function day(event, value) {
    if (!value) return "";
    if (value.length === 10 || !event.timezone) return value.slice(0, 10);
    return new Intl.DateTimeFormat("en-CA", { timeZone: event.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
  }

  // Catalogue strings are scraped: cells are DOM nodes, never HTML strings.
  function nameCell(params, options) {
    const link = document.createElement("a");
    link.href = options.detailHref(params.data.id);
    link.textContent = params.value == null ? "" : String(params.value);
    return link;
  }

  function columns(options) {
    return [
      { field: "start", headerName: "Date", width: 110, sort: options.sort, valueFormatter: (p) => day(p.data, p.value) },
      { field: "name", headerName: "Event", flex: 2, minWidth: 260, cellRenderer: (p) => nameCell(p, options) },
      { field: "city", width: 130, valueFormatter: (p) => p.value || "Online / TBA" },
      { field: "country", width: 90 },
      { field: "program", headerName: "Community", width: 150 },
      { colId: "topics", headerName: "Topics", flex: 1, minWidth: 120, valueGetter: (p) => (p.data.topics || []).join(", ") },
      { field: "end", headerName: "Through", width: 110, valueFormatter: (p) => day(p.data, p.value) },
      {
        colId: "track", headerName: "Shortlist", width: 120, pinned: "right", editable: true, sortable: false,
        // A choice shows at once as pending; only onTrack's successful save writes the shortlist itself.
        valueGetter: (p) => (p.data.id in pending ? pending[p.data.id] : options.tracking()[p.data.id] || ""),
        valueSetter: (p) => {
          if (p.newValue === p.oldValue) return false;
          pending[p.data.id] = p.newValue || "";
          return true;
        },
        valueFormatter: (p) => p.value || "Add",
        cellEditor: "agSelectCellEditor", cellEditorParams: { values: TRACKING },
        onCellValueChanged: async (p) => {
          await options.onTrack(p.data.id, p.newValue || "").catch(() => false);
          delete pending[p.data.id];
          p.api.refreshCells({ rowNodes: [p.node], columns: ["track"], force: true });
        },
      },
    ];
  }

  async function show(host, events, options) {
    const ag = await loadBundle();
    if (ag.ModuleRegistry && ag.AllCommunityModule) ag.ModuleRegistry.registerModules([ag.AllCommunityModule]);
    // A new host (the app remounted Find events) gets a new grid, bound to that mount's shortlist.
    if (grid && !grid.isDestroyed() && gridHost !== host) grid.destroy();
    if (grid && !grid.isDestroyed()) {
      grid.setGridOption("rowData", events);
      grid.setGridOption("overlayNoRowsTemplate", `<span>${escapeHtml(options.empty)}</span>`);
      grid.applyColumnState({ state: [{ colId: "start", sort: options.sort }], defaultState: { sort: null } });
      grid.refreshCells({ columns: ["track"], force: true });
      return;
    }
    gridHost = host;
    grid = ag.createGrid(host, {
      theme: theme(ag),
      rowData: events,
      columnDefs: columns(options),
      defaultColDef: { sortable: true, resizable: true, filter: false },
      getRowId: (p) => p.data.id,
      singleClickEdit: true,
      animateRows: false,
      overlayNoRowsTemplate: `<span>${escapeHtml(options.empty)}</span>`,
    });
  }

  window.confnoteCatalogueGrid = { show };
})();
