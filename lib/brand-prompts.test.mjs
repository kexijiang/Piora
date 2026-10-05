import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);
async function loadModule(file, brand) {
  const source = await readFile(new URL(file, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  runInNewContext(compiled, { exports, process, Buffer, console, setTimeout, clearTimeout,
    require: id => {
      if (/branding(?:\.ts)?$/.test(id)) return { APP_DISPLAY_NAME: brand };
      if (id.startsWith("node:")) return nativeRequire(id);
      if (id === "@earendil-works/pi-ai") return { Type: new Proxy({}, { get: () => () => ({}) }) };
      if (id === "@earendil-works/pi-coding-agent") return { defineTool: value => value };
      // Registration and prompt generation must not start browsers or jobs.
      return {};
    },
  });
  return exports;
}

for (const brand of ["Piora", "ExampleApp"]) {
  test(`${brand} room and device tool copy retains stable tool identifiers`, async () => {
    for (const [file, expectedName] of [["piora-room.ts", "piora_room"]]) {
      const extension = await loadModule(`../extensions/${file}`, brand);
      const tools = [];
      extension.default({ registerTool: tool => tools.push(tool), registerCommand() {}, on() {} });
      assert.ok(tools.some(tool => tool.name === expectedName));
      const copy = tools.flatMap(tool => [tool.label, tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])]).filter(Boolean).join("\n");
      assert.ok(copy.includes(brand));
      if (brand !== "Piora") assert.doesNotMatch(copy, /\bPiora\b/);
    }
    const harmony = await loadModule("../extensions/piora-harmony.ts", brand);
    const tools = [];
    harmony.default({ registerTool: tool => tools.push(tool), on() {} });
    assert.equal(tools[0].name, "harmony_control");
    const help = await tools[0].execute("test", { operation: "help" });
    assert.doesNotMatch(help.content[0].text, /\bPiora\b/);
  });

  test(`${brand} tool descriptions and injected capabilities use the build identity without rewriting input`, async () => {
    for (const [file, toolName] of [["piora-browser.ts", "browser"], ["piora-automations.ts", "piora_automation"], ["piora-user-input.ts", "piora_request_user_input"]]) {
      const extension = await loadModule(`../extensions/${file}`, brand);
      const tools = [];
      const handlers = new Map();
      extension.default({ registerTool: tool => tools.push(tool), on: (event, handler) => handlers.set(event, handler) });
      const tool = tools.find(candidate => candidate.name === toolName);
      assert.ok(tool, `${toolName} identifier stays stable`);
      for (const copy of [tool.description, tool.promptSnippet]) {
        assert.ok(copy.includes(brand));
        if (brand !== "Piora") assert.doesNotMatch(copy, /\bPiora\b/);
      }
      const original = "User-owned prompt: Piora, PIORA, ExampleApp, PIORA_BROWSER_EXECUTABLE, piora_automation. 不要改我的原文。";
      const before = handlers.get("before_agent_start");
      const result = await before({ systemPrompt: original, systemPromptOptions: { selectedTools: [toolName] } });
      assert.ok(result.systemPrompt.startsWith(original + "\n\n"));
      const injected = result.systemPrompt.slice(original.length);
      assert.ok(injected.includes(brand));
      assert.match(injected, /<piora_runtime_capability/);
      if (brand !== "Piora") assert.doesNotMatch(injected, /\bPiora\b/);
      assert.equal(await before({ systemPrompt: original, systemPromptOptions: { selectedTools: [] } }), undefined);
      assert.equal(await before({ systemPrompt: result.systemPrompt, systemPromptOptions: { selectedTools: [toolName] } }), undefined, "capability remains deduplicated");
    }
  });

  test(`${brand} extension display names and Shell Agent identity follow the brand`, async () => {
    const { FIRST_PARTY_EXTENSIONS } = await loadModule("./first-party-extensions.ts", brand);
    for (const extension of FIRST_PARTY_EXTENSIONS) {
      assert.ok(extension.name.startsWith(brand + " "));
      assert.ok(extension.id.startsWith("piora:"));
      assert.ok(extension.fileName.startsWith("piora-"));
    }
    const source = await readFile(new URL("./shell/agent.ts", import.meta.url), "utf8");
    const parsed = ts.createSourceFile("agent.ts", source, ts.ScriptTarget.Latest, true);
    let initializer;
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === "SYSTEM_PROMPT") initializer = node.initializer.getText(parsed);
      ts.forEachChild(node, visit);
    }
    visit(parsed);
    assert.ok(initializer);
    const prompt = runInNewContext(initializer, { APP_DISPLAY_NAME: brand });
    assert.ok(prompt.startsWith(`You are ${brand}'s Shell Agent`));
  });
}
