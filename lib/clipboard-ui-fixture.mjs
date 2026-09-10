import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

/** Isolated browser bundle of the actual clipboard components; never touches .next. */
export async function buildClipboardUI(directory, { draftTesting = false } = {}) {
  await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
  await writeFile(path.join(directory, "css.cjs"), `module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))`);
  await writeFile(path.join(directory, "entry.tsx"), `${draftTesting ? `import * as draftStore from ${JSON.stringify(path.join(repo, "components/clipboard/clipboard-draft-store.ts"))};window.testDraftStore=draftStore;` : ""}import React from "react";import {createRoot} from "react-dom/client";import {I18nProvider} from ${JSON.stringify(path.join(repo, "hooks/useI18n.tsx"))};import {ClipboardWorkspace} from ${JSON.stringify(path.join(repo, "components/clipboard/ClipboardWorkspace.tsx"))};if(!localStorage.getItem("pi-locale"))localStorage.setItem("pi-locale","zh-CN");createRoot(document.getElementById("root")).render(<I18nProvider><ClipboardWorkspace surface={new URLSearchParams(location.search).get("surface")||"manager"}/></I18nProvider>);`);
  const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(directory, "entry.tsx"), output: { path: directory, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { parser: { javascript: { dynamicImportMode: "eager" } }, rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") }, { test: /\.css$/, use: path.join(directory, "css.cjs") }] } });
  await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
  return { bundle: await readFile(path.join(directory, "bundle.js")), css: await readFile(path.join(repo, "components/clipboard/ClipboardWorkspace.module.css"), "utf8") };
}
// Use the production theme tokens so visual acceptance cannot drift to a test-only palette.
const globalStyles = await readFile(path.join(repo, "app/globals.css"), "utf8");
const light = globalStyles.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1];
const dark = globalStyles.match(/html\.dark\s*\{([\s\S]*?)\n\}/)?.[1];
if (!light || !dark) throw new Error("Production clipboard theme tokens were not found");
export const clipboardTheme = `:root{${light}}:root.dark{${dark}}*{box-sizing:border-box}body{margin:0;background:var(--bg);font:14px Inter,'Microsoft YaHei UI',system-ui,sans-serif}`;
