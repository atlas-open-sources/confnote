import type { Catalogue } from "../../events-model/src/index.js";
import { openApplications, searchEvents, type ApplicationProfile, type Filters } from "./catalogue.js";

// Anonymous callers: bound the input so one request cannot buy seconds of CPU (each topic is matched against every event).
const MAX_TEXT = 200;
const MAX_LIST = 50;
const text = { type: "string", maxLength: MAX_TEXT };
const list = { type: "array", items: text, maxItems: MAX_LIST };
const filterSchema = { type: "object", properties: Object.fromEntries(["q", "country", "city", "program", "topic", "from", "to"].map((key) => [key, text])), additionalProperties: false };
function boundedText(value: unknown): boolean { return typeof value === "string" && value.length <= MAX_TEXT; }
function boundedList(value: unknown): boolean { return Array.isArray(value) && value.length <= MAX_LIST && value.every(boundedText); }
export function mcpResponse(catalogue: Catalogue, payload: unknown, now = new Date()): unknown {
  if (!payload || typeof payload !== "object") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
  const request = payload as { jsonrpc?: string; id?: string | number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  const id = request.id ?? null;
  function result(value: unknown): unknown { return { jsonrpc: "2.0", id, result: value }; }
  if (request.jsonrpc !== "2.0") return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } };
  if (request.method === "notifications/initialized") return null;
  if (request.method === "initialize") return result({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "confnote-catalogue", version: "2.0.0" } });
  if (request.method === "ping") return result({});
  if (request.method === "tools/list") return result({ tools: [
    { name: "search_events", description: "Search public event facts. Dates are inclusive YYYY-MM-DD.", inputSchema: filterSchema, annotations: { readOnlyHint: true } },
    { name: "open_applications", description: "Find open applications matching a profile. Verify eligibility on the organizer page.", inputSchema: { type: "object", properties: { profile: { type: "object", properties: { topics: list, audience: list, country: text, city: text }, additionalProperties: false } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  ] });
  if (request.method === "tools/call") {
    try {
      const args = request.params?.arguments || {};
      let value: unknown;
      if (request.params?.name === "search_events") {
        if (Object.keys(args).some((key) => !["q", "country", "city", "program", "topic", "from", "to"].includes(key)) || !Object.values(args).every(boundedText)) throw new Error("Invalid filters");
        value = searchEvents(catalogue, args as Filters).slice(0, 200);
      } else if (request.params?.name === "open_applications") {
        const profile = args.profile ?? {};
        if (!profile || typeof profile !== "object" || Array.isArray(profile)) throw new Error("Invalid profile");
        const p = profile as Record<string, unknown>;
        if (Object.keys(p).some((key) => !["topics", "audience", "country", "city"].includes(key)) || ["topics", "audience"].some((key) => p[key] !== undefined && !boundedList(p[key])) || ["country", "city"].some((key) => p[key] !== undefined && !boundedText(p[key]))) throw new Error("Invalid profile");
        value = openApplications(catalogue, profile as ApplicationProfile, now).slice(0, 200);
      } else return { jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown read-only tool" } };
      return result({ content: [{ type: "text", text: JSON.stringify(value) }] });
    } catch (error) {
      return result({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Invalid request" }] });
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
}
