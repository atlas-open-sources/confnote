import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { validateCatalogue, type Catalogue } from "../../events-model/src/index.js";
import { calendar, llmsText, searchEvents, tripEvents, type Filters, type TripStop, type When } from "../../catalogue-web/src/catalogue.js";
import { mcpResponse } from "../../catalogue-web/src/mcp.js";
import { json, method, one } from "./http.js";

const FIXTURE_CATALOGUE = path.resolve(import.meta.dirname, "../../catalogue-web/fixtures");
// Hosted builds copy the published snapshot here (scripts/build-static.mjs). The literal
// `new URL(..., import.meta.url)` lets Vercel's file tracer ship it with the function.
const BUNDLED_CATALOGUE_INDEX = fileURLToPath(new URL("../catalogue-data/index.json", import.meta.url));

function publishedCatalogueDirectory(): string | undefined {
  if (process.env.CONFNOTE_CATALOGUE_DIR) return process.env.CONFNOTE_CATALOGUE_DIR;
  if (existsSync(BUNDLED_CATALOGUE_INDEX)) return path.dirname(BUNDLED_CATALOGUE_INDEX);
  return undefined;
}

export async function readCatalogue(): Promise<Catalogue> {
  const published = publishedCatalogueDirectory();
  if (!published && process.env.CONFNOTE_PUBLIC_DEMO === "0") throw new Error("Published catalogue is not configured.");
  const directory = published || FIXTURE_CATALOGUE;
  const raw: unknown = JSON.parse(await fs.readFile(path.join(directory, "index.json"), "utf8"));
  validateCatalogue(raw);
  return raw;
}
export async function catalogueRoute(req: VercelRequest, res: VercelResponse, route: string): Promise<boolean> {
  if (route !== "catalogue" && !route.startsWith("catalogue/")) return false;
  try {
    if (route === "catalogue/llms.txt") {
      if (req.method !== "GET") { method(res); return true; }
      res.status(200).setHeader("Content-Type", "text/plain; charset=utf-8").send(llmsText()); return true;
    }
    if (route === "catalogue/mcp") {
      if (req.method !== "POST") { method(res); return true; }
      const reply = mcpResponse(await readCatalogue(), req.body);
      if (reply === null) res.status(202).end(); else json(res, 200, reply);
      return true;
    }
    if (req.method !== "GET") { method(res); return true; }
    const catalogue = await readCatalogue();
    const filters: Filters = {};
    for (const name of ["q", "country", "city", "program", "topic", "from", "to"] as const) filters[name] = one(req.query[name]);
    filters.when = one(req.query.when) as When | undefined;
    let events = searchEvents(catalogue, filters);
    // A trip's list and its calendar feed read the same stops.
    if (route === "catalogue/trip" || (route === "catalogue/calendar" && one(req.query.stops))) {
      const stops: unknown = JSON.parse(one(req.query.stops) || "[]");
      if (!Array.isArray(stops) || stops.some((stop) => !stop || typeof stop !== "object" || ["city", "from", "to"].some((key) => typeof stop[key] !== "string"))) throw new Error("Invalid trip stops.");
      events = tripEvents(catalogue, stops as TripStop[]);
    }
    if (route === "catalogue/calendar") {
      const ids = one(req.query.ids);
      if (ids) { const selected = new Set(ids.split(",")); events = events.filter((event) => selected.has(event.id)); }
      res.status(200).setHeader("Content-Type", "text/calendar; charset=utf-8").setHeader("Content-Disposition", 'inline; filename="confnote-events.ics"').send(calendar(events)); return true;
    } else if (route.startsWith("catalogue/event/")) {
      const event = catalogue.events.find((event) => event.id === route.slice("catalogue/event/".length));
      json(res, event ? 200 : 404, event || { error: "Event not found" }); return true;
    } else if (route !== "catalogue" && route !== "catalogue/trip") { json(res, 404, { error: "Not found" }); return true; }
    const published = publishedCatalogueDirectory();
    json(res, 200, { schema_version: catalogue.schema_version, events, sample: !published || path.resolve(published) === FIXTURE_CATALOGUE });
  } catch (error) {
    json(res, 400, { error: "Catalogue unavailable or invalid filters." });
  }
  return true;
}
