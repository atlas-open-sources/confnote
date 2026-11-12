import { addWaitlistSignup, removeWaitlistSignup } from "../lib/waitlist.js";
import { productRoute } from "../lib/product.js";
import { slugify } from "../lib/agenda.js";
import type { Principal } from "../../auth/src/index.js";
import { authRoute, requestPrincipal, sameOrigin, webRequest } from "../lib/web-auth.js";
import { chatThreadStore, identityRepository, noteCoordinator } from "../lib/auth-runtime.js";
import { MAX_HISTORY_TURNS, type ChatThreadStore } from "../lib/chat-threads.js";
import { catalogueRoute } from "../lib/catalogue.js";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  actionsPayload,
  addConference,
  assetPayload,
  confDocPayload,
  conferencePayload,
  conferencesPayload,
  exportPayload,
  filesPayload,
  moduleStatePayload,
  putModuleState,
  notePayload,
  picksPayload,
  privatePayload,
  putPicks,
  putConfDoc,
  putNote,
  setupPrivate,
  uploadAsset,
  validateConference,
} from "../lib/service.js";
import { streamPlanEvents, streamWebChatEvents, type ChatHistoryBinding } from "../lib/chat.js";
import { assetHeaders, context, json, method, one, textEventStream } from "../lib/http.js";

// Hosted transcription is locked (musa, 2026-11-11: conferences may not like recording and transcription). The page
// (core-ui browser-transcribe.js) shows the Transcript tab locked, explains that transcription runs on device in the
// confnote Mac app with Local AI Cat, and lets people paste a transcript through the note API. `browser: true` +
// `locked: true` tell the page so. This server never receives audio: there is no transcription/file or recording
// route here (see the refusal below).
const settingsPayload = {
  transcription: {
    browser: true,
    locked: true,
    provider: "none",
    model: "",
    has_api_key: false,
  },
  web: true,
};
const transcriptionStatus = {
  browser: true,
  locked: true,
  provider: "none",
  available: false,
  can_record: false,
  detail: "Transcription is locked on the web; it runs on device in the confnote Mac app.",
};
const NO_AUDIO_HERE =
  "Audio never goes to confnote's servers; transcription runs on device in the confnote Mac app.";

function routePath(req: VercelRequest): string {
  const rewritten = one(req.query.route);
  if (rewritten) return rewritten.replace(/^\/+|\/+$/g, "");
  const url = new URL(req.url || "/", "https://confnote.local");
  return url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
}

function html(res: VercelResponse, status: number, body: string): void {
  res.status(status);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(body);
}

export const config = { api: { bodyParser: false } };

export interface HandlerDependencies {
  principal?: (request: Request, res: VercelResponse) => Promise<Principal | null>;
  chatThreads?: () => ChatThreadStore | undefined;
}
export function createHandler(dependencies: HandlerDependencies = {}) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    try { await handleRequest(req, res, dependencies); } catch { json(res, 503, { error: "The request could not be completed." }); }
  };
}
export default createHandler();

async function handleRequest(req: VercelRequest, res: VercelResponse, dependencies: HandlerDependencies): Promise<void> {
  const route = routePath(req);
  const request = await webRequest(req, route === "auth/webhook");
  if (await catalogueRoute(req, res, route)) return;
  if (await authRoute(req, res, route, request)) return;
  const publicDemo = process.env.CONFNOTE_PUBLIC_DEMO !== "0";
  const publicRoute = route === "waitlist" || route === "waitlist/remove";
  const principal = publicDemo || publicRoute ? null : await (dependencies.principal || requestPrincipal)(request, res);
  if (!publicDemo && !publicRoute && !principal) return json(res, 401, { error: "Sign in required.", signInUrl: "/api/auth/signin" });
  if (principal && !["GET", "HEAD"].includes(req.method || "GET")) {
    if (principal.role === "viewer") return json(res, 403, { error: "This workspace is read-only." });
    if (!request.headers.get("authorization")?.startsWith("Bearer ") && !sameOrigin(request)) return json(res, 403, { error: "Same-origin request required." });
  }
  const ctx = context(req, principal);
  const readonly = Boolean(ctx.publicDemo);
  const repo = identityRepository();
  if (principal && repo) ctx.notes = noteCoordinator();
  if (principal && repo) ctx.allocateConference = async (agenda) => (await repo.eventWorkspace(principal.userId, `${agenda.conference.date}-${slugify(agenda.conference.name)}`, agenda.conference.name)).id;
  if (await productRoute(req, res, route, ctx, repo)) return;
  // Concierge threads belong to the signed-in person in the session's workspace; demo and signed-out keep none.
  const threadStore = principal ? (dependencies.chatThreads || chatThreadStore)() : undefined;
  const chatHistory: ChatHistoryBinding | undefined = principal && threadStore
    ? { store: threadStore, owner: { workspaceId: principal.workspaceId, userId: principal.userId } }
    : undefined;

  if (route === "conferences") {
    if (req.method === "GET") return json(res, 200, await conferencesPayload(ctx));
    if (readonly) return json(res, 403, { error: "public demo is read-only" });
    if (req.method === "POST") return json(res, 201, await addConference(ctx, req.body));
    return method(res);
  }

  if (route === "conference") {
    if (req.method !== "GET") return method(res);
    const data = await conferencePayload(ctx, one(req.query.slug));
    return data ? json(res, 200, data) : json(res, 404, { error: "not found" });
  }

  if (route === "conference/validate") {
    if (req.method !== "POST") return method(res);
    return json(res, 200, await validateConference(req.body));
  }

  if (route === "note") {
    const slug = one(req.query.slug);
    const file = one(req.query.file);
    if (req.method === "GET") {
      const data = await notePayload(ctx, slug, file);
      return data ? json(res, 200, data) : json(res, 404, { error: "not found" });
    }
    if (req.method === "PUT") {
      if (readonly) return json(res, 403, { error: "public demo is read-only" });
      const result = await putNote(ctx, slug, file, req.body);
      if (!result) return json(res, 404, { error: "not found" });
      if ("conflict" in result) return json(res, 409, result);
      return json(res, 200, result);
    }
    return method(res);
  }

  if (route === "picks") {
    const slug = one(req.query.slug);
    if (req.method === "GET") {
      const data = await picksPayload(ctx, slug);
      return data ? json(res, 200, data) : json(res, 404, { error: "not found" });
    }
    if (req.method === "PUT") {
      if (readonly) return json(res, 403, { error: "public demo is read-only" });
      const result = await putPicks(ctx, slug, req.body);
      if (!result) return json(res, 404, { error: "not found" });
      if ("error" in result) return json(res, 400, result);
      return json(res, 200, result);
    }
    return method(res);
  }

  if (route === "export") {
    if (req.method !== "GET") return method(res);
    const data = await exportPayload(ctx, one(req.query.slug));
    return data ? json(res, 200, data) : json(res, 404, { error: "not found" });
  }

  if (route === "actions") {
    if (req.method !== "GET") return method(res);
    const data = await actionsPayload(ctx, one(req.query.slug));
    return data ? json(res, 200, data) : json(res, 404, { error: "not found" });
  }

  if (route === "conf-doc") {
    const slug = one(req.query.slug);
    if (req.method === "GET") {
      const data = await confDocPayload(ctx, slug);
      return data ? json(res, 200, data) : json(res, 404, { error: "not found" });
    }
    if (req.method === "PUT") {
      if (readonly) return json(res, 403, { error: "public demo is read-only" });
      const result = await putConfDoc(ctx, slug, one(req.query.name), req.body);
      if (!result) return json(res, 404, { error: "not found" });
      if ("conflict" in result) return json(res, 409, result);
      return json(res, 200, result);
    }
    return method(res);
  }

  if (route === "files") {
    if (req.method !== "GET") return method(res);
    const data = await filesPayload(ctx, one(req.query.slug), one(req.query.file));
    return data ? json(res, 200, data) : json(res, 404, { error: "not found" });
  }

  if (route === "asset") {
    if (req.method === "GET") {
      const data = await assetPayload(ctx, one(req.query.slug), one(req.query.path));
      if (!data) return json(res, 404, { error: "not found" });
      res.status(200);
      res.setHeader("Content-Type", data.contentType);
      res.setHeader("Cache-Control", "no-store");
      for (const [name, value] of Object.entries(assetHeaders(data.contentType))) res.setHeader(name, value);
      res.send(Buffer.from(data.bytes));
      return;
    }
    if (req.method === "POST") {
      if (readonly) return json(res, 403, { error: "public demo is read-only" });
      const data = await uploadAsset(ctx, one(req.query.slug), one(req.query.file), req.body);
      return data ? json(res, 200, data) : json(res, 400, { error: "bad asset upload" });
    }
    return method(res);
  }

  if (route === "private") {
    if (req.method !== "GET") return method(res);
    return json(res, 200, await privatePayload(ctx));
  }

  if (route === "private/setup") {
    if (req.method !== "POST") return method(res);
    if (readonly) return json(res, 403, { error: "public demo is read-only" });
    return json(res, 200, await setupPrivate(ctx, req.body));
  }

  if (route === "waitlist") {
    if (req.method !== "POST") return method(res);
    const repo = identityRepository();
    if (!repo) return json(res, 503, { error: "Waitlist is not configured." });
    if (!await repo.rateLimit("waitlist:global", 20, 60)) return json(res, 429, { error: "Please try again later." });
    const result = await addWaitlistSignup({ ...ctx, workspace: "waitlist" }, req.body, (bucket, limit, seconds) => repo.rateLimit(bucket, limit, seconds));
    return json(res, result.ok ? 200 : 400, result);
  }

  if (route === "waitlist/remove") {
    if (req.method !== "GET" && req.method !== "POST") return method(res);
    const token = one(req.query.token) || one((req.body as { token?: string } | undefined)?.token);
    const result = await removeWaitlistSignup({ ...ctx, workspace: "waitlist" }, token);
    if (one(req.query.format) === "json") return json(res, result.ok ? 200 : 400, result);
    const title = result.ok ? "Unsubscribed" : "Could not unsubscribe";
    const copy = result.ok ? "You have been removed from the confnote interest list." : result.error;
    return html(
      res,
      result.ok ? 200 : 400,
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body><main style="font-family:system-ui,sans-serif;max-width:36rem;margin:10vh auto;padding:0 1rem"><h1>${title}</h1><p>${copy}</p></main></body></html>`,
    );
  }

  const moduleStateMatch = /^module\/([a-z0-9][a-z0-9_-]{0,31})\/state$/.exec(route);
  if (moduleStateMatch) {
    if (req.method === "GET") {
      const data = await moduleStatePayload(ctx, moduleStateMatch[1], one(req.query.slug));
      return data === null ? json(res, 404, { error: "not found" }) : json(res, 200, data);
    }
    if (req.method === "PUT") {
      if (readonly) return json(res, 403, { error: "public demo is read-only" });
      const data = await putModuleState(ctx, moduleStateMatch[1], one(req.query.slug), req.body);
      return data === null ? json(res, 404, { error: "not found" }) : json(res, 200, data);
    }
    return method(res);
  }

  if (/^module\/([a-z0-9][a-z0-9_-]{0,31})\/(events|result)$/.test(route)) {
    return json(res, 501, { error: "module bridge is local-app only" });
  }

  if (route === "settings") {
    if (req.method === "GET" || req.method === "POST") return json(res, 200, settingsPayload);
    return method(res);
  }

  if (route === "settings/test") {
    if (req.method !== "POST") return method(res);
    return json(res, 200, { ok: false, browser: true, locked: true, detail: transcriptionStatus.detail });
  }

  if (route === "vault") {
    if (req.method !== "GET") return method(res);
    return json(res, 200, {
      current: `vercel-blob://${ctx.workspace}`,
      default: "vercel-blob://default",
      channel: "web",
      recents: [],
      env_pinned: true,
      web: true,
    });
  }

  if (route === "vault/switch") {
    if (req.method !== "POST") return method(res);
    return json(res, 403, { ok: false, error: "vault switching is local-app only" });
  }

  if (route === "transcription/status") {
    if (req.method !== "GET") return method(res);
    return json(res, 200, transcriptionStatus);
  }

  if (route.startsWith("transcription/")) return json(res, 404, { error: NO_AUDIO_HERE });

  if (route === "chat/archive") {
    if (req.method !== "POST") return method(res);
    if (!chatHistory) return json(res, 200, { ok: true, disabled: true });
    return json(res, 200, { archived: await chatHistory.store.archive(chatHistory.owner), active: null });
  }

  if (route === "chat/global") {
    if (req.method !== "POST") return method(res);
    if (readonly) {
      return textEventStream(res, "The public demo is read-only. Join the waitlist if you want to try an editable workspace.");
    }
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const abort = new AbortController();
    const disconnect = () => abort.abort(new DOMException("Client disconnected", "AbortError"));
    res.once("close", disconnect); req.once("aborted", disconnect);
    try {
      await streamWebChatEvents({ ...ctx, abortSignal: abort.signal }, {
        slug: one(req.query.slug), file: one(req.query.file), body: req.body, history: chatHistory,
      }, (event) => { if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`); });
    } finally {
      res.off("close", disconnect); req.off("aborted", disconnect);
      if (!res.destroyed) res.end();
    }
    return;
  }

  // Planner "Plan my days": a tool-less, server-prompted Concierge step (see streamPlanEvents).
  if (route === "chat/plan") {
    if (req.method !== "POST") return method(res);
    if (readonly) {
      return textEventStream(res, "The public demo is read-only. Join the waitlist if you want to try an editable workspace.");
    }
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const abort = new AbortController();
    const disconnect = () => abort.abort(new DOMException("Client disconnected", "AbortError"));
    res.once("close", disconnect); req.once("aborted", disconnect);
    try {
      await streamPlanEvents({ ...ctx, abortSignal: abort.signal }, req.body, (event) => { if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`); });
    } finally {
      res.off("close", disconnect); req.off("aborted", disconnect);
      if (!res.destroyed) res.end();
    }
    return;
  }

  if (route === "chat/history") {
    if (req.method !== "GET") return method(res);
    if (!chatHistory) return json(res, 200, { history: [] });
    const limit = Number.parseInt(one(req.query.limit), 10);
    const turns = await chatHistory.store.history(chatHistory.owner, Number.isFinite(limit) ? limit : MAX_HISTORY_TURNS);
    return json(res, 200, { history: turns });
  }

  if (route === "chat/resume") {
    if (req.method !== "POST") return method(res);
    const active = chatHistory ? await chatHistory.store.resume(chatHistory.owner, one(req.query.id)) : null;
    return active ? json(res, 200, { active }) : json(res, 404, { error: "thread not found" });
  }

  if (route === "chat/session") {
    if (req.method !== "POST") return method(res);
    if (readonly) {
      return textEventStream(res, "The public demo is read-only. Join the waitlist if you want to try an editable workspace.");
    }
    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    const abort = new AbortController();
    const disconnect = () => abort.abort(new DOMException("Client disconnected", "AbortError"));
    res.once("close", disconnect); req.once("aborted", disconnect);
    try {
      await streamWebChatEvents({ ...ctx, abortSignal: abort.signal }, {
        slug: one(req.query.slug), file: one(req.query.file), body: req.body,
      }, (event) => { if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`); });
    } finally {
      res.off("close", disconnect); req.off("aborted", disconnect);
      if (!res.destroyed) res.end();
    }
    return;
  }

  if (route === "chat/threads") {
    if (req.method !== "GET") return method(res);
    if (!chatHistory) return json(res, 200, { active: null, archived: [] });
    return json(res, 200, await chatHistory.store.list(chatHistory.owner));
  }

  return json(res, 404, { error: "not found" });
}
