// Full private test: convert the sample GPT, check the package (including a planted-leak
// control), unit-test the Gumroad adapter, then run the OAuth + MCP end-to-end test
// against a fresh local workerd.  Usage: node test/run.mjs
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const step = (s) => console.log(`\n== ${s}`);

step("convert sample GPT");
run("node", ["tools/convert.mjs", "samples/sourdough-rescue"]);

step("check package");
run("node", ["tools/check-package.mjs", "build/sourdough-rescue-plugin.zip"]);

step("leak-check controls: each planted leak must fail the check");
const content = JSON.parse(readFileSync("src/generated/content.json", "utf8"));
const secret = [content.playbook, ...content.chunks.map((c) => c.text)].join("\n\n");
const plants = {
  "plain sentence in the skill": (d) => appendFileSync(join(d, "skills/sourdough-rescue/SKILL.md"), "\nBakers who change three things learn nothing. Give exactly one primary adjustment\n"),
  "gzip file": (d) => writeFileSync(join(d, "assets/notes.md"), gzipSync(secret)),
  "UTF-16 file": (d) => writeFileSync(join(d, "assets/notes.md"), Buffer.from(secret, "utf16le")),
  "base64 data URI in the SVG": (d) => appendFileSync(join(d, "assets/logo.svg"), `<image href="data:text/plain;base64,${Buffer.from(secret).toString("base64")}"/>`),
  "nested zip": (d) => { writeFileSync(join(d, "inner.md"), secret); execFileSync("zip", ["-qj", join(d, "assets/extra.json"), join(d, "inner.md")]); rmSync(join(d, "inner.md")); },
  "HTML tags between words": (d) => writeFileSync(join(d, "assets/page.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${content.playbook.split(" ").map((w) => `<tspan>${w}</tspan>`).join("")}</svg>`),
  "JSON unicode escapes": (d) => {
    const m = JSON.parse(readFileSync(join(d, "plugin.json"), "utf8"));
    m.keywords = ["__PLANT__"];
    const escaped = content.chunks[0].text.replace(/[^A-Za-z0-9 ,.()%]/g, " ").replace(/[a-z]/g, (c) => "\\u00" + c.charCodeAt(0).toString(16));
    writeFileSync(join(d, "plugin.json"), JSON.stringify(m).replace("__PLANT__", escaped));
  },
  "unexpected .txt file": (d) => writeFileSync(join(d, "assets/readme.txt"), "harmless"),
};
for (const [label, plant] of Object.entries(plants)) {
  const tmp = mkdtempSync(join(tmpdir(), "leak-control-"));
  cpSync("build/plugin/sourdough-rescue", join(tmp, "pkg"), { recursive: true });
  plant(join(tmp, "pkg"));
  run("zip", ["-qrX", join(tmp, "leak.zip"), "."], { cwd: join(tmp, "pkg") });
  let caught = false;
  try { execFileSync("node", ["tools/check-package.mjs", join(tmp, "leak.zip")], { stdio: "ignore" }); } catch { caught = true; }
  rmSync(tmp, { recursive: true, force: true });
  if (!caught) throw new Error(`leak control not detected: ${label}`);
  console.log(`ok   detected: ${label}`);
}

step("Gumroad adapter");
run("node", ["--test", "test/gumroad.test.mjs"]);

step("end to end on local workerd");
rmSync(".wrangler/state", { recursive: true, force: true });
run("node", ["tools/customers.mjs", "add", "buyer@example.com", "--key", "TEST-KEY-0001-AAAA-BBBB", "--local"], { stdio: "ignore" });
const server = spawn("npx", ["wrangler", "dev", "--port", "8787", "--local", "--var", "OPENAI_APPS_CHALLENGE:challenge-token-123", "--var", "USER_ID_SECRET:test-only-secret-0123456789abcdef0123"], { detached: true, stdio: "ignore" });
let code = 1;
try {
  for (let i = 0; i < 60; i++) {
    try { await fetch("http://localhost:8787/"); break; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  try { run("node", ["test/e2e.mjs"]); code = 0; } catch { code = 1; }
} finally {
  process.kill(-server.pid, "SIGTERM");
}
process.exit(code);
