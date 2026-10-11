// Full private test: convert the sample GPT, check the package (including a planted-leak
// control), unit-test the Gumroad adapter, then run the OAuth + MCP end-to-end test
// against a fresh local workerd.  Usage: node test/run.mjs
import { execFileSync, spawn } from "node:child_process";
import { cpSync, rmSync, appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });
const step = (s) => console.log(`\n== ${s}`);

step("convert sample GPT");
run("node", ["tools/convert.mjs", "samples/sourdough-rescue"]);

step("check package");
run("node", ["tools/check-package.mjs", "build/sourdough-rescue-plugin.zip"]);

step("leak-check control: a planted instruction sentence must fail the check");
const tmp = mkdtempSync(join(tmpdir(), "leak-control-"));
cpSync("build/plugin/sourdough-rescue", join(tmp, "pkg"), { recursive: true });
appendFileSync(join(tmp, "pkg/skills/sourdough-rescue/SKILL.md"), "\nBakers who change three things learn nothing. Give exactly one primary adjustment\n");
run("zip", ["-qrX", join(tmp, "leak.zip"), "."], { cwd: join(tmp, "pkg") });
try {
  execFileSync("node", ["tools/check-package.mjs", join(tmp, "leak.zip")], { stdio: "ignore" });
  throw new Error("leak control passed: the leak check is broken");
} catch (e) {
  if (e.message.includes("leak control passed")) throw e;
  console.log("ok   planted leak detected");
}
rmSync(tmp, { recursive: true, force: true });

step("Gumroad adapter");
run("node", ["--test", "test/gumroad.test.mjs"]);

step("end to end on local workerd");
rmSync(".wrangler/state", { recursive: true, force: true });
run("node", ["tools/customers.mjs", "add", "buyer@example.com", "--key", "TEST-KEY-0001", "--local"], { stdio: "ignore" });
const server = spawn("npx", ["wrangler", "dev", "--port", "8787", "--local", "--var", "OPENAI_APPS_CHALLENGE:challenge-token-123"], { detached: true, stdio: "ignore" });
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
