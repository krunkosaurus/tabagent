import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';

// Playwright's normal launch keeps every page focused and disables background
// throttling. Those defaults hide the bugs this suite needs to exercise.
export async function launchBackgroundChrome(profile, extension) {
  const child = spawn(chromium.executablePath(), [
    ...(process.argv.includes('--headed') ? [] : ['--headless=new']),
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    'about:blank',
  ], {stdio: ['ignore', 'ignore', 'pipe']});
  const exited = once(child, 'exit').catch(() => {});
  let browser;
  async function close() {
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Chrome startup timed out')), 10_000);
      const finish = (error, url) => {
        clearTimeout(timer);
        if (error) reject(error); else resolve(url);
      };
      child.once('error', error => finish(error));
      child.once('exit', code => finish(new Error(`Chrome exited (${code}): ${output.slice(-1000)}`)));
      child.stderr.on('data', chunk => {
        output = (output + chunk).slice(-4000);
        const url = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
        if (url) finish(null, url);
      });
    });
    browser = await chromium.connectOverCDP(endpoint, {noDefaults: true});
    return {context: browser.contexts()[0], close};
  } catch (error) {
    await close();
    throw error;
  }
}
