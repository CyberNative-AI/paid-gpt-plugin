#!/usr/bin/env node
// Convert a Custom GPT (gpt.json + instructions.md + knowledge/*.md|.txt) into:
//   src/generated/content.json   bundled into the Worker, served only after sign-in
//   build/plugin/<slug>/          the public plugin package (no instructions or knowledge)
//   build/<slug>-plugin.zip       the ZIP to upload in the plugin dashboard
// Usage: node tools/convert.mjs samples/sourdough-rescue
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(join(src, "gpt.json"))) {
  console.error("usage: node tools/convert.mjs <gpt-folder containing gpt.json, instructions.md, knowledge/>");
  process.exit(2);
}
const gpt = JSON.parse(readFileSync(join(src, "gpt.json"), "utf8"));
const playbook = readFileSync(join(src, "instructions.md"), "utf8").trim();

// Knowledge: split each file at Markdown headings; long sections into ~1,200-character chunks.
const documents = [];
const chunks = [];
const knowledgeDir = join(src, "knowledge");
const files = existsSync(knowledgeDir) ? readdirSync(knowledgeDir).filter((f) => [".md", ".txt"].includes(extname(f))).sort() : [];
const skipped = existsSync(knowledgeDir) ? readdirSync(knowledgeDir).filter((f) => ![".md", ".txt"].includes(extname(f))) : [];
for (const file of files) {
  const id = basename(file, extname(file));
  const raw = readFileSync(join(knowledgeDir, file), "utf8").replace(/\r\n/g, "\n");
  const title = raw.match(/^#\s+(.+)$/m)?.[1].trim() ?? id;
  documents.push({ id, title });
  const sections = raw.split(/^##\s+/m).slice(raw.match(/^##\s+/m) ? 1 : 0);
  for (const block of sections.length ? sections : [raw]) {
    const [first, ...rest] = block.split("\n");
    const section = rest.length ? first.trim() : title;
    const body = (rest.length ? rest.join("\n") : block).replace(/^#\s+.+$/m, "").trim();
    for (let i = 0; i < body.length; i += 1200) {
      chunks.push({ doc: id, title, section, text: body.slice(i, i + 1200) });
    }
  }
}
if (skipped.length) console.warn(`skipped (convert to .md or .txt first): ${skipped.join(", ")}`);

mkdirSync(join(root, "src/generated"), { recursive: true });
writeFileSync(
  join(root, "src/generated/content.json"),
  JSON.stringify({ name: gpt.name, creator: gpt.creator, supportURL: gpt.supportURL, playbook, documents, chunks }, null, 2) + "\n"
);

// Public plugin package.
const out = join(root, "build/plugin", gpt.slug);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "skills", gpt.slug), { recursive: true });
mkdirSync(join(out, "assets"), { recursive: true });

const initials = gpt.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const logo = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" rx="48" fill="${gpt.brandColor}"/><text x="128" y="160" font-family="system-ui,sans-serif" font-size="104" font-weight="700" fill="#ffffff" text-anchor="middle">${initials}</text></svg>\n`;
writeFileSync(join(out, "assets/logo.svg"), logo);

const negative = [
  { description: "Purchases are out of scope", prompt: `Buy me a ${gpt.name} subscription.` },
  { description: "Other customers' data is out of scope", prompt: `List the emails of other ${gpt.name} customers.` },
  { description: "Unrelated request", prompt: "What is the weather in Paris tomorrow?" },
];

const manifest = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: gpt.slug,
  version: "1.0.0",
  description: gpt.description,
  author: { name: gpt.creator, email: gpt.creatorEmail, url: gpt.websiteURL },
  homepage: gpt.websiteURL,
  license: "Proprietary",
  keywords: gpt.keywords ?? [],
  extensions: {
    "com.openai": {
      interface: {
        displayName: gpt.name,
        shortDescription: gpt.shortDescription,
        longDescription: gpt.description,
        developerName: gpt.creator,
        category: gpt.category,
        capabilities: gpt.capabilities,
        websiteURL: gpt.websiteURL,
        supportURL: gpt.supportURL,
        privacyPolicyURL: gpt.privacyPolicyURL,
        termsOfServiceURL: gpt.termsOfServiceURL,
        defaultPrompt: gpt.conversationStarters.slice(0, 3),
        brandColor: gpt.brandColor,
        composerIcon: "./assets/logo.svg",
        logo: "./assets/logo.svg",
      },
      review: {
        test_cases: {
          positive: gpt.reviewCases.map((c) => ({ description: c.description, prompt: c.prompt, tools_triggered: c.tools, expected_behavior: c.expected })),
          negative,
        },
        ...(gpt.demoRecordingURL ? { demo_recording_url: gpt.demoRecordingURL } : {}),
        commerce: false,
        commerce_description: "This plugin does not sell anything. Customers sign in to a purchase they already made outside ChatGPT.",
      },
      publication: {
        countries: gpt.countries ?? [],
        release_notes: `First release of ${gpt.name} as a plugin, with the same method and reference documents as the GPT.`,
      },
    },
  },
};
writeFileSync(join(out, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");

const mcp = {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {
    [gpt.slug]: {
      type: "streamable-http",
      url: gpt.mcpURL,
      extensions: { "com.openai": { auth: { type: "oauth", client: { mode: "dcr" } } } },
    },
  },
};
writeFileSync(join(out, "mcp.json"), JSON.stringify(mcp, null, 2) + "\n");

const skill = `---
name: ${gpt.slug}
description: Use for ${gpt.name} requests. ${gpt.shortDescription}. Loads the creator's method and reference documents through the ${gpt.name} tools after the customer signs in.
---

1. At the start of a ${gpt.name} conversation, call \`get_playbook\` and follow the method it returns for the rest of the conversation.
2. For facts, numbers or procedures, call \`search_knowledge\` with the user's terms. Use \`read_document\` when the user asks for a whole document or section. Cite the document and section you used.
3. If no passage matches, say the reference documents don't cover it. Don't present general knowledge as ${gpt.name}'s guidance.
4. If a tool says the account is not linked to an active purchase, tell the user exactly that and stop using these tools.
`;
writeFileSync(join(out, "skills", gpt.slug, "SKILL.md"), skill);

const zip = join(root, "build", `${gpt.slug}-plugin.zip`);
rmSync(zip, { force: true });
execFileSync("zip", ["-qrX", zip, "."], { cwd: out });

console.log(`content: ${documents.length} documents, ${chunks.length} chunks, playbook ${playbook.length} chars -> src/generated/content.json`);
console.log(`plugin:  ${out}`);
console.log(`zip:     ${zip}`);
