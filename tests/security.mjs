import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const dir = await mkdtemp(join(tmpdir(), 'tabagent-unit-'));
const local = new Map([['agent.session.legacy', { history: ['private'] }]]);
const session = new Map();
const levels = [];
function area(map, name) {
  return {
    async get(key) { return structuredClone(Object.fromEntries([...map].filter(([k]) => key == null || k === key))); },
    async set(data) { for (const [k, v] of Object.entries(data)) map.set(k, structuredClone(v)); },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k); },
    async setAccessLevel(level) { levels.push([name, level.accessLevel]); },
  };
}
globalThis.chrome = {
  runtime: { id: 'test', getURL: (p) => `chrome-extension://test/${p}` },
  storage: { local: area(local, 'local'), session: area(session, 'session') },
};
try {
  const output = join(dir, 'modules.mjs');
  await build({ stdin: { contents: `
    export * from './src/core/security';
    export * from './src/core/storage';
    export * from './src/background/permissions';
    export * from './src/background/plan-service';
    export * from './src/providers/openai-compat';
    export * from './src/shared/external-tools';
    export * from './src/tools/browser-tools';
  `, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: output });
  const m = await import(pathToFileURL(output));
  const browserTools = m.createBrowserToolRegistry();
  assert.deepEqual(m.EXTERNAL_TOOLS.map((t) => t.name).sort(), browserTools.list().map((t) => t.info().name).sort());
  for (const tool of m.EXTERNAL_TOOLS) {
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), Object.keys(browserTools.get(tool.name).info().parameters.properties).sort(), `${tool.name}: MCP and native arguments must agree`);
    assert.equal(tool.readonly, !!browserTools.get(tool.name).meta.readonly, `${tool.name}: MCP permissions must agree with the browser dispatcher`);
  }
  console.log('PASS: MCP/native browser tool names, argument keys and mutation classifications agree');
  await m.initStorageAccess();
  assert.deepEqual(levels.sort(), [['local', 'TRUSTED_CONTEXTS'], ['session', 'TRUSTED_CONTEXTS']]);
  assert(!local.has('agent.session.legacy'));
  await m.writeEncryptedCredentials({ custom: { apiKey: 'unit-test-secret' } });
  assert(!JSON.stringify([...local]).includes('unit-test-secret'));
  session.clear();
  assert.equal(await m.unlockCredentials(), true);
  assert.equal((await m.readProviderCredentials('custom')).apiKey, 'unit-test-secret');
  const live = { sessionId: 'abc', history: [{ parts: [{ type: 'tool_result', content: 'data:image/jpeg;base64,abc' }] }] };
  await m.saveSession(live);
  assert(!local.has('agent.session.abc'));
  assert.equal(live.history[0].parts[0].content, 'data:image/jpeg;base64,abc');
  assert(!JSON.stringify(await m.loadSession('abc')).includes('base64,abc'));
  await m.saveSettings({ providerId: 'custom', modelId: 'initial' });
  await m.loadTabState(1);
  await m.loadTabState(2);
  await Promise.all([m.saveTabState(1, { draft: 'Tab one draft' }), m.saveTabState(1, { modelId: 'one', autonomyMode: 'auto' })]);
  assert.deepEqual(await m.loadTabState(1), { providerId: 'custom', modelId: 'one', autonomyMode: 'auto', draft: 'Tab one draft' });
  assert.deepEqual(await m.loadTabState(2), { providerId: 'custom', modelId: 'initial', autonomyMode: 'ask', draft: '' });
  assert(!JSON.stringify([...local]).includes('Tab one draft'));
  await m.deleteTabState(1);
  assert(!session.has('agent.tab.1'));
  console.log('PASS: storage isolation, credential round trip, memory-only checkpoints');

  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/a', 'chrome://settings', 'https://user:pw@example.com']) {
    assert.throws(() => m.webURL(url));
  }
  for (const url of ['http://example.com/v1', 'http://localhost.evil.com/v1', 'https://example.com/v1?key=x']) {
    assert.throws(() => m.providerURL(url));
  }
  for (const url of ['https://api.example.com/v1', 'http://127.0.0.1:11434/v1', 'http://localhost:1234/v1', 'http://[::1]:1234/v1']) assert(m.providerURL(url));
  const bad = { id: 'test', url: 'https://evil.example', tab: { id: 2 }, frameId: 0 };
  assert(!m.isExtensionPage(bad, ['panel.html']));
  assert(!m.isBackground(bad));
  assert(m.isSelectionSender(bad));
  assert(!m.isSelectionSender({ ...bad, id: 'other-extension' }));
  assert(m.isExtensionPage({ id: 'test', url: chrome.runtime.getURL('panel.html?tabId=2') }, ['panel.html']));
  for (const path of ['panel.html', 'panel.html?tabId=0', 'panel.html?tabId=2&tabId=3', 'panel.html?tabId=2#other', 'panel.html?tabId=NaN']) {
    assert(!m.isExtensionPage({ id: 'test', url: chrome.runtime.getURL(path) }, ['panel.html']));
  }
  console.log('PASS: URL restrictions and sender boundaries');

  await m.saveSettings({ permissionGrants: { 'https://example.com::*': true } });
  let pending;
  m.permissions.onPendingChange((p) => { pending = p; });
  const call = { id: 'nav', name: 'navigate', input: { url: 'https://example.net' } };
  const approval = m.permissions.request('run', call, 'Navigate?', 'https://example.com', true);
  await new Promise((r) => setImmediate(r));
  assert.equal(pending.toolCallId, 'nav');
  m.permissions.resolve('nav', 'allow', 'wrong-session');
  assert.equal(m.permissions.pendingForSession('run').length, 1);
  m.permissions.resolve('nav', { kind: 'always_allow_on_site', site: 'https://example.com' }, 'run');
  assert.equal(m.permissions.pendingForSession('run').length, 1);
  m.permissions.resolve('nav', 'deny', 'run');
  assert.equal(await approval, 'deny');
  const ordinary = m.permissions.request('run', { ...call, id: 'type', name: 'type' }, '?', 'https://new.example');
  await new Promise((r) => setImmediate(r));
  m.permissions.resolve('type', { kind: 'always_allow_on_site', site: 'https://other.example' }, 'run');
  assert.equal(m.permissions.pendingForSession('run').length, 1);
  m.permissions.abortSession('run');
  assert.equal(await ordinary, 'deny');
  const plan = m.planService.requestApproval('run', 'plan');
  m.planService.resolve('plan', 'approve', 'wrong-session');
  assert(m.planService.hasPending('run'));
  m.planService.resolve('plan', 'reject', 'run');
  assert.equal(await plan, 'reject');
  console.log('PASS: navigation cannot inherit grants; decisions bind to session and origin');

  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return new Response('data: [DONE]\n\n', { status: 200 });
  };
  const ctx = { providerId: 'custom', baseURL: 'http://localhost:1234/v1', credentials: { apiKey: 'test' }, seedModels: [] };
  const req = {
    model: { id: 'chosen-model', apiName: 'chosen-model' },
    messages: [
      { role: 'assistant', parts: [{ type: 'tool_call', id: 'shot', name: 'screenshot', input: '{}' }] },
      { role: 'tool', parts: [{ type: 'tool_result', toolCallId: 'shot', name: 'screenshot', content: 'data:image/jpeg;base64,abc' }] },
    ], tools: [], signal: new AbortController().signal,
  };
  for await (const _ of m.OpenAICompatAdapter.streamChat(req, ctx)) { /* drain */ }
  const body = JSON.parse(request.init.body);
  assert.equal(body.model, 'chosen-model');
  assert.equal(body.messages[0].tool_calls[0].id, 'shot');
  assert.equal(body.messages[2].content[1].image_url.url, 'data:image/jpeg;base64,abc');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.referrerPolicy, 'no-referrer');
  globalThis.fetch = originalFetch;
  const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
  assert.deepEqual(manifest.host_permissions, []);
  assert(!manifest.side_panel, 'no global panel may follow the active tab');
  assert(!manifest.content_scripts);
  assert(!manifest.web_accessible_resources);
  assert(!manifest.content_security_policy.extension_pages.includes('unsafe-eval'));
  console.log('PASS: image/tool wire format, private fetch options, minimal manifest');
} finally {
  await rm(dir, { recursive: true, force: true });
}
