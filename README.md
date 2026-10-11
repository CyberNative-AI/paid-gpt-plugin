# paid-gpt-plugin

Keep your paying Custom GPT customers when GPTs become plugins.

If you sold access to a Custom GPT ("Anyone with the link"), that link stops working when
custom GPTs retire, and plugins have no equivalent share for people outside your workspace.
What the plugin guidelines do allow: "Users may sign in to an existing paid account and
access features already included in their subscription."

This template builds that:

- **A public plugin** with no secrets in it: listing fields, review cases, one skill.
- **A Cloudflare Worker MCP server** that holds your GPT's instructions and knowledge and
  serves them only to customers who sign in with their purchase email and key.
- **Everyone else gets a neutral denial**, with no plans, prices or links.

```text
ChatGPT ──OAuth (DCR/CIMD, PKCE S256)──▶ Worker /authorize: email + key ──▶ allowlist or Gumroad
   │                                                                   │
   └──── MCP tools/call + bearer token ──▶ Worker /mcp ── re-checks the purchase on each call
                                             ├─ get_playbook      (your instructions)
                                             ├─ search_knowledge  (your knowledge files, BM25)
                                             └─ read_document
```

## Convert a GPT

Put your GPT in a folder like [`samples/sourdough-rescue`](samples/sourdough-rescue):

```text
my-gpt/
  gpt.json          name, descriptions, creator, URLs, conversation starters, 5 review cases
  instructions.md   the GPT's instructions, unchanged
  knowledge/        the GPT's knowledge files as .md or .txt
```

```sh
npm install
node tools/convert.mjs my-gpt                 # Worker content + build/plugin/<slug>/ + ZIP
node tools/check-package.mjs build/<slug>-plugin.zip
```

`check-package` fails if any 8-word passage of your instructions or knowledge is in the ZIP
(compared as words, ignoring markup, JSON escapes and punctuation). It allows only plain
`.json`/`.md`/`.svg` and real image files, with no archives, `data:` URIs or UTF-16 text. It also
checks the manifest against OpenAI's published submission limits.

## Who gets in

Set `ENTITLEMENT_MODE` in `wrangler.jsonc`:

- **`allowlist`** (default): you issue each customer an access key. Keys are stored only as
  SHA-256 hashes in KV (at least 16 letters or digits). Revocation applies on the next tool
  call once the KV write has propagated, usually within a minute.
  ```sh
  node tools/customers.mjs import customers.csv   # prints email,key for each customer
  node tools/customers.mjs revoke someone@example.com
  ```
- **`gumroad`**: customers sign in with their Gumroad license key. Refunds, chargebacks,
  open disputes, and ended or failed subscriptions are denied. A cancelled subscription keeps
  access until it ends. Results are cached for 10 minutes. Set `GUMROAD_PRODUCT_ID`.

Other stores fit the `Entitlement` interface in [`src/entitlement.ts`](src/entitlement.ts).

Set the `USER_ID_SECRET` secret (32+ random characters) before deploying; grants are keyed by
an HMAC of the email, so codes and tokens never reveal it. Only `ALLOWED_REDIRECT_HOSTS`
(ChatGPT and loopback by default) can receive sign-in codes.

The reviewer account is an ordinary allowlist entry, so OpenAI's reviewers can sign in
without MFA, magic links or email codes, as review requires.

## Test

```sh
npm test         # convert, package check, planted-leak control, Gumroad adapter, OAuth + MCP end to end
npm run typecheck
```

The end-to-end test runs against local workerd with the official MCP SDK client. It covers
discovery from the 401, dynamic client registration, PKCE, sign-in, the `iss` response
parameter, token exchange, all three tools, a wrong key, an unknown email, a mistyped key
retried, revocation after sign-in, the reviewer account, forged sign-in forms, notifications,
malformed batches, a disallowed redirect host and the per-email throttle. The package check
runs against eight planted-leak controls.

## Publish

See [docs/SUBMISSION.md](docs/SUBMISSION.md) for OpenAI's requirements and which ones this
template covers. Tell customers what changes with [docs/CUSTOMER-CHECKLIST.md](docs/CUSTOMER-CHECKLIST.md).

## Limits

- **Not yet reviewed by OpenAI.** Nobody has submitted a plugin built from this template.
  Whether review accepts a plugin whose content needs sign-in is untested.
- **Free-plan access to directory plugins is UNKNOWN.** OpenAI support says "no guarantee".
- **Knowledge must be text.** Convert PDFs and DOCX first and check the output.
- **Custom actions are not converted.**
- **The Gumroad adapter is tested against Gumroad's open-source verify endpoint**, with mocked
  responses, not a live store.
- **Sign-in throttling** uses Cloudflare's rate-limiting binding: 20 attempts per IP and 5 per
  email per minute, counted per Cloudflare location. Someone who knows a customer's email can
  keep that customer's sign-in throttled while they keep trying.

## License

MIT
