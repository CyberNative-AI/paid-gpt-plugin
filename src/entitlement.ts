// Who may use the content. Every method answers the same question: does this email
// hold an active purchase right now? Adapters never return marketing text.

export interface Env {
  OAUTH_KV: KVNamespace;
  ENTITLEMENTS: KVNamespace;
  PUBLIC_ORIGIN: string;
  ENTITLEMENT_MODE: string;
  GUMROAD_PRODUCT_ID?: string;
  OPENAI_APPS_CHALLENGE?: string;
  ALLOWED_REDIRECT_HOSTS: string;
  USER_ID_SECRET: string;
  SIGNIN_IP_LIMIT: RateLimit;
  SIGNIN_EMAIL_LIMIT: RateLimit;
  OAUTH_PROVIDER: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
}

export type Verdict = { ok: true; email: string } | { ok: false };

export interface Entitlement {
  check(email: string, key: string): Promise<Verdict>;
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Access keys you issue to each customer. KV key `customer:<email>` holds
// {"keyHash": sha256(key), "active": true}. Add, revoke and list with tools/customers.mjs.
export class AllowlistEntitlement implements Entitlement {
  private kv: KVNamespace;
  constructor(kv: KVNamespace) {
    this.kv = kv;
  }
  async check(email: string, key: string): Promise<Verdict> {
    const address = normalizeEmail(email);
    const record = await this.kv.get<{ keyHash: string; active: boolean }>(`customer:${address}`, "json");
    if (!record || !record.active) return { ok: false };
    return sameString(record.keyHash, await sha256(key.trim())) ? { ok: true, email: address } : { ok: false };
  }
  // Re-check with the stored hash, so grants never hold the plain access key.
  async checkHash(email: string, keyHash: string): Promise<boolean> {
    const record = await this.kv.get<{ keyHash: string; active: boolean }>(`customer:${normalizeEmail(email)}`, "json");
    return !!record?.active && sameString(record.keyHash, keyHash);
  }
}

// Gumroad license keys: POST /v2/licenses/verify. A refund, chargeback, disabled key or an
// ended or failed subscription denies access; a cancelled subscription keeps access until it ends.
export class GumroadEntitlement implements Entitlement {
  private productId: string;
  private fetcher: typeof fetch;
  constructor(productId: string, fetcher: typeof fetch = fetch) {
    this.productId = productId;
    this.fetcher = fetcher;
  }
  async check(email: string, key: string): Promise<Verdict> {
    const address = normalizeEmail(email);
    const body = new URLSearchParams({
      product_id: this.productId,
      license_key: key.trim(),
      increment_uses_count: "false",
    });
    const response = await this.fetcher("https://api.gumroad.com/v2/licenses/verify", { method: "POST", body });
    if (response.status === 404) return { ok: false };
    if (!response.ok) throw new Error(`Gumroad verify returned ${response.status}`);
    const data = (await response.json()) as {
      success?: boolean;
      purchase?: {
        email?: string;
        refunded?: boolean;
        chargebacked?: boolean;
        disputed?: boolean;
        dispute_won?: boolean;
        subscription_ended_at?: string | null;
        subscription_failed_at?: string | null;
      };
    };
    const p = data.purchase;
    if (!data.success || !p?.email) return { ok: false };
    if (normalizeEmail(p.email) !== address) return { ok: false };
    if (p.refunded || p.chargebacked || (p.disputed && !p.dispute_won)) return { ok: false };
    if (p.subscription_ended_at || p.subscription_failed_at) return { ok: false };
    return { ok: true, email: address };
  }
}

export function entitlementFor(env: Env): Entitlement {
  if (env.ENTITLEMENT_MODE === "gumroad") {
    if (!env.GUMROAD_PRODUCT_ID) throw new Error("GUMROAD_PRODUCT_ID is required in gumroad mode");
    return new GumroadEntitlement(env.GUMROAD_PRODUCT_ID);
  }
  return new AllowlistEntitlement(env.ENTITLEMENTS);
}

// Re-check on use so a refund or revocation takes effect within RECHECK_SECONDS,
// without calling the store on every tool call.
const RECHECK_SECONDS = 600;

// What a grant keeps for re-checks: the key hash in allowlist mode, the license key for Gumroad.
export async function grantSecret(env: Env, key: string): Promise<string> {
  return env.ENTITLEMENT_MODE === "gumroad" ? key : sha256(key.trim());
}

export async function stillEntitled(env: Env, email: string, key: string): Promise<boolean> {
  // The allowlist is one KV read, so it is checked on every call (KV edge reads can lag
  // a write by up to about a minute).
  if (env.ENTITLEMENT_MODE !== "gumroad") return new AllowlistEntitlement(env.ENTITLEMENTS).checkHash(email, key);
  const cacheKey = `check:${await sha256(`${env.ENTITLEMENT_MODE}\n${normalizeEmail(email)}\n${key}`)}`;
  if ((await env.ENTITLEMENTS.get(cacheKey)) === "ok") return true;
  const verdict = await entitlementFor(env).check(email, key);
  if (verdict.ok) await env.ENTITLEMENTS.put(cacheKey, "ok", { expirationTtl: RECHECK_SECONDS });
  return verdict.ok;
}

// Slow down key guessing: Workers rate-limiting bindings count atomically per location.
export async function signInAllowed(env: Env, ip: string, email: string): Promise<boolean> {
  const [byIp, byEmail] = await Promise.all([
    env.SIGNIN_IP_LIMIT.limit({ key: `ip:${ip}` }),
    env.SIGNIN_EMAIL_LIMIT.limit({ key: `email:${normalizeEmail(email)}` }),
  ]);
  return byIp.success && byEmail.success;
}

// Stable per-customer ID for grants. Codes and tokens embed it, so it is keyed with a secret:
// a guessed email cannot be confirmed from a code.
export async function userIdFor(env: Env, email: string): Promise<string> {
  if (!env.USER_ID_SECRET || env.USER_ID_SECRET.length < 32) throw new Error("USER_ID_SECRET (32+ characters) is required");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.USER_ID_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(normalizeEmail(email)));
  return [...new Uint8Array(mac)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}
