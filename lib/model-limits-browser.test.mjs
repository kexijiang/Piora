import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { createJiti } from "jiti";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");
const { parseDiscoveredModels, buildModelsListUrl } = await createJiti(import.meta.url, { alias: { "@": repo } }).import("./model-discovery.ts");

// Upstream GET /models documents. The discover stub parses these with the real parser.
const openRouterList = {
  data: [
    { id: "or-model", name: "OR Model", context_length: 200000, top_provider: { max_completion_tokens: 8192 } },
    { id: "gpt-official", object: "model", owned_by: "openai" },
    { id: "model-ok", context_length: 999999, top_provider: { max_completion_tokens: 1111 } },
  ],
};

test("model context and max output block incomplete saves and fill only empty fields from the endpoint", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-model-limits-"));
  let browser;
  const errors = [];
  let page;
  try {
    await writeFile(path.join(directory, "loader.cjs"), `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, "css.cjs"), 'module.exports=s=>"export default "+JSON.stringify(Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],m[1]])))');
    await writeFile(path.join(directory, "entry.tsx"), `import React from 'react';import{createRoot}from'react-dom/client';import{I18nProvider}from'@/hooks/useI18n';import{ModelsConfig}from'@/components/ModelsConfig';createRoot(document.getElementById('root')).render(<I18nProvider><ModelsConfig embedded onClose={()=>{}}/></I18nProvider>);`);
    const compiler = webpack({
      mode: "development",
      target: "web",
      devtool: false,
      entry: path.join(directory, "entry.tsx"),
      output: { path: directory, filename: "bundle.js" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
      module: {
        parser: { javascript: { dynamicImportMode: "eager" } },
        rules: [
          { test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "loader.cjs") },
          { test: /\.css$/, use: path.join(directory, "css.cjs") },
        ],
      },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const bundle = await readFile(path.join(directory, "bundle.js"));
    const css = (await Promise.all(["app/globals.css", "components/ModelsConfig.module.css"].map((file) => readFile(path.join(repo, file), "utf8")))).join("\n");
    browser = await chromium.launch({ channel: "msedge", headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("pi-locale", "zh-CN"));

    let upstreamMode = "list";
    const puts = [];
    let saved = {
      unknownRoot: true,
      providers: {
        alpha: {
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
          unknownProvider: "keep",
          models: [
            { id: "model-ok", name: "OK", contextWindow: 32000, maxTokens: 8192, unknownModel: [1] },
            { id: "model-old", name: "Legacy" },
          ],
        },
      },
    };
    await page.route("http://models.test/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: bundle });
      if (!url.pathname.startsWith("/api/")) {
        return route.fulfill({
          contentType: "text/html",
          body: `<html><meta charset="utf-8"><style>html,body,#root{height:100%;margin:0}${css}</style><div id="root"></div><script src="/bundle.js"></script></html>`,
        });
      }
      if (url.pathname === "/api/models-config") {
        if (request.method() === "PUT") {
          const body = request.postDataJSON();
          puts.push(body);
          saved = body;
          return route.fulfill({ json: { success: true } });
        }
        return route.fulfill({ json: saved });
      }
      if (url.pathname === "/api/models-config/discover") {
        const body = request.postDataJSON();
        const api = body?.provider?.api || "openai-completions";
        const endpoint = buildModelsListUrl(body.provider.baseUrl, api).toString();
        if (upstreamMode !== "list") {
          return route.fulfill({ status: 504, json: { error: "The model list request timed out", status: 504 } });
        }
        const models = parseDiscoveredModels(openRouterList, { api });
        return route.fulfill({ json: { models, endpoint } });
      }
      if (url.pathname === "/api/models/scope") return route.fulfill({ json: { models: [], warnings: [], enabledModels: [] } });
      if (url.pathname === "/api/model-capabilities") return route.fulfill({ json: { imageInput: {} } });
      return route.fulfill({ json: { providers: [], imageInput: {} } });
    });

    const row = (id) => page.locator(".modelTreeRow").filter({ has: page.getByText(id, { exact: true }) });
    const limitField = (name) => page.locator(`[data-model-limit-field="${name}"]`);
    const limitInput = (name) => limitField(name).locator("input");
    const limitsBox = () => page.locator("[data-model-limits-help]").locator("..");
    const saveButton = () => page.getByRole("button", { name: "保存", exact: true });
    const saveAlert = () => page.getByRole("alert").filter({ hasText: "请先补全模型“alpha/model-old”的上下文窗口和最大输出。" });
    const assertNoUiMeta = (config) => {
      const json = JSON.stringify(config);
      assert.equal(json.includes("limitsMeta"), false, json);
      assert.equal(json.includes("\"unavailable\""), false, json);
      assert.equal(json.includes("来自接口"), false, json);
    };

    await page.goto("http://models.test/");
    const banner = page.locator("[data-model-limits-banner]");
    try {
      await banner.waitFor();
    } catch (error) {
      throw new Error(`${error.message}\n${errors.join("\n")}\n${await page.locator("body").innerText()}`);
    }
    assert.match(await banner.innerText(), /1 个模型缺少上下文 \/ 最大输出/);
    assert.equal(await row("model-old").locator("[data-model-limits-missing]").count(), 1);
    assert.equal(await row("model-ok").locator("[data-model-limits-missing]").count(), 0);
    assert.equal(await row("model-old").locator("[data-model-limits-missing]").getAttribute("aria-label"), "缺少上下文或最大输出");
    assert.deepEqual(errors, []);

    await row("model-ok").click();
    await page.locator('input[placeholder="model-id"]').waitFor();
    assert.equal(await page.locator('input[placeholder="model-id"]').inputValue(), "model-ok");
    await saveButton().click();
    await saveAlert().waitFor();
    assert.equal(puts.length, 0, "missing limits must block the save before any PUT");
    assert.equal(await page.locator('input[placeholder="model-id"]').inputValue(), "model-old");
    assert.match(await row("model-old").evaluate((node) => node.style.background), /bg-selected/);
    for (const name of ["contextWindow", "maxTokens"]) {
      assert.equal(await limitInput(name).inputValue(), "");
      assert.equal(await limitInput(name).getAttribute("aria-invalid"), "true");
      assert.match(await limitInput(name).getAttribute("style"), /#ef4444/);
      assert.match(await limitField(name).innerText(), /请填写正整数/);
    }

    const reject = async (context, max, note) => {
      await limitInput("contextWindow").fill(context);
      await limitInput("maxTokens").fill(max);
      assert.equal(await limitInput("contextWindow").inputValue(), context);
      assert.equal(await limitInput("maxTokens").inputValue(), max);
      await saveButton().click();
      await saveAlert().waitFor();
      assert.match(await limitField("maxTokens").innerText(), new RegExp(note));
      assert.equal(puts.length, 0, `${context}/${max} must not be saved`);
      assert.equal(await page.locator('input[placeholder="model-id"]').inputValue(), "model-old");
    };
    await reject("0", "0", "必须是正整数");
    await reject("-4", "-2", "必须是正整数");
    await reject("1000", "4000", "最大输出不能大于上下文窗口");
    assert.match(await limitField("contextWindow").innerText(), /最大输出不能大于上下文窗口/);

    await limitInput("contextWindow").fill("8000");
    await limitInput("maxTokens").fill("2000");
    await saveButton().click();
    await page.getByRole("button", { name: "已保存", exact: true }).waitFor();
    assert.equal(puts.length, 1);
    assertNoUiMeta(puts[0]);
    assert.equal(puts[0].unknownRoot, true);
    assert.equal(puts[0].providers.alpha.unknownProvider, "keep");
    assert.deepEqual(puts[0].providers.alpha.models[0].unknownModel, [1]);
    assert.equal(puts[0].providers.alpha.models[1].id, "model-old");
    assert.equal(puts[0].providers.alpha.models[1].contextWindow, 8000);
    assert.equal(puts[0].providers.alpha.models[1].maxTokens, 2000);
    assert.deepEqual(Object.keys(puts[0].providers.alpha.models[1]).sort(), ["contextWindow", "id", "maxTokens", "name"]);
    await banner.waitFor({ state: "hidden" });
    assert.equal(await page.locator("[data-model-limits-missing]").count(), 0);

    await page.locator(".providerRow").filter({ hasText: "alpha" }).click();
    await page.getByRole("button", { name: "自动识别可用模型", exact: true }).click();
    await page.getByText("已获取 3 个模型", { exact: true }).waitFor();
    await page.getByText("选择当前结果", { exact: true }).click();
    await page.getByRole("button", { name: "添加所选模型（2）", exact: true }).click();
    await row("or-model").waitFor();
    await row("gpt-official").waitFor();

    await row("or-model").click();
    assert.equal(await limitInput("contextWindow").inputValue(), "200000");
    assert.equal(await limitInput("maxTokens").inputValue(), "8192");
    assert.equal(await limitField("contextWindow").locator("[data-limit-source='endpoint']").innerText(), "来自接口");
    assert.equal(await limitField("maxTokens").locator("[data-limit-source='endpoint']").innerText(), "来自接口");
    assert.equal(await limitInput("contextWindow").getAttribute("aria-invalid"), null);
    assert.equal(await row("or-model").locator("[data-model-limits-missing]").count(), 0);

    await row("gpt-official").click();
    for (const name of ["contextWindow", "maxTokens"]) {
      assert.equal(await limitInput(name).inputValue(), "");
      assert.equal(await limitInput(name).getAttribute("aria-invalid"), "true");
      assert.match(await limitInput(name).getAttribute("style"), /#ef4444/);
      assert.equal(await limitField(name).locator("[data-limit-endpoint-missing='true']").innerText(), "接口未提供，请手动填写");
    }
    assert.equal(await row("gpt-official").locator("[data-model-limits-missing]").count(), 1);
    await saveButton().click();
    await page.getByRole("alert").filter({ hasText: "请先补全模型“alpha/gpt-official”的上下文窗口和最大输出。" }).waitFor();
    assert.equal(puts.length, 1, "an endpoint model without limits still cannot be saved");

    await row("model-ok").click();
    await limitInput("maxTokens").fill("");
    assert.equal(await limitInput("contextWindow").inputValue(), "32000");
    assert.equal(await limitInput("maxTokens").inputValue(), "");
    const fetchLimits = limitsBox().locator("button").first();
    await fetchLimits.click();
    await limitField("maxTokens").locator("[data-limit-source='endpoint']").waitFor();
    assert.equal(await limitInput("contextWindow").inputValue(), "32000", "filled context must stay");
    assert.equal(await limitField("contextWindow").locator("[data-limit-source='endpoint']").count(), 0);
    assert.equal(await limitInput("maxTokens").inputValue(), "1111");
    assert.equal(await limitField("maxTokens").locator("[data-limit-source='endpoint']").innerText(), "来自接口");
    await limitsBox().getByRole("button", { name: "撤销", exact: true }).click();
    await limitField("maxTokens").locator("[data-limit-source='endpoint']").waitFor({ state: "hidden" });
    assert.equal(await limitInput("contextWindow").inputValue(), "32000");
    assert.equal(await limitInput("maxTokens").inputValue(), "");
    assert.equal(await limitsBox().getByRole("button", { name: "撤销", exact: true }).count(), 0);
    await limitInput("maxTokens").fill("8192");

    upstreamMode = "down";
    await row("gpt-official").click();
    const failedFetch = limitsBox().locator("button").first();
    await failedFetch.click();
    await limitsBox().getByRole("alert").filter({ hasText: "请求超时或已取消，请检查网络后重试。" }).waitFor();
    assert.equal((await failedFetch.innerText()).trim(), "从接口获取");
    assert.equal(await failedFetch.isEnabled(), true);
    await limitInput("contextWindow").fill("4096");
    await limitInput("maxTokens").fill("1024");
    assert.equal(await limitInput("contextWindow").inputValue(), "4096");
    assert.equal(await limitInput("maxTokens").inputValue(), "1024");
    assert.equal(await limitField("contextWindow").locator("[data-limit-endpoint-missing='true']").count(), 0);
    assert.equal(await page.getByRole("button", { name: "正在获取…", exact: true }).count(), 0);

    await saveButton().click();
    await page.getByRole("button", { name: "已保存", exact: true }).waitFor();
    assert.equal(puts.length, 2);
    assertNoUiMeta(puts[1]);
    const stored = Object.fromEntries(puts[1].providers.alpha.models.map((model) => [model.id, model]));
    assert.equal(stored["or-model"].contextWindow, 200000);
    assert.equal(stored["or-model"].maxTokens, 8192);
    assert.equal(stored["or-model"].name, "OR Model");
    assert.equal(stored["gpt-official"].contextWindow, 4096);
    assert.equal(stored["gpt-official"].maxTokens, 1024);
    assert.equal(stored["model-ok"].contextWindow, 32000);
    assert.equal(stored["model-ok"].maxTokens, 8192);
    assert.equal(stored["model-old"].contextWindow, 8000);
    assert.equal(stored["model-old"].maxTokens, 2000);
    assert.deepEqual(errors, []);
  } catch (error) {
    let body = "";
    try { body = await page?.locator("body").innerText(); } catch { /* page may not exist */ }
    error.message += `\n--- pageerrors ---\n${errors.join("\n")}\n--- body ---\n${body}`;
    throw error;
  } finally {
    await browser?.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith("piora-model-limits-"));
    await rm(directory, { recursive: true, force: true });
  }
});
