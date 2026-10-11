import { AuthorizationError, CimdFetchError, OAuthProvider, type ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { CONTENT } from "./content";
import { entitlementFor, normalizeEmail, recordFailure, tooManyFailures, sha256, type Env, type Verdict } from "./entitlement";
import { McpApiHandler, type Props } from "./mcp";

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Neutral: the same words for an unknown email, a wrong key, a refund or a revoked key.
const NOT_FOUND = "That email and key do not match an active purchase. Check both and try again.";
const KEY_LABEL: Record<string, string> = { allowlist: "Access key", gumroad: "Gumroad license key" };

function signInPage(env: Env, details: ConsentDescription, handle: string, message = "", email = ""): string {
  const client = details.clientDomain
    ? `<strong>${escape(details.clientName)}</strong> (${escape(details.clientDomain)})`
    : `<strong>${escape(details.clientName)}</strong> (name not verified)`;
  const keyLabel = KEY_LABEL[env.ENTITLEMENT_MODE] ?? "Access key";
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to ${escape(CONTENT.name)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
label{display:block;margin:1rem 0 .25rem;font-weight:600}input{width:100%;padding:.6rem;font:inherit;box-sizing:border-box;border:1px solid #888;border-radius:6px}
button{margin-top:1.25rem;padding:.6rem 1rem;font:inherit;border-radius:6px;border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;cursor:pointer}
button.secondary{background:#fff;color:#1a1a1a;margin-left:.5rem}.note{color:#444;font-size:.9rem}.error{color:#a40000;font-weight:600}
</style>
<h1>Sign in to ${escape(CONTENT.name)}</h1>
<p>Use the email and ${escape(keyLabel.toLowerCase())} from your ${escape(CONTENT.creator)} purchase.</p>
${message ? `<p class="error" role="alert">${escape(message)}</p>` : ""}
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${escape(email)}">
  <label for="key">${escape(keyLabel)}</label><input id="key" name="key" type="password" autocomplete="off" required>
  <p class="note">Signing in lets ${client} read ${escape(CONTENT.name)}'s method and reference documents for you. Access goes to <strong>${escape(details.redirectHost)}</strong>.${details.redirectIsLoopback ? " <strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it." : ""}</p>
  <button name="decision" value="approve">Sign in</button><button class="secondary" name="decision" value="deny" formnovalidate>Cancel</button>
</form>
<p class="note">Help: <a href="${escape(CONTENT.supportURL)}">${escape(CONTENT.supportURL)}</a></p>
</html>`;
}

const frameHeaders = () => new Headers({ "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" });

const html = (body: string, headers: Headers, status = 200) => {
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { status, headers });
};

const authorizePage = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response(`${CONTENT.name} sign-in service for existing customers.\n`, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    // Plugin dashboard domain verification: the exact token as plain text.
    if (url.pathname === "/.well-known/openai-apps-challenge" && env.OPENAI_APPS_CHALLENGE)
      return new Response(env.OPENAI_APPS_CHALLENGE, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    if (url.pathname !== "/authorize") return new Response("Not found", { status: 404 });
    const oauth = env.OAUTH_PROVIDER;
    try {
      if (request.method === "GET") {
        const authRequest = await oauth.parseAuthRequest(request);
        const details = await oauth.describeConsent(authRequest);
        const consent = await oauth.beginConsent(authRequest);
        return html(signInPage(env, details, consent.handle), consent.headers);
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const email = normalizeEmail(String(form.get("email") ?? ""));
      const key = String(form.get("key") ?? "").trim();
      let verdict: Verdict;
      try {
        verdict = email && key && !(await tooManyFailures(env, email)) ? await entitlementFor(env).check(email, key) : { ok: false };
      } catch {
        const authRequest = await oauth.parseAuthRequest(new Request(request.url, { headers: request.headers }));
        const details = await oauth.describeConsent(authRequest);
        return html(signInPage(env, details, handle, "The purchase check is unavailable right now. Try again in a few minutes.", email), frameHeaders(), 503);
      }
      if (!verdict.ok) {
        if (email) await recordFailure(env, email);
        // Same page, same handle: the consent transaction is only consumed on approve or deny.
        const authRequest = await oauth.parseAuthRequest(new Request(request.url, { headers: request.headers }));
        const details = await oauth.describeConsent(authRequest);
        return html(signInPage(env, details, handle, NOT_FOUND, email), frameHeaders(), 401);
      }
      const approved = await oauth.approveConsent(request, handle, { scope: ["content:read"] });
      const props: Props = { email: verdict.email, key };
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        // Codes and tokens embed userId, so use a hash: the email never appears in redirect URLs.
        userId: (await sha256(verdict.email)).slice(0, 32),
        metadata: {},
        scope: ["content:read"],
        props,
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (error) {
      if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
        return new Response(message ?? "Sign-in request is not valid.", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
      throw error;
    }
  },
};

let provider: OAuthProvider<Env> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    provider ??= new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: McpApiHandler as any,
      defaultHandler: authorizePage as any,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: ["content:read"],
      requiredScopes: ["content:read"],
      resourceMetadata: {
        resource: `${env.PUBLIC_ORIGIN}/mcp`,
        authorization_servers: [env.PUBLIC_ORIGIN],
      },
    });
    return provider.fetch(request, env, ctx);
  },
};
