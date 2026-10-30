import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { sha256 } from "./intelligent-ui/evaluation.mjs";

const jiti = createJiti(import.meta.url);
const { intelligentUiDecisionPrompt, intelligentUiSurfacePrompt, intelligentUiPlanPrompt, intelligentUiRichPlanPrompt } = await jiti.import("./intelligent-ui/decision-policy.ts");
const beta = await jiti.import("./beta-features.ts");
const register = (await jiti.import("../extensions/piora-intelligent-ui.ts")).default;
const frozen = JSON.parse(readFileSync(new URL("../tests/fixtures/intelligent-ui/phase1-tool.json", import.meta.url), "utf8"));

test("phase 1 baseline retains its exact source hash and full schema", () => {
  const source = readFileSync(new URL("../tests/fixtures/intelligent-ui/phase1-extension-source.txt", import.meta.url), "utf8");
  assert.equal(frozen.sourceSha256, sha256(source));
  assert.equal(frozen.tool.parameters.properties.nodes.maxItems, 64);
  assert.equal(frozen.version, "phase1");
});

test("legacy candidate policy replaces only guidance, preserves schema and adds no classifier tool", t => {
  const root = mkdtempSync(join(tmpdir(), "ui-policy-test-")), previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PIORA_UI_INPUT_PROTOCOL: process.env.PIORA_UI_INPUT_PROTOCOL };
  process.env.PI_CODING_AGENT_DIR = root; process.env.PIORA_UI_INPUT_PROTOCOL = "surface";
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });
  const tools = [], handlers = {};
  const api = { registerTool: tool => tools.push(tool), on: (name, callback) => { handlers[name] = callback; } };
  register(api); assert.deepEqual(tools, []); assert.deepEqual(handlers, {});
  beta.writeBetaFeatures({ intelligentUi: true }, root); register(api);
  assert.equal(tools.length, 1); assert.equal(tools[0].name, frozen.tool.name);
  assert.deepEqual(JSON.parse(JSON.stringify(tools[0].parameters)), frozen.tool.parameters);
  assert.deepEqual(Object.keys(handlers), ["context"]);
  assert.notEqual(tools[0].description, frozen.tool.description);
  assert.deepEqual(tools[0].promptGuidelines, intelligentUiSurfacePrompt().promptGuidelines);
  const policy = intelligentUiDecisionPrompt();
  assert.ok(policy.promptGuidelines.every(guideline => tools[0].promptGuidelines.includes(guideline)));
  // Caller mutation must not affect another task's policy snapshot.
  policy.promptGuidelines.length = 0;
  assert.ok(intelligentUiDecisionPrompt().promptGuidelines.length > 0);
});

for (const version of [1, 2]) test(`plan-${version} evaluation uses the production declaration and complete prompting without a second policy copy`, async t => {
  const root = mkdtempSync(join(tmpdir(), "ui-plan-policy-test-"));
  const previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PIORA_UI_INPUT_PROTOCOL: process.env.PIORA_UI_INPUT_PROTOCOL };
  process.env.PI_CODING_AGENT_DIR = root; process.env.PIORA_UI_INPUT_PROTOCOL = `plan-${version}`;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  beta.writeBetaFeatures({ intelligentUi: true }, root);
  const tools = []; register({ registerTool: tool => tools.push(tool), on() {} });
  assert.equal(tools.length, 1);
  const { evaluationVariant } = await import("../scripts/intelligent-ui-live-evaluation.mjs");
  const variant = await evaluationVariant(`plan-${version}`), declaration = tools[0], guidance = version === 2 ? intelligentUiRichPlanPrompt() : intelligentUiPlanPrompt();
  assert.deepEqual(variant.tools[0], { name: declaration.name, description: declaration.description, parameters: declaration.parameters });
  assert.deepEqual(declaration.promptGuidelines, guidance.promptGuidelines);
  assert.ok(variant.systemPrompt.endsWith([declaration.promptSnippet, ...declaration.promptGuidelines].join("\n\n")));
});
