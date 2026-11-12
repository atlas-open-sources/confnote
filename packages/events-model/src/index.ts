import { localDay } from "./time.js";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export interface Evidence {
  extensions?: Record<string, unknown>;
  source_url: string;
  source_type: "page" | "ical" | "api" | "json-feed" | "user-submission" | "email" | "migration";
  fetched_at: string;
  content_hash: string;
  quote: string;
  locator: string;
  extractor: { agent: string; prompt_rev: string; run: string };
  check: { rule: string; passed: boolean };
  review: { agent: string; verdict: "agree" | "disagree" | "pending"; at: string };
  license: string;
}
export type Provenance = Record<string, Evidence[]>;
export interface Entity {
  extensions?: Record<string, unknown>;
  id: string;
  name: string;
  same_as?: Record<string, string | null>;
  provenance?: Provenance;
}
export interface Application {
  extensions?: Record<string, unknown>;
  type: "register" | "apply" | "cfp" | "waitlist" | "sponsor" | "volunteer" | "scholarship" | "speaker-nomination";
  url: string;
  platform?: string;
  approval?: "none" | "manual" | "lottery" | "invite-only" | "unknown";
  opens_at?: string | null;
  deadline?: string | null;
  price?: { min?: number; max?: number; currency?: string; is_free?: boolean };
  eligibility?: string;
  capacity?: number | null;
  status?: "open" | "closed" | "waitlist" | "sold-out" | "unknown";
}
export interface Event extends Entity {
  kind: "event";
  category: string;
  format: string;
  level?: string | null;
  region?: string | null;
  start: string;
  end: string;
  timezone: string | null;
  topics: string[];
  applications: Application[];
  provenance: Provenance;
  series?: string | null;
  super_event?: string | null;
  sub_events?: string[];
  sessions?: string[];
  status?: "scheduled" | "cancelled" | "postponed" | "rescheduled" | "completed";
  attendance_mode?: "offline" | "online" | "mixed";
  venue?: string | null;
  virtual_location?: string | null;
  city?: string | null;
  country?: string | null;
  url?: string;
  audience?: string[];
  languages?: string[];
  program?: string | null;
  host_type?: string;
  organizers?: string[];
  hosts?: string[];
  sponsors?: string[];
}
export interface Session {
  extensions?: Record<string, unknown>;
  id: string; kind: "session"; event: string; title: string;
  start: string; end: string; day: string;
  room?: string; track?: string; type?: string; language?: string;
  speakers?: string[]; recording_url?: string; slides_url?: string;
  abstract_ref?: string; status?: string; provenance?: Provenance;
}
export interface Series extends Entity { kind: "series"; category?: string; url?: string }
export interface Person extends Entity { kind: "person"; affiliation?: string; links?: Record<string,string> }
export interface Organisation extends Entity { kind: "organisation"; url?: string }
export interface Venue extends Entity { kind: "venue"; address?: string; city?: string; country?: string; latitude?: number; longitude?: number }
export interface Catalogue {
  extensions?: Record<string, unknown>;
  schema_version: "events.catalogue.v2";
  events: Event[];
  series?: Series[]; sessions?: Session[]; people?: Person[]; orgs?: Organisation[]; venues?: Venue[];
}
const schema = JSON.parse(readFileSync(new URL("../schema/events-v2.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({allErrors: true});
addFormats.default(ajv);
ajv.addSchema(schema);
const catalogueValidator = ajv.compile<Catalogue>({$ref: schema.$id});
const eventValidator = ajv.compile<Event>({$ref: `${schema.$id}#/$defs/Event`});
function validateTimes(value: { start: string; end: string; timezone?: string | null }): void {
  if (value.start.length !== value.end.length && (value.start.length === 10 || value.end.length === 10)) throw new Error("start/end precision must match");
  if (Date.parse(value.end) < Date.parse(value.start)) throw new Error("end precedes start");
  if (value.timezone != null) new Intl.DateTimeFormat("en", {timeZone:value.timezone}).format();
}
export function validateEvent(value: unknown): asserts value is Event {
  if (!eventValidator(value)) throw new Error(ajv.errorsText(eventValidator.errors));
  validateTimes(value);
}
export function validateCatalogue(value: unknown): asserts value is Catalogue {
  if (!catalogueValidator(value)) throw new Error(ajv.errorsText(catalogueValidator.errors));
  const ids = new Set<string>();
  for (const entity of [...value.events,...value.series ?? [],...value.sessions ?? [],...value.people ?? [],...value.orgs ?? [],...value.venues ?? []]) {
    if (ids.has(entity.id)) throw new Error(`duplicate id: ${entity.id}`);
    ids.add(entity.id);
  }
  for (const event of value.events) validateTimes(event);
  for (const session of value.sessions ?? []) {
    validateTimes(session);
    const timezone = value.events.find(event => event.id === session.event)?.timezone;
    if (session.day !== localDay(session.start, timezone)) throw new Error("session day differs from start");
  }
}
