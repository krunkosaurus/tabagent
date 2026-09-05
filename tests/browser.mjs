import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';

// Real extension/Chrome APIs with a local deterministic provider; no real keys,
// paid requests, personal browser profiles or external sites are used.
const scratch = await mkdtemp(join(tmpdir(), 'tabagent-browser-'));
const requests = [];
const modelRequests = [];
const events = [];
const browserErrors = [];
let toolsToReturn = [];
let beforeNextReply;
let ctx;
const server = createServer(async (req, res) => {
  if (req.url.endsWith('/models')) {
    modelRequests.push({ url: req.url, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'mock-first' }, { id: 'mock-selected' }] }));
  } else if (req.url.endsWith('/chat/completions')) {
    let raw = '';
    for await (const data of req) raw += data;
    const body = JSON.parse(raw);
    requests.push(body);
    // Reject invalid tool history, as a real OpenAI-compatible server does.
    const pending = new Set();
    for (const message of body.messages) {
      if (message.role === 'assistant') for (const call of message.tool_calls ?? []) pending.add(call.id);
      if (message.role === 'tool') {
        assert(pending.delete(message.tool_call_id), 'tool result must have a matching call');
      }
      if (message.role === 'user' || message.role === 'assistant') {
        if (!message.tool_calls?.length) assert.equal(pending.size, 0, 'all preceding calls must be answered');
      }
    }
    assert.equal(pending.size, 0);
    if (beforeNextReply) {
      const action = beforeNextReply;
      beforeNextReply = undefined;
      await action();
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const call = toolsToReturn.shift();
    const delta = call ? { tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] } : { content: 'Mock provider completed the task.' };
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  } else {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Agent fixture</title><h1>Local fixture</h1><label for="name">Name</label><input id="name"><button id="save">Save</button><p id="status">Ready</p><script>window.__agentRefMap={poisoned:true};document.getElementById("save").onclick=()=>document.getElementById("status").textContent="Saved";</script>');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const baseURL = `http://127.0.0.1:${server.address().port}`;

async function until(fn, description, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out: ${description}; errors: ${JSON.stringify(events.filter((e) => e.kind === 'error'))}`);
}

try {
  const extension = join(scratch, 'extension');
  await cp('dist', extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  // Only the TEST COPY pre-grants loopback access, avoiding native permission UI
  // in headless CI. The distributed manifest has no required host permissions.
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  ctx = await chromium.launchPersistentContext(join(scratch, 'profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await ctx.exposeBinding('recordExtensionEvent', (_, e) => events.push(e));
  const worker = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const target = await ctx.newPage();
  await target.goto(baseURL);
  await target.bringToFront();
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url + '/')?.id, baseURL);
  assert(tabId);
  const newPage = ctx.waitForEvent('page');
  await worker.evaluate((url) => chrome.tabs.create({ url, active: false }), `chrome-extension://${id}/panel.html?tabId=${tabId}`);
  const panel = await newPage;
  panel.on('pageerror', (e) => browserErrors.push(e.message));
  await panel.waitForLoadState();
  await panel.evaluate(() => chrome.runtime.onMessage.addListener((msg) => { window.recordExtensionEvent(msg); }));
  const send = (msg) => panel.evaluate((message) => chrome.runtime.sendMessage(message), msg);
  const ready = await send({ kind: 'get_state' });
  assert.equal(ready.ok, true);
  await send({ kind: 'set_notifications', enabled: false });
  const connected = await send({ kind: 'connect_provider', providerId: 'custom', credentials: { baseURL: baseURL + '/v1', apiKey: 'mock-secret' } });
  assert.equal(connected.ok, true, JSON.stringify(connected));
  await send({ kind: 'select_model', providerId: 'custom', modelId: 'mock-selected' });
  assert.equal(requests.length, 0, 'connection must not issue a chat probe to a guessed model');
  await panel.reload();
  await panel.waitForLoadState();
  await panel.evaluate(() => chrome.runtime.onMessage.addListener((msg) => { window.recordExtensionEvent(msg); }));
  await until(() => panel.locator('#model-select option').count(), 'model list');
  // The editor must be discoverable at actual side-panel widths after reload.
  await panel.setViewportSize({ width: 360, height: 800 });
  await until(() => panel.locator('#build-version').textContent().then((text) => text === `v${manifest.version}`), 'current build version');
  assert.equal(await panel.locator('#edit-connection').textContent(), 'Edit connection');
  const editBounds = await panel.locator('#edit-connection').boundingBox();
  assert(editBounds && editBounds.x >= 0 && editBounds.x + editBounds.width <= 360 && editBounds.y < 140);
  await panel.getByRole('button', { name: 'Edit connection', exact: true }).click();
  await panel.locator('#modal-auth-baseURL').waitFor();
  assert.equal(await panel.locator('#modal-auth-baseURL').inputValue(), baseURL + '/v1');
  await panel.locator('#connect-close').click();
  console.log('PASS: version and direct Edit connection control visible at 360px after reload');
  console.log('PASS: extension boots; custom provider connects and discovers models');

  const connection = await send({ kind: 'get_provider_connection', providerId: 'custom' });
  assert.deepEqual(connection.data, { baseURL: baseURL + '/v1', hasSavedKey: true });
  const editCustom = async () => {
    await panel.locator('#provider-chip').click();
    await panel.getByRole('button', { name: 'Edit Custom connection', exact: true }).click();
    await panel.locator('#modal-auth-baseURL').waitFor();
  };
  await editCustom();
  assert.equal(await panel.locator('#modal-auth-baseURL').inputValue(), baseURL + '/v1');
  assert.equal(await panel.locator('#modal-auth-apiKey').inputValue(), '');
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
  await until(() => panel.locator('#connect-modal').getAttribute('hidden').then((v) => v !== null), 'save existing connection');
  assert.equal(modelRequests.at(-1).authorization, 'Bearer mock-secret');
  assert.equal((await send({ kind: 'get_state' })).data.settings.modelId, 'mock-selected');

  await editCustom();
  const beforeEdit = modelRequests.length;
  await panel.locator('#modal-auth-baseURL').fill(baseURL + '/edited/v1');
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
  await until(() => panel.locator('#validation-msg').textContent().then((t) => t.includes('server address changed')), 'reject forwarding saved key');
  assert.equal(modelRequests.length, beforeEdit, 'old key must not go to a changed endpoint');
  await panel.locator('#modal-auth-apiKey').fill('mock-replacement-key');
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
  await until(() => panel.locator('#connect-modal').getAttribute('hidden').then((v) => v !== null), 'save edited endpoint and key');
  assert.equal(modelRequests.at(-1).url, '/edited/v1/models');
  assert.equal(modelRequests.at(-1).authorization, 'Bearer mock-replacement-key');
  assert.equal((await send({ kind: 'get_provider_connection', providerId: 'custom' })).data.baseURL, baseURL + '/edited/v1');

  await editCustom();
  await panel.getByLabel('Use without an API key').check();
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
  await until(() => panel.locator('#connect-modal').getAttribute('hidden').then((v) => v !== null), 'remove optional API key');
  assert.equal((await send({ kind: 'get_provider_connection', providerId: 'custom' })).data.hasSavedKey, false);
  assert(!modelRequests.at(-1).authorization?.includes('mock-'));
  console.log('PASS: edit custom endpoint/key, retain unchanged key/model, block key forwarding, remove optional key');

  // Execute in a real content-script context with the extension's identity.
  const untrusted = await panel.evaluate(async (targetId) => {
    return (await chrome.scripting.executeScript({ target: { tabId: targetId }, func: async () => {
      const out = {};
      for (const name of ['local', 'session']) {
        try { await chrome.storage[name].get(null); out[name] = 'readable'; } catch { out[name] = 'blocked'; }
      }
      out.settings = await chrome.runtime.sendMessage({ kind: 'get_state' });
      out.connection = await chrome.runtime.sendMessage({ kind: 'get_provider_connection', providerId: 'custom' });
      out.autonomy = await chrome.runtime.sendMessage({ kind: 'set_autonomy', mode: 'auto' });
      out.run = await chrome.runtime.sendMessage({ kind: 'send_message', tabId: 1, text: 'malicious' });
      out.selection = await chrome.runtime.sendMessage({ kind: 'selection_action', action: 'explain', text: 'Untrusted selection' });
      return out;
    } }))[0].result;
  }, tabId);
  assert.equal(untrusted.local, 'blocked');
  assert.equal(untrusted.session, 'blocked');
  for (const key of ['settings', 'connection', 'autonomy', 'run']) assert.equal(untrusted[key].ok, false);
  assert.equal(requests.length, 0, 'selection only produces a draft');
  console.log('PASS: real content scripts cannot read storage, change autonomy or start a run');

  const start = async (sequence, text = 'Run fixture test') => {
    toolsToReturn = sequence;
    events.length = 0;
    const response = await send({ kind: 'send_message', tabId, text });
    assert.equal(response.ok, true);
    return response.data.sessionId;
  };
  const finished = async (sessionId) => until(async () => {
    const state = (await send({ kind: 'get_state', sessionId })).data.session;
    if (state?.state === 'error') throw new Error(JSON.stringify(events.filter((e) => e.kind === 'error')));
    return state?.state === 'done';
  }, 'run completes');

  let sessionId = await start([{ name: 'snapshot', input: {} }]);
  await finished(sessionId);
  assert(requests.every((r) => r.model === 'mock-selected'));
  assert(requests.every((r) => !r.tools.some((t) => ['remember', 'forget'].includes(t.function.name))));
  const snap = events.find((e) => e.kind === 'tool_result' && e.name === 'snapshot');
  assert(snap && !snap.isError, JSON.stringify(snap));
  assert(snap.content.includes('Name'));
  assert.equal(await target.evaluate(() => Object.keys(window.__agentRefMap).join(',')), 'poisoned');
  const nameRef = snap.content.match(/textbox "Name" \[ref=([^\]]+)\]/)?.[1];
  assert(nameRef, snap.content);
  console.log('PASS: chosen model, complete tool history, snapshot in isolated page world');

  sessionId = await start([
    { name: 'propose_plan', input: { steps: [{ title: '<img id="injected" src="https://track.invalid/x">Fill name' }] } },
    { name: 'type', input: { ref: nameRef, text: 'Verified input' } },
  ]);
  await until(() => panel.locator('.card.plan').count(), 'plan card');
  assert.equal(await panel.locator('#injected').count(), 0, 'plan text must not create HTML');
  await panel.getByRole('button', { name: 'Approve plan', exact: true }).click();
  const approval = await until(() => events.find((e) => e.kind === 'permission_request' && e.name === 'type'), 'action approval after plan approval');
  assert.equal(await target.locator('#name').inputValue(), '');
  assert.equal(approval.input.text, 'Verified input');
  await panel.getByRole('button', { name: 'Allow once', exact: true }).click();
  await finished(sessionId);
  assert.equal(await target.locator('#name').inputValue(), 'Verified input');
  console.log('PASS: escaped plan HTML; approved plans still require action approval; typing works');

  await send({ kind: 'set_autonomy', mode: 'auto' });
  sessionId = await start([{ name: 'navigate', input: { url: 'javascript:alert(1)' } }]);
  const navigation = await until(() => events.find((e) => e.kind === 'permission_request' && e.name === 'navigate'), 'navigation in Auto mode');
  assert.equal(navigation.alwaysAsk, true);
  await send({ kind: 'permission_decision', sessionId, toolCallId: navigation.toolCallId, decision: 'allow' });
  await finished(sessionId);
  assert(events.some((e) => e.kind === 'tool_result' && e.name === 'navigate' && e.isError));
  assert.equal(target.url(), baseURL + '/');
  console.log('PASS: Auto mode still prompts for navigation; unsafe schemes fail even after approval');

  sessionId = await start([{ name: 'screenshot', input: {} }]);
  await finished(sessionId);
  assert(requests.at(-1).messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')));
  const persisted = await worker.evaluate(() => chrome.storage.local.get(null));
  assert(!Object.keys(persisted).some((key) => key.startsWith('agent.session.')));
  assert(!JSON.stringify(persisted).includes('mock-secret'));
  // Provider host access must not conceal missing permissions on the page being
  // automated. Chrome omits Tab.url here (e.g. after activeTab is revoked).
  await target.goto(`http://localhost:${server.address().port}/`);
  const hiddenURL = await worker.evaluate(async (targetId) => (await chrome.tabs.get(targetId)).url ?? null, tabId);
  assert.equal(hiddenURL, null, 'test must exercise a page without tab URL access');
  sessionId = await start([{ name: 'snapshot', input: {} }]);
  await finished(sessionId);
  assert(events.some((e) => e.kind === 'tool_result' && e.name === 'snapshot' && !e.isError));
  console.log('PASS: page works when Chrome omits Tab.url; no extra host permissions');
  // A page redirect while the model is thinking must not silently grant access
  // to a new origin, even for a read-only tool and even in Auto mode.
  const secondSite = createServer((_, res) => res.end('<h1>Private second site</h1>'));
  await new Promise((r) => secondSite.listen(0, '127.0.0.1', r));
  try {
    const secondURL = `http://localhost:${secondSite.address().port}/`;
    beforeNextReply = () => target.goto(secondURL);
    sessionId = await start([{ name: 'snapshot', input: {} }]);
    const access = await until(() => events.find((e) => e.kind === 'permission_request' && e.name === 'access_page'), 'new-origin read approval');
    assert.equal(access.site, new URL(secondURL).origin);
    assert(!events.some((e) => e.kind === 'tool_result' && e.name === 'snapshot'));
    await send({ kind: 'permission_decision', sessionId, toolCallId: access.toolCallId, decision: 'deny' });
    await finished(sessionId);
    console.log('PASS: cross-origin redirects cannot silently grant read access in Auto mode');
  } finally {
    secondSite.closeAllConnections();
    await new Promise((r) => secondSite.close(r));
  }
  // Each panel is owned by one tab, including when booting with a different
  // tab active. Use actual sidePanel configuration as well as separate UI pages.
  await target.goto(baseURL);
  await target.locator('h1').evaluate((el) => { el.textContent = 'Only tab A content'; });
  const other = await ctx.newPage();
  await other.goto(baseURL + '/other');
  await other.locator('h1').evaluate((el) => { el.textContent = 'Only tab B content'; });
  const otherId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url)?.id, other.url());
  assert(otherId && otherId !== tabId);
  assert.equal((await worker.evaluate(() => chrome.sidePanel.getOptions({}))).enabled, false);
  assert.equal((await worker.evaluate((tabId) => chrome.sidePanel.getOptions({ tabId }), otherId)).enabled, false);
  const openNativePanel = async (page, owner) => {
    await page.evaluate((tabId) => {
      const button = document.createElement('button');
      button.id = 'test-native-open';
      button.textContent = 'Open tab panel';
      button.onclick = async () => {
        button.dataset.result = JSON.stringify(await chrome.runtime.sendMessage({ kind: 'open_side_panel_for_tab', tabId }));
      };
      document.body.appendChild(button);
    }, owner);
    await page.locator('#test-native-open').click();
    const result = JSON.parse(await until(() => page.locator('#test-native-open').getAttribute('data-result'), 'native open from real click'));
    await page.locator('#test-native-open').evaluate((el) => el.remove());
    return result;
  };
  const opened = await openNativePanel(panel, tabId);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const optionsA = await worker.evaluate((tabId) => chrome.sidePanel.getOptions({ tabId }), tabId);
  assert.equal(optionsA.path, `panel.html?tabId=${tabId}`);
  assert.equal(optionsA.enabled, true);
  await target.bringToFront();
  await until(() => worker.evaluate(async (owner) => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }))
    .some((c) => c.documentUrl.endsWith(`panel.html?tabId=${owner}`)), tabId), 'native A side panel instance');
  assert.equal((await worker.evaluate((tabId) => chrome.sidePanel.getOptions({ tabId }), otherId)).enabled, false);

  await panel.locator('#composer').fill('Draft for tab A only');
  await until(async () => (await send({ kind: 'get_state' })).data.tabState.draft === 'Draft for tab A only', 'save A draft');
  await other.bringToFront();
  await panel.reload();
  await until(() => panel.locator('#send-btn').isEnabled(), 'restore A while B is active');
  await panel.evaluate(() => chrome.runtime.onMessage.addListener((msg) => { window.recordExtensionEvent(msg); }));
  assert.equal(await panel.locator('html').getAttribute('data-tab-id'), String(tabId));
  assert.equal(await panel.locator('#composer').inputValue(), 'Draft for tab A only');
  assert((await panel.locator('#messages').textContent()).includes('Run fixture test'));

  const nextPage = ctx.waitForEvent('page');
  await worker.evaluate((url) => chrome.tabs.create({ url, active: false }), `chrome-extension://${id}/panel.html?tabId=${otherId}`);
  const panelB = await nextPage;
  panelB.on('pageerror', (e) => browserErrors.push(e.message));
  await until(() => panelB.locator('#send-btn').isEnabled(), 'independent B panel boot');
  const sendB = (msg) => panelB.evaluate((message) => chrome.runtime.sendMessage(message), msg);
  assert.equal((await sendB({ kind: 'get_state' })).data.sessions.length, 0);
  assert(!(await panelB.locator('#messages').textContent()).includes('Run fixture test'));
  assert.equal(await panelB.locator('#composer').inputValue(), '');
  await panelB.locator('#composer').fill('Draft for tab B only');
  await panelB.locator('#model-select').selectOption('mock-first');
  await until(async () => (await sendB({ kind: 'get_state' })).data.settings.modelId === 'mock-first', 'B model selection');
  assert.equal((await send({ kind: 'get_state' })).data.settings.modelId, 'mock-selected');
  assert.equal((await sendB({ kind: 'get_state' })).data.settings.autonomyMode, 'ask');
  assert.equal((await send({ kind: 'get_state' })).data.settings.autonomyMode, 'auto');
  assert.equal((await openNativePanel(panelB, otherId)).ok, true);
  assert.equal((await worker.evaluate((tabId) => chrome.sidePanel.getOptions({ tabId }), otherId)).path, `panel.html?tabId=${otherId}`);
  console.log('PASS: no global panel; distinct native tab paths; owner, conversation, model and draft survive switching/reload');

  // Hold A at approval while B executes on its own document with its own model.
  await send({ kind: 'set_autonomy', mode: 'ask' });
  sessionId = await start([{ name: 'navigate', input: { url: baseURL + '/never-visited' } }], 'Task only in tab A');
  const pendingA = await until(() => events.find((e) => e.kind === 'permission_request' && e.name === 'navigate'), 'A approval');
  const firstBRequest = requests.length;
  toolsToReturn = [{ name: 'snapshot', input: {} }];
  await panelB.locator('#composer').fill('Task only in tab B');
  await panelB.locator('#send-btn').click();
  const sessionB = await until(async () => (await sendB({ kind: 'get_state' })).data.sessions.at(-1), 'B session');
  await until(async () => (await sendB({ kind: 'get_state', sessionId: sessionB.sessionId })).data.session.state === 'done', 'B completes independently');
  assert(requests.slice(firstBRequest).every((r) => r.model === 'mock-first'));
  const historyB = JSON.stringify((await sendB({ kind: 'get_state', sessionId: sessionB.sessionId })).data.session.history);
  assert(historyB.includes('Only tab B content'));
  assert(!historyB.includes('Only tab A content') && !historyB.includes('Task only in tab A'));
  assert(!(await panel.locator('#messages').textContent()).includes('Task only in tab B'));
  assert.equal(await panelB.locator('.card.permission').count(), 0);
  for (const request of [
    { kind: 'send_message', tabId, text: 'Wrong target' },
    { kind: 'get_state', sessionId },
    { kind: 'stop', sessionId },
    { kind: 'permission_decision', sessionId, toolCallId: pendingA.toolCallId, decision: 'allow' },
  ]) assert.equal((await sendB(request)).ok, false, request.kind);
  assert.equal((await send({ kind: 'get_state', sessionId })).data.session.state, 'awaiting_permission');
  await panel.reload();
  await until(() => panel.locator('#send-btn').isEnabled(), 'restore A approval');
  assert.equal(await panel.locator('.card.permission').count(), 1);
  assert.equal(await panel.locator('#stop-btn').isVisible(), true);
  await panel.getByRole('button', { name: 'Deny', exact: true }).click();
  await finished(sessionId);
  assert.equal(target.url(), baseURL + '/');

  // A follow-up must use B's conversation even after A has been active.
  await target.bringToFront();
  await panelB.reload();
  await until(() => panelB.locator('#send-btn').isEnabled(), 'restore B conversation');
  assert((await panelB.locator('#messages').textContent()).includes('Task only in tab B'));
  await panelB.locator('#composer').fill('Follow up only in tab B');
  await panelB.locator('#send-btn').click();
  await until(() => requests.at(-1).messages.some((m) => typeof m.content === 'string' && m.content.includes('Follow up only in tab B')), 'B follow-up request');
  await until(async () => (await sendB({ kind: 'get_state', sessionId: sessionB.sessionId })).data.session.state === 'done', 'B follow-up completes');
  assert.equal((await sendB({ kind: 'get_state' })).data.sessions.at(-1).sessionId, sessionB.sessionId);
  assert(JSON.stringify(requests.at(-1).messages).includes('Task only in tab B'));
  assert(!JSON.stringify(requests.at(-1).messages).includes('Task only in tab A'));
  console.log('PASS: concurrent tabs keep requests, histories and approvals separate; reopens restore approvals and follow-up context');

  sessionId = await start([{ name: 'propose_plan', input: { steps: [{ title: 'Keep A pending' }] } }], 'A remains open when B closes');
  await until(async () => (await send({ kind: 'get_state' })).data.planPending, 'A pending plan');
  toolsToReturn = [{ name: 'navigate', input: { url: baseURL + '/never-visited-b' } }];
  await sendB({ kind: 'send_message', tabId: otherId, text: 'B closes during its run' });
  await until(async () => (await sendB({ kind: 'get_state' })).data.pendingPermissions.length === 1, 'B pending action');
  await other.close();
  await until(async () => {
    const storage = await worker.evaluate(() => chrome.storage.session.get(null));
    return !storage[`agent.tab.${otherId}`] && !Object.values(storage).some((v) => v?.tabId === otherId);
  }, 'closing B removes only B session data');
  assert((await send({ kind: 'get_state' })).data.sessions.length > 0);
  assert.equal((await send({ kind: 'get_state' })).data.planPending, true);
  await panel.reload();
  await until(() => panel.locator('#send-btn').isEnabled(), 'restore A plan after B closes');
  assert.equal(await panel.locator('.card.plan').count(), 1);
  await panel.locator('#stop-btn').click();
  await finished(sessionId);
  assert.equal(await panel.locator('.card.plan').count(), 0);
  const afterClose = await worker.evaluate(() => chrome.storage.session.get(null));
  assert(!afterClose[`agent.tab.${otherId}`]);
  assert(!Object.values(afterClose).some((v) => v?.tabId === otherId), 'cancelled run must not recreate a closed tab session');
  assert.equal((await sendB({ kind: 'send_message', tabId: otherId, text: 'Closed tab' })).ok, false);
  console.log('PASS: closing a tab cancels and clears its run; another tab keeps its plan and can stop independently');
  let releaseReply;
  const replyGate = new Promise((resolve) => { releaseReply = resolve; });
  beforeNextReply = () => replyGate;
  const rapid = await Promise.all([
    send({ kind: 'send_message', tabId, text: 'Rapid first message' }),
    send({ kind: 'send_message', tabId, text: 'Rapid second message' }),
  ]);
  releaseReply();
  assert(rapid.every((r) => r.ok));
  assert.equal(rapid[0].data.sessionId, rapid[1].data.sessionId);
  assert.equal(rapid.filter((r) => r.data.queued).length, 1);
  await until(() => requests.some((r) => JSON.stringify(r.messages).includes('Rapid second message')), 'rapid second message reaches same conversation');
  await finished(rapid[0].data.sessionId);
  console.log('PASS: rapid sends share one tab session and queue instead of starting competing runs');
  assert.equal(browserErrors.length, 0, JSON.stringify(browserErrors));
  console.log('PASS: screenshot reaches model; no transcripts/plaintext API key persisted; no panel JS errors');
} finally {
  await ctx?.close();
  await new Promise((r) => server.close(r));
  await rm(scratch, { recursive: true, force: true });
}
