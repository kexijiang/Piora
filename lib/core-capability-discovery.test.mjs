import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: registerBrowser } = await jiti.import("../extensions/piora-browser.ts");
const { default: registerHarmony } = await jiti.import("../extensions/piora-harmony.ts");

function captureBeforeAgentStart(register) {
  let handler;
  const tools = [];
  register({
    registerTool(candidate) { tools.push(candidate); },
    on(event, candidate) {
      if (event === "before_agent_start") handler = candidate;
    },
  });
  assert.ok(tools.length);
  assert.ok(handler);
  return { handler, tool: tools.at(-1), tools };
}

function event(systemPrompt, selectedTools) {
  return {
    type: "before_agent_start",
    prompt: "test",
    systemPrompt,
    systemPromptOptions: { selectedTools },
  };
}

test("browser capability is appended to custom system prompts only while its tool is active", async () => {
  const { handler, tool } = captureBeforeAgentStart(registerBrowser);
  assert.equal(tool.name, "browser");

  const active = await handler(event("CUSTOM SYSTEM PROMPT", ["browser"]), {});
  assert.match(active.systemPrompt, /^CUSTOM SYSTEM PROMPT/);
  assert.match(active.systemPrompt, /piora_runtime_capability name="browser" availability="active"/);
  assert.match(active.systemPrompt, /Never claim browsing is unavailable/);
  assert.equal(await handler(event("CUSTOM SYSTEM PROMPT", []), {}), undefined);
  assert.equal(await handler(event(active.systemPrompt, ["browser"]), {}), undefined);
});

test("Harmony capability is appended to custom system prompts only while its tool is active", async () => {
  const { handler, tools } = captureBeforeAgentStart(registerHarmony);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "harmony_control");

  const active = await handler(event("CUSTOM SYSTEM PROMPT", ["harmony_list_devices", "harmony_tap"]), {});
  assert.match(active.systemPrompt, /^CUSTOM SYSTEM PROMPT/);
  assert.match(active.systemPrompt, /piora_runtime_capability name="harmony_phone_operator" availability="active"/);
  assert.match(active.systemPrompt, /harmony_control/);
  assert.equal(await handler(event("CUSTOM SYSTEM PROMPT", []), {}), undefined);
  assert.equal(await handler(event(active.systemPrompt, ["harmony_list_devices"]), {}), undefined);
});
