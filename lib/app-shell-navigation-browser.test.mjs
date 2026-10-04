import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const appShellPath = path.join(repo, "components/AppShell.tsx");
const appShell = ts.createSourceFile(appShellPath, await readFile(appShellPath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const functions = new Map();
const callbacks = new Map();
function collect(node) {
  if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node.getText(appShell));
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
    const callback = node.initializer.arguments[0];
    if (callback && ts.isArrowFunction(callback)) callbacks.set(node.name.text, callback.getText(appShell));
  }
  ts.forEachChild(node, collect);
}
collect(appShell);
for (const name of ["handleSelectSession", "handleViewFullHistory", "closeFullHistory", "navigateHistory", "openRelatedHistory"]) {
  assert.ok(callbacks.has(name), `run AppShell's actual ${name} callback`);
}

test("selection URLs survive installed Next commits and late router actions without remounting the selected chat", { timeout: 120000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-selection-router-"));
  const origin = "http://localhost:38372";
  let browser;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    const historyHelpers = ["getSelectionHistoryState", "replaceUrlWithoutNextNavigation", "pushUrlWithoutNextNavigation"]
      .filter(name => functions.has(name)).map(name => functions.get(name)).join("\n");
    await writeFile(path.join(directory, "entry.tsx"), `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import AppRouter from 'next/dist/client/components/app-router';
      import {createInitialRouterState} from 'next/dist/client/components/router-reducer/create-initial-router-state';
      import {createMutableActionQueue} from 'next/dist/client/components/app-router-instance';
      import {dispatchAppRouterAction} from 'next/dist/client/components/use-action-queue';
      import {ACTION_RESTORE} from 'next/dist/client/components/router-reducer/router-reducer-types';
      import {useSearchParams} from 'next/navigation';
      import {historyLocationUrl} from ${JSON.stringify(path.join(repo, "lib/history-navigation.ts"))};
      ${historyHelpers}
      window.next={};
      window.nativeWrites=[];
      for(const method of ['pushState','replaceState']){
        const original=window.history[method].bind(window.history);
        if(method==='replaceState') window.setNativeFixtureHistoryState=(data)=>original(data,'',window.location.href);
        window.history[method]=function(data,title,url){
          const result=original(data,title,url);
          window.nativeWrites.push({method,url:String(url)});
          return result;
        };
      }
      window.mounts=0;
      window.unmounts=0;
      window.calls={};
      const sessions=[{id:'owned-session-one',cwd:${JSON.stringify("F:\\Piora")}},{id:'owned-session-two',cwd:${JSON.stringify("F:\\Piora")}}];
      const record=(name,value)=>{(window.calls[name]??=[]).push(value);};
      function ChatProbe(){
        React.useEffect(()=>{window.mounts++;return()=>{window.unmounts++;};},[]);
        return <textarea aria-label="Owned composer" defaultValue="retained draft"/>;
      }
      function SelectionProbe(){
        const searchParams=useSearchParams();
        const [selectedSession,selectSession]=React.useState(sessions[0]);
        const [sessionKey,setKey]=React.useState(0);
        const selectedSessionIdRef=React.useRef(selectedSession.id);
        selectedSessionIdRef.current=selectedSession.id;
        const suppressCwdBumpRef=React.useRef(false);
        const chatInputRef=React.useRef({focus(){record('focus',true);}});
        const historyReturnFocus=React.useRef(null);
        const isMobile=false;
        const setSelectedSession=(value)=>{record('setSelectedSession',value.id);selectSession(value);};
        const setSessionKey=(value)=>{record('setSessionKey',true);setKey(value);};
        const setSettingsDialogOpen=(v)=>record('setSettingsDialogOpen',v);
        const setHistoryDialogOpen=(v)=>record('setHistoryDialogOpen',v);
        const setHistoryLocation=(v)=>record('setHistoryLocation',v);
        const setSelectedRoom=(v)=>record('setSelectedRoom',v);
        const setActiveTopPanel=(v)=>record('setActiveTopPanel',v);
        const setNewSessionCwd=(v)=>record('setNewSessionCwd',v);
        const setNewSessionInitialModel=(v)=>record('setNewSessionInitialModel',v);
        const setNewSessionInitialPrompt=(v)=>record('setNewSessionInitialPrompt',v);
        const setFocusedEntryId=(v)=>record('setFocusedEntryId',v);
        const setSystemPrompt=(v)=>record('setSystemPrompt',v);
        const setInitialSessionRestored=(v)=>record('setInitialSessionRestored',v);
        const setSidebarOpen=(v)=>record('setSidebarOpen',v);
        const handleSelectSession=${callbacks.get("handleSelectSession")};
        const handleViewFullHistory=${callbacks.get("handleViewFullHistory")};
        const closeFullHistory=${callbacks.get("closeFullHistory")};
        const navigateHistory=${callbacks.get("navigateHistory")};
        const openRelatedHistory=${callbacks.get("openRelatedHistory")};
        window.readSelection=()=>({id:selectedSession.id,cwd:selectedSession.cwd,sessionKey,mounts:window.mounts,unmounts:window.unmounts});
        window.readNextSession=()=>searchParams.get('session');
        React.useEffect(()=>{window.ready=true;},[]);
        return <><button onClick={()=>handleSelectSession(sessions[0])}>Current owned session</button>
          <button onClick={()=>handleSelectSession(sessions[1])}>Other owned session</button>
          <button onClick={handleViewFullHistory}>Open history</button>
          <button onClick={()=>navigateHistory('owned-leaf','owned-entry')}>History entry</button>
          <button onClick={closeFullHistory}>Close history</button>
          <button onClick={()=>openRelatedHistory(sessions[0].id)}>Related owned history</button>
          <button onClick={()=>window.laterNextCommit()}>Later Next commit</button>
          <ChatProbe key={sessionKey}/></>;
      }
      const rsc=<SelectionProbe/>;
      const tree=['',{children:['__PAGE__',{}]},null,null,16];
      const initial=createInitialRouterState({navigatedAt:Date.now(),location:window.location,
        initialRSCPayload:{c:['',''],q:'',i:false,S:false,d:600,f:[[tree,[rsc,{children:['fixture-page',{}]}],null,false]]}});
      const queue=createMutableActionQueue(initial);
      const originalAction=queue.action;
      let holdNextAction=false;
      queue.action=async(state,action)=>{
        const result=await originalAction(state,action);
        if(holdNextAction){
          holdNextAction=false;
          window.heldActionCanonicalUrl=result.canonicalUrl;
          await new Promise(resolve=>{window.releaseOldAction=resolve;});
          window.oldActionFinished=true;
        }
        return result;
      };
      window.readRouter=()=>({canonicalUrl:queue.state.canonicalUrl,pending:Boolean(queue.pending),sameRsc:queue.state.cache.rsc===rsc});
      window.laterNextCommit=()=>dispatchAppRouterAction({type:ACTION_RESTORE,
        url:new URL(queue.state.canonicalUrl,window.location.origin),historyState:window.history.state.__PRIVATE_NEXTJS_INTERNALS_TREE});
      window.holdOldRestore=()=>{
        holdNextAction=true;
        dispatchAppRouterAction({type:ACTION_RESTORE,url:new URL('/',window.location.origin),historyState:window.history.state.__PRIVATE_NEXTJS_INTERNALS_TREE});
      };
      const GlobalError=({error})=><div role="alert">{error.message}</div>;
      createRoot(document.getElementById('root')).render(<AppRouter actionQueue={queue} globalErrorState={[GlobalError,null]}/>);
    `);
    const compiler = webpack({
      mode: "production", target: "web", devtool: false,
      optimization: { minimize: false },
      entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js", publicPath: `${origin}/` },
      plugins: [new webpack.DefinePlugin({
        "process.env": JSON.stringify({ NODE_ENV: "production", __NEXT_ROUTER_BASEPATH: "", __NEXT_CLIENT_ROUTER_FILTER_ENABLED: false }),
        "process.env.TURBOPACK": false,
        "process.env.__NEXT_DEV_SERVER": false,
        "process.env.__NEXT_EXPOSE_TESTING_API": false,
      })],
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: {
        "react$": require.resolve("next/dist/compiled/react"),
        "react/jsx-runtime$": require.resolve("next/dist/compiled/react/jsx-runtime"),
        "react-dom$": require.resolve("next/dist/compiled/react-dom"),
        "react-dom/client$": require.resolve("next/dist/compiled/react-dom/client"),
        "react-server-dom-webpack/client$": require.resolve("next/dist/compiled/react-server-dom-webpack/client.browser"),
      } },
      module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }] },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route(`${origin}/**`, async route => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/sessions/owned-session-one") return route.fulfill({ json: { info: { id: "owned-session-one", cwd: "F:\\Piora" } } });
      if (pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(pathname))) });
      return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><head><meta charset="utf-8"><title>Owned router fixture</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>' });
    });
    await page.goto(origin);
    await page.waitForFunction(() => window.ready && window.nativeWrites.length > 0);
    const baseline = await page.evaluate(() => window.readSelection());
    await page.getByRole("button", { name: "Current owned session", exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get("session"), baseline.id);
    await page.waitForFunction(() => !window.readRouter().pending);
    const writes = await page.evaluate(() => window.nativeWrites.length);
    await page.getByRole("button", { name: "Later Next commit", exact: true }).click();
    await page.waitForFunction(count => window.nativeWrites.length > count && !window.readRouter().pending, writes);
    t.diagnostic(`installed Next later commit: ${JSON.stringify(await page.evaluate(() => ({router:window.readRouter(),selection:window.readSelection(),lastWrite:window.nativeWrites.at(-1)})))}`);
    assert.equal(new URL(page.url()).searchParams.get("session"), baseline.id, "a real Next HistoryUpdater commit must retain the selected session URL");
    assert.equal(await page.evaluate(() => window.readNextSession()), baseline.id, "Next useSearchParams observes the same selection URL");
    assert.deepEqual(await page.evaluate(() => window.readSelection()), baseline, "same-session URL sync preserves selection, cwd and ChatWindow key");
    assert.equal(await page.getByRole("textbox", { name: "Owned composer" }).inputValue(), "retained draft");
    assert.equal(await page.evaluate(() => window.readRouter().sameRsc), true, "native restore retains the rendered cache entry");

    // Vary stored browser data; subsequent selection still runs the unchanged
    // AppShell callback through Next's actual patched native method.
    for (const state of ["empty", "legacy-marker"]) {
      await page.evaluate(kind => window.setNativeFixtureHistoryState(kind === "empty" ? null : {
        ...window.history.state, _N: true, ownedCustomData: "retained",
      }), state);
      await page.getByRole("button", { name: "Current owned session", exact: true }).click();
      await page.waitForFunction(() => !window.readRouter().pending && window.history.state.__NA === true);
      assert.equal(new URL(page.url()).searchParams.get("session"), baseline.id);
      assert.equal(await page.evaluate(() => window.readRouter().canonicalUrl), `/?session=${baseline.id}`);
      assert.deepEqual(await page.evaluate(() => window.readSelection()), baseline);
      assert.equal(await page.evaluate(() => window.readRouter().sameRsc), true);
      if (state === "legacy-marker") assert.equal(await page.evaluate(() => window.history.state.ownedCustomData), "retained");
    }

    await page.evaluate(() => window.holdOldRestore());
    await page.waitForFunction(() => Boolean(window.releaseOldAction));
    assert.equal(await page.evaluate(() => window.heldActionCanonicalUrl), "/", "hold an actual older restore result before selection changes");
    await page.getByRole("button", { name: "Other owned session", exact: true }).click();
    await page.waitForFunction(() => window.readSelection().id === "owned-session-two" && !window.readRouter().pending);
    const switched = await page.evaluate(() => window.readSelection());
    assert.equal(switched.sessionKey, baseline.sessionKey + 1);
    assert.equal(switched.mounts, baseline.mounts + 1);
    await page.evaluate(() => window.releaseOldAction());
    await page.waitForFunction(() => window.oldActionFinished);
    await page.getByRole("button", { name: "Later Next commit", exact: true }).click();
    await page.waitForFunction(() => window.readRouter().canonicalUrl === "?session=owned-session-two" || window.readRouter().canonicalUrl === "/?session=owned-session-two");
    assert.equal(new URL(page.url()).searchParams.get("session"), switched.id, "a discarded old action cannot erase the new selection URL");

    await page.getByRole("button", { name: "Open history", exact: true }).click();
    await page.waitForFunction(() => window.readRouter().canonicalUrl.includes("view=history"));
    assert.equal(new URL(page.url()).searchParams.get("session"), switched.id);
    await page.getByRole("button", { name: "History entry", exact: true }).click();
    await page.waitForFunction(() => window.readRouter().canonicalUrl.includes("historyEntry=owned-entry"));
    await page.goBack();
    await page.waitForFunction(() => !window.readRouter().pending && !new URL(window.location.href).searchParams.has("historyEntry"));
    assert.equal(new URL(page.url()).searchParams.get("view"), "history");
    await page.getByRole("button", { name: "Close history", exact: true }).click();
    await page.waitForFunction(() => !window.readRouter().canonicalUrl.includes("view=history"));
    assert.deepEqual(await page.evaluate(() => window.readSelection()), switched, "history navigation does not remount the selected chat");
    await page.getByRole("button", { name: "Related owned history", exact: true }).click();
    await page.waitForFunction(id => window.readSelection().id === id && window.readRouter().canonicalUrl.includes("view=history"), baseline.id);
    assert.equal(new URL(page.url()).searchParams.get("session"), baseline.id);
    assert.equal(await page.evaluate(() => window.history.state.__NA), true, "Next owns the stored history marker");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("piora-selection-router-"));
    await rm(directory, { recursive: true, force: true });
  }
});
