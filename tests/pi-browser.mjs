import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createPiFixture, until } from './pi-fixture.mjs';

// Actual Pi -> authenticated bridge -> Chrome SW -> tab-bound panel and CDP.
const pi = await createPiFixture();
const errors = [];
let context;
const pageServer = createServer((_req, res) => res.end('<!doctype html><title>Pi browser fixture</title><h1>Blue lighthouse page</h1><button id="save" onclick="this.textContent=\'Saved\'">Save</button><div style="height:2400px">Scrollable page</div>'));
const deadline = setTimeout(() => { throw new Error('Pi browser tests timed out'); }, 90_000);
try {
  await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
  const extension = join(pi.scratch, 'extension');
  await cp('dist', extension, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  manifest.content_scripts = [...(manifest.content_scripts ?? []), { matches: ['http://127.0.0.1/*'], js: ['probe.js'] }];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(extension, 'probe.js'), `
    addEventListener('message', async (event) => {
      if (event.source === window && event.data?.probeRequest) {
        const result = await chrome.runtime.sendMessage(event.data.probeRequest);
        document.documentElement.dataset.probeResult = JSON.stringify(result);
      }
    });
    const port = chrome.runtime.connect({name:'tabagent-external'});
    port.onMessage.addListener(() => { document.documentElement.dataset.chatLeak='true'; });
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; document.documentElement.dataset.portRejected='true'; });
  `);
  context = await chromium.launchPersistentContext(join(pi.scratch, 'browser-profile'), {
    channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  async function tab(path) {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${pageServer.address().port}/${path}`);
    const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({})).find((t) => t.url === url).id, page.url());
    const created = context.waitForEvent('page');
    await worker.evaluate((url) => chrome.tabs.create({ url, active: false }), `chrome-extension://${extensionId}/panel.html?tabId=${tabId}`);
    const panel = await created;
    panel.on('pageerror', (error) => errors.push(error.message));
    await panel.waitForLoadState();
    await until(() => panel.locator('#send-btn').isEnabled(), 'panel boot');
    const send = (request) => panel.evaluate((req) => chrome.runtime.sendMessage(req), request);
    return { page, panel, tabId, send, state: async () => (await send({ kind: 'get_state' })).data.external };
  }
  const a = await tab('a');
  const b = await tab('b');
  async function share(t) {
    const code = await pi.code();
    await t.panel.locator('#external-summary').click();
    await t.panel.locator('#external-code').fill(code);
    await t.panel.locator('#external-connect').click();
    await until(async () => (await t.state())?.phase === 'ready', 'shared');
  }
  await share(a);
  await share(b);
  await a.panel.setViewportSize({ width: 360, height: 800 });
  assert.equal(await a.panel.locator('#external-chat-pane').isVisible(), false);
  await a.panel.locator('#external-chat-attach').click();
  await until(() => a.panel.locator('#external-chat-messages').textContent().then((t) => t.includes('blue lighthouse')), 'existing conversation');
  assert.equal(await a.panel.locator('.external-chat-message.assistant .markdown-body strong').textContent(), 'blue lighthouse');
  await b.panel.evaluate(() => {
    window.chatBroadcasts = [];
    chrome.runtime.onMessage.addListener((m) => window.chatBroadcasts.push(m));
    const port = chrome.runtime.connect({ name: 'tabagent-external' });
    port.onMessage.addListener((m) => window.chatBroadcasts.push(m));
  });
  await b.panel.locator('#external-chat-attach').click();
  await until(() => b.panel.locator('#external-operation-error').textContent().then((t) => t.includes('another shared tab')), 'owner conflict');
  const state = await a.state();
  const forged = { kind: 'external_chat', connectionId: state.connectionId, request: { type: 'chat_request', id: randomUUID(), sessionId: state.chat.sessionId, action: 'send', text: 'forged prompt' } };
  assert.equal((await b.send({ ...forged, tabId: a.tabId })).ok, false);
  assert.equal((await b.send(forged)).ok, false);
  await a.page.evaluate((req) => window.postMessage({ probeRequest: req }, '*'), forged);
  await until(() => a.page.locator('html').getAttribute('data-probe-result'), 'content script rejection');
  assert.equal(JSON.parse(await a.page.locator('html').getAttribute('data-probe-result')).error, 'Untrusted message sender');
  assert.equal(await a.page.locator('html').getAttribute('data-port-rejected'), 'true');
  assert.equal(await a.page.locator('html').getAttribute('data-chat-leak'), null);
  assert.equal(pi.requests.length, 0);
  console.log('PASS: explicit in-tab attachment restores Pi history; other tabs and content scripts cannot read or send chat');

  pi.plans.push({ text: 'Partial <img src=x onerror=alert(1)> **bold**\n\n**stre',
    tail: 'amed** completed\n\n## Summary\n\n- First **item**\n- Second item\n\n```html\n<strong>literal code</strong>\n```\n\n| Name | Value |\n| --- | ---: |\n| lighthouse | 42 |\n\n[Details](https://example.com/) [unsafe](javascript:alert(1)) ![image description](https://tracking.invalid/pi)', hold: true });
  await a.panel.locator('#external-chat-input').fill('Continue with the lighthouse **literally**');
  await a.panel.locator('#external-chat-input').press('Enter');
  await until(() => a.panel.locator('#external-chat-messages').textContent().then((t) => t.includes('Partial <img')), 'streamed text');
  assert.equal(await a.panel.locator('#external-chat-messages img').count(), 0);
  const reply = a.panel.locator('.external-chat-message.assistant .markdown-body').last();
  assert.equal(await reply.locator('strong').textContent(), 'bold');
  assert.match(await a.panel.locator('.external-chat-message.user > div').last().textContent(), /\*\*literally\*\*/);
  assert.equal(await a.panel.locator('.external-chat-message.user > div strong').count(), 0);
  assert.equal(await a.panel.locator('#external-chat-send').isDisabled(), true);
  await a.panel.locator('#external-chat-input').fill('Draft while working');
  await a.panel.reload();
  await until(() => a.panel.locator('#external-chat-messages').textContent().then((t) => t.includes('Partial <img')), 'restore during stream');
  assert.equal(await reply.locator('strong').textContent(), 'bold');
  assert.equal(pi.requests.length, 1, 'reload never replays a prompt');
  pi.release();
  await until(() => a.panel.locator('#external-chat-send').isEnabled(), 'Pi idle');
  assert.match(await a.panel.locator('#external-chat-messages').textContent(), /completed/);
  assert.deepEqual(await reply.locator('strong').allTextContents(), ['bold', 'streamed', 'item']);
  assert.equal(await reply.locator('h2').textContent(), 'Summary');
  assert.equal(await reply.locator('li').count(), 2);
  assert.equal(await reply.locator('pre code').textContent(), '<strong>literal code</strong>\n');
  assert.equal(await reply.locator('table td').last().textContent(), '42');
  assert.equal(await reply.locator('a[href]').count(), 1);
  assert.equal(await reply.locator('a[href]').getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await reply.locator('img, script, style, iframe').count(), 0);
  assert.equal(await reply.evaluate((node) => getComputedStyle(node).whiteSpace), 'normal');
  assert.equal(await a.panel.locator('#external-chat-input').inputValue(), '', 'chat drafts are memory-only');
  assert(!JSON.stringify(await b.panel.evaluate(() => window.chatBroadcasts)).includes('lighthouse'));
  assert(!JSON.stringify(await a.panel.evaluate(() => chrome.storage.local.get(null))).includes('Continue with the lighthouse'));
  assert(!JSON.stringify(await a.panel.evaluate(() => chrome.storage.session.get(null))).includes('Continue with the lighthouse'));
  for (const id of ['external-chat-input', 'external-chat-send', 'external-chat-abort', 'external-stop']) {
    const bounds = await a.panel.locator(`#${id}`).boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360 && bounds.y + bounds.height <= 800, id);
  }
  await a.panel.screenshot({ path: join(tmpdir(), 'tabagent-pi-chat-review.png') });
  console.log('PASS: Pi Markdown formats history, partial streams and completed replies at 360px; user text stays literal and reload never replays prompts');

  const thoughtStart = 'I will check the page before deciding what to do.\n';
  const thoughtTail = `Thinking about the next browser action. `.repeat(20) + '\nLATEST_THOUGHT';
  pi.plans.push({ thinking: thoughtStart, holdThinking: true, text: 'I have finished thinking.' });
  await a.panel.locator('#external-chat-input').fill('Think about this page');
  await a.panel.locator('#external-chat-send').click();
  const thinking = a.panel.locator('#external-chat-thinking');
  const thinkingBody = a.panel.locator('#external-chat-thinking-text');
  const thinkingPreview = a.panel.locator('#external-chat-thinking-preview');
  await until(() => a.panel.locator('#external-chat-thinking-label').textContent().then((text) => text === 'Thinking…'), 'live thinking line');
  assert.equal(await thinking.evaluate((node) => node.open), false);
  assert.equal(await thinkingBody.isVisible(), false, 'full thinking starts collapsed');
  pi.think(thoughtTail);
  await until(() => thinkingPreview.textContent().then((text) => text.endsWith('LATEST_THOUGHT')), 'single-line thinking updates');
  const previewMetrics = await thinkingPreview.evaluate((node) => ({
    remaining: node.scrollWidth - node.scrollLeft - node.clientWidth,
    height: node.getBoundingClientRect().height,
  }));
  assert(previewMetrics.remaining < 2 && previewMetrics.height <= 24, 'one line follows the newest text');
  assert(!(await a.panel.locator('#external-chat-messages').textContent()).includes('LATEST_THOUGHT'));
  await a.panel.screenshot({ path: join(tmpdir(), 'tabagent-pi-thinking-collapsed.png') });
  await thinking.locator('summary').click();
  assert.equal(await thinkingBody.isVisible(), true);
  await until(() => thinkingBody.evaluate((node) => node.getBoundingClientRect().bottom <= document.querySelector('#external-chat-scroll').getBoundingClientRect().bottom), 'expanded thinking is brought into view');
  assert.equal(await thinkingBody.textContent(), thoughtStart + thoughtTail);
  const privateToken = 'a'.repeat(64);
  const shortCode = await pi.code();
  pi.think(`\n<img src=x onerror=alert(1)> tabagent:12345:${privateToken.slice(0, -8)} ${shortCode} EXPANDED_THOUGHT`);
  await until(() => thinkingBody.textContent().then((text) => text.endsWith('EXPANDED_THOUGHT')), 'expanded thinking continues streaming');
  assert.equal(await thinking.evaluate((node) => node.open), true);
  assert.equal(await thinking.locator('img').count(), 0);
  assert(!(await thinkingBody.textContent()).includes(privateToken.slice(0, -8)));
  assert(!(await thinkingBody.textContent()).includes(shortCode));
  await thinkingBody.evaluate((node) => { node.scrollTop = 0; });
  pi.think('\nMore detail while the beginning is being read.');
  await until(() => thinkingBody.textContent().then((text) => text.includes('beginning is being read')), 'thinking advances without moving the reader');
  assert.equal(await thinkingBody.evaluate((node) => node.scrollTop), 0);
  await a.panel.screenshot({ path: join(tmpdir(), 'tabagent-pi-thinking-expanded.png') });
  const requestCount = pi.requests.length;
  await a.panel.reload();
  await until(() => thinkingPreview.textContent().then((text) => text.includes('beginning is being read')), 'thinking restores during a stream');
  assert.equal(await thinking.evaluate((node) => node.open), false, 'reload restores thinking collapsed');
  assert.equal(pi.requests.length, requestCount, 'restoring thinking never replays a prompt');
  assert(!JSON.stringify(await b.panel.evaluate(() => window.chatBroadcasts)).includes('LATEST_THOUGHT'));
  for (const area of ['local', 'session']) {
    assert(!JSON.stringify(await a.panel.evaluate((area) => chrome.storage[area].get(null), area)).includes('LATEST_THOUGHT'));
  }
  await thinking.locator('summary').click();
  pi.release();
  await until(() => a.panel.locator('#external-chat-send').isEnabled(), 'thinking completed');
  assert.equal(await a.panel.locator('#external-chat-thinking-label').textContent(), 'Thoughts');
  assert.equal(await thinking.evaluate((node) => node.open), false, 'completed thinking collapses');
  await thinking.locator('summary').click();
  await a.panel.locator('#external-view-activity').click();
  await a.panel.locator('#external-view-chat').click();
  assert.equal(await thinkingBody.isVisible(), true, 'completed thinking can be reopened and stays open across renders');
  assert((await thinkingBody.textContent()).includes('LATEST_THOUGHT'));
  console.log('PASS: thinking stays on one live line, expands safely, collapses on completion, can be reopened and stays private to its tab');

  // The actual model calls the registered Pi tool; approvals still belong to Chrome.
  pi.plans.push({ text: 'Reading the page', tool: { name: 'tabagent_snapshot', args: { tabId: a.tabId } } }, { text: 'I read the page.' });
  await a.panel.locator('#external-chat-input').fill('Read this tab');
  await a.panel.locator('#external-chat-send').click();
  await until(() => a.panel.locator('#external-chat-send').isEnabled(), 'browser turn completes');
  assert.equal(await thinking.evaluate((node) => node.open), false, 'new responses start collapsed');
  assert(await a.panel.locator('#external-chat-scroll').evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight < 2), 'showing the first action card keeps the latest reply in view');
  await a.panel.locator('#external-view-activity').click();
  await until(() => a.panel.locator('.external-action-row[data-tool="snapshot"][data-status="done"]').count(), 'browser activity');
  assert(JSON.stringify(pi.requests.at(-1)).includes('Blue lighthouse page'));
  pi.plans.push({ text: 'Looking at this tab', tool: { name: 'tabagent_screenshot', args: { tabId: a.tabId } } }, { text: 'I received the image.' });
  await a.panel.locator('#external-view-chat').click();
  await a.panel.locator('#external-chat-input').fill('Take a screenshot');
  await a.panel.locator('#external-chat-send').click();
  await until(() => a.panel.locator('#external-chat-send').isEnabled(), 'vision turn completes');
  assert.match(JSON.stringify(pi.requests.at(-1)), /data:image\/(jpeg|png);base64,/);
  const snap = await pi.call('tabagent_snapshot', { tabId: a.tabId });
  const ref = /button "Save" \[ref=([^\]]+)\]/.exec(snap.content[0].text)?.[1];
  assert(ref, 'snapshot contains button ref');
  pi.plans.push({ text: 'Clicking Save', tool: { name: 'tabagent_click', args: { tabId: a.tabId, ref } } }, { text: 'Saved.' });
  await a.panel.locator('#external-view-chat').click();
  await a.panel.locator('#external-chat-input').fill('Click Save');
  await a.panel.locator('#external-chat-send').click();
  await a.panel.locator('#external-allow').waitFor({ state: 'visible' });
  assert.equal(await a.page.locator('#save').textContent(), 'Save');
  await a.panel.locator('#external-allow').click();
  await until(() => a.page.locator('#save').textContent().then((t) => t === 'Saved'), 'approved click');
  await until(() => a.panel.locator('#external-chat-send').isEnabled(), 'click turn completed');
  console.log('PASS: Pi chats invoke real CDP browser tools, deliver images to Pi’s model and enforce mutation approval in the chat view');

  const scrollBefore = await a.page.evaluate(() => scrollY);
  const scrollRequests = pi.requests.length;
  pi.plans.push(
    { text: '', tool: { name: 'tabagent_scroll', args: { tabId: a.tabId, direction: 'down', amount: 400 } } },
    { text: '', tail: 'Scrolled down.', hold: true },
  );
  await a.panel.locator('#external-chat-input').fill('Scroll down');
  await a.panel.locator('#external-chat-send').click();
  const latestScroll = a.panel.locator('#external-chat-actions [data-tool="scroll"]');
  await until(() => latestScroll.getAttribute('data-status').then((status) => status === 'waiting'), 'inline scroll approval');
  assert.equal(await latestScroll.isVisible(), true);
  assert.match(await a.panel.locator('#external-chat-status').textContent(), /Waiting for your approval/);
  assert.equal(await a.page.evaluate(() => scrollY), scrollBefore);
  await a.panel.locator('#external-allow').click();
  await until(() => latestScroll.getAttribute('data-status').then((status) => status === 'done'), 'inline scroll result');
  await until(() => pi.requests.length === scrollRequests + 2, 'Pi receives scroll result');
  assert(await a.page.evaluate(() => scrollY) > scrollBefore, 'the actual tab scrolled');
  assert.match(await latestScroll.textContent(), /down · 400 pixels/);
  assert.equal(await a.panel.locator('#external-chat-send').isDisabled(), true);
  assert(await a.panel.locator('.external-chat-message > div').evaluateAll((nodes) => nodes.every((node) => node.textContent.trim())), 'no empty Pi rows during tool-only or thinking-only turns');
  await a.panel.reload();
  await until(() => latestScroll.isVisible(), 'inline action survives panel reload');
  assert(await a.panel.locator('.external-chat-message > div').evaluateAll((nodes) => nodes.every((node) => node.textContent.trim())));
  await a.panel.screenshot({ path: join(tmpdir(), 'tabagent-pi-chat-activity-review.png') });
  for (const id of ['external-chat-activity', 'external-chat-input', 'external-chat-send', 'external-chat-abort']) {
    const bounds = await a.panel.locator(`#${id}`).boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360 && bounds.y + bounds.height <= 800, id);
  }
  await a.panel.locator('#external-chat-show-activity').click();
  assert.equal(await a.panel.locator('#external-activity-scroll').isVisible(), true);
  await a.panel.locator('#external-view-chat').click();
  pi.release();
  await until(() => a.panel.locator('#external-chat-send').isEnabled(), 'reply after quiet browser turn');
  assert.match(await a.panel.locator('#external-chat-messages').textContent(), /Scrolled down\./);
  console.log('PASS: tool-only scrolling shows approval and completion in chat, with no empty Pi rows during thinking or reload');

  pi.plans.push({ text: 'Still working', hold: true });
  await a.panel.locator('#external-chat-input').fill('Work until stopped');
  await a.panel.locator('#external-chat-send').click();
  await until(() => a.panel.locator('#external-chat-messages').textContent().then((t) => t.includes('Still working')), 'abort target started');
  await a.panel.locator('#external-chat-abort').click();
  await until(() => a.panel.locator('#external-chat-send').isEnabled(), 'stop Pi');
  assert.equal((await a.state()).connected, true);
  await a.panel.locator('#external-chat-detach').click();
  await until(() => a.panel.locator('#external-chat-pane').isHidden(), 'detach clears view');
  assert.equal(await a.panel.locator('#external-chat-messages').textContent(), '');
  assert.equal(await a.panel.locator('#external-chat-actions').textContent(), '');
  assert.equal(await thinkingBody.textContent(), '');
  assert.equal(await thinkingPreview.textContent(), '');
  await a.panel.locator('#external-chat-attach').click();
  await until(() => a.panel.locator('#external-chat-send').isEnabled(), 'reattach');
  pi.plans.push({ text: 'Independent Pi work', hold: true });
  await a.panel.locator('#external-chat-input').fill('Continue working');
  await a.panel.locator('#external-chat-send').click();
  await until(() => a.panel.locator('#external-chat-messages').textContent().then((t) => t.includes('Independent Pi work')), 'sharing stop target');
  await a.panel.locator('#external-stop').click();
  await until(() => a.panel.locator('#external-phase').textContent().then((t) => t === 'Sharing ended'), 'sharing ended');
  assert.equal(pi.session.isIdle, false, 'stop sharing does not abort unrelated Pi work');
  assert.equal(await a.panel.locator('#external-chat-messages').textContent(), '');
  assert.equal(await a.panel.locator('#external-chat-actions').textContent(), '');
  assert.equal(await thinkingBody.textContent(), '');
  pi.release();
  await until(() => pi.session.isIdle, 'Pi finished');
  assert.deepEqual(errors, []);
  assert.deepEqual(pi.errors, []);
  console.log('PASS: Stop Pi, detach chat, and Stop sharing have separate effects; ending sharing clears the transcript');
} finally {
  clearTimeout(deadline);
  await context?.close();
  pageServer.closeAllConnections();
  await new Promise((resolve) => pageServer.close(resolve));
  await pi.close();
}
