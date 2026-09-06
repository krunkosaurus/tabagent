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
import { redeemPairing } from './pairing-client.mjs';

// Real MCP stdio processes -> authenticated WebSocket -> real extension -> CDP.
// No model API, personal browser profile, public website or customer data.
const scratch = await mkdtemp(join(tmpdir(), 'tabagent-mcp-browser-'));
const clients = [];
const errors = [];
let context;
let fixture;
let releaseNavigation;
let hostileServer;
let hostileSockets;
const call = (client, name, args = {}, options) => {
  const result = client.callTool({ name, arguments: args }, undefined, options);
  // A failed assertion can close clients while a call awaits a sidebar choice.
  // Keep that cleanup rejection from hiding the original test failure.
  void result.catch(() => {});
  return result;
};
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
    const body = `<!doctype html><title>${req.url === '/b' ? 'Tab B' : 'Tab A'}</title><h1>Fixture ${req.url}</h1>
      <label for="name">Name</label><input id="name"><button id="save">Save</button><p id="status">Ready</p>
      <script>window.__agentRefMap={poisoned:true};document.querySelector('#save').onclick=()=>document.querySelector('#status').textContent='Saved';</script>`;
    if (req.url.startsWith('/slow-activity')) releaseNavigation = () => res.end(body);
    else res.end(body);
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
  const credentialsA = await redeemPairing(codeA);
  const privateCodeA = `tabagent:${credentialsA.port}:${credentialsA.token}`;
  const freshCode = async (agent) => json(await call(agent, 'tabagent_connect')).pairingCode;
  async function openPairing(t) {
    if (!await t.panel.locator('#external-panel').evaluate((node) => node.open)) await t.panel.locator('#external-summary').click();
  }
  async function share(t, agent, approvalMode = 'ask') {
    const code = await freshCode(agent);
    await openPairing(t);
    await t.panel.locator('#external-code').fill(code.toLowerCase());
    assert.equal(await t.panel.locator('#external-code').inputValue(), code);
    assert.equal(await t.panel.locator('#external-connect').evaluate((node) => node.classList.contains('is-ready')), true);
    await t.panel.locator('#external-approval-mode').selectOption(approvalMode);
    await t.panel.locator('#external-connect').click();
    await until(async () => (await t.send({ kind: 'get_state' })).data.external?.status.startsWith('Connected'), 'tab paired');
  }
  assert.equal((await a.send({ kind: 'external_connect', code: codeA, approvalMode: 'forever' })).ok, false);
  await share(a, codex);
  await share(b, hermes);
  assert.equal((await a.send({ kind: 'get_state' })).data.external.approvalMode, 'ask');
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
  await a.panel.locator('#external-activity').waitFor({ state: 'visible' });
  assert.equal(await a.panel.locator('#messages').isVisible(), false);
  assert.equal(await a.panel.locator('#chat-composer').isVisible(), false);
  assert.equal(await a.panel.locator('#provider-chip').isVisible(), false);
  assert.equal(await a.panel.locator('#external-agent-name').textContent(), 'Codex');
  assert.match(await a.panel.locator('#external-phase').textContent(), /Waiting for Codex to send a browser action/);
  assert.equal(await a.panel.locator('#external-waiting').isVisible(), true);
  assert.equal(await a.panel.locator('#external-actions > li').count(), 0);
  console.log('PASS: actual Chrome pairing, visible supervision at 360px, two-agent isolation and standalone ownership exclusion');

  const untrusted = await a.panel.evaluate(async (tabId) => (await chrome.scripting.executeScript({ target: { tabId }, func: async () => {
    const result = {};
    for (const kind of ['external_connect', 'external_stop', 'external_decision']) result[kind] = await chrome.runtime.sendMessage({ kind, code: 'x', id: 'x', allow: true, approvalMode: 'connection', scope: 'connection' });
    return result;
  } }))[0].result, a.tabId);
  for (const response of Object.values(untrusted)) assert.equal(response.ok, false);
  const snapshot = await call(codex, 'tabagent_snapshot', { tabId: a.tabId });
  assert(!snapshot.isError, JSON.stringify(snapshot));
  await a.panel.locator('#external-actions [data-tool="snapshot"][data-status="done"]').waitFor();
  assert.equal(await b.panel.locator('#external-actions > li').count(), 0, 'activity belongs only to its shared tab');
  assert.equal(await a.panel.locator('#external-waiting').isVisible(), false);
  assert.match(await a.panel.locator('#external-phase').textContent(), /next browser action/);
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
  assert(!JSON.stringify(storage).includes(credentialsA.token), 'pairing secrets never persist');
  assert(!JSON.stringify(storage).includes(image.content[0].data.slice(0, 100)), 'screenshots never persist');
  console.log('PASS: real content-script denial, isolated-world snapshots and decodable MCP image output without stored secrets/images');

  const pending = async (t) => until(async () => (await t.send({ kind: 'get_state' })).data.external?.pending, 'approval');
  await a.send({ kind: 'set_autonomy', mode: 'auto' });
  const denied = call(codex, 'tabagent_type', { tabId: a.tabId, ref, text: 'Must stay empty' });
  const approval = await pending(a);
  assert.equal(approval.input.text, 'Must stay empty');
  assert.equal(await a.page.locator('#name').inputValue(), '');
  await a.panel.locator('#external-actions [data-tool="type"][data-status="waiting"]').waitFor();
  assert.equal(await a.panel.locator('#external-phase').textContent(), 'Waiting for your approval');
  assert(!(await a.panel.locator('#external-actions').textContent()).includes('Must stay empty'), 'history does not echo typed values');
  assert.equal((await b.send({ kind: 'external_decision', id: approval.id, allow: true })).ok, false);
  await a.panel.locator('#external-deny').click();
  assert.equal((await denied).isError, true);
  await a.panel.locator('#external-actions [data-status="error"]').waitFor();
  assert((await a.panel.locator('#external-actions .external-error').textContent()).includes('Denied by user'));
  assert.equal(await a.page.locator('#name').inputValue(), '');

  const typed = call(codex, 'tabagent_type', { tabId: a.tabId, ref, text: 'Approved value' });
  await pending(a);
  await a.panel.reload();
  await a.panel.locator('#external-allow').waitFor({ state: 'visible' });
  assert.equal(await a.panel.locator('#external-actions > li').count(), 4, 'prior activity and the pending action restore on reopen');
  assert.equal(await a.panel.locator('#messages').isVisible(), false);
  assert((await a.panel.locator('#external-action').textContent()).includes('Approved value'));
  await a.panel.locator('#external-allow').click();
  assert(!(await typed).isError);
  assert.equal(await a.page.locator('#name').inputValue(), 'Approved value');
  const completed = (await a.send({ kind: 'get_state' })).data.external.actions.at(-1);
  assert.equal(completed.status, 'done');
  assert(completed.finishedAt >= completed.startedAt);
  assert(!JSON.stringify(completed).includes('Approved value'));
  assert(!JSON.stringify(completed).includes('data:image/'));
  console.log('PASS: main activity view replaces the chat greeting and shows waiting, completed, failed and restored actions without typed values');
  console.log('PASS: external actions require approval even in Auto mode; wrong-tab decisions fail; pending approvals survive panel recreation');

  const changed = call(codex, 'tabagent_type', { tabId: a.tabId, ref, text: 'Must not follow navigation' });
  await pending(a);
  await a.page.goto(otherOrigin + '/private');
  await a.panel.locator('#external-allow-connection').click();
  assert.equal((await changed).isError, true);
  assert.equal((await a.send({ kind: 'get_state' })).data.external.approvalMode, 'ask', 'a changed-origin decision cannot grant connection access');
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
  await a.panel.locator('#external-actions [data-status="cancelled"]').waitFor();
  assert.equal(await a.panel.locator('#external-phase').textContent(), 'Sharing ended');
  assert.equal(await a.panel.locator('#external-stop').isVisible(), false);
  await a.panel.locator('#external-back').click();
  assert.equal(await a.panel.locator('#external-activity').isVisible(), false);
  assert.equal(await a.panel.locator('#messages').isVisible(), true);
  assert.equal(await a.panel.locator('#chat-composer').isVisible(), true);
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
  await openPairing(a);
  await a.panel.locator('#external-code').fill(privateCodeA); // Full-code compatibility.
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
  const raceCode = await freshCode(hermes);
  const raced = await Promise.all([
    b.send({ kind: 'external_connect', code: raceCode }), b.send({ kind: 'external_stop' }),
  ]);
  assert.equal(raced[1].ok, true);
  if (!raced[0].ok) assert.match(raced[0].error, /stopp|revok/i);
  assert.equal((await b.send({ kind: 'get_state' })).data.external, null);
  console.log('PASS: accepted navigation and a rapid Share/Stop race follow user intent');

  // A tab-bound user decision can authorize the rest of this connection.
  // No model/client parameter, stored Auto preference or other tab can do so.
  await a.page.goto(url + '/grant');
  await share(a, codex);
  const grantedSnapshot = await call(codex, 'tabagent_snapshot', { tabId: a.tabId });
  const grantedRef = grantedSnapshot.content[0].text.match(/textbox "Name" \[ref=([^\]]+)\]/)[1];
  const grantCall = call(codex, 'tabagent_type', { tabId: a.tabId, ref: grantedRef, text: 'Allowed connection' });
  const grant = await pending(a);
  assert.equal((await a.send({ kind: 'external_decision', id: grant.id, allow: true, scope: 'forever' })).ok, false);
  assert.equal((await a.send({ kind: 'external_decision', id: grant.id, allow: false, scope: 'connection' })).ok, false);
  assert.equal((await b.send({ kind: 'external_decision', id: grant.id, allow: true, scope: 'connection' })).ok, false);
  const forged = await a.panel.evaluate(async ({ tabId, id }) => (await chrome.scripting.executeScript({ target: { tabId }, args: [id], func: async (id) =>
    chrome.runtime.sendMessage({ kind: 'external_decision', id, allow: true, scope: 'connection' }),
  }))[0].result, { tabId: a.tabId, id: grant.id });
  assert.equal(forged.ok, false);
  assert.equal(await a.page.locator('#name').inputValue(), '');
  await a.panel.locator('#external-allow-connection').click();
  assert(!(await grantCall).isError);
  assert.equal(await a.page.locator('#name').inputValue(), 'Allowed connection');
  await a.panel.reload();
  await until(() => a.panel.locator('#external-permissions').textContent().then((text) => text.includes('Allowed for this connection')), 'connection grant restored in panel');
  async function automatic(name, args) {
    const result = await call(codex, name, { tabId: a.tabId, ...args }, { timeout: 5000 });
    assert(!result.isError, JSON.stringify(result));
    const state = (await a.send({ kind: 'get_state' })).data.external;
    assert.equal(state.approvalMode, 'connection');
    assert.equal(state.pending, undefined);
    return result;
  }
  await automatic('tabagent_type', { ref: grantedRef, text: 'No repeated prompt', clearFirst: true });
  const saveRef = grantedSnapshot.content[0].text.match(/button "Save" \[ref=([^\]]+)\]/)[1];
  await automatic('tabagent_click', { ref: saveRef });
  assert.equal(await a.page.locator('#status').textContent(), 'Saved');
  const liveNavigation = call(codex, 'tabagent_navigate', { tabId: a.tabId, url: url + '/slow-activity?token=private-query#private-fragment' });
  await until(() => releaseNavigation, 'navigation request received');
  await a.panel.locator('#external-activity[data-phase="running"]').waitFor();
  const liveRow = a.panel.locator('#external-actions [data-tool="navigate"][data-status="running"]');
  await liveRow.waitFor();
  assert.equal(await liveRow.locator('strong').textContent(), 'Navigate to page');
  assert(!(await liveRow.textContent()).includes('private-query'));
  assert(!(await liveRow.textContent()).includes('private-fragment'));
  assert.equal(await a.panel.locator('#external-stop').isVisible(), true);
  await a.panel.reload();
  await a.panel.locator('#external-activity[data-phase="running"]').waitFor();
  releaseNavigation();
  assert(!(await liveNavigation).isError);
  await a.panel.locator('#external-actions [data-tool="navigate"][data-status="done"]').waitFor();
  console.log('PASS: real in-flight navigation shows progress and restores while running; activity omits URL queries and fragments');
  await automatic('tabagent_navigate', { url: otherOrigin + '/trusted-destination' });
  await a.page.waitForURL(otherOrigin + '/trusted-destination');
  assert((await automatic('tabagent_snapshot', {})).content[0].text.includes('Fixture /trusted-destination'));
  const grantsOnDisk = await worker.evaluate(async () => ({ local: await chrome.storage.local.get(null), session: await chrome.storage.session.get(null) }));
  assert(!JSON.stringify(grantsOnDisk).includes('"approvalMode":"connection"'), 'connection approval is not persisted');
  console.log('PASS: one explicit grant permits repeated actions, navigation and new-origin reads; content scripts and other panels cannot grant it');

  // The same MCP process can own another tab without inheriting this grant.
  await share(b, codex);
  const otherWrite = call(codex, 'tabagent_scroll', { tabId: b.tabId, direction: 'down' });
  await pending(b);
  assert.equal((await b.send({ kind: 'get_state' })).data.external.approvalMode, 'ask');
  await b.panel.locator('#external-deny').click();
  assert.equal((await otherWrite).isError, true);
  await a.panel.locator('#external-stop').click();
  await until(async () => !(await a.send({ kind: 'get_state' })).data.external, 'granted connection stopped');
  assert.equal(await a.panel.locator('#external-approval-mode').inputValue(), 'ask');
  assert.equal((await call(codex, 'tabagent_snapshot', { tabId: a.tabId })).isError, true);
  assert.deepEqual(json(await call(codex, 'tabagent_tabs')).tabs.map((tab) => tab.tabId), [b.tabId]);
  // Re-pair without selecting a mode: the previous grant must be gone.
  await openPairing(a);
  await a.panel.locator('#external-code').fill(await freshCode(codex));
  await a.panel.locator('#external-connect').click();
  await until(async () => (await a.send({ kind: 'get_state' })).data.external?.status.startsWith('Connected'), 'default re-pair');
  assert.equal((await a.send({ kind: 'external_decision', id: grant.id, allow: true, scope: 'connection' })).ok, false);
  const askAgain = call(codex, 'tabagent_scroll', { tabId: a.tabId, direction: 'down' });
  await pending(a);
  await a.panel.locator('#external-deny').click();
  assert.equal((await askAgain).isError, true);
  await a.panel.locator('#external-stop').click();
  await until(async () => !(await a.send({ kind: 'get_state' })).data.external, 'default connection stopped');
  await share(a, codex, 'connection');
  assert.equal(await a.panel.locator('#external-actions > li').count(), 0, 'new connections start a fresh activity history');
  await automatic('tabagent_scroll', { direction: 'down' });
  await worker.evaluate((tabId) => chrome.debugger.detach({ tabId }), a.tabId);
  assert.equal((await call(codex, 'tabagent_snapshot', { tabId: a.tabId })).isError, true);
  await until(async () => !(await a.send({ kind: 'get_state' })).data.external, 'granted connection debugger stop');
  await b.panel.locator('#external-stop').click();
  await until(async () => !(await b.send({ kind: 'get_state' })).data.external, 'other tab stopped');
  console.log('PASS: connection grants stay on their tab, reset after Stop/re-pair, can be chosen at pairing and end on debugger loss');

  // A buggy/hostile companion is still subject to the extension's whitelist.
  hostileServer = createServer();
  hostileSockets = new WebSocketServer({ server: hostileServer });
  let peer;
  hostileSockets.on('connection', (ws) => {
    peer = ws;
    ws.on('message', (raw) => {
      const message = JSON.parse(raw);
      if (message.type === 'auth') ws.send(JSON.stringify({ type: 'ready', agent: '<img id="injected" src="x">', approvalMode: 'connection' }));
      if (message.type === 'share') ws.send('{"type":"shared"}');
      if (message.type === 'ping') ws.send('{"type":"pong"}');
    });
  });
  await new Promise((r) => hostileServer.listen(0, '127.0.0.1', r));
  const hostileCode = `tabagent:${hostileServer.address().port}:${'a'.repeat(64)}`;
  await openPairing(b);
  await b.panel.locator('#external-code').fill(hostileCode);
  await b.panel.locator('#external-connect').click();
  await until(async () => (await b.send({ kind: 'get_state' })).data.external?.status.startsWith('Connected'), 'hostile companion paired');
  assert.equal(await b.panel.locator('#injected').count(), 0);
  assert.equal(await b.panel.locator('#external-agent-name').textContent(), '<img id="injected" src="x">');
  const forgedRequest = once(peer, 'message');
  peer.send(JSON.stringify({ type: 'invoke', id: randomUUID(), name: 'scroll', input: { direction: 'down' }, approvalMode: 'connection' }));
  await pending(b);
  assert.equal((await b.send({ kind: 'get_state' })).data.external.approvalMode, 'ask', 'companion cannot set its own approval mode');
  await b.panel.locator('#external-allow-connection').click();
  assert.equal(JSON.parse((await forgedRequest)[0]).isError, false);
  assert.equal((await b.send({ kind: 'get_state' })).data.external.approvalMode, 'connection');
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
