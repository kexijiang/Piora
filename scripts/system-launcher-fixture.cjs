/* eslint-disable @typescript-eslint/no-require-imports -- Electron main-process fixture */
const assert = require('node:assert/strict');
const { app, shell } = require('electron');
app.setPath('userData', process.env.PIORA_LAUNCHER_TEST_HOME);
const { SystemLauncher, systemSettings } = require('../desktop/dist/system-launcher.js');
app.whenReady().then(async () => {
  try {
    const launcher = new SystemLauncher();
    const result = await launcher.list();
    assert.equal(result.supported, true);
    assert.ok(result.items.some(item => item.kind === 'app'));
    assert.ok(result.items.some(item => item.id === 'setting:bluetooth'));
    assert.ok(result.items.every(item => !('target' in item)));
    assert.equal(new Set(result.items.map(item => item.id)).size, result.items.length);
    const again = await launcher.list();
    assert.deepEqual(again, result);
    const opened = [];
    const oldExternal = shell.openExternal, oldPath = shell.openPath;
    shell.openExternal = async target => { opened.push(target); };
    shell.openPath = async target => { opened.push(target); return ''; };
    try {
      await launcher.open('setting:bluetooth');
      assert.deepEqual(opened, ['ms-settings:bluetooth']);
      const shortcut = [...launcher.entries.values()].find(item => item.source === 'shortcut');
      assert.ok(shortcut);
      await launcher.open(shortcut.id);
      assert.equal(opened[1], shortcut.target);
      for (const id of ['cmd.exe /c echo unsafe', 'ms-settings:unknown', '', null, 'x'.repeat(101)]) await assert.rejects(launcher.open(id));
      assert.equal(opened.length, 2);
      assert.ok(systemSettings.every(item => item.target.startsWith('ms-settings:')));
    } finally { shell.openExternal = oldExternal; shell.openPath = oldPath; }
    console.log(`PASS native Windows inventory (${result.items.filter(item => item.kind === 'app').length} apps, ${systemSettings.length} settings), cache and launch dispatch with isolated shell adapters`);
    if (result.warning) throw new Error(result.warning);
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
