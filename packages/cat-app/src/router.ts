// The /api routes the Vercel handler (packages/web-app/api/index.ts) answers, answered in
// the page over the same service. test/router.test.ts pins that the two route lists match.
import {
  actionsPayload,
  addConference,
  conferencePayload,
  conferencesPayload,
  confDocPayload,
  filesPayload,
  notePayload,
  picksPayload,
  privatePayload,
  putPicks,
  putConfDoc,
  putNote,
  setupPrivate,
  validateConference,
} from "../../web-app/lib/service.js";
import { createStorage } from "./cat-storage.js";
import type { RequestContext } from "../../web-app/lib/types.js";

export interface CatRequest {
  method: string;
  route: string;
  query: URLSearchParams;
  body: unknown;
}

export interface CatResponse {
  status: number;
  body: unknown;
}

declare const __CONFNOTE_CATALOGUE__: { schema_version: string; events: unknown[] };

async function cataloguePayload(): Promise<unknown> {
  const local = await createStorage().readText("default/catalogue/index.json");
  if (local) {
    const data = JSON.parse(local.text);
    if (data.schema_version !== "events.catalogue.v2" || !Array.isArray(data.events)) throw new Error("Invalid catalogue index");
    return data;
  }
  if (typeof __CONFNOTE_CATALOGUE__ !== "undefined") return __CONFNOTE_CATALOGUE__;
  return { schema_version: "events.catalogue.v2", events: [], message: "No local catalogue configured yet." };
}

const ctx: RequestContext = { workspace: "default" };

const settingsPayload = {
  transcription: {
    provider: "openai",
    local_base_url: "",
    openai_base_url: "https://api.openai.com/v1",
    model: "gpt-4o-transcribe",
    save_in_cat_history: false,
    has_api_key: false,
    key_storage: "web-disabled",
  },
  web: true,
};

const disabled = (feature: string): CatResponse => ({
  status: 501,
  body: { ok: false, error: `${feature} is not part of ConfNote in the Cat yet` },
});

const ok = (body: unknown): CatResponse => ({ status: 200, body });
const notFound: CatResponse = { status: 404, body: { error: "not found" } };
const methodNotAllowed: CatResponse = { status: 405, body: { error: "method not allowed" } };

function found(data: unknown): CatResponse {
  return data ? ok(data) : notFound;
}

function saved(result: unknown): CatResponse {
  if (!result) return notFound;
  if (typeof result === "object" && "conflict" in result) return { status: 409, body: result };
  return ok(result);
}

type Handler = (request: CatRequest) => Promise<CatResponse> | CatResponse;

/// One entry per route, keyed by method. A route answered with `disabled` exists in the
/// web target but needs a network or an agent the Cat does not lend ConfNote in v1.
export const routes: Record<string, Partial<Record<string, Handler>>> = {
  catalogue: { GET: async () => ok(await cataloguePayload()) },
  conferences: {
    GET: async () => ok(await conferencesPayload(ctx)),
    POST: async ({ body }) => ({ status: 201, body: await addConference(ctx, body) }),
  },
  conference: { GET: async ({ query }) => found(await conferencePayload(ctx, query.get("slug") || "")) },
  "conference/validate": { POST: async ({ body }) => ok(await validateConference(body)) },
  note: {
    GET: async ({ query }) => found(await notePayload(ctx, query.get("slug") || "", query.get("file") || "")),
    PUT: async ({ query, body }) =>
      saved(await putNote(ctx, query.get("slug") || "", query.get("file") || "", body)),
  },
  picks: {
    GET: async ({ query }) => found(await picksPayload(ctx, query.get("slug") || "")),
    PUT: async ({ query, body }) => {
      const result = await putPicks(ctx, query.get("slug") || "", body);
      if (result && "error" in result) return { status: 400, body: result };
      return found(result);
    },
  },
  actions: { GET: async ({ query }) => found(await actionsPayload(ctx, query.get("slug") || "")) },
  "conf-doc": {
    GET: async ({ query }) => found(await confDocPayload(ctx, query.get("slug") || "")),
    PUT: async ({ query, body }) =>
      saved(await putConfDoc(ctx, query.get("slug") || "", query.get("name") || "", body)),
  },
  files: {
    GET: async ({ query }) => found(await filesPayload(ctx, query.get("slug") || "", query.get("file") || "")),
  },
  asset: { GET: () => disabled("attachments"), POST: () => disabled("attachments") },
  private: { GET: async () => ok(await privatePayload(ctx)) },
  "private/setup": { POST: async ({ body }) => ok(await setupPrivate(ctx, body)) },
  settings: { GET: () => ok(settingsPayload), POST: () => ok(settingsPayload) },
  "settings/test": { POST: () => disabled("transcription") },
  vault: {
    GET: () =>
      ok({
        current: "Local AI Cat",
        default: "Local AI Cat",
        channel: "cat",
        recents: [],
        env_pinned: true,
        web: true,
      }),
  },
  "vault/switch": { POST: () => ({ status: 403, body: { ok: false, error: "the Cat chooses ConfNote's folder" } }) },
  "transcription/status": {
    GET: () =>
      ok({ provider: "cat", ok: false, available: false, error: "transcription is not part of ConfNote in the Cat yet" }),
  },
  "chat/archive": { POST: () => ok({ ok: true, disabled: true }) },
  "chat/global": { POST: () => disabled("the Concierge") },
  "chat/history": { GET: () => ok({ history: [] }) },
  "chat/resume": { POST: () => notFound },
  "chat/session": { POST: () => disabled("the Concierge") },
  "chat/threads": { GET: () => ok({ active: null, archived: [] }) },
};

export async function handle(request: CatRequest): Promise<CatResponse> {
  const route = routes[request.route];
  if (!route) return notFound;
  const handler = route[request.method.toUpperCase()];
  if (!handler) return methodNotAllowed;
  return handler(request);
}
