# TabAgent

> A supervised AI agent with an independent instance for each browser tab.

**This is my fork of [binSaed/tabagent](https://github.com/binSaed/tabagent), with security improvements and features added through hands-on testing.**

I've been looking for the best open-source replacement for Claude's Chrome extension: something that can work with any OpenAI-compatible LLM that supports tool calling, including models running on my own hardware. So far, TabAgent is my pick.

It impressed me more than several GitHub projects with far more stars. When I found it, the original project had **zero stars**, yet it was already a capable browser agent built as an alternative to Claude's browser extension.

I forked it to strengthen its security and fill in gaps I found while using it:

- **Security and privacy improvements** — tighter permissions, safer provider connections, and stronger isolation between web pages and extension controls. See the [security review](SECURITY.md) for the changes and remaining limitations.
- **An independent instance in each tab** — conversations, drafts, model choices, and approvals stay with their tab when you switch between pages.
- **Editable custom model connections** — update a saved endpoint or API key, and choose among the models your server provides.

I'm using it successfully with **DeepSeek V4 Flash Vision running locally on my dual Sparks**. That's the setup I'm building this fork around: a useful browser agent powered by models I run myself.

Clone my fork, try it with your own models, and let's move away from Anthropic toward **100% local AI**, one step at a time:

```sh
git clone https://github.com/krunkosaurus/tabagent.git
cd tabagent
```

Follow the [installation instructions](#installation) below to build it and load it into Chrome.

<p align="center">
  <img src=".github/assets/banner.png" alt="TabAgent — turn any browser tab into an AI agent" width="100%" />
</p>

![Chrome 120+](https://img.shields.io/badge/Chrome-120%2B-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)
![Zero runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow)

TabAgent is a Manifest V3 Chrome extension that lets any OpenAI-compatible LLM drive the active tab through the Chrome DevTools Protocol. Connect a provider — **Z.AI's coding plan is the first-class default** — give the agent a goal in the side panel, and it works the page through 11 structured browser tools. Everything is hand-rolled with zero runtime dependencies: SSE streaming, markdown rendering, and WebCrypto encryption included.

## Demo

https://github.com/user-attachments/assets/2adfd956-d6e8-4b5c-893d-dc04f92abe66

## Features

- **Any OpenAI-compatible provider** — Z.AI, Zhipu/BigModel, OpenAI, OpenRouter, DeepSeek, Groq, xAI (Grok), Mistral, Fireworks, Cerebras, Moonshot (Kimi), Hugging Face, or any custom endpoint (Ollama, LM Studio, …) through a single adapter
- **11 CDP browser tools** — snapshot, click, type, scroll, hover, key presses, screenshots, text extraction, and more (see [Browser tools](#browser-tools))
- **Resumable agent loop** — memory-only checkpoints survive service-worker restarts; conversations are cleared when Chrome exits
- **Plan approval** — the agent can propose a step-by-step plan; you approve or reject it, then watch steps tick off live in the panel
- **Permission system** — per-site grants (site-wide or per-tool), plus **ask**/**auto** autonomy modes
- **Mid-run steering** — queue follow-up messages while the agent is working; they're folded into the run
- **Independent tabs** — open TabAgent separately on each tab. Conversations, drafts, model choices, autonomy mode and pending approvals stay with their tab; a run continues on its original tab while you browse elsewhere.
- **Manual saved notes** — add, edit or delete notes in the Memory panel. Automatic extraction and model-written memory have been removed.
- **Skills** — keyword-activated expert procedures; ships with full-page translation via in-place text replacement with automatic LTR/RTL handling
- **Selection drafts** — on an explicitly activated tab, selected text can fill a draft. Review it and press Send in the panel.
- **Unattended-run hygiene** — JS dialogs (`alert`/`confirm`/`prompt`) are auto-dismissed; `beforeunload` blocks are detected and reported instead of hanging
- **Notifications** — chime + system toast when a run finishes or needs your attention (toggleable)
- **Polished chat UI** — streaming markdown, collapsible reasoning blocks, screenshot lightbox, suggested next-action chips, light/dark theme, JSON conversation export

## Installation

Requires Chrome 120+ and Node.js 22+ for this development setup.

```sh
npm ci --ignore-scripts
npm run build
```

1. Open `chrome://extensions` in Chrome (prefer a separate profile for browser automation).
2. Enable **Developer mode**, click **Load unpacked**, and select this repository's **dist/** folder.
3. Pin TabAgent, visit a regular web page, and open its panel using the toolbar or **Cmd/Ctrl+Shift+A**.
4. Open the provider picker. Choose a provider, enter its API key in the extension, and click **Connect**. Chrome requests access to that API host before validation runs.
5. Pick a model from the provider's live list. Keep **Ask** mode on for initial use.
6. Try “Summarize this page in three bullet points” on a public page, then a harmless form on a test page.

To edit the current connection, click **Edit connection** directly below the
panel header. The version beside it identifies the loaded build (currently
**v0.1.8**). To edit another saved provider, open the provider picker and use its
**Edit connection** button. Change the base URL or API key
and click **Save changes**. An empty key field keeps the existing key when the
server address is unchanged. For a different address, explicitly enter that
server's key or select **Use without an API key**. Saving preserves your model
selection if the server still lists it. Use the top model dropdown to change
models. Stop any active run before editing its connection.

Open TabAgent on a tab using its toolbar icon or keyboard shortcut. Switching to
a tab where you have not opened it hides the panel; returning brings back that
tab's panel. Opening it on another tab starts an independent conversation. Closing
and reopening a panel restores that tab's conversation, draft and pending approvals
within the current browser session. Closing the browser tab cancels its run and
clears its conversation and draft. API connections, manual notes, saved site grants,
theme and notifications are shared across tabs.

For Claude models, choose **OpenRouter** and select a Claude model from its live list. This requires an OpenRouter API key and any applicable API billing; a Claude browser subscription cannot be used as the credential. The native Anthropic adapter is still unimplemented.

For a local model, choose **Custom**, use your running server's OpenAI-compatible base URL (for example `http://localhost:11434/v1`), and choose an installed model that supports tool calling. Remote providers require HTTPS; HTTP is allowed only on loopback. Nothing contacts a provider until you explicitly connect or use it.

Review the exact URL/text in each action prompt. Plan approval keeps individual action checks in place. Navigation and entering a new origin require approval even in Auto mode. Site grants apply to the full origin (scheme, hostname and port).

Conversations and drafts are kept in memory and cleared when their tab closes,
Chrome exits, or the extension is reloaded or updated. Export a conversation
explicitly if you want to retain it. On upgrade, this build removes old disk
checkpoint mirrors; export anything you need with the previous build first.
Credentials, settings, site grants and manually saved notes still persist locally.

## Providers

| Provider | Endpoint | Notes |
|---|---|---|
| **Z.AI (Coding Plan)** | `api.z.ai/api/coding/paas/v4` | Default. Flat-rate subscription. GLM roster: `glm-5.2` (default), `glm-5.1`, `glm-5-turbo`, `glm-5`, `glm-4.7`, `glm-4.6`, `glm-4.5`, `glm-4.5-air` |
| **Zhipu / BigModel** | `open.bigmodel.cn/api/paas/v4` | Same GLM family, separate key |
| **OpenAI** | `api.openai.com/v1` | Pre-seeded models |
| **OpenRouter** | `openrouter.ai/api/v1` | Fully dynamic model list |
| **DeepSeek** | `api.deepseek.com/v1` | Dynamic model list |
| **Groq** | `api.groq.com/openai/v1` | Dynamic model list |
| **xAI (Grok)** | `api.x.ai/v1` | Dynamic model list |
| **Mistral** | `api.mistral.ai/v1` | Dynamic model list |
| **Fireworks AI** | `api.fireworks.ai/inference/v1` | Dynamic model list |
| **Cerebras** | `api.cerebras.ai/v1` | Dynamic model list |
| **Moonshot (Kimi)** | `api.moonshot.ai/v1` | Dynamic model list |
| **Hugging Face** | `router.huggingface.co/v1` | Dynamic model list |
| **Custom (OpenAI-compatible)** | any base URL | Ollama, LM Studio, Together, Fireworks, … — dynamic `GET /models` discovery |

Z.AI's API quirks are handled automatically: `tool_stream: true` is injected into chat requests, `thinking: { type: "enabled" | "disabled" }` is set for reasoning models, and the `/models` health check tolerates `401` (Z.AI scopes that endpoint differently from chat).

The Anthropic native adapter is currently a stub — use OpenRouter for Claude models. There is no Gemini adapter yet.

All providers run through one adapter: `src/providers/openai-compat.ts`, with the catalog in `src/providers/catalog.ts`.

## Browser tools

Eleven CDP-backed tools, defined in `src/tools/browser-tools.ts`:

| Tool | Description |
|---|---|
| `snapshot` | Page snapshot as YAML with `ref` ids for interactive elements (DOM walk over light DOM + open shadow roots) |
| `click` | Trusted mouse click on a `ref` (left/right/middle, double-click) |
| `type` | Focus a `ref` and type text, with optional clear and submit |
| `hover` | Move the mouse over a `ref` (tooltips, dropdown triggers) |
| `press_key` | Press a key or combo (`Escape`, `Tab`, `ctrl+a`, …) |
| `scroll` | Scroll the page by pixels in any direction |
| `scroll_to` | Scroll a `ref` element into view |
| `navigate` | Go to a URL — gated behind user approval |
| `screenshot` | Full-page JPEG, resized to fit a token budget |
| `extractText` | Visible text of the page or a `ref` subtree |
| `set_text` | Overwrite an element's text in place (powers page translation, auto LTR/RTL) |

The agent loop also offers `propose_plan` and `suggest_actions`. Durable notes can only be edited in the panel.

## How it works

```
Tab-specific side panel (UI only, fixed owner tab)
      ↕  chrome.runtime messages
Service worker (orchestrator)
   ├─ Agent loop — resumable state machine
   ├─ Checkpointing — storage.session only
   ├─ Permission & plan-approval services
   └─ chrome.alarms heartbeat (recovery)
      ↕  chrome.debugger (CDP)
Owner tab (debuggee, remains fixed when switching tabs)
```

The loop (`src/background/loop.ts`) checkpoints progress during a run. Recovery is limited to the current browser session:

- **Mid-stream** (no assistant message committed) → re-send the stream
- **Mid-tool** (a mutating tool may have run) → stop and ask the user; mutating tools are never auto-replayed
- **Idle/paused** → the service worker can die freely; state is preserved

The debugger attaches when a run starts and detaches when it finishes. While attached, it also keeps the service worker alive for the duration of the run (Chrome 118+ behavior).

There are no runtime dependencies: SSE parsing, markdown rendering, and crypto are implemented in-repo, and the UI is vanilla TypeScript.

See [the tab-instance architecture](docs/architecture.md) for panel ownership,
state restoration, concurrent runs and tab cleanup.

## The debugger permission

TabAgent requires the `debugger` permission, which triggers a scary install warning and shows a *"this browser is being controlled by automated test software"* banner — but only while a run is active, since the debugger is attached at run start and detached at run finish.

CDP is required for capabilities a content script cannot provide:

- **Trusted input** (`Input.dispatchMouseEvent` and friends) that defeats synthetic-event bot detection
- **Full-page screenshots** beyond the viewport
- **Service-worker keepalive** during long runs

## Security & privacy

- No analytics SDK, telemetry collector, or developer-owned relay was found in the reviewed source. Optional application attribution headers have been removed.
- Chat messages, page content and screenshots needed for a task go directly to the provider you connect. Its own retention/training policies still apply.
- Both storage areas are restricted to trusted extension contexts. API keys are AES-GCM encrypted locally, but the encryption key is in the same Chrome profile: this does not protect against profile theft or a compromised computer.
- Content scripts cannot call privileged panel commands. Selection actions prepare drafts only. The extension installs with no required host permissions or global content script injection.
- Page inspection runs in a separate JavaScript world. The page DOM, links and text remain untrusted; prompt injection and destructive model actions cannot be eliminated by these changes.
- Ask mode gates page mutations unless you have explicitly granted the origin. Navigation and access to a new origin always ask. Requests reject unsafe URL schemes, remote HTTP and provider redirects.
- The debugger permission remains powerful. Use supervised tasks and keep sensitive account administration, payments and secrets out of the agent's workflow.

See [SECURITY.md](SECURITY.md) for findings, validation and limits.

## Limitations

- **Anthropic native adapter** is a stub (use OpenRouter for Claude); **no Gemini adapter**
- **Pause is cancel** — true mid-run pause/resume is not implemented yet
- **No cost tracking** — the default Z.AI plan is flat-rate; per-token accounting is absent elsewhere
- **One tab per agent** — independent tabs can run concurrently; a single agent cannot orchestrate multiple tabs
- **Offscreen streaming path** is implemented but dormant; the loop currently streams inside the service worker (safe because the attached debugger keeps it alive)
- **No prompt-injection classifier** (see [Security & privacy](#security--privacy))
- **Vanilla TS UI** — no framework

## Development

```sh
npm run typecheck
npm run build
npm test
npx playwright install chromium
npm run test:browser
```

Iterate by rebuilding, reloading the extension at `chrome://extensions`, and refreshing the target tab.

Key files:

- `src/background/loop.ts` — the resumable agent loop (read the invariants in its header)
- `src/providers/openai-compat.ts` — the one adapter covering every provider
- `src/providers/catalog.ts` — built-in provider and model definitions
- `src/tools/browser-tools.ts` — the 11 CDP browser tools
- `src/core/storage.ts` — encrypted credential store, settings, session persistence

## License

MIT
