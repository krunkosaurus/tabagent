import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createPiFixture, until } from './pi-fixture.mjs';
import { PiChat } from '../pi/chat.js';
import { parsePairingCode, validateChatRequest, validateChatState } from '../build/mcp-tools.mjs';

const fixture = await createPiFixture();
const peers = [];
const deadline = setTimeout(() => { throw new Error('Pi integration tests timed out'); }, 60_000);
async function pair(code, tabId) {
  const { port, token } = parsePairingCode(code);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tabagent`, { origin: `chrome-extension://${'a'.repeat(32)}` });
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw)));
  peers.push(ws);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'auth', token }));
  const ready = await until(() => messages.find((m) => m.type === 'ready'), 'ready');
  ws.send(JSON.stringify({ type: 'share', tabId, url: 'https://example.com/', title: 'Fixture' }));
  await until(() => messages.find((m) => m.type === 'shared'), 'shared');
  return { ws, messages, sessionId: ready.chatSessionId,
    state: () => messages.filter((m) => m.type === 'chat_state').at(-1)?.state,
    async request(action, text, overrides = {}) {
      const req = { type: 'chat_request', id: randomUUID(), sessionId: ready.chatSessionId, action, ...(text === undefined ? {} : { text }), ...overrides };
      ws.send(JSON.stringify(req));
      return until(() => messages.find((m) => m.type === 'chat_ack' && m.id === req.id), `ack ${action}`);
    },
  };
}

try {
  assert.equal(fixture.session.getAllTools().filter((t) => t.name.startsWith('tabagent_')).length, 14);
  const code = await fixture.code();
  const a = await pair(code, 101);
  const b = await pair(code, 102);
  assert.equal(a.state(), undefined, 'pairing alone never sends history');
  assert.equal((await a.request('attach')).error, undefined);
  assert.match(JSON.stringify(a.state()), /blue lighthouse/);
  assert((await b.request('attach')).error.includes('another shared tab'));
  assert.equal(b.state(), undefined);
  assert((await b.request('send', 'steal')).error.includes('Attach'));
  assert((await a.request('send', 'wrong session', { sessionId: randomUUID() })).error.includes('ended'));
  console.log('PASS: real Pi extension loads native tools; chat requires attachment and belongs to one tab/session');

  fixture.plans.push({ text: 'Terminal reply' });
  await fixture.session.prompt('Message from the terminal');
  await until(() => JSON.stringify(a.state()).includes('Terminal reply'), 'terminal reply reaches panel');
  fixture.plans.push({ text: 'Streaming reply', tail: ' complete', hold: true });
  assert.equal((await a.request('send', 'Continue from the browser')).error, undefined);
  await until(() => a.state()?.busy && JSON.stringify(a.state()).includes('Streaming reply'), 'partial stream');
  assert((await a.request('send', 'second message while busy')).error.includes('working'));
  assert(JSON.stringify(fixture.requests.at(-1)).includes('blue lighthouse'));
  assert(JSON.stringify(fixture.requests.at(-1)).includes('Message from the terminal'));
  assert(!JSON.stringify(a.state()).includes('PRIVATE_REASONING'));
  fixture.release();
  await until(() => !a.state().busy && JSON.stringify(a.state()).includes('Streaming reply complete'), 'stream completed');
  assert(fixture.session.messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('Continue from the browser')));
  console.log('PASS: terminal and panel use the same model context; partial replies stream without raw reasoning');

  const quietStart = a.messages.length;
  const quietRequests = fixture.requests.length;
  fixture.plans.push(
    { text: '', tool: { name: 'tabagent_tabs', args: {} } },
    { text: ' \n', tool: { name: 'tabagent_tabs', args: {} } },
    { text: '', tail: 'The browser tools finished.', hold: true },
  );
  await a.request('send', 'Use tools before replying');
  await until(() => fixture.requests.length === quietRequests + 3 &&
    a.state()?.messages.some((m) => m.text === 'Use tools before replying'), 'tool-only turns followed by thinking');
  for (const message of a.messages.slice(quietStart).filter((m) => m.type === 'chat_state')) {
    assert(message.state.messages.every((m) => m.text.trim()), 'tool-only and thinking-only turns must not become blank messages');
  }
  assert(!JSON.stringify(a.state()).includes('PRIVATE_REASONING'));
  fixture.release();
  await until(() => !a.state().busy && a.state().messages.some((m) => m.text === 'The browser tools finished.'), 'text after an empty stream start');
  console.log('PASS: tool-only and thinking-only turns stay out of chat while later visible text still streams');

  fixture.plans.push({ text: 'Long operation', hold: true });
  await a.request('send', 'Run until stopped');
  await until(() => JSON.stringify(a.state()).includes('Long operation'), 'long operation started');
  await a.request('abort');
  await until(() => !a.state().busy && fixture.session.isIdle, 'Pi actually aborted');
  assert(fixture.session.messages.some((m) => m.stopReason === 'aborted'));
  assert.equal(a.ws.readyState, WebSocket.OPEN, 'stopping Pi is separate from browser sharing');
  await a.request('detach');
  assert.deepEqual(a.state().messages, []);
  await b.request('attach');
  assert.equal(b.state().attached, true);
  const count = fixture.requests.length;
  const id = randomUUID();
  await b.request('send', 'Only once', { id });
  const closed = once(b.ws, 'close');
  b.ws.send(JSON.stringify({ type: 'chat_request', id, sessionId: b.sessionId, action: 'send', text: 'Only once' }));
  await closed;
  await until(() => fixture.session.isIdle && fixture.requests.length > count, 'one prompt finishes');
  assert.equal(fixture.requests.length, count + 1);
  console.log('PASS: Stop aborts the real Pi run, detach clears history, duplicate prompts revoke the connection without replay');

  const oldClosed = once(a.ws, 'close');
  await fixture.runtime.newSession();
  await oldClosed;
  const newCode = await fixture.code();
  assert.notEqual(newCode, code);
  const c = await pair(newCode, 103);
  assert.notEqual(c.sessionId, a.sessionId);
  await c.request('attach');
  assert.deepEqual(c.state().messages, []);
  await assert.rejects(fixture.call('tabagent_snapshot', { tabId: 101 }), /not shared/);
  await assert.rejects(fixture.call('tabagent_navigate', { tabId: 103, url: 'file:///tmp/a' }), /HTTP/);
  const invocation = until(() => c.messages.find((m) => m.type === 'invoke'), 'native browser call');
  const snapshot = fixture.call('tabagent_snapshot', { tabId: 103 });
  const command = await invocation;
  c.ws.send(JSON.stringify({ type: 'result', id: command.id, content: 'real browser result', isError: false }));
  assert.equal((await snapshot).content[0].text, 'real browser result');
  console.log('PASS: real Pi session replacement rotates credentials, revokes old tabs, and preserves native browser result delivery');

  await fixture.session.prompt('Create a branch point');
  const branchClosed = once(c.ws, 'close');
  await fixture.session.navigateTree(fixture.session.getUserMessagesForForking()[0].entryId, { summarize: false });
  await branchClosed;
  assert.notEqual(await fixture.code(), newCode);
  console.log('PASS: changing the Pi conversation branch also revokes the old pairing');

  const input = { type: 'chat_request', id: randomUUID(), sessionId: randomUUID(), action: 'send', text: 'hello' };
  for (const mutation of [{ text: '' }, { text: 'x'.repeat(8001) }, { command: 'bash' }, { action: 'eval' }, { sessionId: '../session' }, { action: 'abort', text: 'oops' }]) {
    assert.throws(() => validateChatRequest({ ...input, ...mutation }));
  }
  const ctx = { isIdle: () => true, sessionManager: { getBranch: () => [
    { type: 'message', message: { role: 'toolResult', content: 'PRIVATE_TOOL_RESULT' } },
    ...Array.from({ length: 100 }, () => ({ type: 'message', message: { role: 'user', content: '\x00'.repeat(9000) } })),
    { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_THOUGHT' }, { type: 'text', text: '<img src=x onerror=alert(1)>' }] } },
  ] } };
  const chat = new PiChat({ getSessionName: () => 'Private test' }, ctx);
  const bounded = { ...chat.snapshot(), attached: true, sessionId: chat.sessionId, revision: 1 };
  validateChatState(bounded);
  assert(bounded.truncated && JSON.stringify(bounded).length < 100000);
  assert(!JSON.stringify(bounded).includes('PRIVATE_TOOL_RESULT') && !JSON.stringify(bounded).includes('PRIVATE_THOUGHT'));
  assert.throws(() => validateChatState({ ...bounded, messages: [...bounded.messages, bounded.messages[0]] }));
  chat.close();
  assert.deepEqual(fixture.errors, []);
  console.log('PASS: bounded chat schemas reject malformed input and repeated IDs; only recent visible text is serialized');
} finally {
  clearTimeout(deadline);
  for (const ws of peers) ws.terminate();
  await fixture.close();
}
