/* The public /catalogue/ page: the app's Find events view (core-ui find-events.js), with event details at #event/<id>. */
(() => {
  "use strict";
  const view = window.confnoteFindEvents.mount(document.querySelector("#find-events"), {
    hosted: true,
    detailHref: (id) => `#event/${encodeURIComponent(id)}`,
    detailId: () => (location.hash.startsWith("#event/") ? decodeURIComponent(location.hash.slice(7)) : ""),
    back: () => { location.hash = ""; },
  });
  window.addEventListener("hashchange", () => view.render());
})();
