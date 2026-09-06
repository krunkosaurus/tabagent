import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentSession, createAgentSessionRuntime, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

export async function until(fn, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out: ${label}`);
}
export const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'tabagent-fixture', model: 'test', usage, stopReason: 'stop', timestamp: Date.now() });

/** Real Pi loader/session/runtime + a local deterministic model API. Never reads
 * the user's Pi settings, session history, credentials, project or model server. */
export async function createPiFixture() {
  const scratch = await mkdtemp(join(tmpdir(), 'tabagent-pi-'));
  const requests = [];
  const plans = [];
  const errors = [];
  const events = [];
  let release;
  const http = createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks)));
      const plan = plans.shift() ?? { text: 'Fixture reply.' };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      chunk({ role: 'assistant', content: '', reasoning_content: 'PRIVATE_REASONING' });
      chunk({ content: plan.text ?? 'Working…' });
      if (plan.hold) await new Promise((resolve) => { release = resolve; res.once('close', resolve); });
      if (res.destroyed) return;
      if (plan.tool) chunk({ tool_calls: [{ index: 0, id: 'fixture_call', type: 'function', function: { name: plan.tool.name, arguments: JSON.stringify(plan.tool.args) } }] });
      if (plan.tail) chunk({ content: plan.tail });
      chunk({}, plan.tool ? 'tool_calls' : 'stop');
      res.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error.message); res.destroy(); }
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const model = { id: 'test', name: 'Local fixture', provider: 'tabagent-fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${http.address().port}/v1`,
    reasoning: false, input: ['text', 'image'], cost: usage.cost, contextWindow: 100000, maxTokens: 4000 };
  const factory = async ({ sessionManager, sessionStartEvent }) => {
    const modelRuntime = await ModelRuntime.create({ authPath: join(scratch, 'auth.json'), modelsPath: null,
      modelsStorePath: join(scratch, 'models-cache.json'), allowModelNetwork: false, refreshOnCreate: false });
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd: scratch, agentDir: scratch, settingsManager,
      noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [resolve('.')], // Exercise package.json's Pi manifest.
      extensionFactories: [(pi) => pi.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: 'test-only', models: [model] })],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const result = await createAgentSession({ cwd: scratch, agentDir: scratch, resourceLoader, modelRuntime, settingsManager,
      model, noTools: 'builtin', sessionManager, sessionStartEvent });
    return { ...result, services: { cwd: scratch, agentDir: scratch, resourceLoader, modelRuntime, settingsManager, diagnostics: [] }, diagnostics: [] };
  };
  const manager = SessionManager.inMemory(scratch);
  manager.appendMessage({ role: 'user', content: 'Remember the blue lighthouse.', timestamp: Date.now() });
  manager.appendMessage(assistant('I will remember the blue lighthouse.'));
  const runtime = await createAgentSessionRuntime(factory, { cwd: scratch, agentDir: scratch, sessionManager: manager });
  const bind = async (session) => {
    session.subscribe((event) => events.push(event));
    await session.bindExtensions({ mode: 'rpc', onError: (error) => errors.push(error.error) });
  };
  await bind(runtime.session);
  runtime.setRebindSession(bind);
  return {
    runtime, requests, plans, errors, events, scratch,
    get session() { return runtime.session; },
    release() { release?.(); release = undefined; },
    async call(name, args = {}, signal) {
      const tool = runtime.session.agent.state.tools.find((t) => t.name === name);
      assert(tool, `Native Pi tool ${name} exists`);
      return tool.execute('test_call', args, signal ?? new AbortController().signal);
    },
    async code() { return JSON.parse((await this.call('tabagent_connect')).content[0].text).pairingCode; },
    async close() {
      release?.();
      await runtime.session.abort();
      await runtime.dispose();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
      await rm(scratch, { recursive: true, force: true });
    },
  };
}
