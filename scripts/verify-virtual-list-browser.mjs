import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const webpackBundle = require("next/dist/compiled/webpack/webpack");

// Exercise the real component in a browser without Next dev compilation or user data.
const baseline = Boolean(process.env.PIORA_TEST_BASELINE);
const output = path.resolve(baseline ? ".verification/virtual-list-baseline" : ".verification/virtual-list");
mkdirSync(output, { recursive: true });
const session = "piora-virtual-list-regression";
const executable = process.env.AGENT_BROWSER_EXECUTABLE || "agent-browser";
const results = [];
function command(args, input) {
  const logPath = path.join(output, "command.json");
  const log = openSync(logPath, "w");
  const errors = openSync(path.join(output, "command-error.log"), "w");
  let failure;
  try {
    execFileSync(executable, ["--session", session, "--json", ...args], {
      encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", log, errors],
      windowsHide: true, timeout: 40_000,
    });
  } catch (error) { failure = error; }
  finally { closeSync(log); closeSync(errors); }
  const raw = readFileSync(logPath, "utf8");
  if (failure) throw new Error(`${args[0]}: ${raw || failure.message}`);
  const response = JSON.parse(raw);
  if (!response.success) throw new Error(response.error);
  return response.data;
}
const evaluate = (source) => command(["eval", "--stdin"], source).result;
const wait = (source) => {
  const deadline = Date.now() + 20_000;
  do {
    if (evaluate(`Boolean(${source})`)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${source}`);
};
function check(name, condition) {
  assert.ok(condition, name);
  results.push({ name, passed: true });
  console.log(`PASS ${name}`);
}

writeFileSync(path.join(output, "fixture.tsx"), `
    import React, { useRef, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { VirtualList } from '@/components/VirtualList';
    import { useVirtualRowToggle } from '@/components/VirtualRowState';
    const keys = Array.from({length:10000}, (_,i)=>String(i));
    function Row({id}) {
      const [expanded, setExpanded] = useVirtualRowToggle('details', false);
      return <article style={{padding:8}}>
        <button data-expand={id} aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>Row {id}</button>
        <p>{('Variable height content for row '+id+'. ').repeat(Number(id)%4+1)}</p>
        {expanded && <p>{'Expanded retained content. '.repeat(35)}</p>}
      </article>;
    }
    function App() {
      const scroller = useRef(null), list = useRef(null);
      const [hidden, setHidden] = useState(false);
      return <><button id="first" onClick={()=>list.current.scrollToKey('0')}>First</button>
        <button id="last" onClick={()=>list.current.scrollToKey('9999')}>Last</button>
        <button id="hide" onClick={()=>setHidden(!hidden)}>Toggle visibility</button>
        <div id="scroller" ref={scroller} style={{display:hidden?'none':'block',height:400,width:'100%',overflowY:'auto'}}>
          <div style={{padding:12}}><VirtualList keys={keys} estimate={160} initialTail
            scrollContainer={scroller} handleRef={list} renderItem={(id)=><Row id={id}/>} /></div>
        </div></>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  `);
writeFileSync(path.join(output, "tsx-loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=function(source){if(${baseline} && this.resourcePath.endsWith('VirtualList.tsx'))source=source.replace('if (!scrollContainer?.current)', 'if (!scrollContainer)');return ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText}`);
await new Promise((resolve, reject) => {
  const compiler = webpackBundle.webpack({
    mode: "production", target: "web", entry: path.join(output, "fixture.tsx"),
    output: { path: output, filename: "fixture.js" }, optimization: { minimize: false },
    resolve: { extensions: [".tsx", ".ts", ".js"], alias: { "@": process.cwd() } },
    module: { rules: [{ test: /\.tsx?$/, use: path.join(output, "tsx-loader.cjs") }] },
  });
  compiler.run((error, stats) => compiler.close(() => error || stats?.hasErrors()
    ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve()));
});
writeFileSync(path.join(output, "index.html"), '<!doctype html><html><meta charset="utf-8"><title>Virtual list regression</title><style>body{margin:16px;font:16px sans-serif}p{margin:8px 0}button{padding:8px}</style><div id="root"></div><script src="fixture.js"></script></html>');
try {
  command(["open", pathToFileURL(path.join(output, "index.html")).href]);
  wait(`document.querySelector('[data-expand="9999"]')`);
  const mounted = () => evaluate(`document.querySelectorAll('[data-virtual-key]').length`);
  check("initial mount resolves ancestor ref and bounds 10,000 rows", mounted() < 80);
  command(["click", "#first"]);
  wait(`document.querySelector('[data-expand="0"]')`);
  check("oldest row navigation stays bounded", mounted() < 80);
  command(["click", '[data-expand="0"]']);
  wait(`document.querySelector('[data-expand="0"]')?.getAttribute('aria-expanded')==='true'`);
  command(["click", "#last"]);
  wait(`!document.querySelector('[data-expand="0"]') && document.querySelector('[data-expand="9999"]')`);
  command(["click", "#first"]);
  wait(`document.querySelector('[data-expand="0"]')?.getAttribute('aria-expanded')==='true'`);
  check("expanded content survives DOM recycling", true);
  command(["set", "viewport", "390", "844"]);
  wait(`innerWidth===390 && document.querySelector('#scroller').clientWidth<390`);
  check("narrow width keeps bounded rows without horizontal overflow", mounted() < 80 && evaluate("document.documentElement.scrollWidth<=innerWidth"));
  command(["screenshot", path.join(output, "narrow.png")]);
  const beforeHidden = evaluate(`document.querySelector('#scroller').scrollHeight`);
  command(["click", "#hide"]);
  wait(`document.querySelector('#scroller').clientHeight===0`);
  command(["click", "#hide"]);
  wait(`document.querySelector('#scroller').clientHeight===400`);
  check("hidden rows keep valid measurements on restore", evaluate(`Math.abs(document.querySelector('#scroller').scrollHeight-${beforeHidden})<2`));
  evaluate(`document.querySelector('[data-expand="0"]').focus();document.querySelector('#scroller').scrollTop=document.querySelector('#scroller').scrollHeight`);
  wait(`document.querySelector('[data-expand="9999"]')`);
  check("offscreen keyboard focus survives recycling with bounded rows", evaluate(`document.activeElement?.getAttribute('data-expand')==='0'`) && mounted()<80);
  evaluate(`document.querySelector('#last').focus()`);
  wait(`!document.querySelector('[data-expand="0"]')`);
  check("released keyboard focus allows the old row to recycle", true);
  check("no uncaught browser errors", command(["errors"]).errors.length === 0);
  writeFileSync(path.join(output, "report.json"), JSON.stringify({ date:new Date().toISOString(), results, mounted:mounted() },null,2));
} catch (error) {
  try { command(["screenshot", path.join(output,"failure.png")]); } catch { /* Keep original error. */ }
  const mounted = evaluate(`document.querySelectorAll('[data-virtual-key]').length`);
  writeFileSync(path.join(output,"report.json"),JSON.stringify({date:new Date().toISOString(),results,mounted,error:String(error)},null,2));
  throw error;
} finally {
  if (!process.env.PIORA_KEEP_TEST_BROWSER) command(["close"]);
}
