import assert from 'node:assert/strict';

/** Real OS key input; paste transport is intercepted inside the owned fixture. */
export async function verifyNativeClipboardIme(application, page) {
  try {
  await application.evaluate(async () => {
    const runtime = global.controller.runtime;
    global.imeOriginalOperate = runtime.operate;
    global.imeOperations = [];
    runtime.operate = async (...args) => { global.imeOperations.push(args); return { status: 'copied', message: 'IME fixture operation intercepted' }; };
    await runtime.store.capture({ text: 'nihao 你好 你 IME A' });
    await runtime.store.capture({ text: 'nihao 你好 你 IME B' });
    runtime.emit('mutation');
    global.imeSend = keys => {
      const native = runtime.native, window = global.controller.windows.get('quick');
      if (!native || !window || !native.isForeground(window)) throw Error('IME fixture is not foreground');
      for (const key of new Set([16, 17, 18, 91, 92, ...keys])) if (native.keyState(key) & 0x8000) throw Error('A key is already held; native IME probe stopped');
      const size = process.arch === 'ia32' ? 28 : 40, offset = process.arch === 'ia32' ? 4 : 8;
      const bytes = Buffer.alloc(size * keys.length * 2);
      keys.forEach((key, index) => {
        for (let up = 0; up < 2; up++) { const base = (index * 2 + up) * size; bytes.writeUInt32LE(1, base); bytes.writeUInt16LE(key, base + offset); bytes.writeUInt32LE(up ? 2 : 0, base + offset + 4); }
      });
      const sent = native.sendInput(keys.length * 2, bytes, size);
      if (sent !== keys.length * 2) {
        if (sent % 2) { const release = Buffer.alloc(size); release.writeUInt32LE(1); release.writeUInt16LE(keys[Math.floor(sent / 2)], offset); release.writeUInt32LE(2, offset + 4); native.sendInput(1, release, size); }
        throw Error('Native IME input was only partially inserted');
      }
    };
    if (!await global.raiseTarget()) throw Error('Cannot activate the owned IME fixture');
    await global.controller.open('quick');
  });
    const search = page.getByLabel('搜索剪贴板', { exact: true });
    await page.waitForFunction(() => {
      const input = document.querySelector('input[aria-label="搜索剪贴板"]');
      return input === document.activeElement && input.value === '' && document.hasFocus();
    }, null, { timeout: 3000 });
    await page.getByRole('option').filter({ hasText: 'IME B' }).waitFor();
    await page.evaluate(() => {
      window.imeEvents = [];
      const input = document.querySelector('input[aria-label="搜索剪贴板"]');
      window.imeRecord = event => window.imeEvents.push({ type: event.type, key: event.key, composing: event.isComposing, data: event.data });
      for (const event of ['compositionstart', 'compositionend', 'keydown']) input.addEventListener(event, window.imeRecord);
    });
    await application.evaluate(() => global.imeSend([0x4e, 0x49, 0x48, 0x41, 0x4f]));
    await page.waitForFunction(() => window.imeEvents.some(event => event.type === 'compositionstart'), null, { timeout: 5000 });
    await application.evaluate(() => global.imeSend([0x0d]));
    await page.waitForFunction(() => window.imeEvents.some(event => event.type === 'compositionend'), null, { timeout: 5000 });
    assert.equal(await application.evaluate(() => global.imeOperations.length), 0, 'Enter committing OS composition must not invoke paste');
    assert.ok(await page.evaluate(() => window.imeEvents.some(event => event.type === 'keydown' && event.composing)), 'OS keyboard event must carry composing state');
    const committed = await search.inputValue();
    assert.ok(committed.length > 0, 'IME commit remains in the search field');
    await search.fill('');
    await application.evaluate(() => global.imeSend([0x4e, 0x49, 0x48, 0x41, 0x4f]));
    await page.waitForFunction(() => window.imeEvents.filter(event => event.type === 'compositionstart').length >= 2, null, { timeout: 5000 });
    await application.evaluate(() => global.imeSend([0x20]));
    await page.waitForFunction(() => window.imeEvents.filter(event => event.type === 'compositionend').length >= 2, null, { timeout: 5000 });
    const chineseCommitted = await search.inputValue();
    assert.match(chineseCommitted, /\p{Script=Han}/u, 'Space commits a real Chinese candidate');
    assert.equal(await application.evaluate(() => global.imeOperations.length), 0);
    const events = await page.evaluate(() => window.imeEvents);
    await search.fill('IME B');
    await page.getByRole('option').filter({ hasText: 'IME B' }).waitFor();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    assert.equal(await application.evaluate(() => global.imeOperations.length), 1, 'Non-composing Enter is the positive paste control');
    await application.evaluate(async () => {
      await global.controller.open('quick');
      await new Promise(resolve => setTimeout(resolve, 50));
      if (!await global.raiseTarget()) throw Error('Could not move focus to the owned host');
      const deadline = Date.now() + 2000;
      while (global.controller.windows.get('quick').isVisible() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      if (global.controller.windows.get('quick').isVisible()) throw Error('Actual blur did not hide the quick window');
    });
    return { realWindowsComposition: true, compositionCommitDoesNotPaste: true, normalEnterInvokesPaste: true, actualBlurHides: true, committed, chineseCommitted, events, systemClipboardWritten: false, inputLayoutChanged: false };
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({ events: window.imeEvents, input: document.querySelector('input[aria-label="搜索剪贴板"]')?.value, visibility: document.visibilityState, documentFocused: document.hasFocus(), activeLabel: document.activeElement?.getAttribute('aria-label'), inert: document.documentElement.inert, bounds: document.querySelector('input[aria-label="搜索剪贴板"]')?.getBoundingClientRect().toJSON() })).catch(() => null);
    const nativeState = await application.evaluate(() => { const window = global.controller.windows.get('quick'); return { visible: window.isVisible(), focused: window.isFocused(), rendererFocused: window.webContents.isFocused(), foreground: global.controller.runtime.native.isForeground(window), bounds: window.getBounds() }; }).catch(() => null);
    throw new Error('Native IME acceptance failed: ' + String(error) + '; fixture diagnostics: ' + JSON.stringify({ renderer: diagnostics, native: nativeState }));
  } finally {
    await page.evaluate(() => {
      const input = document.querySelector('input[aria-label="搜索剪贴板"]');
      for (const event of ['compositionstart', 'compositionend', 'keydown']) input?.removeEventListener(event, window.imeRecord);
    }).catch(() => {});
    await application.evaluate(() => { if (global.imeOriginalOperate) global.controller.runtime.operate = global.imeOriginalOperate; delete global.imeSend; });
  }
}
