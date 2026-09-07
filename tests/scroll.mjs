import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, cp, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { launchBackgroundChrome } from './background-chrome.mjs';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Exercise the public MCP tools through a real extension in an isolated Chrome
// profile. The fixture deliberately cancels wheel input while remaining alive.
const scratch = await mkdtemp(join(tmpdir(), 'tabagent-scroll-'));
let context;
let browser;
let client;
const fixture = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>Scroll fixture</title>
    <style>
      html { scroll-behavior: smooth; }
      body { margin: 0; width: 4000px; height: 8000px; }
      #nested { position: fixed; left: 12px; top: 12px; width: 240px;
        height: 140px; overflow: auto; scroll-behavior: smooth; }
      #contents { width: 1800px; height: 2400px; }
      #feed { position: absolute; top: 500px; }
    </style>
    <div id="nested"><div id="contents"><button id="target">Nested target</button></div></div>
    <main id="feed"></main>
    <script>
      window.wheels = [];
      window.scrolls = 0;
      window.blockWheel = true;
      addEventListener('wheel', e => {
        wheels.push({x: e.clientX, y: e.clientY, trusted: e.isTrusted});
        if (blockWheel) e.preventDefault();
      }, {passive: false});
      addEventListener('scroll', () => {
        scrolls++;
        requestAnimationFrame(() => {
          const start = Math.floor(scrollY / 100);
          document.querySelector('#feed').innerHTML = Array.from({length: 10}, (_, i) =>
            '<article>Post ' + (start + i) + '</article>').join('');
        });
      });
      // Page-world overrides must not intercept our isolated-world DOM scroll.
      Element.prototype.scrollBy = () => { throw new Error('page override ran'); };
    </script>`);
});

async function until(fn, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  await new Promise(r => fixture.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${fixture.address().port}/scroll`;
  const extension = join(scratch, 'extension');
  await cp('dist', extension, {recursive: true});
  const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(extension, 'manifest.json'), JSON.stringify(manifest));
  // Exercise the standalone attachment manager in the same real Chrome process,
  // without involving a model or exposing a test entry point in the product.
  const native = await build({stdin: {contents: `
    export { cdpManager } from './src/background/cdp-manager';
    export { cdp } from './src/tools/cdp';
  `, resolveDir: process.cwd()}, bundle: true, platform: 'browser', format: 'iife',
  globalName: 'nativeCdpTest', write: false});
  await appendFile(join(extension, 'background.js'), '\n' + native.outputFiles[0].text);
  browser = await launchBackgroundChrome(join(scratch, 'profile'), extension);
  context = browser.context;
  const worker = await until(async () => {
    for (const candidate of context.serviceWorkers()) {
      if (await candidate.evaluate(() => chrome.runtime.getManifest().name).catch(() => '') === 'TabAgent') return candidate;
    }
  }, 'TabAgent service worker');
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.setViewportSize({width: 360, height: 320});
  await page.goto(url);
  const tabId = await worker.evaluate(async url => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(t => t.url === url);
    if (!tab) throw new Error('Fixture tab missing');
    return tab.id;
  }, url);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel.html?tabId=${tabId}`);
  await panel.bringToFront();
  assert.equal(await page.evaluate(() => document.visibilityState), 'hidden', 'test must start with real background-tab rendering behavior');
  assert.equal(await worker.evaluate(async tabId => (await chrome.tabs.get(tabId)).active, tabId), false);
  const send = request => panel.evaluate(req => chrome.runtime.sendMessage(req), request);
  client = new Client({name: 'Hermes scroll regression', version: '1.0.0'});
  await client.connect(new StdioClientTransport({command: process.execPath, args: [resolve('mcp/server.mjs')], stderr: 'pipe'}));
  const call = (name, args = {}) => client.callTool({name: `tabagent_${name}`, arguments: args});
  const scroll = args => call('scroll', {tabId, ...args});
  const code = JSON.parse((await call('connect')).content[0].text).pairingCode;
  assert.equal((await send({kind: 'external_connect', code})).ok, true);
  await until(async () => (await send({kind: 'get_state'})).data.external?.phase === 'ready', 'pairing');
  const connectionId = (await send({kind: 'get_state'})).data.external.connectionId;
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible', 'pairing must keep background rendering active');
  assert.equal(await worker.evaluate(async tabId => (await chrome.tabs.get(tabId)).active, tabId), false, 'pairing must not activate the shared tab');

  const pending = scroll({direction: 'down', amount: 400});
  await until(async () => (await send({kind: 'get_state'})).data.external?.pending, 'scroll approval');
  assert.equal(await page.evaluate(() => scrollY), 0);
  await panel.locator('#external-allow-connection').click();
  const first = await pending;
  assert(!first.isError, JSON.stringify(first));
  if (process.argv.includes('--minimized')) {
    const session = await context.newCDPSession(panel);
    const {windowId} = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', {windowId, bounds: {windowState: 'minimized'}});
    await until(async () => (await session.send('Browser.getWindowBounds', {windowId})).bounds.windowState === 'minimized', 'test window minimized');
    await session.detach();
  }
  assert.equal(await page.evaluate(() => scrollY), 400, 'default scroll must move the document despite blocked wheel input');
  assert.match(first.content[0].text, /400/);
  assert.equal(await page.evaluate(() => wheels.length), 0, 'DOM scrolling must not enter the wheel input queue');
  assert.match(first.content[0].text, /target "document"; page visibility=visible/);
  assert.match(first.content[0].text, /maximum \(3640, 7680\)/);
  await until(() => page.evaluate(() => scrolls > 0), 'native scroll event');
  const capture = await call('screenshot', {tabId});
  assert(!capture.isError, JSON.stringify(capture));
  assert.equal(capture.content[0].type, 'image');
  assert(capture.content[0].data.length > 1000, 'background capture must return image data');
  for (let i = 0; i < 12; i++) assert(!(await scroll({direction: 'down', amount: 100})).isError);
  assert.equal(await page.evaluate(() => scrollY), 1600);
  await until(() => page.locator('#feed').textContent().then(text => text.includes('Post 16')), 'virtualized feed refresh');
  assert((await call('extractText', {tabId})).content[0].text.includes('Post 16'));
  console.log('PASS: default scrolling moves the document without wheel input, enforces approval and refreshes a virtualized feed');

  const snapshot = await call('snapshot', {tabId});
  assert.match(snapshot.content[0].text, /Page state: visibility=visible; ready=complete/);
  assert.match(snapshot.content[0].text, /Document scroll: \(0, 1600\); maximum \(3640, 7680\)/);
  const ref = snapshot.content[0].text.match(/button "Nested target" \[ref=([^\]]+)\]/)?.[1];
  assert(ref, snapshot.content[0].text);
  const nestedScroll = await scroll({ref, direction: 'down', amount: 200});
  assert(!nestedScroll.isError);
  assert.match(nestedScroll.content[0].text, /target "div#nested"/);
  assert.equal(await page.locator('#nested').evaluate(el => el.scrollTop), 200);
  assert.equal(await page.evaluate(() => scrollY), 1600);
  assert(!(await scroll({ref, direction: 'right', amount: 120})).isError);
  assert.equal(await page.locator('#nested').evaluate(el => el.scrollLeft), 120);
  assert(!(await scroll({direction: 'up', amount: 100})).isError);
  assert.equal(await page.evaluate(() => scrollY), 1500);
  assert(!(await scroll({direction: 'right', amount: 100})).isError);
  assert.equal(await page.evaluate(() => scrollX), 100);
  assert(!(await scroll({direction: 'left', amount: 100})).isError);
  const bottom = await scroll({direction: 'down', amount: 100_000});
  assert(!bottom.isError);
  assert.match(bottom.content[0].text, /actual/);
  const stopped = await scroll({direction: 'down', amount: 400});
  assert(!stopped.isError);
  assert.match(stopped.content[0].text, /no movement/i);
  assert((await scroll({ref: 'stale-ref', amount: 100})).isError);
  console.log('PASS: nested targets, all four directions, large bounded scrolls and no-movement results use measured positions');

  const wheel = await scroll({method: 'wheel', direction: 'up', amount: 100});
  assert(!wheel.isError, JSON.stringify(wheel));
  assert.match(wheel.content[0].text, /not confirmed/);
  const points = await page.evaluate(() => wheels);
  assert(points.length > 0);
  assert(points.every(p => p.x >= 0 && p.x < 360 && p.y >= 0 && p.y < 320 && p.trusted));
  assert((await scroll({method: 'wheel', ref, direction: 'down', amount: 100})).isError, 'clipped target must not receive wheel input');
  assert(!(await scroll({ref, direction: 'up', amount: 200})).isError);
  assert(!(await scroll({ref, direction: 'left', amount: 120})).isError);
  assert(!(await scroll({method: 'wheel', ref, direction: 'down', amount: 100})).isError);
  const box = await page.locator('#target').boundingBox();
  const aimed = await page.evaluate(() => wheels.at(-1));
  assert(aimed.x >= box.x && aimed.x <= box.x + box.width && aimed.y >= box.y && aimed.y <= box.y + box.height);
  const wheelCount = await page.evaluate(() => wheels.length);
  await page.evaluate(() => {
    const cover = document.createElement('div');
    cover.id = 'cover';
    cover.style.cssText = 'position:fixed;inset:0;z-index:10000;background:white';
    document.body.append(cover);
  });
  assert((await scroll({method: 'wheel', ref, direction: 'down', amount: 100})).isError, 'covered target must not send input to the overlay');
  assert.equal(await page.evaluate(() => wheels.length), wheelCount);
  await page.locator('#cover').evaluate(el => el.remove());
  await page.evaluate(() => { blockWheel = false; });
  const beforeWheel = await page.evaluate(() => scrollY);
  assert(!(await scroll({method: 'wheel', direction: 'up', amount: 100})).isError);
  await until(() => page.evaluate(before => scrollY < before, beforeWheel), 'real wheel scrolling in a background tab');

  // Simulate the reported missing wheel acknowledgement, without freezing the
  // renderer or spending 20 seconds per regression run. Only the test worker's
  // command deadline is shortened; production timeouts stay unchanged.
  await worker.evaluate(() => {
    const command = chrome.debugger.sendCommand.bind(chrome.debugger);
    const timer = globalThis.setTimeout;
    globalThis.wheelAttempts = 0;
    chrome.debugger.sendCommand = (target, method, params, callback) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseWheel') {
        globalThis.wheelAttempts++;
        return;
      }
      return command(target, method, params, callback);
    };
    globalThis.setTimeout = (fn, ms, ...args) => timer(fn, ms === 20_000 ? 50 : ms, ...args);
    globalThis.restoreWheelTest = () => {
      chrome.debugger.sendCommand = command;
      globalThis.setTimeout = timer;
    };
  });
  const timedOut = await scroll({method: 'wheel', direction: 'up', amount: 100});
  assert(timedOut.isError);
  assert.match(timedOut.content[0].text, /unknown/);
  assert.doesNotMatch(timedOut.content[0].text, /renderer.*frozen/i);
  assert.equal(await worker.evaluate(() => wheelAttempts), 1, 'never replay uncertain input');
  assert(!(await call('snapshot', {tabId})).isError);
  const before = await page.evaluate(() => scrollY);
  assert(!(await scroll({method: 'dom', direction: 'up', amount: 200})).isError);
  assert.equal(await page.evaluate(() => scrollY), before - 200);
  assert.equal((await send({kind: 'get_state'})).data.external.connectionId, connectionId);
  assert.equal(await worker.evaluate(() => wheelAttempts), 1);
  await worker.evaluate(() => restoreWheelTest());
  console.log('PASS: wheel coordinates stay inside a narrow viewport; DOM scrolling works on the same pairing after an unacknowledged wheel command');

  // App shells often scroll a full-window inner panel while the document stays
  // fixed. Existing calls without a ref must remain useful for those clients.
  await page.evaluate(() => {
    document.querySelector('#feed').style.display = 'none';
    document.body.style.cssText = 'width:100vw;height:100vh';
    const nested = document.querySelector('#nested');
    nested.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh';
    nested.scrollTop = 0;
    nested.scrollLeft = 0;
  });
  assert.equal(await page.evaluate(() => document.scrollingElement.scrollHeight), 320);
  assert(!(await scroll({direction: 'down', amount: 125})).isError);
  assert.equal(await page.locator('#nested').evaluate(el => el.scrollTop), 125);
  assert.equal(await page.evaluate(() => scrollY), 0);
  console.log('PASS: calls without a ref still scroll inner panels in fixed-document app layouts');

  await send({kind: 'external_stop'});
  await until(async () => !(await send({kind: 'get_state'})).data.external, 'access revoked');
  await until(() => page.evaluate(() => document.visibilityState === 'hidden'), 'Stop sharing releases the rendering keepalive');
  assert((await scroll({method: 'dom', direction: 'up', amount: 200})).isError);
  assert.equal(await page.locator('#nested').evaluate(el => el.scrollTop), 125);

  const newCode = JSON.parse((await call('connect')).content[0].text).pairingCode;
  assert.equal((await send({kind: 'external_connect', code: newCode, approvalMode: 'connection'})).ok, true);
  await until(async () => (await send({kind: 'get_state'})).data.external?.phase === 'ready', 'fresh pairing');
  assert(!(await call('navigate', {tabId, url: `${url}?navigated`})).isError);
  await until(() => page.evaluate(() => document.readyState === 'complete' && scrollY === 0).catch(() => false), 'navigated document');
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
  assert(!(await scroll({direction: 'down', amount: 500})).isError);
  await until(() => page.locator('#feed').textContent().then(text => text.includes('Post 5')), 'rendering survives navigation');
  assert(!(await call('screenshot', {tabId})).isError);
  await worker.evaluate(tabId => chrome.debugger.detach({tabId}), tabId);
  // Programmatic detach does not emit Chrome's user-initiated onDetach event;
  // the next strict command detects it and must fail without reattaching.
  assert((await call('snapshot', {tabId})).isError);
  await until(async () => !(await send({kind: 'get_state'})).data.external, 'Chrome debugger stop revokes access');
  await until(() => page.evaluate(() => document.visibilityState === 'hidden'), 'Chrome debugger stop releases the rendering keepalive');
  assert((await call('snapshot', {tabId})).isError);
  console.log('PASS: background rendering, real wheel input and screenshots work without activating the tab; navigation preserves rendering, and both Stop paths release it');

  await worker.evaluate(async tabId => {
    const {cdpManager} = nativeCdpTest;
    await cdpManager.attachForRun(tabId);
  }, tabId);
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible', 'standalone attachment must also keep rendering active');
  await page.evaluate(() => { blockWheel = false; });
  const nativeStart = await page.evaluate(() => scrollY);
  await worker.evaluate(async tabId => {
    const {cdp} = nativeCdpTest;
    await cdp(tabId, 'Input.dispatchMouseEvent', {type: 'mouseWheel', x: 300, y: 200, deltaX: 0, deltaY: 100});
    const image = await cdp(tabId, 'Page.captureScreenshot', {format: 'jpeg', captureBeyondViewport: true});
    if (!image.data?.length) throw new Error('Native background screenshot has no data');
  }, tabId);
  await until(() => page.evaluate(before => scrollY > before, nativeStart), 'standalone background wheel movement');
  await worker.evaluate(async tabId => {
    const {cdpManager} = nativeCdpTest;
    await cdpManager.detachIfIdle(tabId);
  }, tabId);
  await until(() => page.evaluate(() => document.visibilityState === 'hidden'), 'standalone detach releases the rendering keepalive');
  assert.equal(await worker.evaluate(async tabId => (await chrome.tabs.get(tabId)).active, tabId), false);
  console.log('PASS: standalone attachment enables background input/capture and releases rendering when the run detaches');
} finally {
  await client?.close();
  await browser?.close();
  fixture.closeAllConnections();
  await new Promise(r => fixture.close(r));
  await rm(scratch, {recursive: true, force: true});
}
