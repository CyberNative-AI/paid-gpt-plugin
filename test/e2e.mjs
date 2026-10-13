// End to end against local workerd (wrangler dev): OAuth discovery, DCR, PKCE, sign-in,
// token exchange and MCP tool calls through the official MCP SDK client, the same client
// library MCP Inspector uses. Run through test/run.mjs, which starts the server and seeds customers.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";

const BASE = process.env.BASE ?? "http://localhost:8787";
const MCP = new URL("/mcp", BASE);
const REDIRECT = "http://localhost:9/callback";
const content = JSON.parse(readFileSync(new URL("../src/generated/content.json", import.meta.url), "utf8"));
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(["PASS", name]); console.log(`PASS ${name}`); }
  catch (e) { results.push(["FAIL", name]); console.log(`FAIL ${name}\n  ${e.stack ?? e}\n  cause: ${e.cause?.stack ?? e.cause}`); }
};

// wrangler dev closes idle keep-alive sockets after a few seconds; retry once when a pooled
// socket was already closed ("other side closed"), as a browser or ChatGPT would reconnect.
// Applied globally because the SDK's OAuth requests use the global fetch.
const nativeFetch = globalThis.fetch;
const retryingFetch = async (url, init) => {
  try { return await nativeFetch(url, init); }
  catch (e) { if (e.cause?.code === "UND_ERR_SOCKET") return nativeFetch(url, init); throw e; }
};
globalThis.fetch = retryingFetch;

class MemoryProvider {
  constructor() { this.store = {}; this.lastAuthUrl = null; }
  get redirectUrl() { return REDIRECT; }
  get clientMetadata() { return { client_name: "e2e test client", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }; }
  clientInformation() { return this.store.client; }
  saveClientInformation(c) { this.store.client = c; }
  tokens() { return this.store.tokens; }
  saveTokens(t) { this.store.tokens = t; }
  redirectToAuthorization(url) { this.lastAuthUrl = url; }
  saveCodeVerifier(v) { this.store.verifier = v; }
  codeVerifier() { return this.store.verifier; }
}

// Plays the customer's browser on the sign-in page.
async function signIn(authUrl, email, key) {
  const page = await fetch(authUrl, { redirect: "manual" });
  assert.equal(page.status, 200, "sign-in page loads");
  const cookie = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const html = await page.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)[1];
  const post = await fetch(authUrl, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams({ handle, email, key, decision: "approve" }),
  });
  return { page: html, status: post.status, location: post.headers.get("location"), body: await post.text() };
}

async function connect(email, key) {
  const provider = new MemoryProvider();
  let transport = new StreamableHTTPClientTransport(MCP, { authProvider: provider, fetch: retryingFetch });
  const client = new Client({ name: "e2e", version: "1.0.0" });
  await assert.rejects(client.connect(transport), UnauthorizedError, "first connect needs sign-in");
  assert.ok(provider.store.client?.client_id, "dynamic client registration returned a client_id");
  const authUrl = provider.lastAuthUrl;
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authUrl.searchParams.get("resource"), MCP.href);
  const result = await signIn(authUrl, email, key);
  if (result.status !== 302) return { provider, result };
  const back = new URL(result.location);
  assert.equal(back.searchParams.get("iss"), BASE, "RFC 9207 iss returned");
  const code = decodeURIComponent(back.searchParams.get("code")).toLowerCase();
  assert.ok(!code.includes(email.toLowerCase()), "authorization code does not carry the email");
  assert.ok(!code.startsWith(createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 16)), "nor an unsalted email hash");
  await transport.finishAuth(back.searchParams.get("code"));
  transport = new StreamableHTTPClientTransport(MCP, { authProvider: provider, fetch: retryingFetch });
  const authed = new Client({ name: "e2e", version: "1.0.0" });
  await authed.connect(transport);
  return { provider, result, client: authed };
}

const UPSELL = /\b(buy|purchase now|subscribe|subscription plan|upgrade|pricing|price|trial|discount|checkout)\b|\$\d/i;
const textOf = (r) => r.content.map((c) => c.text).join("\n");

let customer;
await check("domain verification token served as exact plain text", async () => {
  const r = await fetch(new URL("/.well-known/openai-apps-challenge", BASE));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "challenge-token-123");
});

await check("unauthenticated MCP request gets 401 with resource metadata", async () => {
  const r = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(r.status, 401);
  assert.ok(r.headers.get("www-authenticate").includes(`resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", BASE).href}"`));
});

await check("entitled customer: DCR + PKCE + sign-in + token exchange + MCP connect", async () => {
  customer = await connect("Buyer@Example.com", "TEST-KEY-0001-AAAA-BBBB");
  assert.equal(customer.result.status, 302, `sign-in redirected (got ${customer.result.status})`);
  assert.ok(customer.client, "connected");
});

await check("entitled customer: tools listed with read-only annotations and oauth securitySchemes", async () => {
  const { tools } = await customer.client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["get_playbook", "read_document", "search_knowledge"]);
  for (const t of tools) {
    assert.deepEqual([t.annotations.readOnlyHint, t.annotations.destructiveHint, t.annotations.openWorldHint], [true, false, false]);
  }
});

await check("entitled customer: get_playbook returns the GPT instructions", async () => {
  const r = await customer.client.callTool({ name: "get_playbook", arguments: {} });
  assert.equal(textOf(r), content.playbook);
});

await check("entitled customer: search_knowledge finds the right section", async () => {
  const r = await customer.client.callTool({ name: "search_knowledge", arguments: { query: "flat loaf gummy crumb" } });
  assert.match(textOf(r).split("\n---")[0], /Flat loaf, gummy crumb/);
});

await check("entitled customer: read_document returns one section verbatim", async () => {
  const r = await customer.client.callTool({ name: "read_document", arguments: { doc: "troubleshooting-matrix", section: "Dense, tight crumb" } });
  assert.match(textOf(r), /weak or young starter/);
});

for (const [label, email, key] of [
  ["wrong key", "buyer@example.com", "TEST-KEY-9999-AAAA-BBBB"],
  ["unknown email", "stranger@example.com", "TEST-KEY-0001-AAAA-BBBB"],
]) {
  await check(`non-entitled (${label}): no token, neutral message, no content, no upsell`, async () => {
    const { result, client } = await connect(email, key);
    assert.equal(client, undefined, "no MCP session");
    assert.equal(result.status, 401);
    assert.match(result.body, /do not match an active purchase/);
    assert.doesNotMatch(result.body, UPSELL);
    assert.doesNotMatch(result.page + result.body, UPSELL);
    for (const chunk of content.chunks) assert.ok(!result.body.includes(chunk.text.slice(0, 60)), "no knowledge text");
    assert.ok(!result.body.includes(content.playbook.slice(0, 60)), "no playbook text");
  });
}

await check("revoked after sign-in: next tool call is denied neutrally with a re-auth challenge", async () => {
  execFileSync("node", ["tools/customers.mjs", "revoke", "buyer@example.com", "--local"], { stdio: "ignore" });
  const r = await customer.client.callTool({ name: "get_playbook", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /not linked to an active Crumb & Crust Studio purchase/);
  assert.doesNotMatch(textOf(r), UPSELL);
  assert.ok(!textOf(r).includes(content.playbook.slice(0, 60)));
  assert.match(r._meta["mcp/www_authenticate"][0], /resource_metadata=/);
});

await check("reviewer-style account signs in with email + key only (no MFA, magic link or email code)", async () => {
  execFileSync("node", ["tools/customers.mjs", "add", "reviewer@example.com", "--key", "REVIEW-KEY-0001-AAAA-BBBB", "--local"], { stdio: "ignore" });
  const r = await connect("reviewer@example.com", "REVIEW-KEY-0001-AAAA-BBBB");
  assert.equal(r.result.status, 302);
  const tools = await r.client.listTools();
  assert.equal(tools.tools.length, 3);
});

const rpc = (token, body) => retryingFetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

await check("a customer who mistypes the key can retry on the re-shown form and get in", async () => {
  const provider = new MemoryProvider();
  const transport = new StreamableHTTPClientTransport(MCP, { authProvider: provider, fetch: retryingFetch });
  await assert.rejects(new Client({ name: "e2e", version: "1.0.0" }).connect(transport), UnauthorizedError);
  const authUrl = provider.lastAuthUrl;
  const jar = new Map();
  const keep = (r) => r.headers.getSetCookie().forEach((c) => { const [kv] = c.split(";"); const [k, v] = kv.split("="); v ? jar.set(k, v) : jar.delete(k); });
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const page = await fetch(authUrl, { redirect: "manual" }); keep(page);
  let handle = (await page.text()).match(/name="handle" value="([^"]+)"/)[1];
  const post = (key) => fetch(authUrl, { method: "POST", redirect: "manual", headers: { cookie: cookie(), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle, email: "reviewer@example.com", key, decision: "approve" }) });
  const wrong = await post("REVIEW-KEY-0001-XXXX-BBBB"); keep(wrong);
  assert.equal(wrong.status, 401);
  handle = (await wrong.text()).match(/name="handle" value="([^"]+)"/)[1];
  const right = await post("REVIEW-KEY-0001-AAAA-BBBB");
  assert.equal(right.status, 302);
  assert.ok(new URL(right.headers.get("location")).searchParams.get("code"));
});

await check("forged form (no consent cookie, made-up handle) gets the same 400 for a right or wrong key", async () => {
  const authUrl = new URL(customer.provider.lastAuthUrl ?? "http://x");
  const post = (key) => fetch(new URL("/authorize?" + authUrl.searchParams, BASE), {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle: "bogus", email: "reviewer@example.com", key, decision: "approve" }),
  });
  const [right, wrong] = await Promise.all([post("REVIEW-KEY-0001-AAAA-BBBB"), post("WRONG-KEY-0001-AAAA-BBBB")]);
  assert.equal(right.status, 400);
  assert.equal(wrong.status, 400);
  assert.equal(await right.text(), await wrong.text());
});

await check("notifications get no response and run nothing; malformed batch entries are rejected", async () => {
  const token = (await (async () => { const r = await connect("reviewer@example.com", "REVIEW-KEY-0001-AAAA-BBBB"); return r.provider.store.tokens.access_token; })());
  const note = await rpc(token, { jsonrpc: "2.0", method: "tools/call", params: { name: "get_playbook", arguments: {} } });
  assert.equal(note.status, 202);
  assert.equal(await note.text(), "");
  const bad = await rpc(token, [null]);
  assert.equal(bad.status, 200);
  assert.equal((await bad.json())[0].error.code, -32600);
  const list = await (await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json();
  const listed = JSON.stringify(list);
  for (const d of content.documents) assert.ok(!listed.includes(d.id), `tools/list does not name document ${d.id}`);
});

await check("redirect to a host outside ALLOWED_REDIRECT_HOSTS is refused before sign-in", async () => {
  const reg = await (await fetch(new URL("/oauth/register", BASE), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }) })).json();
  const u = new URL("/authorize", BASE);
  Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://evil.example/cb", code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256", state: "s", scope: "content:read", resource: MCP.href }).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u, { redirect: "manual" });
  assert.equal(r.status, 400);
  assert.doesNotMatch(await r.text(), /<form/);
});

await check("per-email throttle: the 6th attempt in a minute gets 'too many attempts' (429), not 'no match'", async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await connect("throttle@example.com", `WRONG-KEY-${i}-AAAAAAAA`);
  assert.equal(last.result.status, 429);
  assert.match(last.result.body, /Too many sign-in attempts/);
});

const failed = results.filter(([s]) => s === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
