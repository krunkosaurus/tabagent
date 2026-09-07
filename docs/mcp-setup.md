# Connect your local agent to TabAgent

Use TabAgent as a browser tool for **Codex, Hermes, Pi**, or another agent that
supports local MCP servers. Your agent runs the conversation and chooses the
model; TabAgent controls only the tabs you explicitly share.

Choose your setup: [Codex](#codex), [Hermes](#hermes), [Pi](#pi), or
[another MCP client](#another-mcp-client). Then [pair a tab](#pair-a-tab-and-test-it).

## Build and load the extension

You need Chrome 120+, Node.js 22.19+, and an installed local agent with its model
already configured. Run the agent and companion on the same computer as Chrome.
Your model server can run on another machine, such as your local GPU server.

```sh
git clone https://github.com/krunkosaurus/tabagent.git
cd tabagent
npm ci --ignore-scripts
npm run build
```

If you already have the checkout, run the install/build commands there. The build
creates both `dist/` for Chrome and `build/mcp-tools.mjs` for the companion.

1. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked**.
2. Select the repository's **dist/** directory. If already installed, click **Reload**.
3. Pin TabAgent to the toolbar.

For MCP use, you can leave TabAgent's provider picker unconfigured. The calling
agent's model handles the task, including image analysis when supported.

Run these from your checkout to find the two paths used below:

```sh
pwd
node -p 'process.execPath'
```

Replace `/absolute/path/tabagent` with the checkout path and
`/absolute/path/to/node` with the Node executable path. Absolute paths let desktop
clients launch the companion even when their PATH differs from your terminal.

## Register the MCP server

Keep your existing agent settings and other MCP servers when adding these entries.
The agent launches `mcp/server.mjs` over **stdio** and owns its stdin/stdout.
Running `npm run mcp` in a separate terminal does not connect it to your agent.

You can ask your agent to read the optional [agent usage notes](agent-setup-notes.md).
The companion also supplies pairing and usage instructions during tool discovery;
no repository instruction file is required.

### Codex

Register the server from your terminal:

```sh
codex mcp add tabagent -- "/absolute/path/to/node" "/absolute/path/tabagent/mcp/server.mjs"
```

In `~/.codex/config.toml`, add `tool_timeout_sec = 120` to the table created by
that command. The complete table should look like this; edit the existing table
if present, rather than adding it twice:

```toml
[mcp_servers.tabagent]
command = "/absolute/path/to/node"
args = ["/absolute/path/tabagent/mcp/server.mjs"]
tool_timeout_sec = 120
```

Check registration with `codex mcp list`. Start a fresh Codex session and use
`/mcp` in the terminal UI to check active servers. Codex discovers the tools and
reads the companion's pairing instructions; no extra skill is required.
See [OpenAI's MCP documentation](https://learn.chatgpt.com/docs/extend/mcp)
for host configuration details.

### Hermes

Tested with **Hermes 0.21.0**. Register the companion with `hermes mcp add`:

**Choose the same profile you use for chat.** For a named profile, add
`--profile NAME` before the subcommand in every Hermes command below, for example
`hermes --profile coder mcp ls`. The CLI saves to that profile's config and shows
the destination path. Plain `hermes` uses the active default profile.

```sh
hermes mcp add tabagent --command "/absolute/path/to/node" --args "/absolute/path/tabagent/mcp/server.mjs"
```

Keep `--args` last. After a successful connection, Hermes lists the 14 tools and
asks whether to enable them; answer `Y`. If TabAgent is already registered, check
its existing entry before replacing it, especially any custom tool filters.

Set the tool-call timeout explicitly, then check registration:

```sh
hermes config set mcp_servers.tabagent.timeout 120
hermes mcp ls
hermes mcp test tabagent    # connects; should show 14 tools
```

For manual setup, merge this entry under `mcp_servers` in the same profile's
`config.yaml`: normally `~/.hermes/config.yaml` for the default profile or
`~/.hermes/profiles/<name>/config.yaml` for a named profile. A custom `HERMES_HOME`
can change these paths. Preserve the other servers and settings in that file.

```yaml
mcp_servers:
  tabagent:
    command: "/absolute/path/to/node"
    args: ["/absolute/path/tabagent/mcp/server.mjs"]
    timeout: 120
```

Named profiles have separate MCP configs; they do not inherit the top-level
entry. If `hermes mcp ls` does not show TabAgent, check that registration and chat
target the same profile before adding it again. See
[Hermes profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles).

Run `/reload-mcp` in the running session or start a fresh session in that profile,
then confirm the tools appear. Hermes 0.21.0 exposes `tabagent_connect` as
`mcp__tabagent__tabagent_connect`: the server prefix is added to the complete
tool name. Use the names discovered by your installed version. Pair a tab from
that session using the steps below; registration and `mcp test` only check a
temporary connection. If an MCP reload disconnects the companion, request fresh
pairing.

The explicit 120-second client timeout leaves room for TabAgent's 90-second
action deadline; it does not extend that deadline. See
[Hermes's MCP documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/)
for configuration, reloading and tool filtering.

### Pi

**For chat inside the TabAgent panel, use the [native Pi extension](pi-chat.md).**
It supplies the same browser tools and connects the current Pi conversation;
no MCP adapter is needed for TabAgent. If you already use the configuration
below, the native setup guide explains how to replace just its TabAgent entry.

The following MCP setup provides browser tools and activity only. Choose one
Pi integration; loading both registers competing TabAgent tool names.

Install the MCP adapter for the Pi coding agent (tested with **2.32.1**):

```sh
pi install npm:pi-mcp-adapter@2.32.1
```

Add this server to Pi's `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "tabagent": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/tabagent/mcp/server.mjs"],
      "lifecycle": "lazy-keep-alive",
      "requestTimeoutMs": 120000,
      "directTools": true,
      "toolPrefix": "none"
    }
  }
}
```

Restart Pi and open `/mcp`. `directTools` exposes the `tabagent_*` tools directly.
`lazy-keep-alive` starts the companion on first use and keeps it alive while idle,
preserving your pairing. If tools have not appeared yet, run
`/mcp reconnect tabagent` to refresh discovery.

These settings are described in the
[Pi MCP adapter documentation](https://github.com/nicobailon/pi-mcp-adapter#config).

### Another MCP client

Choose a **local command / stdio** server in your client's MCP settings. For
clients that accept the common `mcpServers` JSON format, use:

```json
{
  "mcpServers": {
    "tabagent": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/tabagent/mcp/server.mjs"]
    }
  }
}
```

Set the client's tool-call timeout to at least **120 seconds** and keep the
companion alive between calls. TabAgent exposes 14 tools: 11 browser actions plus
`tabagent_connect`, `tabagent_tabs`, and `tabagent_disconnect`.

The companion has no HTTP MCP endpoint. Pairing codes are for the Chrome
extension, not server URLs to enter in an MCP client. A client that only supports
remote HTTP MCP cannot use this setup directly.

## Pair a tab and test it

1. In your agent's chat, say: **“Use TabAgent to inspect my browser tab.”**
2. The agent calls `tabagent_connect` and gives you a five-character uppercase
   pairing code, such as `K7P4M`. It works once and expires after two minutes.
3. Open an ordinary HTTP(S) page, click TabAgent, expand **Local agent**, and
   enter the code. The **Share this tab** button highlights when it is complete.
   Choose an approval setting, click **Share this tab**, and
   accept Chrome's local connection permission when requested.
4. Tell the agent: **“List the tabs shared with TabAgent, take a snapshot of the
   tab I just shared, and summarize its heading and visible controls.”**
5. Confirm that the agent uses `tabagent_tabs` and `tabagent_snapshot`. TabAgent's
   **Browser activity** view should show **Read page** followed by **Done**. Read
   the summary in your agent's chat.

Keep the agent session open during pairing. The tools supply pairing and usage
instructions automatically; mentioning **TabAgent** tells the agent which browser
tool to choose. The agent can ask you to open the extension on the desired tab,
but this MCP interface cannot enable or share another tab on your behalf.

To check vision, ask the agent to take a TabAgent screenshot and describe it.
The companion returns an MCP image. Configure vision in the calling agent;
Hermes may pass images through local `MEDIA:` files to its vision tools.

### Approvals and activity

| Setting | Behavior |
| --- | --- |
| **Ask before each action** (default) | Sharing permits reads of the initial site. Mutations, navigation and reads of new sites require approval in TabAgent. |
| **Allow for this connection** | Permits those actions, including form submissions and reading new sites, on this shared tab until the connection ends. You can select it while pairing or on a pending approval prompt. |

Re-pairing defaults to Ask. The extension's standalone Auto mode and saved site
grants do not change an external connection's policy. Your agent application may
also have its own tool approval prompts.

The activity view shows browser calls, approval waits, failures and elapsed time.
It retains the latest 50 summaries while connected, including when you reopen
the panel. **Waiting for the agent** means no browser call is currently running;
the agent's conversation and model inference remain in its own client.

### Scrolling long pages

Shared tabs keep rendering in the background without switching tabs or focusing
the browser window. This lasts only for the debugger attachment. Older builds
could change a background tab's scroll position while Chrome paused scroll
events and feed rendering; wheel input could then time out. After updating the
extension, reload it in `chrome://extensions` and pair again to enable the fix.

`tabagent_scroll` uses **DOM scrolling** by default: it moves the document's
scroll position and reports the actual change, without waiting for mouse-wheel
input. If the document has no scroll range, it uses a scrollable area at the
viewport center. Pass a snapshot `ref` to choose its nearest scrollable container.
For virtualized feeds, use modest `amount` values and take a fresh snapshot after
each scroll; only the currently rendered content is available. A result showing
no movement does not prove that the full feed has been collected.
Scroll results identify the target, its position and maximum scroll range;
snapshots include page visibility, loading state and document scroll position.
Check for new content, not just a changed position. A stale `ref` requires a fresh
snapshot because virtualized pages replace elements as you scroll.

For controls that specifically need wheel events, use `method: "wheel"`.
Wheel input targets the viewport center or the visible portion of the supplied
`ref`; its acknowledgment does not confirm movement. If it times out while
snapshots still work, check the page state and use `method: "dom"` for subsequent
scrolling. Do not automatically replay uncertain input. Re-pair only if the tab's
access has ended; a wheel timeout alone does not establish a frozen renderer.

## Stop, reconnect and share more tabs

Click **Stop sharing** in the panel or ask the agent to call
`tabagent_disconnect`. Stop, cancellation, tool timeout, agent exit, tab closure
or debugger loss ends that tab's access. Reloading the extension also ends
sharing. Already-dispatched page actions cannot be undone by stopping.

To reconnect or share another tab, ask the active agent for a fresh pairing code.
Each short code works once. A new request replaces the previous unused code;
five incorrect guesses also invalidate it. Code expiry does not end an already
paired connection. Keep codes in the agent conversation and extension UI, never
on a webpage or in committed configuration. Full `tabagent:PORT:TOKEN` codes
remain accepted; the companion uses that format if all temporary pairing slots
are occupied by other local apps. See [pairing security](mcp.md#pairing-and-trust-boundaries).

Repeat pairing on another tab to let one agent work across several shared tabs.
Each tab has one owner. Independent agents need separate companion processes;
a host that reuses a companion across conversations shares its paired tabs
across those conversations too.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Agent cannot find TabAgent tools | Check the config path and absolute Node/checkout paths, rebuild, and start a fresh agent session. In Codex use `/mcp`; in Pi use `/mcp reconnect tabagent`. Check tool filters if only some tools appear. |
| Missing `build/mcp-tools.mjs` or an MCP package | Run `npm ci --ignore-scripts` and `npm run build` from the checkout. Keep the full checkout; the Chrome `dist/` directory alone does not include the companion. |
| `tabagent_tabs` returns an empty list | The server is reachable, but this companion owns no tabs. Pair from this agent session on your intended tab. |
| Pairing fails | Get a fresh code; short codes expire after two minutes, work once and lock after five incorrect guesses. Keep the agent open and allow Chrome's local connection permission. The companion and Chrome must share the same computer and loopback network; a remote shell or separate container is a different environment. |
| Tool call waits without page activity | Check the panel for an approval prompt. The companion revokes access after 90 seconds without completion; the 120-second client timeout does not extend that limit. |
| Wheel scroll times out but snapshots still work | Inspect the current page, then use `tabagent_scroll` with `method: "dom"` (the default). For a nested scrolling area, supply a snapshot `ref` inside it. Avoid repeating an input whose completion is unknown. |
| Every action asks again | Choose **Allow for this connection** in TabAgent when that is the permission you want. If the prompt appears in your agent application, check that application's tool approvals separately. |
| Panel says it is waiting for the agent | Give the task in the agent's chat. If it selects another browser tool, explicitly ask it to use TabAgent. |
| Connection disappears after idle or restart | Keep the companion alive (Pi: `lazy-keep-alive`). Re-pair after an agent restart, extension reload or Stop. |
| Screenshot arrives but the agent cannot interpret it | Check the calling agent's image handling and vision model. Changing TabAgent's provider picker does not change an external agent's model. |
| Tab is already owned or the debugger cannot attach | Stop the existing TabAgent run/connection. Release any other debugger attached to the tab, then pair again. |

For protocol details, security boundaries and automated tests, see
[MCP architecture](mcp.md) and the [security review](../SECURITY.md).
