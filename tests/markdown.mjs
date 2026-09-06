import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Exercise the real browser DOM without extension CSP masking sanitizer failures.
const bundle = await build({ entryPoints: ['src/panel/markdown.ts'], bundle: true,
  platform: 'browser', format: 'iife', globalName: 'markdown', write: false });
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
  const requests = [];
  const errors = [];
  const dialogs = [];
  await page.route('**/*', (route) => { requests.push(route.request().url()); return route.abort(); });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  await page.setContent('<main id="output" class="markdown-body"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const render = (text) => page.evaluate((text) => {
    document.querySelector('#output').innerHTML = markdown.renderMarkdown(text);
  }, text);
  const output = page.locator('#output');

  await render('# Heading\n\n**Bold with *emphasis***, __also bold__, ~~deleted~~ and file_name_here.\nNext line.\n\n- Parent\n  - Nested\n\n3. Third\n4. Fourth\n\n> Quoted **text**\n\n---\n\n- [x] Done\n- [ ] Pending');
  assert.equal(await output.locator('h1').textContent(), 'Heading');
  assert.equal(await output.locator('strong em').textContent(), 'emphasis');
  assert.equal(await output.locator('del').textContent(), 'deleted');
  assert((await output.textContent()).includes('file_name_here'));
  assert.equal(await output.locator('br').count(), 1);
  assert.equal(await output.locator('ul ul li').textContent(), 'Nested');
  assert.equal(await output.locator('ol').getAttribute('start'), '3');
  assert.equal(await output.locator('blockquote strong').textContent(), 'text');
  assert.equal(await output.locator('hr').count(), 1);
  assert.equal(await output.locator('input').count(), 0);
  assert((await output.textContent()).includes('[x] Done'));

  const code = '<img src="https://tracking.invalid/code" onerror="alert(1)">\n**literal** [link](javascript:alert(1))';
  await render('Use `**literal**` and ``a `backtick` here``.\n\n```html\n' + code + '\n```');
  assert.equal(await output.locator('p code').first().textContent(), '**literal**');
  assert.equal(await output.locator('p code').nth(1).textContent(), 'a `backtick` here');
  assert.equal(await output.locator('pre code').textContent(), code + '\n');
  assert.equal(await output.locator('img, strong, a').count(), 0);
  // Fences and inline tokens can be incomplete while a reply streams.
  await render('```js\nconst value = "<script>";');
  assert.equal(await output.locator('pre code').textContent(), 'const value = "<script>";\n');
  await render('```js extra fence info\n**literal**\n```\n\n**partial');
  assert.equal(await output.locator('pre code').textContent(), '**literal**\n');
  assert((await output.textContent()).includes('**partial'));
  console.log('PASS: Markdown emphasis, nested lists, quotes, code, task lists and incomplete streaming fences');

  await render('[web](https://example.com/a_(b)?one=1&two=two_three "Title") [http](http://example.com/) [email](mailto:user@example.com) [reference][r]\n\n[r]: https://example.com/reference\n\nhttps://example.com/auto');
  assert.deepEqual(await output.locator('a').evaluateAll((nodes) => nodes.map((node) => ({ href: node.getAttribute('href'), target: node.target, rel: node.rel }))), [
    'https://example.com/a_(b)?one=1&two=two_three', 'http://example.com/', 'mailto:user@example.com',
    'https://example.com/reference', 'https://example.com/auto',
  ].map((href) => ({ href, target: '_blank', rel: 'noopener noreferrer' })));
  assert.equal(await output.locator('a').first().getAttribute('title'), 'Title');

  const unsafe = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'jav&#x61;script:alert(1)',
    '&#106;avascript:alert(1)', 'java&#x09;script:alert(1)', 'java&#10;script:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox(1)', 'file:///tmp/private',
    'chrome://settings', 'chrome-extension://test/panel.html', 'ftp://example.com/',
    '//example.com/tracker', '/panel.html', '#settings',
  ];
  for (const url of unsafe) {
    await render(`[unsafe](${url})`);
    assert.equal(await output.locator('a[href]').count(), 0, `reject ${url}`);
    assert((await output.textContent()).includes('unsafe'), 'keep the link label');
  }

  const attacks = [
    '<script>alert("script")</script>',
    '<img src="https://tracking.invalid/pixel" onerror="alert(1)">',
    '<svg><a xlink:href="javascript:alert(1)">SVG</a></svg>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
    '<style>body{background:url(https://tracking.invalid/style)}</style>',
    '<form id="messages"><input name="innerHTML"><button formaction="https://tracking.invalid/">Send</button></form>',
    '<a href="https://example.com" ping="https://tracking.invalid/ping" onclick="alert(1)">link</a>',
    '[![pixel](https://tracking.invalid/image)](javascript:alert(1))',
    '![<img src=x onerror=alert(1)>](data:image/svg+xml,test)',
    '[label](https://example.com/ "\" onmouseover=\"alert(1)")',
    '&lt;img src=x onerror=alert(1)&gt;',
    '\u0000CODE0\u0000 [label](https://example.com/`\"`) `**code**`',
  ];
  // Test every possible chunk boundary, not just the final completed messages.
  const violation = await page.evaluate((attacks) => {
    const root = document.querySelector('#output');
    for (const attack of attacks) {
      for (let end = 1; end <= attack.length; end++) {
        const text = attack.slice(0, end);
        root.innerHTML = markdown.renderMarkdown(text);
        for (const node of root.querySelectorAll('*')) {
          if (/^(SCRIPT|STYLE|IMG|SVG|MATH|IFRAME|OBJECT|EMBED|FORM|INPUT|BUTTON|LINK|META|VIDEO|AUDIO|SOURCE|TEMPLATE)$/.test(node.tagName)) return { text, html: root.innerHTML };
          for (const attr of node.attributes) {
            if (/^(on|src|style$|id$|name$|data-|ping$|formaction$)/i.test(attr.name)) return { text, html: root.innerHTML };
          }
          if (node.hasAttribute('href') && !['http:', 'https:', 'mailto:'].includes(new URL(node.href).protocol)) return { text, html: root.innerHTML };
        }
      }
    }
    return null;
  }, attacks);
  assert.equal(violation, null, JSON.stringify(violation));
  await render(attacks[1]);
  assert.equal(await output.textContent(), attacks[1]);
  await render('![image description](https://tracking.invalid/pixel)');
  assert.equal((await output.textContent()).trim(), 'image description');
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(requests, [], 'rendering never requests model-supplied resources');
  assert.deepEqual(dialogs, []);
  assert.deepEqual(errors, []);
  console.log('PASS: safe link targets; malicious HTML, URL schemes and images stay inert at every streaming boundary without CSP');

  // Shared formatting must keep wide code and tables within a 360px panel.
  await page.addStyleTag({ content: await readFile('src/panel/panel.css', 'utf8') });
  await page.addStyleTag({ content: '#output { width: 320px; margin: 16px; }' });
  await render('| Left | Center | Right |\n| :--- | :---: | ---: |\n| **value** | a\\|b | `' + 'wide_'.repeat(30) + '` |\n\n```text\n' + 'long code '.repeat(40) + '\n```');
  assert.equal(await output.locator('th').count(), 3);
  assert.equal(await output.locator('td').nth(1).textContent(), 'a|b');
  assert.equal(await output.locator('td').nth(2).evaluate((node) => getComputedStyle(node).textAlign), 'right');
  assert.equal(await output.locator('th').nth(1).evaluate((node) => getComputedStyle(node).textAlign), 'center');
  for (const selector of ['pre', '.md-table-wrap']) {
    const bounds = await output.locator(selector).evaluate((node) => ({
      right: node.getBoundingClientRect().right, width: node.clientWidth, scrollWidth: node.scrollWidth,
      overflow: getComputedStyle(node).overflowX,
    }));
    assert(bounds.right <= 360 && bounds.scrollWidth > bounds.width && bounds.overflow === 'auto', selector);
  }
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= 360));
  console.log('PASS: GFM tables retain alignment and wide content scrolls inside the panel');
} finally {
  await browser.close();
}
