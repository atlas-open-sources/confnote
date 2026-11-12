import { describe, expect, it } from "vitest";
import { agendaFromIcal, agendaFromJsonLd, agendaLinks } from "../lib/agenda-link.js";
import { MAX_RAW_FETCH_BYTES } from "../lib/webResearch.js";

// findAgendaAt's parsers read the raw page (fetchUrlRaw, capped at MAX_RAW_FETCH_BYTES), and some of their regexes
// slow down on hostile input; at the raw cap each stays well inside a second. Before the attribute runs were bounded,
// a page of unclosed "<script " took about 1.2 s at 160 KB and would take about 45 s at 1 MB.
const BASE = "https://example.test/";
const HOSTILE = [
  '<script type="application/ld+json">',
  "<script ",
  '<meta property="og:title" ',
  "<title>",
  'href="',
  "BEGIN:VEVENT\n",
];

describe("agenda parsers on a hostile page at the raw fetch cap", () => {
  it("keeps the raw cap at 160 KB", () => {
    expect(MAX_RAW_FETCH_BYTES).toBe(160_000);
  });

  it.each(HOSTILE)("stay fast on a page full of %j", (unit) => {
    const html = unit.repeat(Math.floor(MAX_RAW_FETCH_BYTES / unit.length));
    const start = performance.now();
    agendaFromJsonLd(html, BASE);
    agendaLinks(html, BASE);
    agendaFromIcal(html, BASE);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("still reads JSON-LD sessions and agenda links", () => {
    const sessions = [1, 2, 3].map((n) => ({ "@type": "Event", name: `Talk ${n}`, startDate: `2099-05-03T0${n}:00:00Z`, endDate: `2099-05-03T0${n}:30:00Z` }));
    const html = `<meta property="og:title" content="LD Conf"><script type="application/ld+json">${JSON.stringify(sessions)}</script><a href="/agenda.ics">ics</a>`;
    expect(agendaFromJsonLd(html, BASE)?.events.length).toBe(3);
    expect(agendaLinks(html, BASE)).toEqual(["https://example.test/agenda.ics"]);
  });
});
