#!/usr/bin/env node
// Check a built plugin ZIP before upload:
//  1. leak check: no passage of the GPT's instructions or knowledge appears anywhere in the ZIP;
//  2. manifest check: fields and limits from OpenAI's plugin submission reference
//     (developers.openai.com/plugins/deploy/submission, read 2026-10-11);
//  3. review cases name only tools the Worker actually exposes.
// Usage: node tools/check-package.mjs build/<slug>-plugin.zip
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const zip = resolve(process.argv[2] ?? "");
const problems = [];
const ok = [];
const need = (cond, message) => (cond ? ok.push(message) : problems.push(message));

const dir = mkdtempSync(join(tmpdir(), "plugin-check-"));
execFileSync("unzip", ["-qq", zip, "-d", dir]);
const files = [];
const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(join(d, f))));
walk(dir);
const rel = (f) => f.slice(dir.length + 1);

// 1. Leak check. Only plain package files are allowed, so content can't hide in an
// archive, an encoding or a data: URI; text is compared as word tokens, ignoring markup,
// JSON escapes and punctuation.
const TEXT = [".json", ".md", ".svg"];
const IMAGE = { ".png": [0x89, 0x50, 0x4e, 0x47], ".jpg": [0xff, 0xd8], ".jpeg": [0xff, 0xd8], ".webp": [0x52, 0x49, 0x46, 0x46] };
const tokens = (t) => t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const strings = (v) => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);
const unmark = (t) => t.replace(/<[^>]*>/g, " ").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&[a-z]+;/gi, " ");
const haystack = [];
for (const f of files) {
  const name = rel(f);
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  const bytes = readFileSync(f);
  haystack.push(name);
  need(!(bytes[0] === 0x50 && bytes[1] === 0x4b) && !(bytes[0] === 0x1f && bytes[1] === 0x8b), `${name}: not an archive`);
  if (TEXT.includes(ext)) {
    let text = "";
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { need(false, `${name}: valid UTF-8`); continue; }
    need(!/data:/i.test(text), `${name}: no data: URIs`);
    need(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text), `${name}: no control characters (e.g. UTF-16 text)`);
    haystack.push(text, unmark(text));
    if (ext === ".json") { try { haystack.push(...strings(JSON.parse(text))); } catch { need(false, `${name}: valid JSON`); } }
  } else if (IMAGE[ext]) {
    need(IMAGE[ext].every((b, k) => bytes[k] === b), `${name}: is a real ${ext} image`);
    haystack.push(bytes.toString("latin1"));
  } else {
    need(false, `${name}: allowed file type (${[...TEXT, ...Object.keys(IMAGE)].join(" ")})`);
  }
}
const zipTokens = ` ${haystack.map((t) => tokens(t).join(" ")).join(" | ")} `;

const content = JSON.parse(readFileSync(join(root, "src/generated/content.json"), "utf8"));
let windows = 0, leaks = [];
for (const source of [content.playbook, ...content.chunks.map((c) => c.text)]) {
  const w = tokens(source);
  // Passages shorter than 8 words are checked whole when they have at least 4 words.
  const size = w.length >= 8 ? 8 : w.length >= 4 ? w.length : 0;
  for (let k = 0; size && k + size <= w.length; k++) {
    windows++;
    const phrase = w.slice(k, k + size).join(" ");
    if (zipTokens.includes(` ${phrase} `)) leaks.push(phrase);
  }
}
need(windows > 0 && leaks.length === 0, `no instructions or knowledge text in ZIP (${windows} word windows checked, ${leaks.length} found)`);
if (leaks.length) console.log("leaked:", leaks.slice(0, 5));

// 2. Manifest.
const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
const oa = manifest.extensions?.["com.openai"] ?? {};
const ui = oa.interface ?? {};
const https = (u) => typeof u === "string" && /^https:\/\/[^@\s]+$/.test(u) && u.length <= 1024;
need(manifest.$schema === "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "Agent Plugins $schema");
need(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name) && manifest.name.length <= 64, "name: kebab-case, ≤64");
need(/^\d+\.\d+\.\d+$/.test(manifest.version ?? ""), "explicit semantic version");
need((manifest.description ?? "").length <= 4000, "description ≤4000");
need(!manifest.author || (manifest.author.name?.length ?? 0) <= 120, "author.name ≤120");
need(ui.displayName && ui.displayName.length <= 30, `displayName ≤30 (${ui.displayName?.length})`);
need(!/\b(mcp|plugin)\b/i.test(ui.displayName ?? ""), "displayName has no 'MCP'/'Plugin' suffix");
need(ui.shortDescription && ui.shortDescription.length <= 30, `shortDescription ≤30 (${ui.shortDescription?.length})`);
need(ui.longDescription && ui.longDescription.length <= 4000, "longDescription present, ≤4000");
need(ui.developerName && ui.developerName.length <= 80, "developerName ≤80");
need(typeof ui.category === "string" && ui.category.length > 0, "category set");
need(!ui.capabilities || (ui.capabilities.length <= 20 && ui.capabilities.every((c) => c.length <= 120)), "capabilities ≤20 × ≤120");
for (const k of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) need(https(ui[k]), `${k}: HTTPS, ≤1024`);
const prompts = [].concat(ui.defaultPrompt ?? []);
need(prompts.length <= 3 && prompts.every((p) => p.length <= 128 && !p.includes("@")) && new Set(prompts).size === prompts.length, "defaultPrompt ≤3 unique, ≤128, no @mentions");
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
need(!ui.brandColor || (/^#[0-9A-Fa-f]{6}$/.test(ui.brandColor) && 1.05 / (luminance(ui.brandColor) + 0.05) >= 2), "brandColor #RRGGBB with ≥2:1 contrast on white");
const marketing = /\b(price|pricing|subscribe|subscription plans?|free trial|discount|promo|upgrade|cheap|best)\b|\$\d/i;
need(![ui.shortDescription, ui.longDescription, manifest.description, ...prompts].some((t) => marketing.test(t ?? "")), "listing text advertises no pricing, trials, discounts or upgrades");
for (const k of ["logo", "composerIcon"]) {
  const p = ui[k];
  const f = p && join(dir, p);
  const exists = f && files.includes(f);
  let square = false;
  if (exists && p.endsWith(".svg")) {
    const svg = readFileSync(f, "utf8");
    const vb = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    square = !!vb && vb[1] === vb[2] && Number(vb[1]) >= 48;
  }
  need(exists && p.startsWith("./") && square, `${k}: ./-relative, included, square ≥48`);
}
const pos = oa.review?.test_cases?.positive ?? [];
const neg = oa.review?.test_cases?.negative ?? [];
need(pos.length === 5 && pos.every((c) => c.description && c.prompt && c.tools_triggered && c.expected_behavior), "exactly 5 complete positive review cases");
need(neg.length === 3 && neg.every((c) => c.description && c.prompt), "exactly 3 negative review cases");
need(!JSON.stringify(manifest).match(/test_credentials|reviewer_instructions|clientSecret/), "no credentials or reviewer instructions in package");
need(!oa.apps && !oa.hooks && !files.some((f) => rel(f) === ".app.json" || rel(f).startsWith("hooks/")), "no app references or lifecycle hooks (not submittable)");
const servers = Object.entries(mcp.mcpServers ?? {});
need(mcp.$schema === "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", "mcp.json Agent Plugins $schema");
need(servers.length === 1, "exactly one MCP server (plugin-level review cases)");
const [, server] = servers[0] ?? [];
need(server?.type === "streamable-http" && https(server.url), "remote HTTPS streamable-http MCP URL");
need(!server?.headers || Object.keys(server.headers).length === 0, "no server headers");
const auth = server?.extensions?.["com.openai"]?.auth;
need(auth?.type === "oauth" && auth.client?.mode === "dcr" && !auth.client.clientId, "OAuth with DCR, no client credentials in package");
for (const f of files.filter((f) => f.endsWith("SKILL.md"))) {
  const head = readFileSync(f, "utf8").match(/^---\n([\s\S]*?)\n---/);
  need(head && /^name: \S+/m.test(head[1]) && /^description: .+/m.test(head[1]), `${rel(f)}: name + description front matter`);
}

// 3. Review cases reference real tools.
const toolNames = new Set(readFileSync(join(root, "src/mcp.ts"), "utf8").match(/name: "([a-z_]+)"/g).map((m) => m.slice(7, -1)));
const named = pos.flatMap((c) => c.tools_triggered.split(/,\s*/));
need(named.every((n) => toolNames.has(n)), `review cases name only real tools (${[...new Set(named)].join(", ")})`);
need(!oa.review?.demo_recording_url ? (console.log("note: demo_recording_url missing: required before submitting for review"), true) : https(oa.review.demo_recording_url), "demo_recording_url HTTPS when present");

rmSync(dir, { recursive: true, force: true });
for (const m of ok) console.log(`ok   ${m}`);
for (const m of problems) console.log(`FAIL ${m}`);
console.log(`\n${ok.length} ok, ${problems.length} problems`);
process.exit(problems.length ? 1 : 0);
