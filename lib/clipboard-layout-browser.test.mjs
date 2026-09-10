import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { buildClipboardUI, clipboardTheme } from './clipboard-ui-fixture.mjs';
import { setup } from './clipboard-test-data.mjs';

test('clipboard layouts at four raster scales preserve composition and keyboard actions', { timeout: 180000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'clipboard-layout-'));
  const output = path.resolve('.verification/clipboard-layout');
  let browser;
  try {
    await mkdir(output, { recursive: true });
    const { bundle, css } = await buildClipboardUI(directory);
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const results = [];
    for (const scale of [1, 1.25, 1.5, 2]) {
      const context = await browser.newContext({ deviceScaleFactor: scale });
      await context.route('https://clipboard-layout.test/**', route => route.fulfill(route.request().url().endsWith('bundle.js')
        ? { contentType: 'text/javascript', body: bundle }
        : { contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><style>${clipboardTheme}${css}</style><div id="root"></div><script>${setup}</script><script src="/bundle.js"></script>` }));
      for (const [surface, width, height] of [['quick', 760, 540], ['shelf', 360, 420], ['manager', 500, 600]]) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height });
        await page.goto('https://clipboard-layout.test/?surface=' + surface);
        await page.getByRole('listbox').waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${surface} at ${scale}: no horizontal overflow`);
        const search = page.getByLabel('搜索剪贴板', { exact: true });
        if (surface !== 'shelf') {
          await search.focus();
          const before = await page.evaluate(() => window.commands.length);
          // This checks DOM composition routing, not a physical Windows IME.
          await search.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
          await search.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', isComposing: true, bubbles: true });
          assert.equal(await page.evaluate(() => window.commands.length), before);
          assert.equal(await page.evaluate(() => Boolean(window.hidden)), false);
          await search.fill('第一条');
          await page.keyboard.press('Escape');
          assert.equal(await search.inputValue(), '');
          await page.keyboard.press('Control+f');
          assert.equal(await search.evaluate(element => element === document.activeElement), true);
        }
        await page.screenshot({ path: path.join(output, `${surface}-${scale}.png`) });
        results.push({ surface, width, height, deviceScaleFactor: scale, horizontalOverflow: false });
        await page.close();
      }
      await context.close();
    }
    await writeFile(path.join(output, 'report.json'), JSON.stringify({ scope: 'Headless Edge raster scale and DOM composition regression; not physical monitor DPI or native IME acceptance', results }, null, 2));
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
