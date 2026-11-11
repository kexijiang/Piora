import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, delimiter, join, resolve } from 'node:path';
import { createJiti } from 'jiti';
import { _electron } from 'playwright-core';

// Explicit real-device test: rotates the current scene and restores its angle.
// It interrupts only this test's capture session, never another application's.
const args = Object.fromEntries(process.argv.slice(2).map(value => { const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)]; }));
assert.ok(args['--hdc'] && args['--serial'], 'Pass --hdc=path --serial=authorized-device');
const require = createRequire(import.meta.url), repo = resolve(import.meta.dirname, '..');
const directory = resolve(args['--output'] ?? `.verification/mirror-rewrite/lifecycle-${Date.now()}`);
await mkdir(directory, { recursive: true });
const jiti = createJiti(import.meta.url);
const { MirrorCaptureSession } = await jiti.import('../lib/harmony/mirror/capture-session.ts');
const { disableHypiumTelemetry } = await jiti.import('../lib/harmony/hypium-backend.ts');
disableHypiumTelemetry();
const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
process.env[pathKey] = dirname(args['--hdc']) + delimiter + process.env[pathKey];
const imported = await import('hypium-driver'), hypium = imported.default ?? imported;
const execute = promisify(execFile);
const run = async (argv, _operation, signal, timeout = 8000) => ({ ...await execute(args['--hdc'], argv,
  { encoding: 'buffer', windowsHide: true, signal, timeout, maxBuffer: 2 * 1024 * 1024 }), exitCode: 0, durationMs: 0 });
await writeFile(join(directory, 'loader.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;`);
await writeFile(join(directory, 'worker.ts'), `import ${JSON.stringify(join(repo, 'lib/harmony/mirror/video.worker.ts'))};`);
await writeFile(join(directory, 'entry.ts'), `window.events=[];const c=document.querySelector('canvas'),w=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});window.worker=w;w.onmessage=({data})=>window.events.push({...data,at:performance.now()});const canvas=c.transferControlToOffscreen();w.postMessage({type:'start',canvas,serial:${JSON.stringify(args['--serial'])},generation:1},[canvas]);`);
const { webpack } = require('next/dist/compiled/webpack/webpack.js');
const compiler = webpack({ mode: 'development', target: 'web', devtool: false, entry: join(directory, 'entry.ts'), output: { path: directory, filename: 'bundle.js' },
  resolve: { extensions: ['.ts', '.js'], modules: [join(repo, 'node_modules')] }, module: { rules: [{ test: /\.ts$/, exclude: /node_modules/, use: join(directory, 'loader.cjs') }] } });
await new Promise((done, fail) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? fail(error ?? new Error(stats.toString({ all: false, errors: true }))) : done())));
let capture, driver, originalRotation, electron, page;
const evidence = { boundary: 'real phone + native capture + production Worker in isolated Electron; no Next/authentication, no physical cable removal', steps: [], errors: [] };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/harmony/video') {
      if (request.method === 'POST') { capture?.requestKeyframe(); response.end('{}'); return; }
      if (!capture) { response.statusCode = 503; response.end(); return; }
      const abort = new AbortController(); response.on('close', () => abort.abort());
      const connection = capture.subscribe(abort.signal), reader = connection.stream.getReader();
      response.writeHead(200, { 'Content-Type': 'application/vnd.piora.harmony-stream', 'X-Harmony-Generation': '1' });
      try { while (!abort.signal.aborted) { const next = await reader.read(); if (next.done) break; if (!response.write(next.value)) await new Promise(done => { const ready = () => { response.off('drain', ready); response.off('close', ready); done(); }; response.once('drain', ready); response.once('close', ready); }); } }
      finally { await reader.cancel().catch(() => {}); await connection.close(); response.end(); } return;
    }
    if (/^\/[\w.-]+\.js$/.test(url.pathname)) { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(join(directory, url.pathname.slice(1)))); return; }
    response.setHeader('Content-Type', 'text/html'); response.end('<style>body{margin:0;background:#111}canvas{width:100vw;height:100vh;object-fit:contain}</style><canvas></canvas><script src="/bundle.js"></script>');
  } catch (error) { evidence.errors.push(String(error)); if (!response.headersSent) response.statusCode = 500; response.end(); }
});
const startCapture = () => MirrorCaptureSession.start(args['--serial'], run, () => {});
const frame = async landscape => {
  await page.waitForFunction(wide => { const c = document.querySelector('canvas'); return c.width > 100 && c.height > 100 && (c.width > c.height) === wide; }, landscape, { timeout: 30000 });
  return page.evaluate(() => { const c = document.querySelector('canvas'); return { width: c.width, height: c.height }; });
};
try {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  driver = await hypium.UiDriver.connect({ deviceSn: args['--serial'], hdcExecTimeout: 15000, rpcTimeout: 15000 });
  originalRotation = await driver.getDisplayRotation();
  capture = await startCapture();
  await writeFile(join(directory, 'electron.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});app.whenReady().then(()=>new BrowserWindow({width:900,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}}).loadURL('about:blank'));app.on('window-all-closed',()=>app.quit());`);
  electron = await _electron.launch({ executablePath: require('electron'), args: [join(directory, 'electron.cjs')], timeout: 30000 });
  page = await electron.firstWindow({ timeout: 30000 }); page.on('pageerror', error => evidence.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  evidence.steps.push({ step: 'initial', rotation: originalRotation, ...await frame(originalRotation % 2 === 1) });
  const rotation = originalRotation % 2 === 0 ? 1 : 0;
  await driver.setDisplayRotation(rotation);
  const rotatedFrame = await frame(rotation % 2 === 1);
  assert.equal(await driver.getDisplayRotation(), rotation);
  evidence.steps.push({ step: 'rotated', rotation, ...rotatedFrame });
  await page.screenshot({ path: join(directory, 'rotated.png') });
  await driver.setDisplayRotation(originalRotation);
  evidence.steps.push({ step: 'restored', rotation: originalRotation, ...await frame(originalRotation % 2 === 1) });
  const interruptedAt = await page.evaluate(() => performance.now());
  const previous = capture; capture = undefined; await previous.close();
  await page.waitForFunction(since => window.events.some(event => event.at >= since && event.type === 'state' && event.state === 'recovering'), interruptedAt, { timeout: 15000 });
  capture = await startCapture();
  await page.waitForFunction(since => window.events.some(event => event.at >= since && event.type === 'statistics' && event.statistics.presentedFps > 0 && event.statistics.reconnects > 0), interruptedAt, { timeout: 30000 });
  evidence.steps.push({ step: 'capture-reconnected', ...await frame(originalRotation % 2 === 1) });
  await page.screenshot({ path: join(directory, 'reconnected.png') });
  evidence.events = await page.evaluate(() => window.events);
} catch (error) { evidence.errors.push(String(error)); }
finally {
  if (driver && originalRotation !== undefined) await driver.setDisplayRotation(originalRotation).catch(error => evidence.errors.push(`Restore: ${error}`));
  await driver?.disconnect().catch(error => evidence.errors.push(`Driver cleanup: ${error}`));
  await electron?.close().catch(error => evidence.errors.push(`Electron cleanup: ${error}`));
  await capture?.close().catch(error => evidence.errors.push(`Capture cleanup: ${error}`));
  server.closeAllConnections(); await new Promise(done => server.close(done));
}
evidence.passed = evidence.steps.length === 4 && evidence.errors.length === 0;
await writeFile(join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ directory, passed: evidence.passed, steps: evidence.steps, errors: evidence.errors }));
process.exitCode = evidence.passed ? 0 : 1;
