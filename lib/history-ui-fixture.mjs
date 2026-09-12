import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

/** Browser acceptance bundles the production workbench without changing .next. */
export async function buildHistoryUI(directory) {
  await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
  await writeFile(path.join(directory, "entry.tsx"), `import React,{useState} from "react";import {createRoot} from "react-dom/client";import {I18nProvider} from ${JSON.stringify(path.join(repo, "hooks/useI18n.tsx"))};import {SessionHistoryWorkbench} from ${JSON.stringify(path.join(repo, "components/SessionHistoryWorkbench.tsx"))};
    function Fixture(){const [open,setOpen]=useState(true);const [location,setLocation]=useState({open:true,leafId:null,entryId:null});const [leaf,setLeaf]=useState('a2');const controls={busy:false,leafId:leaf,entryIds:['q2','a2'],switchBranch:async id=>{setLeaf(id);return true},forkQuestion:async(id,draft)=>{window.forked={id,draft};return false},focusEntry:id=>{window.focused=id}};
    return <><div style={{height:'100%',visibility:open?'hidden':'visible'}} inert={open}><textarea aria-label="主对话草稿" defaultValue="尚未发送的草稿"/><button onClick={()=>{setLocation({open:true,leafId:null,entryId:null});setOpen(true)}}>完整历史</button></div>{open?<SessionHistoryWorkbench sessionId="fixture" sessionName="修复历史界面" location={location} controls={controls} onClose={()=>setOpen(false)} onLocation={(leafId,entryId)=>setLocation({open:true,leafId,entryId})} onRelated={()=>{}}/>:null}</>}
    localStorage.setItem('pi-locale','zh-CN');createRoot(document.getElementById('root')).render(<I18nProvider><Fixture/></I18nProvider>);`);
  const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo }, fallback: { fs: false, path: false } }, module: { parser: { javascript: { dynamicImportMode: "eager" } }, rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
  const css = await Promise.all(["app/globals.css", "components/SessionHistoryWorkbench.css"].map(file => readFile(path.join(repo, file), "utf8")));
  return { bundle: await readFile(path.join(directory, "bundle.js")), css: css.join("\n") };
}
