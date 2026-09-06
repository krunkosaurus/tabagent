# Local MCP companion

```
Codex / Hermes (one process per agent session)
  -> stdio MCP, official SDK
  -> mcp/server.mjs, ephemeral 127.0.0.1 WebSocket listener
  -> authenticated Chrome extension connection for each shared tab
  -> external-agent.ts: ownership, origin checks, approvals, cancellation
  -> existing browser tool registry, strict CDP, isolated JavaScript world
```

The browser interface contains 11 `tabagent_*` actions plus `tabagent_connect`,
`tabagent_tabs`, and `tabagent_disconnect`. `src/shared/external-tools.ts` defines
the bounded schemas and validation used by both sides. `npm run build` compiles
the companion's copy to `build/mcp-tools.mjs`; Chrome assets remain in `dist/`.
The local Node process uses the official MCP SDK for discovery, initialization,
stdio framing and cancellation. It does not make model requests or sample via
the client. The caller owns the reasoning loop, memory, model and vision route.

## Pairing and trust boundaries

- The MCP process binds an OS-selected port on `127.0.0.1` only. It has no network
  MCP endpoint, discovery HTTP API, CORS access, or credential file.
- A cryptographically random 256-bit token is returned only over the agent's
  stdio `tabagent_connect` tool. The code contains the port and token. The Chrome
  panel parses a fixed grammar; it cannot be used to select another hostname,
  path, scheme, query or arbitrary URL.
- WebSocket upgrades require the exact loopback Host, `/tabagent` path and a
  `chrome-extension://` origin. Authentication checks the token in the first
  frame using a constant-time comparison. Origin alone never authorizes access.
  Authentication expires after five seconds. Tokens never appear in socket URLs.
- Only trusted, tab-bound extension panels can pair, approve or stop. Content
  scripts and pages cannot invoke these controls. Only explicitly shared tab
  metadata reaches the companion; it cannot enumerate the user's other tabs.
- Pairing grants read access to the current origin. New origins require a
  separate sidebar decision. Navigation and all mutating tools always ask.
  Standalone saved grants and Auto mode do not carry over. Decisions bind to
  one random approval ID, one tab and the origin checked before/after approval.
- The companion validates arguments, serializes each tab and binds replies to
  the exact authenticated tab socket. The extension revalidates the whitelist
  and bounded argument schema. There is no arbitrary evaluation, raw CDP,
  provider configuration, cookie API, or file-system tool in this interface.
- Browser tools run in the existing isolated world. Origin checks surround
  commands and read results; an origin change discards the result. Tab listings
  retain only the URL/title explicitly shared at pairing time, avoiding a
  metadata bypass when a user subsequently visits another origin.
- Stop, client cancellation, 90-second tool timeout, agent exit, tab closure,
  debugger detachment and lost heartbeats revoke access. The extension uses CDP
  without reattachment or retries, aborts approvals synchronously and retains
  ownership until in-flight work and debugger cleanup finish. Late old-socket
  events cannot revoke a new owner's connection. Fresh pairing is required.
- Periodic messages keep MV3 workers alive while connected. Worker death loses
  all external-session state and closes its connections. There is no recovery
  that can replay a mutation.

## Limits and validation

This is a supervised browser control interface, not a sandbox for a malicious
local OS process or a guarantee against prompt injection. Another process with
the pairing token and local browser privileges is within the trusted local
boundary. The calling agent may store the code and tool results in its history;
the code becomes useless when its companion exits. MCP client names are display
labels, not independently verified identities. Page DOM can change after a
check; origin checks do not authenticate page content or undo dispatched input.
Dialog confirmations are dismissed, never automatically accepted.

Isolation follows the **MCP process/connection**, not a conversation name supplied
by the caller. If a client or gateway reuses one MCP server across conversations,
those conversations share its paired tabs. Use separate client processes/profiles
for independent agents and Stop sharing when finished; closing a conversation
alone may not terminate its host's MCP process.

The server bounds messages, active sockets, per-tab concurrency and tool wait
time; the extension bounds requests, parameters and result sizes. Huge images
return an error with a request to capture a smaller region. Screenshots are MCP
image blocks, not a base64 text dump. The extension and companion keep external
session data in memory. Receiving agents may persist results or image caches.

`npm test` covers real MCP discovery/stdio, session isolation, argument rejection,
origin/Host/token rejection, response spoofing, image encoding and cancellation.
`npm run test:browser` additionally drives real Chrome extension APIs and CDP:
pairing, two agents/tabs, standalone ownership exclusion, content-script attacks,
isolated snapshots, decodable images, approval restoration, denial, wrong-tab
decisions, changed-origin reads, Stop, MCP cancellation and debugger loss. The
original standalone regression suite runs as well. CI grants localhost host
access only to a copied test extension and uses disposable browser profiles.

`tests/mcp-python.py` is an optional protocol smoke test for the Python MCP SDK.
Run it with the Python environment used by Hermes. It loads no agent config and
makes no model requests; it verifies the real companion's initialization,
14-tool discovery and shared-tab listing.

Manual checks still cover the native first-time permission prompt, your loaded
Chrome profile and the chosen agent/model's actual browsing quality.

## References

- [Codex MCP setup](https://developers.openai.com/codex/mcp)
- [Hermes MCP setup](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/)
- [MCP SDK: stdio and image results](https://ts.sdk.modelcontextprotocol.io/server)
- [Chrome MV3 WebSocket lifecycle](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)
