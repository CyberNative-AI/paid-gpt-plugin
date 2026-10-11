# What your customers keep, lose, or need to check

For a paid Custom GPT moved to a plugin built from this template. Sources: OpenAI's
"Moving your custom GPT workflows to plugins" guide, plugin guidelines and submission
guide (read 2026-10-11). **UNKNOWN** means OpenAI has not published an answer.

## Keeps
- [ ] **Their access, on their own ChatGPT account.** They install your public plugin and sign
      in once with the email and key from their purchase. No workspace invite is needed.
- [ ] **Your method.** The GPT instructions are served by the `get_playbook` tool after sign-in.
- [ ] **Your knowledge files** (.md or .txt), searchable with `search_knowledge` and readable
      with `read_document`. Convert PDFs and DOCX to text first and check the result.
- [ ] **Your control.** Refunds and revocations apply on the next tool call (allowlist) or
      within 10 minutes (Gumroad).

## Loses
- [ ] **Conversation history with the GPT.** OpenAI: "previous chats may not copy". Tell
      customers to save anything they need before the retirement date.
- [ ] **The GPT's selected model.** "The selected model does not carry over."
- [ ] **Conversation starters as buttons.** The plugin listing allows up to three
      `defaultPrompt` entries; anything else goes in your onboarding email.
- [ ] **Custom actions.** They "don't transfer". This template does not rebuild them; each
      one needs its own MCP tool.
- [ ] **GPT capability toggles** (web search, image generation, data analysis). OpenAI:
      "capability settings do not guarantee the same tools or behavior". Test what you rely on.
- [ ] **The "Anyone with the link" share.** Plugins have no equivalent for people outside a
      workspace; this template replaces it with a public listing plus sign-in.
- [ ] **Exact behavior.** Retrieval differs from GPT knowledge, and ChatGPT decides when to
      use the plugin. Test your five most common customer requests before announcing.

## Needs checking (UNKNOWN)
- [ ] Whether **Free-plan** customers can use directory plugins. OpenAI support: "no guarantee".
      If your customers are on Free, ask OpenAI before you commit.
- [ ] **Mobile** availability of directory plugins.
- [ ] **Review time** compared with the retirement date. Submit early.
- [ ] Whether review accepts a plugin whose content is only available after sign-in. The
      guidelines allow signing in "to an existing paid account"; they also reject "trial or
      demo plugins" and expect functionality ChatGPT does not have natively.

## What customers need to do
1. Find your plugin in the ChatGPT plugin directory (send them the listing link).
2. Install it and sign in with the email and key you sent them.
3. Start a chat and select the plugin, or ask a question it covers.
