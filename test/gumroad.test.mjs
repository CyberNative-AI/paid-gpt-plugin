// Gumroad adapter against the response shapes of Gumroad's open-source
// Api::V2::LicensesController#verify (no live Gumroad call).
import assert from "node:assert/strict";
import { test } from "node:test";
import { GumroadEntitlement } from "../src/entitlement.ts";

const purchase = (over = {}) => ({ email: "Buyer@Example.com", refunded: false, chargebacked: false, subscription_ended_at: null, subscription_cancelled_at: null, subscription_failed_at: null, ...over });
const fake = (status, body, seen = {}) => async (url, init) => {
  seen.url = url; seen.body = String(init.body);
  return new Response(JSON.stringify(body), { status });
};
const check = (fetcher, email = "buyer@example.com") => new GumroadEntitlement("prod_123", fetcher).check(email, " LIC-KEY ");

test("active purchase with matching email is entitled; request uses product_id and does not count a use", async () => {
  const seen = {};
  assert.deepEqual(await check(fake(200, { success: true, uses: 3, purchase: purchase() }, seen)), { ok: true, email: "buyer@example.com" });
  assert.equal(seen.url, "https://api.gumroad.com/v2/licenses/verify");
  const sent = new URLSearchParams(seen.body);
  assert.equal(sent.get("product_id"), "prod_123");
  assert.equal(sent.get("license_key"), "LIC-KEY");
  assert.equal(sent.get("increment_uses_count"), "false");
});

test("a valid key bought with a different email is denied", async () => {
  assert.equal((await check(fake(200, { success: true, purchase: purchase() }), "other@example.com")).ok, false);
});

for (const [label, over] of [
  ["refunded", { refunded: true }],
  ["chargebacked", { chargebacked: true }],
  ["open dispute", { disputed: true, dispute_won: false }],
  ["ended subscription", { subscription_ended_at: "2026-11-01T00:00:00Z" }],
  ["failed subscription payment", { subscription_failed_at: "2026-11-01T00:00:00Z" }],
]) {
  test(`${label} is denied`, async () => {
    assert.equal((await check(fake(200, { success: true, purchase: purchase(over) }))).ok, false);
  });
}

test("cancelled but not yet ended subscription keeps access", async () => {
  assert.equal((await check(fake(200, { success: true, purchase: purchase({ subscription_cancelled_at: "2026-11-01T00:00:00Z" }) }))).ok, true);
});

test("disabled, unknown or revoked license (404) is denied", async () => {
  assert.equal((await check(fake(404, { success: false, message: "This license key has been disabled." }))).ok, false);
});

test("a Gumroad outage is an error, not a silent denial or approval", async () => {
  await assert.rejects(check(fake(500, { success: false })));
});
