// Probe a deployed host: node test/probe.mjs wss://<host> [token-env-name]. With no real token the Router's 401
// comes back as an error frame, which proves the CLI started in the container and reached the Router.
import WebSocket from "ws";
const [base, tokenEnv] = process.argv.slice(2);
const token = (tokenEnv && process.env[tokenEnv]) || "probe-invalid-token";
const ws = new WebSocket(`${base}/v1/turn`);
const started = Date.now();
ws.on("open", () => ws.send(JSON.stringify({ type: "start", routerToken: token, walletUser: process.env.PROBE_WALLET || "probe", system: "You are a test. Reply in one short sentence.", messages: [{ role: "user", content: process.env.PROBE_PROMPT || "Say hello." }], tools: [{ name: "list_conferences", description: "List the user's conferences", input_schema: { type: "object", properties: {} } }] })));
ws.on("message", (d) => {
  const f = JSON.parse(String(d));
  console.log(((Date.now() - started) / 1000).toFixed(1) + "s", JSON.stringify(f).slice(0, 300));
  if (f.type === "tool_call") ws.send(JSON.stringify({ type: "tool_result", id: f.id, result: { conferences: [{ slug: "beyond-the-prompt", name: "Beyond The Prompt" }] } }));
});
ws.on("close", (code) => { console.log("closed", code); process.exit(0); });
setTimeout(() => { console.log("timeout"); process.exit(1); }, 120_000);
