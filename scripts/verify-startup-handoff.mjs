// Exercise the production startup barrier with a real pending Electron navigation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const output = path.resolve('.verification/startup-handoff');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, 'run-'));
const main = await readFile(path.resolve('desktop/src/main.ts'), 'utf8');
const source = main.slice(main.indexOf('function createStartupWindow('), main.indexOf('type SmokeRendererState'));
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const reportPath = path.join(directory, 'report.json');
const script = path.join(directory, 'main.cjs');
await writeFile(script, `
const {app,BrowserWindow}=require('electron');const {createServer}=require('node:http');
const {join,resolve}=require('node:path');const {pathToFileURL}=require('node:url');const {writeFileSync}=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});
const PORTABLE_SMOKE_TEST=false,STARTUP_MEDIA_TIMEOUT_MS=60000,STARTUP_CONTINUE_URL='piora-startup://continue';
const readLastLaunchedVersion=()=>null,loadStartupMedia=()=>({video:'fixture'}),createStartupDocument=()=>'<title>Fixture</title>';
let window,base,pendingResponse,requestedResolve;
const requested=new Promise(resolve=>requestedResolve=resolve);
function createMainWindowShell(){window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});window.loadFile=()=>window.loadURL(base+'/slow');return {window,initialState:{maximized:false}};}
${compiled}
setTimeout(()=>{console.error('Native startup handoff probe timed out');app.exit(1)},30000).unref();
app.whenReady().then(async()=>{
 const server=createServer((req,res)=>{if(req.url==='/slow'){pendingResponse=res;requestedResolve()}else{res.end('<title>Application ready</title>')}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 const startup=createStartupWindow({warn(){}});await requested;
 window.webContents.emit('will-navigate',{preventDefault(){}},STARTUP_CONTINUE_URL);
 await startup.finished;
 await window.loadURL(base+'/app');
 if(window.webContents.getURL()!==base+'/app')throw Error('App navigation was displaced');
 pendingResponse?.end('<title>Late intro</title>');
 await new Promise(resolve=>setTimeout(resolve,300));
 if(window.webContents.getURL()!==base+'/app')throw Error('Late intro displaced app navigation');
 writeFileSync(${JSON.stringify(reportPath)},JSON.stringify({realElectron:true,pendingNavigationCancelled:true,lateIntroCannotReplaceApp:true,systemClipboardWritten:false}));
 window.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const code = await new Promise((done, reject) => {
  const child = spawn(require('electron'), [script], { env, windowsHide: true, stdio: 'pipe' });
  child.stderr.on('data', bytes => process.stderr.write(bytes));
  child.on('error', reject); child.on('close', done);
});
assert.equal(code, 0); console.log(await readFile(reportPath, 'utf8'));
