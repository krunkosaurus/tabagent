#!/usr/bin/env node
/** Standard stdio MCP entry point. Native Pi uses the same browser bridge. */
import { readFile } from 'node:fs/promises';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createBridge, instructions } from './bridge.mjs';

const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const server = new Server({ name: 'tabagent', version }, { capabilities: { tools: {} }, instructions });
const bridge = await createBridge({ agentName: () => server.getClientVersion()?.name });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: bridge.tools }));
server.setRequestHandler(CallToolRequestSchema, (req, extra) => bridge.call(req.params.name, req.params.arguments, extra));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  bridge.close();
  await server.close();
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.stdin.on('end', () => void shutdown());
server.onclose = () => void shutdown();
await server.connect(new StdioServerTransport());
