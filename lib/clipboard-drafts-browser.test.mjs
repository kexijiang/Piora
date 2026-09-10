import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { buildClipboardUI, clipboardTheme } from './clipboard-ui-fixture.mjs';
import { setup } from './clipboard-test-data.mjs';

test('edit recovery survives process restart, preserves independent windows, retries storage failures and exports orphan drafts', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'piora-clipboard-draft-test-'));
  let context;
  const errors = [];
  const fixtureNow = Date.now();
  try {
    const { bundle, css } = await buildClipboardUI(directory, { draftTesting: true });
    const launch = async () => {
      context = await chromium.launchPersistentContext(path.join(directory, 'profile'), { channel: 'msedge', headless: true, viewport: { width: 1100, height: 800 }, acceptDownloads: true });
      await context.addInitScript(now => { if (window.top === window && location.origin === 'https://clipboard-drafts.test') sessionStorage.setItem('fixture-now', String(now)); }, fixtureNow);
      await context.route('https://clipboard-drafts.test/**', route => route.fulfill(route.request().url().endsWith('bundle.js') ? { contentType: 'text/javascript', body: bundle } : { contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><style>${clipboardTheme}${css}</style><div id="root"></div><script>${setup}</script><script src="/bundle.js"></script>` }));
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
      const page = await context.newPage();
      await page.goto('https://clipboard-drafts.test/');
      await page.getByRole('option').first().waitFor();
      return page;
    };
    let page = await launch();
    const burst = await page.evaluate(async () => {
      const store = window.testDraftStore, id = crypto.randomUUID(), writes = [], base = '大段编辑😀'.repeat(50000);
      let transactions = 0;
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) { if (this.name === 'piora-clipboard-drafts' && args[1] === 'readwrite') transactions++; return original.apply(this, args); };
      try {
        for (let index = 0; index < 100; index++) writes.push(store.writeClipboardDraft({ id, revision: String(index), entryId: 'row-0', title: 'burst', updatedAt: Date.now(), text: base + index, remark: '', baseText: '', baseRemark: '' }));
        await Promise.all(writes);
        const latest = await store.readClipboardDraft(id), count = transactions;
        await store.removeClipboardDraft(id, latest.revision);
        return { revision: latest.revision, last: latest.text.slice(-2), transactions: count };
      } finally { IDBDatabase.prototype.transaction = original; }
    });
    assert.equal(burst.revision, '99'); assert.equal(burst.last, '99'); assert.ok(burst.transactions <= 2, 'a typing burst queues only the newest full body');
    await page.getByRole('button', { name: '编辑为新记录', exact: true }).click();
    await page.getByLabel('编辑剪贴板副本').fill('应用重新打开后，仍保留这段修改😀\n第二行');
    await page.getByLabel('剪贴板备注', { exact: true }).fill('尚未保存的备注');
    await page.getByText('编辑草稿已保留在本机', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.testDraftStore.listClipboardDrafts())).total, 1);
    await context.close(); context = null;
    page = await launch();
    await page.evaluate(() => { window.entries[0].remark = '另一个窗口已保存的新备注'; window.emit('mutation'); });
    await page.getByRole('button', { name: '未完成的编辑（1）', exact: true }).click();
    const panel = page.getByRole('dialog', { name: '未完成的编辑', exact: true });
    await panel.getByRole('button', { name: /产品说明/ }).click();
    assert.equal(await panel.getByLabel('草稿正文').inputValue(), '应用重新打开后，仍保留这段修改😀\n第二行');
    assert.equal(await panel.getByLabel('草稿备注').inputValue(), '尚未保存的备注');
    await panel.getByRole('button', { name: '继续编辑草稿' }).click();
    assert.equal(await page.getByLabel('编辑剪贴板副本').inputValue(), '应用重新打开后，仍保留这段修改😀\n第二行');
    await page.getByText('原记录的备注已更新，保存这份草稿会覆盖当前备注。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '保存新记录', exact: true }).click();
    await page.getByRole('article').locator('pre').filter({ hasText: '应用重新打开后' }).waitFor();
    assert.equal(await page.evaluate(() => window.entries.find(item => item.id === 'row-0').text), '复制后可以直接粘贴');
    assert.equal((await page.evaluate(() => window.testDraftStore.listClipboardDrafts())).total, 0);
    // A queued write followed immediately by a revert must never resurrect the old draft.
    await page.getByLabel('剪贴板备注', { exact: true }).fill('快速修改');
    await page.getByLabel('剪贴板备注', { exact: true }).fill('');
    await page.waitForFunction(async () => (await window.testDraftStore.listClipboardDrafts()).total === 0);
    await page.getByLabel('搜索剪贴板', { exact: true }).fill('产品说明');
    await page.locator('#clipboard-row-0').click();
    await page.evaluate(() => {
      window.originalDraftTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        if (this.name === 'piora-clipboard-drafts' && args[1] === 'readwrite') throw new DOMException('injected disk quota', 'QuotaExceededError');
        return window.originalDraftTransaction.apply(this, args);
      };
    });
    await page.getByLabel('剪贴板备注', { exact: true }).fill('写入失败时保留的输入');
    await page.getByText('草稿尚未写入本机，请重试后再关闭窗口。', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('剪贴板备注', { exact: true }).inputValue(), '写入失败时保留的输入');
    assert.equal(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true }))), false, 'unsaved recovery writes prevent ordinary unload');
    await page.evaluate(() => { IDBDatabase.prototype.transaction = window.originalDraftTransaction; });
    await page.getByRole('button', { name: '重试保存草稿' }).click();
    await page.getByText('编辑草稿已保留在本机', { exact: true }).waitFor();
    const other = await context.newPage(); await other.goto('https://clipboard-drafts.test/');
    await other.getByLabel('剪贴板备注', { exact: true }).fill('另一个窗口的独立草稿');
    await other.getByText('编辑草稿已保留在本机', { exact: true }).waitFor();
    const records = await page.evaluate(async () => {
      const list = await window.testDraftStore.listClipboardDrafts();
      return Promise.all(list.items.map(item => window.testDraftStore.readClipboardDraft(item.id)));
    });
    assert.equal(records.length, 2);
    assert.equal(new Set(records.map(item => item.id)).size, 2);
    assert.equal(new Set(records.map(item => item.entryId)).size, 1, 'two editors of the same historical item keep distinct recovery copies');
    assert.deepEqual(records.map(item => item.remark).sort(), ['写入失败时保留的输入', '另一个窗口的独立草稿'].sort());
    const stale = records[0];
    const revised = { ...stale, revision: 'newer-revision', updatedAt: Date.now() + 10, remark: '较新的草稿版本' };
    await page.evaluate(async ({ stale, revised }) => {
      await window.testDraftStore.writeClipboardDraft(revised);
      await window.testDraftStore.removeClipboardDraft(stale.id, stale.revision);
    }, { stale, revised });
    assert.equal((await page.evaluate(id => window.testDraftStore.readClipboardDraft(id), stale.id)).remark, '较新的草稿版本');
    await other.close();
    await page.reload();
    // The record's disappearance does not hide its recovery copy or force data loss.
    await page.evaluate(entryId => { window.entries = window.entries.filter(item => item.id !== entryId); window.emit('mutation'); }, revised.entryId);
    await page.getByRole('button', { name: /未完成的编辑（2）/ }).click();
    await panel.getByRole('button', { name: new RegExp(revised.title) }).first().click();
    await panel.getByRole('button', { name: '继续编辑草稿' }).click();
    await panel.getByRole('alert').waitFor();
    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('button', { name: '下载草稿' }).click();
    const download = await downloadPromise;
    const downloaded = await readFile(await download.path(), 'utf8');
    assert.ok(downloaded.includes(revised.text)); assert.ok(downloaded.includes(revised.remark));
    await mkdir(path.resolve('.verification/clipboard-v3'), { recursive: true });
    await page.screenshot({ path: path.resolve('.verification/clipboard-v3/draft-recovery.png') });
    await panel.getByRole('button', { name: '删除草稿', exact: true }).click();
    assert.ok(await page.evaluate(id => window.testDraftStore.readClipboardDraft(id), revised.id), 'first click only requests confirmation');
    await panel.getByRole('button', { name: '确认删除这份草稿', exact: true }).click();
    await page.waitForFunction(async id => await window.testDraftStore.readClipboardDraft(id) === null, revised.id);
    assert.equal((await page.evaluate(() => window.testDraftStore.listClipboardDrafts())).total, 1, 'deleting one draft keeps the other window copy');
    assert.deepEqual(errors, []);
  } finally {
    await context?.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
