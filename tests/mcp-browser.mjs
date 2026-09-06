import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Real MCP stdio processes -> authenticated WebSocket -> real extension -> CDP.
// No model API, personal browser profile, public website or customer data.
const scratch = await mkdtemp(join(tmpdir(), 'tabagent-mcp-browser-'));
const clients = [];
const errors = [];
let context;
let fixture;
let hostileServer;
let hostileSockets;
const call = (client, name, args = {}, options) => client.callTool({ name, arguments: args }, undefined, options);
const json = (result) => JSON.parse(result.content[0].text);
async function until(fn, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out: ${label}. ${errors.join('; ')}`);
}
async function client(name) {
  const instance = new Client({ name, version: '1.0.0' });
  clients.push(instance);
  await instance.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('mcp/server.mjs')], stderr: 'pipe' }));
  return instance;
}

try {
  fixture = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>${req.url === '/b' ? 'Tab B' : 'Tab A'}</title><h1>Fixture ${req.url}</h1>
      <label for="name">Name</label><input id="name"><button id="save">Save</button><p id="status">Ready</p>
      <script>window.__agentRefMap={poisoned:true};document.querySelector('#save').onclick=()=>document.querySelector('#status').textContent='Saved';</script>`);
  });
  await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${fixture.address().port}`;
  const otherOrigin = `http://localhost:${fixture.address().port}`;
  const extension = join(scratch, 'extension');
  await cp('dist', extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  // Only test copy pre-grants the localhost permission normally approved in UI.
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  async function tab(path) {
    const page = await context.newPage();
    await page.goto(url + path);
    const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, page.url());
    const created = context.waitForEvent('page');
    await worker.evaluate((url) => chrome.tabs.create({ url, active: false }), `chrome-extension://${extensionId}/panel.html?tabId=${tabId}`);
    const panel = await created;
    panel.on('pageerror', (e) => errors.push(e.message));
    await panel.waitForLoadState();
    const send = (req) => panel.evaluate((request) => chrome.runtime.sendMessage(request), req);
    await until(() => panel.locator('#build-version').textContent(), 'panel boot');
    return { page, panel, tabId, send };
  }
  const a = await tab('/a');
  const b = await tab('/b');
  const codex = await client('Codex');
  const hermes = await client('Hermes');
  const codeA = json(await call(codex, 'tabagent_connect')).pairingCode;
  const codeB = json(await call(hermes, 'tabagent_connect')).pairingCode;
  async function share(t, code) {
    await t.panel.locator('#external-summary').click();
    await t.panel.locator('#external-code').fill(code);
    await t.panel.locator('#external-connect').click();
    await until(async () => (await t.send({ kind: 'get_state' })).data.external?.status.startsWith('Connected'), 'tab paired');
  }
  await share(a, codeA);
  await share(b, codeB);
  assert.deepEqual(json(await call(codex, 'tabagent_tabs')).tabs.map((t) => t.tabId), [a.tabId]);
  assert.deepEqual(json(await call(hermes, 'tabagent_tabs')).tabs.map((t) => t.tabId), [b.tabId]);
  assert.equal((await call(hermes, 'tabagent_snapshot', { tabId: a.tabId })).isError, true);
  assert.equal((await a.send({ kind: 'external_connect', code: codeB })).ok, false);
  assert.equal((await a.send({ kind: 'send_message', tabId: a.tabId, text: 'conflicting run' })).ok, false);
  await a.panel.setViewportSize({ width: 360, height: 800 });
  const bounds = await a.panel.locator('#external-stop').boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360);
  assert.equal(await a.panel.locator('#external-code').inputValue(), '');
  assert.equal(await a.panel.locator('#composer').isDisabled(), true);
  console.log('PASS: actual Chrome pairing, visible supervision at 360px, two-agent isolation and standalone ownership exclusion');

  const untrusted = await a.panel.evaluate(async (tabId) => (await chrome.scripting.executeScript({ target: { tabId }, func: async () => {
    const result = {};
    for (const kind of ['external_connect', 'external_stop', 'external_decision']) result[kind] = await chrome.runtime.sendMessage({ kind, code: 'x', id: 'x', allow: true });
    return result;
  } }))[0].result, a.tabId);
  for (const response of Object.values(untrusted)) assert.equal(response.ok, false);
  const snapshot = await call(codex, 'tabagent_snapshot', { tabId: a.tabId });
  assert(!snapshot.isError, JSON.stringify(snapshot));
  const ref = snapshot.content[0].text.match(/textbox "Name" \[ref=([^\]]+)\]/)?.[1];
  assert(ref, snapshot.content[0].text);
  assert.equal(await a.page.evaluate(() => Object.keys(window.__agentRefMap).join(',')), 'poisoned');
  // Disable Playwright's automatic dismissal; the actual extension handles it.
  a.page.once('dialog', () => {});
  assert.equal(await a.page.evaluate(() => confirm('Confirm an extra action?')), false, 'page dialogs must not auto-approve');
  const image = await call(codex, 'tabagent_screenshot', { tabId: a.tabId });
  assert.equal(image.content[0].type, 'image');
  const dimensions = await a.panel.evaluate(async (content) => {
    const img = new Image();
    img.src = `data:${content.mimeType};base64,${content.data}`;
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  }, image.content[0]);
  assert(dimensions[0] > 100 && dimensions[1] > 100);
  const storage = await worker.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) }));
  assert(!JSON.stringify(storage).includes(codeA.split(':')[2]), 'pairing secrets never persist');
  assert(!JSON.stringify(storage).includes(image.content[0].data.slice(0, 100)), 'screenshots never persist');
  console.log('PASS: real content-script denial, isolated-world snapshots and decodable MCP image output without stored secrets/images');

  const pending = async (t) => until(async () => (await t.send({ kind: 'get_state' })).data.external?.pending, 'approval');
  await a.send({ kind: 'set_autonomy', mode: 'auto' });
  const denied = call(codex, 'tabagent_type', { tabId: a.tabId, ref, text: 'Must stay empty' });
  const approval = await pending(a);
  assert.equal(approval.input.text, 'Must stay empty');
  assert.equal(await a.page.locator('#name').inputValue(), '');
  assert.equal((await b.send({ kind: 'external_decision', id: approval.id, allow: true })).ok, false);
  await a.panel.locator('#external-deny').click();
  assert.equal((await denied).isError, true);
  assert.equal(await a.page.locator('#name').inputValue(), '');

  const typed = call(codex, 'tabagent_type', { tabId: a.tabId, ref, text: 'Approved value' });
  await pending(a);
  await a.panel.reload();
  await a.panel.locator('#external-allow').waitFor({ state: 'visible' });
  assert((await a.panel.locator('#external-action').textContent()).includes('Approved value'));
  await a.panel.locator('#external-allow').click();
  assert(!(await typed).isError);
  assert.equal(await a.page.locator('#name').inputValue(), 'Approved value');
  console.log('PASS: external actions require approval even in Auto mode; wrong-tab decisions fail; pending approvals survive panel recreation');

  const changed = call(codex, 'tabagent_type', { tabId: a.tabId, ref, text: 'Must not follow navigation' });
  await pending(a);
  await a.page.goto(otherOrigin + '/private');
  await a.panel.locator('#external-allow').click();
  assert.equal((await changed).isError, true);
  assert.equal(await a.page.locator('#name').inputValue(), '');
  const readPrivate = call(codex, 'tabagent_snapshot', { tabId: a.tabId });
  const access = await pending(a);
  assert.equal(access.name, 'access_page');
  assert.equal(access.origin, otherOrigin);
  assert.equal(json(await call(codex, 'tabagent_tabs')).tabs[0].url, url + '/a', 'new private URL must not leak through tab listing');
  await a.panel.locator('#external-deny').click();
  const deniedRead = await readPrivate;
  assert.equal(deniedRead.isError, true);
  assert(!deniedRead.content[0].text.includes('Fixture /private'));
  const acceptedRead = call(codex, 'tabagent_snapshot', { tabId: a.tabId });
  await pending(a);
  await a.panel.locator('#external-allow').click();
  const newSnapshot = await acceptedRead;
  assert(!newSnapshot.isError);
  const newRef = newSnapshot.content[0].text.match(/textbox "Name" \[ref=([^\]]+)\]/)[1];
  console.log('PASS: navigation during approval cancels the action; new-origin reads require consent and do not leak through tab metadata');

  const navigate = call(codex, 'tabagent_navigate', { tabId: a.tabId, url: url + '/destination' });
  assert.equal((await pending(a)).name, 'navigate');
  await a.panel.locator('#external-deny').click();
  assert.equal((await navigate).isError, true);
  assert.equal(a.page.url(), otherOrigin + '/private');

  const stopped = call(codex, 'tabagent_type', { tabId: a.tabId, ref: newRef, text: 'Must not type after Stop' });
  const expired = await pending(a);
  await a.panel.locator('#external-stop').click();
  assert.equal((await stopped).isError, true);
  await until(async () => !(await a.send({ kind: 'get_state' })).data.external, 'ownership released');
  assert.equal((await a.send({ kind: 'external_decision', id: expired.id, allow: true })).ok, false);
  assert.equal(await a.page.locator('#name').inputValue(), '');
  assert.deepEqual(json(await call(codex, 'tabagent_tabs')).tabs, []);
  assert(!(await call(hermes, 'tabagent_snapshot', { tabId: b.tabId })).isError, 'other agent remains connected');
  const moved = call(hermes, 'tabagent_navigate', { tabId: b.tabId, url: url + '/next' });
  await pending(b);
  await b.panel.locator('#external-allow').click();
  assert(!(await moved).isError);
  await b.page.waitForURL(url + '/next');
  console.log('PASS: navigation always asks; Stop cancels pending writes and approvals without disturbing another agent');

  // Pair again on the new site, then exercise MCP cancellation and Chrome's stop.
  await a.panel.locator('#external-code').fill(codeA);
  await a.panel.locator('#external-connect').click();
  await until(async () => json(await call(codex, 'tabagent_tabs')).tabs.length, 're-pair');
  const fresh = await call(codex, 'tabagent_snapshot', { tabId: a.tabId });
  const freshRef = fresh.content[0].text.match(/textbox "Name" \[ref=([^\]]+)\]/)[1];
  const abort = new AbortController();
  const cancelled = call(codex, 'tabagent_type', { tabId: a.tabId, ref: freshRef, text: 'Cancelled' }, { signal: abort.signal }).catch((e) => e);
  await pending(a);
  abort.abort();
  await cancelled;
  await until(async () => !(await a.send({ kind: 'get_state' })).data.external, 'MCP cancellation');
  assert.equal(await a.page.locator('#name').inputValue(), '');
  await worker.evaluate((tabId) => chrome.debugger.detach({ tabId }), b.tabId);
  // Extension-initiated detach does not emit onDetach. The next command must
  // fail closed too; the native Chrome Stop banner emits the listener event.
  assert.equal((await call(hermes, 'tabagent_snapshot', { tabId: b.tabId })).isError, true);
  await until(async () => !(await b.send({ kind: 'get_state' })).data.external, 'Chrome debugger stop');
  assert.equal((await call(hermes, 'tabagent_snapshot', { tabId: b.tabId })).isError, true);
  const attached = await worker.evaluate(async (tabId) => {
    try { await chrome.debugger.sendCommand({ tabId }, 'Page.getFrameTree'); return true; }
    catch { return false; }
  }, b.tabId);
  assert.equal(attached, false);
  const raced = await Promise.all([
    b.send({ kind: 'external_connect', code: codeB }), b.send({ kind: 'external_stop' }),
  ]);
  assert(raced.every((r) => r.ok));
  assert.equal((await b.send({ kind: 'get_state' })).data.external, null);
  console.log('PASS: accepted navigation and a rapid Share/Stop race follow user intent');

  // A buggy/hostile companion is still subject to the extension's whitelist.
  hostileServer = createServer();
  hostileSockets = new WebSocketServer({ server: hostileServer });
  let peer;
  hostileSockets.on('connection', (ws) => {
    peer = ws;
    ws.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (message.type === 'auth') ws.send(JSON.stringify({ type: 'ready', agent: '<img id="injected" src="x">' }));
      if (message.type === 'share') ws.send('{"type":"shared"}');
      if (message.type === 'ping') ws.send('{"type":"pong"}');
    });
  });
  await new Promise((r) => hostileServer.listen(0, '127.0.0.1', r));
  const hostileCode = `tabagent:${hostileServer.address().port}:${'a'.repeat(64)}`;
  await b.panel.locator('#external-code').fill(hostileCode);
  await b.panel.locator('#external-connect').click();
  await until(async () => (await b.send({ kind: 'get_state' })).data.external?.status.startsWith('Connected'), 'hostile companion paired');
  assert.equal(await b.panel.locator('#injected').count(), 0);
  let lastId;
  for (const [name, input] of [['evaluate', { expression: 'window.pwned=true' }], ['navigate', { url: 'javascript:alert(1)' }], ['snapshot', { expression: '1' }]]) {
    lastId = randomUUID();
    const received = once(peer, 'message');
    peer.send(JSON.stringify({ type: 'invoke', id: lastId, name, input }));
    const reply = JSON.parse((await received)[0]);
    assert.equal(reply.type, 'result');
    assert.equal(reply.isError, true);
    assert.equal((await b.send({ kind: 'get_state' })).data.external.pending, undefined);
  }
  assert.equal(await b.page.evaluate(() => window.pwned), undefined);
  peer.send(JSON.stringify({ type: 'invoke', id: lastId, name: 'snapshot', input: {} }));
  await until(async () => !(await b.send({ kind: 'get_state' })).data.external, 'replayed command rejected');
  console.log('PASS: extension independently rejects arbitrary evaluation, unsafe URLs, extra fields, replay and injected agent-name HTML');
  assert.deepEqual(errors, []);
  console.log('PASS: MCP cancellation and Chrome debugger stop revoke access without auto-reattach or page errors');
} finally {
  await Promise.allSettled(clients.map((c) => c.close()));
  await context?.close();
  if (hostileSockets) { for (const ws of hostileSockets.clients) ws.terminate(); hostileSockets.close(); }
  if (hostileServer) { hostileServer.closeAllConnections(); await new Promise((r) => hostileServer.close(r)); }
  if (fixture) { fixture.closeAllConnections(); await new Promise((r) => fixture.close(r)); }
  await rm(scratch, { recursive: true, force: true });
}
