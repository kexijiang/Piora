import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const { webpack } = require('next/dist/compiled/webpack/webpack.js');
const repo = path.resolve(import.meta.dirname, '../..');

test('workspace menu hides the native browser through layout changes and restores the same page', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'piora-tool-menu-'));
  let browser;
  try {
    await writeFile(path.join(directory, 'ts.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, 'css.cjs'), `module.exports=function(s){const prefix=require('node:path').basename(this.resourcePath).replace(/\\W/g,'_');const names=Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],prefix+'_'+m[1]]));const css=s.replace(/\\.([a-zA-Z][\\w-]*)/g,(_,n)=>'.'+names[n]);return 'const style=document.createElement("style");style.textContent='+JSON.stringify(css)+';document.head.append(style);export default '+JSON.stringify(names)}`);
    // Real workspace, browser and viewport queue; unrelated panels stay inert.
    const stubs = path.join(directory, 'stubs.tsx');
    await writeFile(stubs, 'export const FileExplorer=()=>null;export const FileViewer=()=>null;export const TabBar=()=>null;export const ReviewPanel=()=>null;export const CommandPanel=()=>null;export const SafeHarmonyPanel=()=>null;export const AutomationPanel=()=>null;export const SSHPanel=()=>null;export const DesignToHarmonyPanel=()=>null;export default ()=>()=>null;');
    await writeFile(path.join(directory, 'entry.tsx'), `
import {useState} from 'react';import {createRoot} from 'react-dom/client';
import {I18nProvider} from '@/hooks/useI18n';import {RightPanel} from '@/components/workspace/RightPanel';
const noop=()=>{};function App(){const[tab,setTab]=useState('browser');const[active,setActive]=useState(true);
return <I18nProvider><button id='outside'>Outside</button><button onClick={()=>setActive(v=>!v)}>Toggle panel</button>
<div id='file-panel' style={{height:'calc(100vh - 40px)',display:active?'flex':'none',flexDirection:'column'}}><RightPanel activeTab={tab} onActiveTabChange={setTab} active={active} maximized={false} onMaximizedChange={noop} onClosePanel={()=>setActive(false)} cwd={null} refreshKey={0} fileTabs={[]} activeFileTabId={null} canReopenClosedFileTab={false} onSelectFileTab={noop} onCloseFileTab={noop} onCloseOtherFileTabs={noop} onCloseFileTabsToRight={noop} onMoveFileTab={noop} onReopenClosedFileTab={noop} onOpenFile={noop} onDirtyChange={noop} onRefresh={noop} onMention={noop} onMentions={noop} onMentionLines={noop} selectedAutomationId={null} sessionId='fixture' capabilities={null}/></div></I18nProvider>}
createRoot(document.getElementById('root')).render(<App/>);`);
    const alias = Object.fromEntries(['../FileExplorer', '../FileViewer', '../TabBar', './ReviewPanel', './CommandPanel', './HarmonyPanel', '../AutomationPanel', './SSHPanel', './design-to-harmony/DesignToHarmonyPanel', 'next/dynamic'].map(name => [name + '$', stubs]));
    const compiler = webpack({ mode: 'development', target: 'web', devtool: false, entry: path.join(directory, 'entry.tsx'), output: { path: directory, filename: 'bundle.js' }, resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [path.join(repo, 'node_modules')], alias: { ...alias, '@': repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, 'ts.cjs') }, { test: /\.css$/, use: path.join(directory, 'css.cjs') }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, 'app/globals.css'), 'utf8')).replace(/^@import.*$/gm, '');
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true });
    for (const locale of ['zh-CN', 'en']) {
      const page = await browser.newPage({ viewport: { width: 700, height: 750 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(locale => {
        localStorage.setItem('pi-locale', locale);
        localStorage.setItem('piora-desktop-browser-onboarding-v1', 'done');
        window.nativeActions = []; window.nativeViewports = [];
        const state = { sessionId: 'fixture', activeTabId: 'native-tab', url: 'https://example.test/kept-page', title: 'Existing browser tab', tabs: [{ id: 'native-tab', title: 'Existing browser tab', url: 'https://example.test/kept-page' }], canGoBack: false, canGoForward: false, loading: false };
        window.emitNativeState = () => { state.url = 'https://example.test/redirected'; window.nativeStateListener?.({ ...state }); };
        window.piDesktop = { browser: {
          setViewport: async (bounds, visible) => {
            window.nativeViewports.push({ ...bounds, visible }); window.nativeVisible = visible;
            if (visible && window.delayNextShow) { window.delayNextShow = false; await new Promise(resolve => { window.finishShow = resolve; }); }
          },
          action: async input => { window.nativeActions.push(input); return { ...state }; },
          getState: async () => ({ ...state }),
          onState: listener => { window.nativeStateListener = listener; return () => { window.nativeStateListener = null; }; },
          onDownload: () => () => {},
          importChromeBookmarks: async () => ({ bookmarkCount: 0, profiles: [] }),
        } };
      }, locale);
      await page.route('https://tool-menu.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.endsWith('.js')) return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(directory, path.basename(pathname))) });
        if (pathname.startsWith('/fonts/')) return route.fulfill({ status: 404, body: '' });
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset='utf-8'><style>${css}</style><div id='root'></div><script src='/bundle.js'></script>` });
      });
      await page.goto('https://tool-menu.test/');
      const trigger = page.getByRole('button', { name: locale === 'zh-CN' ? '打开工具' : 'Open tool', exact: true });
      const menu = page.getByRole('menu');
      const nativeVisible = visible => page.waitForFunction(expected => window.nativeVisible === expected, visible);
      await nativeVisible(true);
      await page.evaluate(() => { window.delayNextShow = true; window.dispatchEvent(new Event('resize')); });
      await page.waitForFunction(() => typeof window.finishShow === 'function');
      const initialActions = await page.evaluate(() => window.nativeActions);
      await trigger.click(); await menu.waitFor();
      assert.equal(await page.evaluate(() => window.nativeVisible), false, 'opening the menu hides the native view immediately, even with a pending resize');
      assert.equal(await menu.getByRole('menuitem').count(), 7);
      for (const item of await menu.getByRole('menuitem').all()) assert.equal(await item.isVisible(), true);
      const mark = await page.evaluate(() => { window.finishShow(); return window.nativeViewports.length; });
      await page.setViewportSize({ width: 520, height: 660 });
      await page.evaluate(() => window.emitNativeState());
      await page.waitForTimeout(300); // Includes the 250ms position reconciliation.
      assert.equal(await page.evaluate(index => window.nativeViewports.slice(index).some(call => call.visible), mark), false, 'late replies, resizing and page events cannot reshow the browser over the menu');
      await mkdir(path.join(repo, '.verification/tool-menu'), { recursive: true });
      await page.screenshot({ path: path.join(repo, `.verification/tool-menu/${locale}.png`) });
      await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' }); await nativeVisible(true);
      await trigger.click(); await nativeVisible(false);
      await page.locator('#outside').click(); await nativeVisible(true);
      await trigger.click(); await nativeVisible(false); await trigger.click(); await nativeVisible(true);
      assert.deepEqual(await page.evaluate(() => window.nativeActions), initialActions, 'opening and closing the menu never reloads or replaces the browser tab');
      await trigger.click();
      await menu.getByRole('menuitem', { name: locale === 'zh-CN' ? '终端' : 'Terminal', exact: true }).click();
      await nativeVisible(false);
      await page.getByRole('tab', { name: locale === 'zh-CN' ? '浏览器' : 'Browser', exact: true }).click();
      await nativeVisible(true);
      await trigger.click(); await nativeVisible(false);
      await page.getByRole('button', { name: 'Toggle panel', exact: true }).click(); await menu.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Toggle panel', exact: true }).click(); await nativeVisible(true);
      assert.equal(await menu.count(), 0, 'reopening the panel cannot restore a stale menu');
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});
