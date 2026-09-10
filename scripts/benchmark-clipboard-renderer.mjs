// Real controller/preload/SQLite worker and renderer search timing. No OS writes.
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { cpus, release, totalmem } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
import { buildClipboardUI, clipboardTheme } from '../lib/clipboard-ui-fixture.mjs';
const require = createRequire(import.meta.url);
const source = path.resolve(process.argv[2] ?? '.verification/clipboard-performance/run-cb4b916a-5804-42ad-9803-630ae8c92e03');
const previous = JSON.parse(await readFile(path.join(source, 'benchmark.json'), 'utf8'));
assert.equal(previous.dataset.rows, 100000);
assert.equal((await stat(path.join(source, 'clipboard.sqlite-wal')).catch(() => null))?.size ?? 0, 0, 'Source must have no uncheckpointed WAL');
const directory = path.resolve('.verification/clipboard-renderer-performance', 'run-' + randomUUID());
const history = path.join(directory, 'history');
await mkdir(history, { recursive: true });
await cp(path.join(source, 'clipboard.sqlite'), path.join(history, 'clipboard.sqlite'));
await cp(path.join(source, 'content'), path.join(history, 'content'), { recursive: true });
const { bundle, css } = await buildClipboardUI(directory);
await writeFile(path.join(directory, 'bundle.js'), bundle);
const html = `<!doctype html><meta charset="utf-8"><style>${clipboardTheme}${css}</style><div id="root"></div><script src="/bundle.js"></script>`;
const script = path.join(directory, 'main.cjs');
await writeFile(script, `
const {app,BrowserWindow,protocol}=require('electron');
const {createServer}=require('node:http');const {readFileSync}=require('node:fs');
const {ClipboardController}=require(${JSON.stringify(path.resolve('desktop/dist/clipboard-controller.js'))});
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
protocol.registerSchemesAsPrivileged([{scheme:'piora-clipboard',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.whenReady().then(async()=>{
 const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':'text/html');res.end(req.url==='/bundle.js'?readFileSync(${JSON.stringify(path.join(directory, 'bundle.js'))}):req.url.startsWith('/desktop-clipboard')?${JSON.stringify(html)}:'<!doctype html><title>Benchmark host</title>')});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin=new URL('http://127.0.0.1:'+server.address().port);const partition='persist:benchmark';
 const host=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(path.resolve('desktop/dist/preload.js'))},partition,sandbox:true,contextIsolation:true}});
 await host.loadURL(origin.href);
 const controller=new ClipboardController({directory:${JSON.stringify(history)},origin,partition,host,trusted:e=>e.sender===host.webContents&&e.senderFrame===host.webContents.mainFrame,openManager:()=>host,onError:e=>console.error(e)});
 await controller.start();global.controller=controller;
 global.shutdown=async()=>{await controller.stop();host.destroy();await new Promise(resolve=>server.close(resolve))};global.ready=true;
}).catch(e=>{global.setupError=String(e)});
`);
let application;
const report = { source, directory, systemClipboardWritten: false, machine: { cpu: cpus()[0]?.model, windows: release(), memoryGiB: totalmem() / 1024 ** 3 }, scope: 'Production clipboard components/controller/preload/worker in installed Electron, isolated UI harness. Search input event through debounce, IPC, SQL, React and two animation frames. Not packaged Next startup, native capture, large-image encoding, physical IME or disk-contention acceptance.', measurements: {} };
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
try {
  const processStart = performance.now();
  application = await electron.launch({ executablePath: require('electron'), args: [script], env, timeout: 120000 });
  const host = await application.firstWindow();
  await host.waitForFunction(() => !!window.piDesktop?.clipboard?.historyV2);
  for (let i = 0; i < 600; i++) {
    const state = await application.evaluate(() => ({ ready: global.ready, error: global.setupError }));
    if (state.error) throw Error(state.error);
    if (state.ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const status = await host.evaluate(() => window.piDesktop.clipboard.historyV2.status());
  assert.ok(status.total >= 100000); assert.equal(status.settings.enabled, false);
  report.rows = status.total;
  const coldOpen = performance.now();
  await application.evaluate(() => global.controller.open('quick'));
  const page = application.windows().find(window => window.url().includes('/desktop-clipboard'));
  assert.ok(page); await page.getByLabel('搜索剪贴板', { exact: true }).waitFor();
  await page.getByRole('option').first().waitFor();
  report.firstQuickWindowMs = performance.now() - coldOpen;
  report.newProcessToFirstSearchMs = performance.now() - processStart;
  report.cacheState = 'New Electron process; dataset copied immediately before launch, OS caches not flushed. Warm samples follow initial load and four warmups.';
  report.memoryBaseline = await application.evaluate(({ app }) => app.getAppMetrics().map(({ type, memory }) => ({ type, memory })));
  const warmOpen = [];
  for (let index = 0; index < 34; index++) {
    await page.evaluate(async () => { document.activeElement?.blur(); await window.piDesktop.clipboard.historyV2.hide(); });
    const started = performance.now();
    await application.evaluate(() => global.controller.open('quick'));
    await page.waitForFunction(() => {
      const input = document.querySelector('input[aria-label="搜索剪贴板"]');
      return document.visibilityState === 'visible' && document.hasFocus() && input === document.activeElement && !input.disabled && !input.closest('[inert]');
    });
    if (index >= 4) warmOpen.push(performance.now() - started);
  }
  report.measurements.warmOpen = { samples: warmOpen, p95Ms: [...warmOpen].sort((a, b) => a - b)[Math.ceil(warmOpen.length * .95) - 1], budgetMs: 200, scope: 'Controller open through visible/focused/enabled search, including automation IPC overhead; excludes physical hotkey dispatch' };
  console.log(JSON.stringify({ name: 'warmOpen', ...report.measurements.warmOpen }));
  assert.equal(await application.evaluate(() => global.controller.setShortcut('F22')), true, 'Owned native benchmark shortcut must be available');
  const shortcutSamples = [];
  for (let index = 0; index < 34; index++) {
    await page.evaluate(async () => { document.activeElement?.blur(); await window.piDesktop.clipboard.historyV2.hide(); });
    const started = performance.now();
    await application.evaluate(() => {
      const native = global.controller.runtime.native;
      for (const key of [16, 17, 18, 91, 92, 0x85]) if (native.keyState(key) & 0x8000) throw Error('A key is held; native shortcut benchmark stopped');
      const size = process.arch === 'ia32' ? 28 : 40, offset = process.arch === 'ia32' ? 4 : 8, bytes = Buffer.alloc(size * 2);
      for (let index = 0; index < 2; index++) { bytes.writeUInt32LE(1, index * size); bytes.writeUInt16LE(0x85, index * size + offset); bytes.writeUInt32LE(index ? 2 : 0, index * size + offset + 4); }
      const sent = native.sendInput(2, bytes, size);
      if (sent !== 2) { if (sent === 1) native.sendInput(1, bytes.subarray(size), size); throw Error('Native shortcut key injection incomplete'); }
    });
    await page.waitForFunction(() => document.hasFocus() && document.activeElement?.getAttribute('aria-label') === '搜索剪贴板');
    if (index >= 4) shortcutSamples.push(performance.now() - started);
  }
  report.measurements.nativeShortcut = { samples: shortcutSamples, p95Ms: [...shortcutSamples].sort((a, b) => a - b)[Math.ceil(shortcutSamples.length * .95) - 1], budgetMs: 200, scope: 'Windows SendInput F22 through the registered production globalShortcut callback to focused search; includes automation overhead' };
  console.log(JSON.stringify({ name: 'nativeShortcut', ...report.measurements.nativeShortcut }));
  await application.evaluate(() => global.controller.setShortcut());
  for (const [name, terms, budget] of [['indexedSearch', ['000123', 'needle-rare-marker', 'release', '项目计划', '000124'], 200], ['shortSearch', ['重', '☄'], 500]]) {
    const samples = [];
    for (let index = 0; index < 34; index++) {
      const term = terms[index % terms.length];
      const elapsed = await page.evaluate(async term => {
        const input = document.querySelector('input[aria-label="搜索剪贴板"]');
        const started = performance.now();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, term);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve, reject) => {
          const check = () => {
            const match = term === '☄' ? document.body.textContent.includes('没有匹配记录')
              : term === '重' ? !!document.querySelector('#clipboard-benchmark-000097')
              : !!document.querySelector('#clipboard-benchmark-' + ({ 'needle-rare-marker': '001009', release: '000001', '项目计划': '000000' }[term] ?? term));
            if (match) requestAnimationFrame(() => requestAnimationFrame(resolve));
            else if (performance.now() - started > 10000) reject(Error('Search render timed out: ' + term));
            else requestAnimationFrame(check);
          }; check();
        });
        return performance.now() - started;
      }, term);
      if (index >= 4) samples.push(elapsed);
    }
    const ordered = [...samples].sort((a, b) => a - b);
    report.measurements[name] = { terms, samples, p95Ms: ordered[Math.ceil(ordered.length * .95) - 1], budgetMs: budget };
    console.log(JSON.stringify({ name, ...report.measurements[name] }));
  }
  await application.evaluate(async () => {
    const runtime = global.controller.runtime;
    global.originalBenchmarkSnapshot = runtime.snapshot;
    runtime.snapshot = () => global.preparedBenchmarkCapture;
    await global.controller.open('quick');
  });
  await page.waitForFunction(() => document.querySelector('input[aria-label="搜索剪贴板"]').value === '');
  await page.getByRole('option').first().waitFor();
  const captureSamples = [];
  for (let index = 0; index < 34; index++) {
    const marker = 'renderer-capture-' + index;
    await application.evaluate((_electron, marker) => { global.preparedBenchmarkCapture = { text: marker + '\n' + 'Normal clipboard text 中文。'.repeat(20) }; }, marker);
    const elapsed = await page.evaluate(async marker => {
      const started = performance.now();
      await window.piDesktop.clipboard.historyV2.capture();
      await new Promise((resolve, reject) => {
        const check = () => {
          if ([...document.querySelectorAll('[role="option"]')].some(row => row.textContent.includes(marker))) requestAnimationFrame(() => requestAnimationFrame(resolve));
          else if (performance.now() - started > 10000) reject(Error('Capture did not render'));
          else requestAnimationFrame(check);
        }; check();
      });
      return performance.now() - started;
    }, marker);
    if (index >= 4) captureSamples.push(elapsed);
  }
  report.measurements.preparedTextCapture = { samples: captureSamples, p95Ms: [...captureSamples].sort((a, b) => a - b)[Math.ceil(captureSamples.length * .95) - 1], budgetMs: 200, scope: 'Prepared text snapshot through real capture admission, SQLite commit, notification, IPC query and rendered row. Excludes OS change delivery and clipboard snapshot reading.' };
  console.log(JSON.stringify({ name: 'preparedTextCapture', ...report.measurements.preparedTextCapture }));
  report.budgetsPassed = Object.values(report.measurements).every(value => value.p95Ms <= value.budgetMs);
  report.memoryFinal = await application.evaluate(({ app }) => app.getAppMetrics().map(({ type, memory }) => ({ type, memory })));
  report.memoryScope = 'Raw Electron MemoryInfo fields per owned process; peakWorkingSetSize is each process lifetime peak, not a simultaneous aggregate peak';
} catch (error) { report.error = String(error); throw error; }
finally {
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  if (application) { await application.evaluate(() => { if (global.originalBenchmarkSnapshot) global.controller.runtime.snapshot = global.originalBenchmarkSnapshot; return global.shutdown?.(); }).catch(() => {}); await application.close(); }
}
assert.equal(report.budgetsPassed, true, 'Renderer search p95 exceeds approved budget; see report');
