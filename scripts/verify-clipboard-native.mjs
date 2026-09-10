// Production controller + bridge + renderer in an isolated Electron profile.
// Native clipboard writes require the explicit --native-paste flag. Existing
// Unsupported clipboard formats are left alone; the report states skipped gates.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "playwright-core";
import { buildClipboardUI, clipboardTheme } from "../lib/clipboard-ui-fixture.mjs";
import { verifyNativeClipboardDrag } from "./clipboard-native-drag-probe.mjs";
import { verifyNativeClipboardIme } from "./clipboard-native-ime-probe.mjs";
const require = createRequire(import.meta.url);
assert.ok(!process.argv.includes('--external-paste') || process.argv.includes('--native-paste'), '--external-paste also requires --native-paste');
const output = path.resolve(".verification/clipboard-v2");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(tmpdir(), "piora-clipboard-native-"));
const { bundle, css } = await buildClipboardUI(directory);
await writeFile(path.join(directory, "bundle.js"), bundle);
const ui = `<!doctype html><meta charset="utf-8"><style>${clipboardTheme}${css}</style><div id="root"></div><script src="/bundle.js"></script>`;
const testTarget = '<!doctype html><meta charset="utf-8"><title>Clipboard acceptance target</title><textarea id="target" autofocus style="width:90%;height:160px"></textarea><script>window.keys=[];document.addEventListener("keydown",e=>window.keys.push(e.key));</script>';
const script = path.join(directory, "main.cjs");
await writeFile(script, `
const {app,BrowserWindow,protocol,clipboard,nativeImage,globalShortcut}=require('electron');
const {createServer}=require('node:http'); const {readFileSync,writeFileSync,unlinkSync}=require('node:fs');const {join}=require('node:path');
const {ClipboardController}=require(${JSON.stringify(path.resolve("desktop/dist/clipboard-controller.js"))});
app.setPath('userData',${JSON.stringify(path.join(directory, "profile"))});
protocol.registerSchemesAsPrivileged([{scheme:'piora-clipboard',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
global.failures=[];
app.whenReady().then(async()=>{
 const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?readFileSync(${JSON.stringify(path.join(directory, "bundle.js"))}):req.url.startsWith('/desktop-clipboard')?${JSON.stringify(ui)}:${JSON.stringify(testTarget)})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=new URL('http://127.0.0.1:'+server.address().port);const partition='persist:clipboard-test';
 const host=new BrowserWindow({width:800,height:500,show:false,webPreferences:{preload:${JSON.stringify(path.resolve("desktop/dist/preload.js"))},partition,sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await host.loadURL(origin.href);
 const controller=new ClipboardController({directory:${JSON.stringify(path.join(directory, "history"))},origin,partition,host,trusted:event=>event.sender===host.webContents&&event.senderFrame===host.webContents.mainFrame,openManager:()=>host,onError:error=>global.failures.push(String(error))});
 await controller.start();
 global.controller=controller;global.host=host;global.origin=origin.href;global.partition=partition;
 global.originalFormats=clipboard.availableFormats();
 global.canRestoreText=global.originalFormats.every(format=>/^(text\\/(plain|html|rtf)|HTML Format|Rich Text Format|CF_UNICODETEXT|CF_TEXT|CF_LOCALE)$/i.test(format))&&!controller.runtime.native.hasFiles();
 global.originalData={};
 if(global.canRestoreText){
   if(global.originalFormats.some(format=>/plain|CF_UNICODETEXT|CF_TEXT/i.test(format)))global.originalData.text=clipboard.readText();
   if(global.originalFormats.some(format=>/html/i.test(format)))global.originalData.html=clipboard.readHTML();
   if(global.originalFormats.some(format=>/rtf|Rich Text Format/i.test(format)))global.originalData.rtf=clipboard.readRTF();
 }
 global.ownedSequence=null;
 const operate=controller.runtime.operate.bind(controller.runtime);
 controller.runtime.operate=async(...args)=>{try{return await operate(...args)}finally{if(clipboard.readText()===global.fixtureText)global.ownedSequence=controller.runtime.native.currentSequence()}};
 global.restore=()=>{if(global.ownedSequence!==null&&controller.runtime.native.currentSequence()===global.ownedSequence){if(global.originalFormats.length)clipboard.write(global.originalData);else clipboard.clear();global.ownedSequence=null;}};
 const koffi=require(${JSON.stringify(require.resolve("koffi", { paths: [path.resolve("desktop")] }))});
 const sendInput=koffi.load('user32.dll').func('uint32_t __stdcall SendInput(uint32_t count,const void *input,int size)');
 global.raiseTarget=()=>new Promise((resolve,reject)=>{
   if(!globalShortcut.register('F23',()=>{host.show();host.focus();globalShortcut.unregister('F23');resolve(true)})){resolve(false);return;}
   const size=process.arch==='ia32'?28:40,offset=process.arch==='ia32'?4:8,input=Buffer.alloc(size*2);
   for(let i=0;i<2;i++){input.writeUInt32LE(1,i*size);input.writeUInt16LE(0x86,i*size+offset);input.writeUInt32LE(i?2:0,i*size+offset+4)}
   if(sendInput(2,input,size)!==2){globalShortcut.unregister('F23');reject(new Error('Native activation test input blocked'));return;}
   setTimeout(()=>{globalShortcut.unregister('F23');resolve(false)},1500);
 });
 global.raiseExternal=(handle,pid)=>new Promise((resolve,reject)=>{
   const native=controller.runtime.native, target=BigInt(handle);
   if(!native.isWindow(target)||native.pid(target)!==pid){resolve(false);return;}
   if(!globalShortcut.register('F24',()=>{native.showWindow(target,9);native.setForeground(target);globalShortcut.unregister('F24');resolve(true)})){resolve(false);return;}
   const size=process.arch==='ia32'?28:40,offset=process.arch==='ia32'?4:8,input=Buffer.alloc(size*2);
   for(let i=0;i<2;i++){input.writeUInt32LE(1,i*size);input.writeUInt16LE(0x87,i*size+offset);input.writeUInt32LE(i?2:0,i*size+offset+4)}
   if(sendInput(2,input,size)!==2){globalShortcut.unregister('F24');reject(new Error('External target activation blocked'));return;}
   setTimeout(()=>{globalShortcut.unregister('F24');resolve(false)},1500);
 });
 global.testCtrlOwned=false;
 global.testCtrl=(down)=>{
   if(down && (controller.runtime.native.keyState(0x11)&0x8000)!==0)return false;
   if(!down&&!global.testCtrlOwned)return true;
   const size=process.arch==='ia32'?28:40,offset=process.arch==='ia32'?4:8,input=Buffer.alloc(size);
   input.writeUInt32LE(1);input.writeUInt16LE(0x11,offset);input.writeUInt32LE(down?0:2,offset+4);
   const sent=sendInput(1,input,size)===1;if(sent)global.testCtrlOwned=down;return sent;
 };
 global.fixtureText='Piora clipboard acceptance '+Date.now();
 global.recordId=await controller.runtime.store.capture({text:global.fixtureText,html:'<b>'+global.fixtureText+'</b>',source:{name:'Acceptance fixture',executable:'fixture.exe'}});
 const image=nativeImage.createFromBitmap(Buffer.alloc(32*32*4,0xaa),{width:32,height:32});
 global.imageId=await controller.runtime.store.capture({image:image.toPNG()});
 global.newAttacker=async()=>{const win=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(path.resolve("desktop/dist/preload.js"))},partition,sandbox:true,contextIsolation:true}});await win.loadURL(origin.href+'attacker');global.attacker=win;return win.webContents.id;};
 global.removeDragFixture=()=>unlinkSync(global.dragFixtureFiles[0]);
 global.shutdown=async()=>{global.testCtrl(false);global.restore();global.prepareRequests?.forEach(request=>request.resolve([]));globalShortcut.unregister('F23');globalShortcut.unregister('F24');await controller.stop();host.destroy();if(global.attacker&&!global.attacker.isDestroyed())global.attacker.destroy();await new Promise(resolve=>server.close(resolve));};
 global.ready=true;
}).catch(error=>{global.setupError=String(error);console.error(error)});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let application, externalProcess;
const report = { nativePaste: "not requested", nativeCapture: "not requested", externalPaste: "not requested", image: null, thumbnail: null, untrustedIPC: null, screenshots: [] };
try {
  // Cold Electron/DevTools startup is distinct from the measured warm-window
  // latency. Allow antivirus scanning and concurrent release I/O to settle.
  application = await electron.launch({ executablePath: require("electron"), args: [script], env, timeout: 120000 });
  const hostPage = await application.firstWindow();
  await hostPage.waitForFunction(() => Boolean(window.piDesktop?.clipboard?.historyV2));
  for (let i = 0; i < 300; i++) {
    const state = await application.evaluate(() => ({ ready: global.ready, error: global.setupError }));
    if (state.error) throw new Error(state.error);
    if (state.ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await application.evaluate(() => global.ready), true, "isolated production controller starts");
  await application.evaluate(() => { global.host.showInactive(); });
  await application.evaluate(() => global.controller.open("quick"));
  const quick = application.windows().find(page => page.url().includes("desktop-clipboard"));
  assert.ok(quick);
  await quick.getByRole("option").first().waitFor();
  await quick.setViewportSize({ width: 760, height: 540 });
  await quick.screenshot({ path: path.join(output, "quick-native.png") }); report.screenshots.push("quick-native.png");
  const imageId = await application.evaluate(() => global.imageId);
  const asset = await quick.evaluate(async id => {
    const url = await window.piDesktop.clipboard.historyV2.asset(id);
    const response = await fetch(url); return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
  }, imageId);
  assert.equal(asset.status, 200); assert.ok(asset.bytes > 50); report.image = "verified scoped PNG fetch";
  const thumbnail = await quick.evaluate(async id => {
    const url = await window.piDesktop.clipboard.historyV2.asset(id, true);
    const response = await fetch(url); return { status: response.status, bytes: (await response.arrayBuffer()).byteLength };
  }, imageId);
  report.thumbnail = thumbnail;
  assert.equal(thumbnail.status, 200, "native thumbnails must load for hash-named PNG assets");
  await application.evaluate(async () => {
    const runtime = global.controller.runtime;
    global.originalRecoverySnapshot = runtime.snapshot;
    global.originalRecoverySequence = runtime.native.currentSequence;
    global.recoverySequence = 101; global.recoverySnapshots = 0;
    runtime.native.currentSequence = () => global.recoverySequence;
    runtime.snapshot = () => { global.recoverySnapshots++; return { text: 'owned-runtime-recovery-snapshot-' + global.recoverySequence }; };
    await runtime.mutate({ type: 'settings', value: { enabled: true } });
    await runtime.store.worker.terminate();
    global.recoverySequence = 102;
    await runtime.capture(false);
  });
  await quick.getByRole('button', { name: '重新连接存储', exact: true }).waitFor();
  assert.equal(await application.evaluate(() => global.recoverySnapshots), 0, 'capture stays paused while the store is unavailable');
  await quick.getByRole('button', { name: '重新连接存储', exact: true }).click();
  await quick.getByText('已重新连接。未确认的操作未重放，请核对最近记录。', { exact: true }).waitFor();
  const recovery = await application.evaluate(async () => {
    const runtime = global.controller.runtime;
    try {
      await runtime.capture(false);
      const pausedSnapshots = global.recoverySnapshots;
      global.recoverySequence = 103; await runtime.capture(false);
      return { pausedSnapshots, nextSnapshots: global.recoverySnapshots, storage: (await runtime.status()).storage, records: (await runtime.store.query({ text: 'owned-runtime-recovery-snapshot-' })).items.map(item => item.title) };
    } finally {
      await runtime.mutate({ type: 'settings', value: { enabled: false } });
      runtime.snapshot = global.originalRecoverySnapshot;
      runtime.native.currentSequence = global.originalRecoverySequence;
      runtime.resetBaseline();
    }
  });
  assert.deepEqual(recovery, { pausedSnapshots: 0, nextSnapshots: 1, storage: 'ready', records: ['owned-runtime-recovery-snapshot-103'] });
  assert.equal((await quick.evaluate(id => window.piDesktop.clipboard.historyV2.getDetail(id), imageId)).kind, 'image');
  report.storageRecovery = 'real worker termination and UI reconnect preserve history; controlled native sequence/snapshot verifies pause and a fresh baseline, with no gap replay';
  const links = await application.evaluate(async ({ shell }) => {
    global.originalOpenExternal = shell.openExternal;
    global.openedClipboardLink = null;
    shell.openExternal = async url => { global.openedClipboardLink = url; };
    return { valid: await global.controller.runtime.store.capture({ text: 'https://example.com/clipboard-verification' }), credentials: await global.controller.runtime.store.capture({ text: 'https://name:secret@example.com/' }), ordinary: global.recordId };
  });
  try {
    await quick.evaluate(id => window.piDesktop.clipboard.historyV2.openLink(id), links.valid);
    assert.equal(await application.evaluate(() => global.openedClipboardLink), 'https://example.com/clipboard-verification');
    for (const id of [links.credentials, links.ordinary, 'https://example.com/untrusted-raw-url']) {
      assert.equal(await quick.evaluate(async id => { try { await window.piDesktop.clipboard.historyV2.openLink(id); return false; } catch { return true; } }, id), true);
    }
    report.linkOpening = 'ID-only IPC resolves and validates stored web URLs; OS browser launch stubbed';
  } finally { await application.evaluate(({ shell }) => { shell.openExternal = global.originalOpenExternal; }); }
  const prepared = await application.evaluate(async () => {
    const runtime = global.controller.runtime;
    const first = await runtime.prepareDrag([global.imageId]);
    const second = await runtime.prepareDrag([global.imageId]);
    global.dragFixtureFiles = first;
    global.realPrepareDrag = runtime.prepareDrag.bind(runtime);
    global.prepareRequests = [];
    runtime.prepareDrag = ids => new Promise(resolve => global.prepareRequests.push({ ids, resolve }));
    return { first, second, other: global.recordId };
  });
  assert.deepEqual(prepared.first, prepared.second, 'reselecting an image reuses the same independent drag copy');
  await quick.evaluate(({ imageId, other }) => {
    const bridge = window.piDesktop.clipboard.historyV2;
    window.dragResults = Promise.all([bridge.prepareDrag([imageId]), bridge.prepareDrag([other])]);
  }, { imageId, other: prepared.other });
  await application.evaluate(async () => {
    const until = Date.now() + 5000;
    while (global.prepareRequests.length < 2 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    if (global.prepareRequests.length !== 2) throw new Error('Expected two isolated preparation requests');
    global.prepareRequests[1].resolve(global.dragFixtureFiles);
    await new Promise(resolve => setImmediate(resolve));
    global.prepareRequests[0].resolve(global.dragFixtureFiles);
    global.controller.runtime.prepareDrag = global.realPrepareDrag;
  });
  assert.deepEqual(await quick.evaluate(() => window.dragResults), [false, true], 'stale preparation cannot replace the current selection');
  await quick.evaluate(id => window.piDesktop.clipboard.historyV2.prepareDrag([id]), imageId);
  await application.evaluate(() => global.removeDragFixture());
  await quick.evaluate(id => window.piDesktop.clipboard.historyV2.startDrag([id]), imageId);
  await quick.getByRole('alert').filter({ hasText: '部分源文件已不存在' }).waitFor();
  report.dragPreparation = 'reused image copy; late preparation rejected; missing file surfaced in renderer';
  const attackerCreated = application.waitForEvent("window");
  const attackerId = await application.evaluate(() => global.newAttacker());
  const attacker = await attackerCreated;
  await attacker.waitForURL(url => url.pathname.includes("attacker"));
  assert.ok(attacker && attackerId);
  const rejection = await attacker.evaluate(async () => { try { await window.piDesktop.clipboard.historyV2.query({}); return false; } catch (error) { return String(error).includes('Untrusted clipboard request'); } });
  assert.equal(rejection, true); report.untrustedIPC = "same-origin unregistered renderer rejected";
  const allowed = process.argv.includes("--native-paste") && await application.evaluate(() => global.canRestoreText);
  if (allowed) {
    // Reopen from the target, since the security check intentionally created
    // another renderer. All input is confined to the test's own textarea.
    assert.equal(await application.evaluate(() => global.raiseTarget()), true, "test activation hotkey registered and fired");
    await hostPage.locator("#target").focus();
    assert.equal(await application.evaluate(() => global.controller.runtime.native.isForeground(global.host)), true, "never send test paste unless the isolated target is the actual foreground HWND");
    await application.evaluate(() => global.controller.open("quick"));
    const fixture = await application.evaluate(() => global.fixtureText);
    await quick.getByLabel("搜索剪贴板").fill(fixture);
    await quick.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 1);
    await quick.getByLabel("搜索剪贴板").press("Enter");
    await hostPage.waitForFunction(expected => document.querySelector('#target').value === expected, fixture, { timeout: 10000 });
    assert.equal(await hostPage.evaluate(() => window.keys.includes('Enter')), false, "target never receives Enter/submit");
    await application.evaluate(() => { global.ownedSequence=global.controller.runtime.native.currentSequence(); });
    report.nativePaste = "Ctrl+V reached original textarea; no Enter received";
    const native = await application.evaluate(async ({ clipboard }) => {
      const runtime = global.controller.runtime;
      await runtime.mutate({ type: 'settings', value: { enabled: true } });
      clipboard.writeText('Piora event capture fixture');global.ownedSequence=runtime.native.currentSequence();
      await new Promise(resolve=>setTimeout(resolve,150));
      const first=await runtime.store.query({text:'Piora event capture fixture'});
      clipboard.writeText('Piora event capture fixture');global.ownedSequence=runtime.native.currentSequence();
      await new Promise(resolve=>setTimeout(resolve,150));
      const second=await runtime.store.query({text:'Piora event capture fixture'});
      await runtime.mutate({type:'settings',value:{enabled:false}});
      return {first:first.items[0]?.copies,second:second.items[0]?.copies,listener:(await runtime.status()).listener};
    });
    assert.deepEqual(native, { first: 1, second: 2, listener: "native" }); report.nativeCapture = native;
    if (process.argv.includes('--external-paste')) {
      const statePath = path.join(directory, 'external-state.json'), targetScript = path.join(directory, 'external-editor.ps1');
      await writeFile(targetScript, `param([string]$StatePath)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Piora isolated external paste acceptance'
$form.Width = 620; $form.Height = 300; $form.KeyPreview = $true
$editor = New-Object System.Windows.Forms.RichTextBox
$editor.Dock = 'Fill'; $editor.Multiline = $true
$form.Controls.Add($editor)
$script:enters = 0
$form.Add_KeyDown({ if ($_.KeyCode -eq [System.Windows.Forms.Keys]::Enter) { $script:enters++ } })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 50
$timer.Add_Tick({
  $editor.Select(0, $editor.TextLength)
  $bold = $null -ne $editor.SelectionFont -and $editor.SelectionFont.Bold
  $editor.Select($editor.TextLength, 0)
  $state = @{ handle = $form.Handle.ToInt64().ToString(); pid = $PID; text = $editor.Text; bold = $bold; enters = $script:enters }
  [System.IO.File]::WriteAllText($StatePath, ($state | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
})
$form.Add_Shown({ $editor.Focus(); $timer.Start() })
try { [System.Windows.Forms.Application]::Run($form) } finally { $timer.Stop(); $timer.Dispose(); $form.Dispose() }
`, 'utf8');
      externalProcess = spawn('powershell.exe', ['-NoProfile', '-STA', '-File', targetScript, '-StatePath', statePath], { windowsHide: true, stdio: 'ignore' });
      const externalState = async predicate => {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          if (externalProcess.exitCode !== null) throw new Error(`External editor exited with ${externalProcess.exitCode}`);
          let value; try { value = JSON.parse(await readFile(statePath, 'utf8')); } catch { /* The owned state file may be mid-write. */ }
          if (value && predicate(value)) return value;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('External editor did not reach the expected state');
      };
      const state = await externalState(value => value.handle && value.pid);
      assert.equal(state.pid, externalProcess.pid, 'target handle belongs to the child process this verifier launched');
      const text = `Piora external rich text ${Date.now()}`;
      const externalRecordId = await application.evaluate(async (_electron, text) => {
        const id = await global.controller.runtime.store.capture({ text, rtf: '{\\rtf1\\ansi\\b ' + text + '\\b0}' });
        global.fixtureText = text;
        return id;
      }, text);
      assert.equal(await application.evaluate((_electron, { handle, pid }) => global.raiseExternal(handle, pid), state), true);
      assert.equal(await application.evaluate((_electron, state) => global.controller.runtime.native.foreground() === BigInt(state.handle), state), true, 'never paste unless the verified external editor is foreground');
      await application.evaluate(() => global.controller.open('quick'));
      await quick.getByLabel('搜索剪贴板').fill(text);
      await quick.waitForFunction(() => document.querySelectorAll('[role="option"]').length === 1);
      await quick.getByLabel('搜索剪贴板').press('Enter');
      const result = await externalState(value => value.text === text);
      assert.equal(result.enters, 0); assert.equal(result.bold, true, 'RTF formatting reached the independent native RichTextBox');
      report.externalPaste = { process: 'Windows PowerShell / System.Windows.Forms.RichTextBox', distinctProcess: true, textMatched: true, rtfBoldPreserved: true, enterCount: result.enters };
      await application.evaluate(() => global.controller.open('quick'));
      assert.equal(await application.evaluate(() => global.testCtrl(true)), true, 'test owns a previously released Ctrl key');
      let held;
      try { held = await quick.evaluate(id => window.piDesktop.clipboard.historyV2.paste({ ids: [id] }), externalRecordId); }
      finally { assert.equal(await application.evaluate(() => global.testCtrl(false)), true, 'always release the test-owned modifier'); }
      assert.equal(held.status, 'modifiers-held');
      assert.equal((await externalState(value => value.text === text)).enters, 0);
      report.externalPaste.modifiersHeld = 'real Ctrl held: automatic paste cancelled';
      const partial = await application.evaluate(async (_electron, state) => {
        const native = global.controller.runtime.native, original = native.sendInput, calls = [];
        await global.raiseExternal(state.handle, state.pid);
        const target = native.target();
        native.sendInput = (count, bytes, size) => { const offset = process.arch === 'ia32' ? 4 : 8; calls.push(Array.from({ length: count }, (_, i) => ({ key: bytes.readUInt16LE(i * size + offset), flags: bytes.readUInt32LE(i * size + offset + 4) }))); return calls.length === 1 ? 1 : count; };
        try { return { result: await native.paste(target.token, () => {}), calls }; }
        finally { native.sendInput = original; }
      }, state);
      assert.equal(partial.result.status, 'input-blocked');
      assert.deepEqual(partial.calls[1], [{ key: 0x11, flags: 2 }], 'simulated partial input releases the Ctrl-down it may have inserted');
      report.externalPaste.partialInputSimulation = 'Ctrl-up cleanup verified after simulated one-event insertion';
      await application.evaluate(() => global.controller.open('quick'));
      const exited = new Promise(resolve => externalProcess.once('exit', resolve)); externalProcess.kill(); await exited;
      const closed = await quick.evaluate(id => window.piDesktop.clipboard.historyV2.paste({ ids: [id] }), externalRecordId);
      assert.equal(closed.status, 'target-lost');
      report.externalPaste.closedTarget = 'closed process rejected without input';
    }
  } else if (process.argv.includes("--native-paste")) report.nativePaste = "skipped: pre-existing clipboard has formats this fixture cannot losslessly restore";
  if (process.argv.includes('--native-drag')) report.nativeDrag = await verifyNativeClipboardDrag(application, quick, directory);
  if (process.argv.includes('--native-ime')) report.nativeIme = await verifyNativeClipboardIme(application, quick);
  await application.evaluate(() => global.controller.open("shelf"));
  const shelf = application.windows().find(page => page.url().includes("surface=shelf"));
  await shelf.getByText("屏幕暂存", { exact: true }).first().waitFor();
  await shelf.screenshot({ path: path.join(output, "shelf-native.png") }); report.screenshots.push("shelf-native.png");
  await application.evaluate(() => global.controller.open('quick'));
  await quick.getByLabel('搜索剪贴板', { exact: true }).fill(await application.evaluate(() => global.fixtureText));
  await quick.getByRole('option').first().click();
  if (await quick.getByRole('button', { name: '预览', exact: true }).getAttribute('aria-pressed') !== 'true') await quick.getByRole('button', { name: '预览', exact: true }).click();
  await quick.getByLabel('剪贴板备注', { exact: true }).fill('native shutdown recovery draft');
  await quick.evaluate(() => {
    window.releaseClipboardQuit = null;
    window.removeClipboardQuitWait = window.piDesktop.clipboard.historyV2.onBeforeClose(() => new Promise(resolve => { window.releaseClipboardQuit = resolve; }));
  });
  await application.evaluate(() => {
    global.clipboardQuitState = 'waiting';
    global.quitPreparation = global.controller.prepareQuit().then(() => { global.clipboardQuitState = 'ready'; }, error => { global.clipboardQuitState = error.message; });
  });
  await quick.waitForFunction(() => Boolean(window.releaseClipboardQuit) && document.documentElement.inert);
  assert.equal(await application.evaluate(() => global.clipboardQuitState), 'waiting', 'native shutdown waits for renderer recovery acknowledgement');
  await application.evaluate(() => {
    const request = [...global.controller.closing].find(([, value]) => value.sender !== global.host.webContents.id);
    if (!request) throw new Error('expected a pending clipboard renderer acknowledgement');
    global.host.webContents.send('pi:clipboard-v2-prepare-close', request[0]);
  });
  await hostPage.waitForFunction(() => document.documentElement.inert);
  assert.equal(await application.evaluate(() => global.clipboardQuitState), 'waiting', 'another trusted renderer cannot acknowledge the clipboard window token');
  await quick.evaluate(() => { window.releaseClipboardQuit(); window.removeClipboardQuitWait(); });
  await application.evaluate(() => global.quitPreparation);
  assert.equal(await application.evaluate(() => global.clipboardQuitState), 'ready');
  assert.equal(await quick.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('piora-clipboard-drafts', 1);
    request.onsuccess = () => { const db = request.result, read = db.transaction('drafts').objectStore('drafts').getAll(); read.onsuccess = () => { resolve(read.result.some(item => item.remark === 'native shutdown recovery draft')); db.close(); }; read.onerror = () => reject(read.error); };
    request.onerror = () => reject(request.error);
  })), true);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.webContents.send('pi:clipboard-v2-cancel-close')));
  await quick.waitForFunction(() => !document.documentElement.inert);
  await quick.evaluate(() => { window.removeClipboardQuitFailure = window.piDesktop.clipboard.historyV2.onBeforeClose(async () => { throw new Error('injected draft storage failure'); }); });
  assert.equal(await application.evaluate(async () => { try { await global.controller.stop(); return false; } catch (error) { return error.constructor.name === 'ClipboardDraftFlushError'; } }), true);
  await quick.waitForFunction(() => !document.documentElement.inert);
  assert.ok(await quick.evaluate(() => window.piDesktop.clipboard.historyV2.status()), 'failed recovery flush leaves the runtime and IPC available');
  await quick.evaluate(() => window.removeClipboardQuitFailure());
  report.draftQuitBarrier = 'native IPC waits for committed recovery; failed flush cancels teardown and restores usable windows';
  const errors = await application.evaluate(() => global.failures); assert.deepEqual(errors, []);
  await writeFile(path.join(output, "native-report.json"), JSON.stringify(report, null, 2));
  const reportName = process.argv.includes('--native-ime') ? 'native-ime-report.json' : process.argv.includes('--native-drag') ? 'native-drag-report.json' : process.argv.includes('--external-paste') ? 'external-paste-report.json' : process.argv.includes('--native-paste') ? 'native-paste-report.json' : 'native-ui-report.json';
  await writeFile(path.join(output, reportName), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (application) { await application.evaluate(async () => { if (global.shutdown) await global.shutdown(); }).catch(() => {}); await application.close(); }
  if (externalProcess && externalProcess.exitCode === null && externalProcess.signalCode === null) {
    const exited = new Promise(resolve => externalProcess.once('exit', resolve)); externalProcess.kill(); await exited;
  }
  assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
