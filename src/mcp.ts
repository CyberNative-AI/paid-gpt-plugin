// Stateless MCP over Streamable HTTP (JSON responses). Every request already carries a
// valid access token (checked by OAuthProvider); each tool call also re-checks the purchase.
import { CONTENT, readSection, search } from "./content";
import { stillEntitled, type Env } from "./entitlement";

export interface Props { email: string; key: string }

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SCOPE = "content:read";
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true };
const securitySchemes = [{ type: "oauth2", scopes: [SCOPE] }];

export const TOOLS = [
  {
    name: "get_playbook",
    title: `Get the ${CONTENT.name} method`,
    description: `Returns the working method for ${CONTENT.name}: how to approach the user's request, what to ask, and how to format answers. Call it once at the start of a ${CONTENT.name} conversation.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: readOnly,
    securitySchemes,
    _meta: { securitySchemes },
  },
  {
    name: "search_knowledge",
    title: `Search ${CONTENT.name} reference material`,
    description: `Searches the reference documents for ${CONTENT.name} and returns the most relevant passages with their document and section.`,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Words to look for, in the user's terms." } },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: readOnly,
    securitySchemes,
    _meta: { securitySchemes },
  },
  {
    name: "read_document",
    title: `Read a ${CONTENT.name} document`,
    description: `Returns a whole reference document, or one section of it, by document ID from search results.`,
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string", enum: CONTENT.documents.map((d) => d.id), description: "Document ID." },
        section: { type: "string", description: "Optional section heading." },
      },
      required: ["doc"],
      additionalProperties: false,
    },
    annotations: readOnly,
    securitySchemes,
    _meta: { securitySchemes },
  },
];

// Shown to anyone without an active purchase. No plans, prices or links.
export const DENIAL = `This account is not linked to an active ${CONTENT.creator} purchase, so ${CONTENT.name} content is not available. If you think this is a mistake, disconnect and sign in again with the email and key from your purchase.`;

const text = (t: string) => ({ content: [{ type: "text", text: t }] });

function callTool(name: string, args: Record<string, unknown>) {
  if (name === "get_playbook") return text(CONTENT.playbook);
  if (name === "search_knowledge") {
    const query = String(args.query ?? "").slice(0, 500);
    const hits = search(query);
    if (!hits.length) return text(`No passages in the ${CONTENT.name} reference documents match "${query}".`);
    return text(hits.map((h) => `[${h.doc} § ${h.section}] ${h.title}\n${h.text}`).join("\n\n---\n\n"));
  }
  if (name === "read_document") {
    const chunks = readSection(String(args.doc ?? ""), args.section ? String(args.section) : undefined);
    if (!chunks.length) return { ...text("No such document or section."), isError: true };
    return text(chunks.map((c) => `## ${c.section}\n${c.text}`).join("\n\n"));
  }
  return null;
}

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };
const reply = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handle(msg: Rpc, env: Env, props: Props) {
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply(msg.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: CONTENT.name, version: "1.0.0" },
      });
    }
    case "ping":
      return reply(msg.id, {});
    case "tools/list":
      return reply(msg.id, { tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      if (!TOOLS.some((t) => t.name === name)) return fail(msg.id, -32602, `Unknown tool: ${name}`);
      let entitled: boolean;
      try {
        entitled = await stillEntitled(env, props.email, props.key);
      } catch {
        return reply(msg.id, { ...text("The purchase check is unavailable right now. Try again in a few minutes."), isError: true });
      }
      if (!entitled) {
        const challenge = `Bearer resource_metadata="${env.PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp", error="invalid_token", error_description="No active purchase"`;
        return reply(msg.id, { ...text(DENIAL), isError: true, _meta: { "mcp/www_authenticate": [challenge] } });
      }
      return reply(msg.id, callTool(name, msg.params?.arguments ?? {}));
    }
    default:
      return msg.id === undefined ? null : fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export const McpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props: Props }): Promise<Response> {
    if (request.method === "GET" || request.method === "DELETE") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    let body: Rpc | Rpc[];
    try {
      body = await request.json();
    } catch {
      return Response.json(fail(null, -32700, "Parse error"), { status: 400 });
    }
    const batch = Array.isArray(body) ? body : [body];
    const out = (await Promise.all(batch.map((m) => handle(m, env, ctx.props)))).filter((r) => r !== null);
    if (!out.length) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(body) ? out : out[0]);
  },
};
