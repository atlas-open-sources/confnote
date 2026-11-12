import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface FetchedPage {
  url: string;
  title?: string;
  contentType?: string;
  text: string;
  truncated?: boolean;
  trust?: typeof UNTRUSTED;
}

/** Page text and search results reach the model labelled as data, never instructions (as on the Mac). */
export const UNTRUSTED = "untrusted_data";

const MAX_FETCH_BYTES = 160_000;
const MAX_TEXT_CHARS = 18_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = "confnote-web-concierge/0.1";

function searchProvider(): string {
  return (process.env.CONFNOTE_WEB_SEARCH_PROVIDER || "auto").toLowerCase();
}

function clampResults(maxResults?: number): number {
  const value = Number(maxResults || 5);
  return Math.max(1, Math.min(10, Number.isFinite(value) ? value : 5));
}

function normalizeUrl(raw: string): URL {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http(s) URLs can be fetched.");
  }
  if (!url.hostname || ["localhost", "localhost.localdomain"].includes(url.hostname.toLowerCase())) {
    throw new Error("Local hostnames cannot be fetched.");
  }
  return url;
}

// Addresses a fetch must never reach. BlockList also matches IPv4-mapped IPv6 (::ffff:7f00:1) against the IPv4 rules.
const PRIVATE_ADDRESSES = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) PRIVATE_ADDRESSES.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::", 96], ["64:ff9b::", 96], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) PRIVATE_ADDRESSES.addSubnet(network, prefix, "ipv6");

export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (!family) return true;
  return PRIVATE_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

function literalHost(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

async function assertPublicHttpUrl(raw: string): Promise<URL> {
  const url = normalizeUrl(raw);
  const host = literalHost(url);
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("Private IP addresses cannot be fetched.");
    return url;
  }
  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length) throw new Error("Host did not resolve.");
  if (records.some((record) => isPrivateAddress(record.address))) throw new Error("Host resolves to a private IP address.");
  return url;
}

/**
 * The resolver the socket itself uses. A name can answer the guard above with a public address and the
 * connection with 127.0.0.1 (DNS rebinding), so the address is checked again at connect time.
 */
export function guardedLookup(
  hostname: string,
  options: { all?: boolean; family?: number | string },
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dnsLookup(hostname, { all: true, verbatim: true, family: options.family === 6 ? 6 : options.family === 4 ? 4 : 0 }, (error, addresses) => {
    if (error) return callback(error, "");
    if (!addresses.length || addresses.some((record) => isPrivateAddress(record.address))) {
      return callback(Object.assign(new Error("Host resolves to a private IP address."), { code: "EPRIVATEADDR" }), "");
    }
    if (options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

// Fetched pages are untrusted, so the HTML is stripped with indexOf scans that touch each character a bounded number
// of times. Lazy regexes like <script[\s\S]*?<\/script> or <[^>]+> rescan to the end of the page for every unclosed
// opener, which is quadratic: a 160 KB page of "<" took about 17 s. Same rules as the Mac app's web_fetch.py.

/** Replace each <tag>…</tag> block with a space; an unclosed block is left as it is. */
function dropBlocks(html: string, tag: string): string {
  const lower = html.toLowerCase();
  const opener = `<${tag}`;
  const closer = `</${tag}>`;
  let out = "";
  let pos = 0;
  for (;;) {
    const start = lower.indexOf(opener, pos);
    const end = start === -1 ? -1 : lower.indexOf(closer, start + opener.length);
    if (end === -1) return out + html.slice(pos);
    out += `${html.slice(pos, start)} `;
    pos = end + closer.length;
  }
}

/** Replace each <…> tag with a space. */
function dropTags(html: string): string {
  let out = "";
  let pos = 0;
  for (;;) {
    const start = html.indexOf("<", pos);
    const end = start === -1 ? -1 : html.indexOf(">", start + 1);
    if (end === -1) return out + html.slice(pos);
    out += `${html.slice(pos, start)} `;
    pos = end + 1;
  }
}

function pageTitle(html: string): string | undefined {
  const lower = html.toLowerCase();
  const start = lower.indexOf("<title");
  const openEnd = start === -1 ? -1 : lower.indexOf(">", start);
  const close = openEnd === -1 ? -1 : lower.indexOf("</title>", openEnd);
  if (close === -1) return undefined;
  return html
    .slice(openEnd + 1, close)
    .replace(/\s+/g, " ")
    .trim();
}

export function stripHtml(html: string): { title?: string; text: string } {
  const title = pageTitle(html);
  const text = dropTags(dropBlocks(dropBlocks(html, "script"), "style"))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  return { title, text };
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Search provider returned HTTP ${response.status}.`);
  return response.json();
}

interface PublicResponse {
  status: number;
  url: string;
  contentType: string;
  location?: string;
  body: Buffer;
}

/** One GET through guardedLookup, keeping at most MAX_FETCH_BYTES of the body. */
function requestPublicUrl(url: URL): Promise<PublicResponse> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: "GET",
        headers: {
          Accept: "text/html,text/plain,application/xhtml+xml,application/json;q=0.7,*/*;q=0.2",
          "User-Agent": USER_AGENT,
        },
        lookup: guardedLookup as unknown as net.LookupFunction,
        signal: AbortSignal.timeout(12_000),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({
            status: response.statusCode || 0,
            url: url.toString(),
            contentType: String(response.headers["content-type"] || ""),
            location: response.headers.location,
            body: Buffer.concat(chunks).subarray(0, MAX_FETCH_BYTES),
          });
          request.destroy();
        };
        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          length += chunk.length;
          if (length >= MAX_FETCH_BYTES) finish();
        });
        response.on("end", finish);
        response.on("error", (error) => { if (!settled) reject(error); });
      },
    );
    request.on("error", reject);
    // A 101 reply or a socket closed before any response settles neither callback above; without these the
    // promise outlives the timeout (rejecting after a resolve is a no-op).
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("Fetch returned a protocol upgrade."));
    });
    request.on("close", () => reject(new Error("Fetch closed without a response.")));
    request.end();
  });
}

async function fetchPublicUrl(url: URL, redirects = 0): Promise<PublicResponse> {
  const response = await requestPublicUrl(url);
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirects >= MAX_REDIRECTS) throw new Error("Too many redirects.");
    if (!response.location) throw new Error(`Fetch redirect missing Location header.`);
    const next = await assertPublicHttpUrl(new URL(response.location, url).toString());
    return fetchPublicUrl(next, redirects + 1);
  }
  return response;
}

export async function webSearch(query: string, maxResults?: number): Promise<{ provider: string; results: SearchResult[] } | { error: string }> {
  if (process.env.CONFNOTE_PAID_SEARCH_ENABLED !== "1") return { error: "Paid web search is disabled. Provide a public URL to fetch instead." };
  const q = query.trim();
  if (!q) return { error: "Search query is empty." };
  const count = clampResults(maxResults);
  const provider = searchProvider();

  if ((provider === "auto" || provider === "brave") && process.env.BRAVE_SEARCH_API_KEY) {
    const params = new URLSearchParams({ q, count: String(count) });
    const json = (await fetchJson(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY,
      },
    })) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    return {
      provider: "brave",
      results: (json.web?.results || [])
        .filter((item) => item.title && item.url)
        .slice(0, count)
        .map((item) => ({ title: item.title || "", url: item.url || "", snippet: item.description || "" })),
    };
  }

  if ((provider === "auto" || provider === "tavily") && process.env.TAVILY_API_KEY) {
    const json = (await fetchJson("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: q,
        max_results: count,
        search_depth: "basic",
      }),
    })) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return {
      provider: "tavily",
      results: (json.results || [])
        .filter((item) => item.title && item.url)
        .slice(0, count)
        .map((item) => ({ title: item.title || "", url: item.url || "", snippet: item.content || "" })),
    };
  }

  if ((provider === "auto" || provider === "exa") && process.env.EXA_API_KEY) {
    const json = (await fetchJson("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.EXA_API_KEY}`,
      },
      body: JSON.stringify({ query: q, numResults: count }),
    })) as { results?: Array<{ title?: string; url?: string; text?: string }> };
    return {
      provider: "exa",
      results: (json.results || [])
        .filter((item) => item.title && item.url)
        .slice(0, count)
        .map((item) => ({ title: item.title || "", url: item.url || "", snippet: item.text || "" })),
    };
  }

  return {
    error:
      "No web search provider is configured. Set BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, or EXA_API_KEY; optionally set CONFNOTE_WEB_SEARCH_PROVIDER.",
  };
}

async function fetchPublicBody(rawUrl: string): Promise<{ url: string; contentType: string; raw: string } | { error: string }> {
  let url: URL;
  try {
    url = await assertPublicHttpUrl(rawUrl);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  let response: PublicResponse;
  try {
    response = await fetchPublicUrl(url);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (response.status < 200 || response.status > 299) return { error: `Fetch returned HTTP ${response.status}.` };
  return { url: response.url, contentType: response.contentType, raw: response.body.toString("utf8") };
}

// The body as published (up to MAX_FETCH_BYTES), for structured data such as an agenda JSON manifest.
export async function fetchUrlRaw(rawUrl: string): Promise<{ url: string; text: string } | { error: string }> {
  const body = await fetchPublicBody(rawUrl);
  if ("error" in body) return body;
  return { url: body.url, text: body.raw };
}

export async function fetchUrlText(rawUrl: string): Promise<FetchedPage | { error: string }> {
  const body = await fetchPublicBody(rawUrl);
  if ("error" in body) return body;
  const { url, contentType, raw } = body;
  const parsed = /html|xml/i.test(contentType) ? stripHtml(raw) : { text: raw.replace(/\s+/g, " ").trim() };
  return {
    url,
    title: parsed.title,
    contentType,
    text: parsed.text.slice(0, MAX_TEXT_CHARS),
    truncated: parsed.text.length > MAX_TEXT_CHARS,
    trust: UNTRUSTED,
  };
}
