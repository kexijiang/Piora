#!/usr/bin/env node
// Real packaged main process, authenticated Next pages and preload IPC.
// Fixture seeding never touches the system clipboard; collection stays disabled.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { createIsolatedProcessEnvironment, prepareIsolatedEnvironment } from './isolated-process-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = resolve(process.argv[2] ?? join(root, 'desktop/release/win-unpacked/Piora.exe'));
const output = resolve(process.argv[3] ?? join(root, '.verification/clipboard-package'));
const temporary = await mkdtemp(join(tmpdir(), 'piora-packaged-clipboard-ui-'));
const paths = await prepareIsolatedEnvironment(temporary);
const require = createRequire(import.meta.url);
const { ClipboardStore } = require(join(root, 'desktop/dist/clipboard-store.js'));
const store = new ClipboardStore(join(paths.userData, 'clipboard'));
const text = '安装包剪贴板验收 中文😀';
const draft = '重启之后继续编辑\n保留完整正文😀';
let application;
const errors = [];
const report = { executable, systemClipboardWritten: false, captureEnabled: false, screenshots: [] };

async function launch() {
  application = await electron.launch({ executablePath: executable, args: [], timeout: 90000,
    env: createIsolatedProcessEnvironment(temporary, {
      PIORA_COMPANION_UI_TEST: '1', PIORA_COMPANION_UI_TEST_USER_DATA: paths.userData,
      PI_CODING_AGENT_DIR: join(temporary, 'agent'), NEXT_TELEMETRY_DISABLED: '1',
    }),
  });
  // The first BrowserWindow initially contains the startup document and is
  // reused for the main page. Bind acceptance to its authenticated navigation.
  const deadline = Date.now() + 90000;
  let page;
  while (Date.now() < deadline && !page) {
    page = application.windows().find(candidate => /^http:\/\/127\.0\.0\.1:\d+\/$/.test(candidate.url()));
    if (!page) await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  assert.ok(page, 'Authenticated main window did not load');
  await page.waitForFunction(() => !!window.piDesktop?.clipboard?.historyV2, null, { timeout: 90000 });
  await page.waitForFunction(async () => {
    try { return (await window.piDesktop.clipboard.historyV2.status()).storage === 'ready'; } catch { return false; }
  }, null, { timeout: 90000 });
  await page.evaluate(() => { localStorage.setItem('pi-locale', 'zh-CN'); });
  return page;
}

async function surface(host, name) {
  await host.evaluate(name => window.piDesktop.clipboard.historyV2.open(name), name);
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    for (const page of application.windows()) {
      if (await page.locator(`[data-surface="${name}"]`).count()) {
        await page.locator(`[data-surface="${name}"]`).waitFor();
        page.on('pageerror', error => errors.push(String(error)));
        return page;
      }
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 100));
  }
  throw new Error('Packaged clipboard surface did not hydrate: ' + name);
}

async function screenshot(page, name) {
  const file = join(output, name + '.png');
  await page.screenshot({ path: file }); report.screenshots.push(file);
}

try {
  await mkdir(output, { recursive: true }); await mkdir(join(temporary, 'agent'), { recursive: true });
  await store.start();
  const id = await store.capture({ text, html: '<b>' + text + '</b>', source: { name: '安装包验收', executable: 'fixture.exe' } });
  await store.mutate({ type: 'shelf-add', ids: [id] });
  await store.close();
  let host = await launch();
  const status = await host.evaluate(() => window.piDesktop.clipboard.historyV2.status());
  assert.equal(status.settings.enabled, false); assert.equal(status.total, 1);
  assert.equal(status.storage, 'ready');
  report.nativeListener = status.listener;
  let quick = await surface(host, 'quick');
  for (let index = 0; index < 5; index++) {
    await application.evaluate(({ BrowserWindow }, url) => {
      const main = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url);
      if (!main) throw Error('Packaged main window not found');
      main.show(); main.focus();
    }, host.url());
    await host.evaluate(() => window.piDesktop.clipboard.historyV2.open('quick'));
    await quick.waitForFunction(() => document.hasFocus() && document.activeElement?.getAttribute('aria-label') === '搜索剪贴板');
    await quick.waitForTimeout(25);
    const focused = await application.evaluate(({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === url);
      return !!window?.isVisible() && window.isFocused();
    }, quick.url());
    assert.equal(focused, true, 'Late blur must not hide the newly opened packaged quick window');
  }
  report.rapidHostQuickFocus = true;
  await quick.getByLabel('搜索剪贴板', { exact: true }).fill('中文');
  await quick.locator('#clipboard-' + id).waitFor();
  assert.equal(await quick.locator('[role="option"]').count(), 1);
  await screenshot(quick, 'packaged-quick');
  const shelf = await surface(host, 'shelf');
  await shelf.locator('#clipboard-' + id).waitFor();
  await screenshot(shelf, 'packaged-shelf');
  await shelf.evaluate(() => window.piDesktop.clipboard.historyV2.hide());
  const manager = await surface(host, 'manager');
  await manager.locator('#clipboard-' + id).click();
  await manager.getByLabel('剪贴板备注', { exact: true }).waitFor();
  await screenshot(manager, 'packaged-manager');
  await manager.getByRole('button', { name: '编辑为新记录', exact: true }).click();
  await manager.getByLabel('编辑剪贴板副本', { exact: true }).fill(draft);
  await manager.getByLabel('剪贴板备注', { exact: true }).fill('重启恢复备注');
  await manager.getByText('编辑草稿已保留在本机', { exact: true }).waitFor();
  // Playwright's Electron close calls app.quit(), exercising the application's
  // normal renderer-flush and database-shutdown barrier before process restart.
  await application.close(); application = null;
  host = await launch();
  quick = await surface(host, 'quick');
  await quick.getByRole('button', { name: '未完成的编辑（1）', exact: true }).click();
  const recovery = quick.getByRole('dialog', { name: '未完成的编辑', exact: true });
  await recovery.getByRole('button', { name: new RegExp(text) }).click();
  assert.equal(await recovery.getByLabel('草稿正文').inputValue(), draft);
  assert.equal(await recovery.getByLabel('草稿备注').inputValue(), '重启恢复备注');
  await screenshot(quick, 'packaged-restart-recovery');
  await recovery.getByRole('button', { name: '继续编辑草稿' }).click();
  assert.equal(await quick.getByLabel('编辑剪贴板副本').inputValue(), draft);
  await quick.getByRole('button', { name: '保存新记录', exact: true }).click();
  await quick.waitForFunction(async value => (await window.piDesktop.clipboard.historyV2.query({ text: value })).items.length === 1, '重启之后继续编辑');
  const original = await quick.evaluate(id => window.piDesktop.clipboard.historyV2.getDetail(id), id);
  assert.equal(original.text, text);
  await application.close(); application = null;
  assert.deepEqual(errors, []);
  Object.assign(report, { quickHydrated: true, shelfHydrated: true, managerHydrated: true,
    nativeIPC: true, productionSearch: true, ordinaryQuitAndRestart: true,
    draftRestoredAcrossSurfaces: true, editedCopySaved: true, originalPreserved: true });
  await writeFile(join(output, 'packaged-ui-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(join(output, 'packaged-ui-failure.json'), JSON.stringify({ ...report, error: String(error), windows: application?.windows().map(page => page.url()) ?? [] }, null, 2));
  console.error(error);
  throw error;
} finally {
  await application?.close().catch(() => {});
  await store.close().catch(() => {});
  assert.equal(dirname(temporary), resolve(tmpdir()));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
