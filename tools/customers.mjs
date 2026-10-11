#!/usr/bin/env node
// Manage the allowlist (ENTITLEMENT_MODE=allowlist). Keys are shown once and stored only as hashes.
//   node tools/customers.mjs add <email> [--key <key>] [--local]   prints the access key to send the customer
//   node tools/customers.mjs revoke <email> [--local]
//   node tools/customers.mjs import <file.csv> [--local]            one email per line; prints email,key
// Without --local, changes go to your deployed KV namespace (wrangler must be logged in).
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const local = args.includes("--local");
const keyFlag = args.indexOf("--key");
const given = keyFlag >= 0 ? args[keyFlag + 1] : undefined;
const [command, target] = args.filter((a, i) => !a.startsWith("--") && !(keyFlag >= 0 && i === keyFlag + 1));

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newKey = () => {
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
  return chars.match(/.{4}/g).join("-");
};
const hash = (key) => createHash("sha256").update(key.trim()).digest("hex");
const norm = (email) => email.trim().toLowerCase();

function wrangler(...rest) {
  execFileSync("npx", ["wrangler", "kv", "key", ...rest, "--binding", "ENTITLEMENTS", local ? "--local" : "--remote"], { stdio: ["ignore", "ignore", "inherit"] });
}
function add(email, key = newKey()) {
  // Keys are the only secret a customer has: refuse short hand-picked ones.
  if (key.replace(/[^A-Za-z0-9]/g, "").length < 16) throw new Error("access keys need at least 16 letters or digits; omit --key to generate one");
  wrangler("put", `customer:${norm(email)}`, JSON.stringify({ keyHash: hash(key), active: true }));
  return key;
}

if (command === "add" && target) console.log(`${norm(target)},${add(target, given)}`);
else if (command === "revoke" && target) { wrangler("delete", `customer:${norm(target)}`); console.log(`revoked ${norm(target)}`); }
else if (command === "import" && target) {
  for (const line of readFileSync(target, "utf8").split(/\r?\n/)) {
    const email = line.split(",")[0].trim();
    if (email.includes("@")) console.log(`${norm(email)},${add(email)}`);
  }
} else {
  console.error("usage: customers.mjs add <email> [--key K] | revoke <email> | import <file.csv>  [--local]");
  process.exit(2);
}
