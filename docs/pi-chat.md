# Continue a Pi conversation inside TabAgent

The native Pi extension adds TabAgent's 14 browser tools to your current Pi
session and lets you continue that same conversation in the Chrome panel.
Replies stream in both clients. Pi keeps its model, history, tools and permissions;
TabAgent does not start another model or copy a conversation into a new agent.

This feature supports the **Pi coding agent**, tested with **0.85.1**. Codex,
Hermes and other MCP clients retain browser tools and activity through the
[standard MCP integration](mcp-setup.md). Their conversations are not connected
by this Pi adapter.

## Install

Use Node **22.19+** and the full checkout on the same computer as Chrome. From
the checkout:

```sh
npm ci --ignore-scripts
npm run build
```

Load or reload `dist/` at `chrome://extensions`.

If Pi already uses TabAgent through `pi-mcp-adapter`, remove **only** the
`mcpServers.tabagent` entry from its active MCP configuration (usually
`~/.pi/agent/mcp.json`; check project overrides too). Keep other MCP servers and
the adapter if you use them. Loading both integrations would register competing
tools with the same names.

Register this checkout as a Pi package, replacing the example with its absolute
path:

```sh
pi install /absolute/path/tabagent
```

Restart Pi. For a temporary trial instead of installation, start Pi with:

```sh
pi -e /absolute/path/tabagent/pi/extension.js
```

Pi discovers the browser tools and their instructions automatically. No skill,
separate MCP process or TabAgent model configuration is needed. Installing from
a local checkout requires the build above; a Chrome release ZIP alone does not
include the Pi companion. Rebuild and restart Pi after updating the checkout.

## Pair and continue

1. In the Pi session you want to continue, run **`/tabagent`**, or ask Pi to use
   `tabagent_connect`. It displays a private pairing code.
2. Open TabAgent on the intended HTTP(S) tab. Under **Local agent**, paste the
   code, select your browser approval setting, and click **Share this tab**.
3. Click **Chat with Pi in this tab**. This explicitly displays recent messages
   from that Pi conversation and lets this tab submit prompts to Pi.
4. Send a follow-up. **Conversation** shows replies and the latest browser action,
   including its approval/running/result status and timing. Click **View all** or
   **Browser activity** for the full action history. Browser approvals remain
   visible in either view. Thinking-only and tool-only turns do not create empty
   chat messages.

You can continue typing in Pi as well. While Pi is busy, the browser lets you
draft the next message; sending becomes available when Pi is idle. The panel
does not enqueue or steer work. Prompts are text, up to 8,000 characters; slash
command and prompt-template expansion is disabled for panel submissions.

Only one shared tab can attach to a Pi conversation at a time. **Detach chat**
there before attaching another tab. Other shared tabs can still receive browser
tool calls. Reopening the attached tab's panel restores its recent transcript
while the connection lives; unsent drafts disappear on panel reload.

## Controls and scope

| Control | Effect |
| --- | --- |
| **Stop Pi** | Requests cancellation of Pi's current run. A browser tool in progress may revoke sharing when cancelled. Messages queued separately in Pi remain Pi's responsibility. |
| **Detach chat** | Clears the panel transcript and removes this tab's chat attachment. Pi work and browser sharing continue. |
| **Stop sharing** | Revokes this tab's browser access and removes its chat attachment. Already-submitted Pi work can continue with its other tools. |

**A chat prompt has the same scope as a prompt typed in Pi**, including any
local file and command tools enabled there. The panel's Ask/connection approval
setting covers browser actions only; it is not a permission boundary for Pi's
other tools. Handle Pi-specific dialogs or provider errors in Pi itself.

New/resumed/forked sessions, `/reload`, branch changes and Pi shutdown revoke the
old pairing. Pair again from the intended conversation. Extension reload, lost
connection or browser debugger loss also ends access. Requests are never
automatically replayed; after a missing acknowledgment, check Pi before sending
the same prompt again.

## Privacy and implementation

The panel shows at most 40 recent user/assistant text messages, bounded to 12,000
characters total and 8,000 per message; older or longer text is shortened. Full
history stays in Pi. Raw tool output, reasoning blocks, images, system prompts,
session file paths and pairing codes are excluded from the transcript. Visible
assistant text can still quote page/tool content or contain private information.
Text renders literally, without loading remote images or interpreting HTML.

The native adapter uses `pi.sendUserMessage`, Pi's message events and `ctx.abort`.
It runs in the existing Pi process and shares `mcp/bridge.mjs` with the stdio MCP
entry point. Chat travels over the existing authenticated loopback WebSocket;
there is no additional HTTP endpoint, daemon, credential file or arbitrary
command RPC. Chat attachment is bound to a random session generation and one
shared socket. Limits cover text, history, requests, socket buffering and waits.

Within Chrome, prompts and transcripts use a private runtime port whose sender
must be a trusted panel for that tab. They are never broadcast to other panels
or saved in Chrome storage. Closing sharing clears the in-memory transcript;
Pi retains messages according to its own session storage behavior. This trusts
the installed extension and local Pi process, as the browser-only bridge does.

## Verify your setup

Tell Pi a short detail in its terminal, then ask about it from the attached tab.
Check that Pi remembers it and that both views show the new exchange. Ask it to
read the shared page, then perform a harmless action in Ask mode and check the
approval. Try **Stop Pi**, **Detach chat**, and **Stop sharing** separately.

Automated coverage runs with `npm test` and `npm run test:browser`: the real,
pinned Pi SDK uses an isolated session and deterministic local model endpoint;
Chrome uses a disposable profile. Tests cover context continuity, streaming,
actual browser tools and approvals, cross-tab/content-script attacks, HTML
escaping, transcript limits, duplicate rejection, cancellation and session
replacement. No personal Pi configuration or live model is used in these tests.

See Pi's [extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
and [package setup](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md).
