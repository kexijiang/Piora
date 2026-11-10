import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const firstParty = await jiti.import("./first-party-extensions.ts");

const rpc = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
const input = await readFile(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");
const messageTypes = await readFile(new URL("./session-message-types.ts", import.meta.url), "utf8");

test("one explicit workflow extension replaces the removed legacy goal and plan extensions", () => {
  assert.ok(firstParty.FIRST_PARTY_EXTENSIONS.every(({ id }) => id !== "piora:goal" && id !== "piora:plan"));
  const workflows = firstParty.FIRST_PARTY_EXTENSIONS.filter(({ id }) => id === "piora:workflows");
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0].required, true);
  assert.deepEqual(workflows[0].profiles, ["normal"]);
});

test("legacy parallel prompt modes stay removed while the shared workflow contract is used", () => {
  for (const source of [rpc, route, input, messageTypes]) {
    assert.doesNotMatch(source, /goalMode|planMode|planExecution|promptMode/);
  }
  assert.doesNotMatch(rpc, /runGoalModeContinuations|enterPlanMode|projectPlanArtifactTaskRun/);
  assert.doesNotMatch(input, /chat\.goalMode|chat\.planMode|composer-mode-chip/);
});

test("built-in workflows do not take over installed extension slash commands", async () => {
  const extension = await readFile(new URL("../extensions/piora-workflows.ts", import.meta.url), "utf8");
  assert.doesNotMatch(extension, /registerCommand\(/);
  assert.match(extension, /piora_submit_plan/);
  assert.match(extension, /piora_update_goal/);
});
