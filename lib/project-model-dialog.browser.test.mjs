import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("project model dialog validates remembered folders and refreshes new models and distinct errors", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-project-model-ui-"));
  let browser;
  try {
    await writeFile(path.join(root, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(root, "entry.tsx"), `import {createRoot} from "react-dom/client";import {I18nProvider} from "@/hooks/useI18n";import {ProjectModelDialog} from "@/components/ProjectModelDialog";createRoot(document.getElementById("root")).render(<I18nProvider><ProjectModelDialog projectRoot="/remembered-empty-project" name="Existing project" onClose={()=>{}}/></I18nProvider>);`);
    const compiler = webpack({ mode: "development", target: "web", devtool: false, entry: path.join(root, "entry.tsx"), output: { path: root, filename: "bundle.js" }, resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules"), "node_modules"], alias: { "@": repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(root, "loader.cjs") }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    browser = await chromium.launch({ channel: "msedge", headless: true });
    const page = await browser.newPage();
    await page.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));
    const requests = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let modelBody = { modelList: [] }, invalidFolder = false;
    await page.route("http://project-model.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/cwd/validate") {
        requests.push("validate");
        assert.equal(route.request().postDataJSON().cwd, "/remembered-empty-project");
        return route.fulfill({ status: invalidFolder ? 400 : 200, json: invalidFolder ? { error: "Directory does not exist" } : { cwd: "/remembered-empty-project" } });
      }
      if (url.pathname === "/api/models") {
        requests.push("models");
        assert.equal(url.searchParams.get("refresh"), "1");
        return route.fulfill({ json: modelBody });
      }
      if (url.pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(root, path.basename(url.pathname))) });
      return route.fulfill({ contentType: "text/html; charset=utf-8", body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>' });
    });
    await page.goto("http://project-model.test/");
    await page.getByText(/暂无可用模型/).waitFor();
    assert.deepEqual(requests, ["validate", "models"]);
    modelBody = { modelList: [{ provider: "new-provider", id: "new-model", name: "Newly added model" }] };
    await page.getByRole("button", { name: "刷新列表" }).click();
    await page.waitForFunction(() => document.querySelector("select").options.length === 2);
    await page.getByRole("combobox").selectOption(JSON.stringify(["new-provider", "new-model"]));
    assert.equal(await page.getByRole("button", { name: "应用到全部会话" }).isEnabled(), true);
    modelBody = { modelList: [], modelError: "MODEL_CATALOG_FAILED" };
    await page.getByRole("button", { name: "刷新列表" }).click();
    await page.getByRole("alert").filter({ hasText: "MODEL_CATALOG_FAILED" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "应用到全部会话" }).isEnabled(), false);
    const modelCalls = requests.filter(item => item === "models").length;
    invalidFolder = true;
    await page.getByRole("button", { name: "刷新列表" }).click();
    await page.getByRole("alert").filter({ hasText: "项目目录：Directory does not exist" }).waitFor();
    assert.equal(requests.filter(item => item === "models").length, modelCalls);
    assert.equal(await page.getByText(/账号权限和模型授权/).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await rm(root, { recursive: true, force: true });
  }
});
