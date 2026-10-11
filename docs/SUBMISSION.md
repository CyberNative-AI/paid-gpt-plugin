# Publishing checklist

What OpenAI's plugin submission guide requires (read 2026-10-11), and what this template
already provides.

| Requirement | Template | You provide |
| --- | --- | --- |
| Verified individual or business identity in an OpenAI platform organization | — | Yes |
| ZIP with `plugin.json`, `mcp.json`, skills, square logo | `tools/convert.mjs` builds it | Final logo if you want one |
| Listing fields: name ≤30, subtitle ≤30, description, category, developer name | From `gpt.json`; `tools/check-package.mjs` checks limits | Text |
| Website, support, privacy policy and terms URLs (HTTPS, same publisher) | Fields only | The four pages |
| Remote HTTPS MCP endpoint | `npx wrangler deploy` | Cloudflare account, domain |
| OAuth with DCR or CIMD, S256, RFC 9207 `iss`, protected resource metadata | Built in (`@cloudflare/workers-oauth-provider`) | — |
| Domain verification: token at `/.well-known/openai-apps-challenge` | Served from the `OPENAI_APPS_CHALLENGE` var | Paste the token |
| Tool annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`) as explicit booleans | All three tools are read-only, bounded | — |
| 5 positive and 3 negative review test cases | From `gpt.json` + 3 fixed negatives | Run each with the reviewer account |
| Reviewer account that works without MFA, magic links or email codes | `tools/customers.mjs add reviewer@yourdomain --key ...` | Enter it in **Review details**, never in the ZIP |
| Demo video URL | — | Record the 5 cases |
| No pricing, trials, upgrades or purchases inside the plugin | Denial text has no plans, prices or links; checker scans listing text | Keep your copy that way |
| No secrets in the ZIP | Checker: no client secret, headers or credentials; no 8-word passage of your instructions or knowledge | — |

## Deploy
```sh
npx wrangler kv namespace create OAUTH_KV        # put the id in wrangler.jsonc
npx wrangler kv namespace create ENTITLEMENTS    # put the id in wrangler.jsonc
# set PUBLIC_ORIGIN to your HTTPS origin and mcpURL in gpt.json to <origin>/mcp
node tools/convert.mjs path/to/your-gpt
node tools/check-package.mjs build/<slug>-plugin.zip
npx wrangler deploy
node tools/customers.mjs import customers.csv    # prints email,key: send each customer their key
```
