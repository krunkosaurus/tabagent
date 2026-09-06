# TabAgent agent notes

For setup, pairing and browser use, read the [agent usage notes](docs/agent-setup-notes.md).
Client configuration lives in the [MCP setup guide](docs/mcp-setup.md); native Pi
chat setup lives in the [Pi guide](docs/pi-chat.md).

## Development

Use Node.js **22.19+** and the full checkout.

- Install dependencies: `npm ci --ignore-scripts`.
- Typecheck: `npm run typecheck`.
- Build the Chrome extension and companion tools: `npm run build`.
- Run security, pairing, MCP and native Pi tests: `npm test`.
- Run the Chrome integration suite: `npm run test:browser`. Install its browser
  with `npx playwright install chromium` if needed.

## Agent compatibility

- Preserve standalone chat, native Pi chat and standard MCP workflows. The
  user's chosen integration determines where the conversation runs.
- Native Pi and the MCP server share `mcp/bridge.mjs` and the browser tool
  definitions. Check both integrations when changing shared behavior.
- Keep client-specific setup in its guide. Preserve other agent settings and
  MCP servers when configuring TabAgent; load only one TabAgent integration
  per Pi session.
