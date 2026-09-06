import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket } from 'ws';
import { EXTERNAL_TOOLS, parsePairingCode, validateExternalTool } from '../build/mcp-tools.mjs';
import { redeemPairing } from './pairing-client.mjs';

const clients = [];
const peers = [];
const origin = `chrome-extension://${'a'.repeat(32)}`;
const deadline = setTimeout(() => { throw new Error('MCP tests timed out'); }, 40_000);
const call = (client, name, args = {}, options) => client.callTool({ name, arguments: args }, undefined, options);
const json = (result) => JSON.parse(result.content[0].text);
async function start(name) {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('mcp/server.mjs')], stderr: 'pipe' });
  clients.push(client);
  await client.connect(transport);
  return client;
}
async function pair({ port, token }, tabId, otherToken) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tabagent`, { origin });
  peers.push(ws);
  await once(ws, 'open');
  const ready = once(ws, otherToken ? 'close' : 'message');
  ws.send(JSON.stringify({ type: 'auth', token: otherToken ?? token }));
  const result = await ready;
  if (otherToken) return ws;
  assert.equal(JSON.parse(result[0]).type, 'ready');
  const shared = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'share', tabId, url: 'https://example.com/', title: 'Fixture' }));
  assert.equal(JSON.parse((await shared)[0]).type, 'shared');
  return ws;
}
async function rejectedHandshake(port, headers, path = '/tabagent') {
  return new Promise((done, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'c3NhbXBsaW5nLXJldmlldyE=', ...headers,
    } }, (res) => { res.resume(); done(res.statusCode); });
    req.on('error', reject);
    req.on('upgrade', () => reject(new Error('Unexpected upgrade')));
    req.end();
  });
}

try {
  for (const code of ['http://localhost:1234', 'tabagent:65536:' + 'a'.repeat(64), 'tabagent:80:' + 'g'.repeat(64), 'tabagent:01:' + 'a'.repeat(64)]) assert.throws(() => parsePairingCode(code));
  assert.throws(() => validateExternalTool('evaluate', { expression: '1' }));
  for (const url of ['file:///tmp/x', 'javascript:alert(1)', 'https://user:pass@example.com']) assert.throws(() => validateExternalTool('navigate', { url }));
  assert.throws(() => validateExternalTool('click', { ref: 's1e1', tabId: 4 }));
  assert.throws(() => validateExternalTool('type', { ref: 's1e1', text: 'x'.repeat(20_001) }));
  assert.throws(() => validateExternalTool('snapshot', []));
  assert.throws(() => validateExternalTool('screenshot', { clip: { width: -1 } }));
  assert.throws(() => validateExternalTool('scroll', { direction: 'execute' }));
  console.log('PASS: shared argument validator rejects extra fields, unsafe URLs, invalid types and unbounded input');

  const a = await start('Codex fixture');
  const b = await start('Hermes fixture');
  const toolList = (await a.listTools()).tools;
  assert.equal(toolList.length, EXTERNAL_TOOLS.length + 3);
  assert(a.getInstructions().includes('untrusted data'));
  const ca = json(await call(a, 'tabagent_connect')).pairingCode;
  const cb = json(await call(b, 'tabagent_connect')).pairingCode;
  assert.notEqual(ca, cb);
  assert.match(ca, /^[A-Z2-9]{5}$/);
  const credentialsA = await redeemPairing(ca);
  const credentialsB = await redeemPairing(cb);
  const { port } = credentialsA;
  for (const headers of [{}, { Origin: 'null' }, { Origin: 'http://localhost:1234' }, { Origin: 'https://evil.example' }, { Origin: origin, Host: 'evil.example' }]) {
    assert.equal(await rejectedHandshake(port, headers), 403);
  }
  assert.equal(await rejectedHandshake(port, { Origin: origin }, '/tabagent?token=anything'), 403);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
  await pair(credentialsA, 100, 'f'.repeat(64));
  assert.deepEqual(json(await call(a, 'tabagent_tabs')).tabs, []);
  console.log('PASS: real stdio discovery; web/null origins, rebinding Hosts, URL credentials and wrong tokens rejected');

  const wa = await pair(credentialsA, 100);
  const wb = await pair(credentialsB, 200);
  assert.equal(json(await call(a, 'tabagent_tabs')).tabs[0].tabId, 100);
  assert.equal((await call(b, 'tabagent_snapshot', { tabId: 100 })).isError, true);
  assert.equal((await call(a, 'tabagent_evaluate', { tabId: 100, expression: '1' })).isError, true);
  const received = once(wa, 'message');
  const screenshot = call(a, 'tabagent_screenshot', { tabId: 100 });
  const invocation = JSON.parse((await received)[0]);
  assert.equal((await call(a, 'tabagent_snapshot', { tabId: 100 })).isError, true, 'same-tab calls cannot overlap');
  wa.send(JSON.stringify({ type: 'result', id: invocation.id, content: 'data:image/jpeg;base64,YWJj', isError: false }));
  const image = await screenshot;
  assert.deepEqual(image.content, [{ type: 'image', mimeType: 'image/jpeg', data: 'YWJj' }]);
  console.log('PASS: sessions isolate tabs; one in-flight action per tab; screenshots use MCP image content');

  const wa2 = await pair(credentialsA, 101);
  const next = once(wa, 'message');
  const snapshot = call(a, 'tabagent_snapshot', { tabId: 100 });
  const invocation2 = JSON.parse((await next)[0]);
  const closed = once(wa2, 'close');
  wa2.send(JSON.stringify({ type: 'result', id: invocation2.id, content: 'spoofed', isError: false }));
  await closed;
  wa.send(JSON.stringify({ type: 'result', id: invocation2.id, content: 'real tab result', isError: false }));
  assert.equal((await snapshot).content[0].text, 'real tab result');
  console.log('PASS: replies are bound to the exact shared-tab socket');

  const abort = new AbortController();
  const waitInvoke = once(wa, 'message');
  const waitClose = once(wa, 'close');
  const cancelled = call(a, 'tabagent_click', { tabId: 100, ref: 's1e1' }, { signal: abort.signal }).catch((e) => e);
  await waitInvoke;
  abort.abort();
  await cancelled;
  await waitClose;
  assert.deepEqual(json(await call(a, 'tabagent_tabs')).tabs, []);
  const exitClose = once(wb, 'close');
  await b.close();
  await exitClose;
  console.log('PASS: MCP cancellation and agent exit revoke sockets and release shared tabs');
} finally {
  clearTimeout(deadline);
  for (const ws of peers) ws.terminate();
  await Promise.allSettled(clients.map((client) => client.close()));
}
