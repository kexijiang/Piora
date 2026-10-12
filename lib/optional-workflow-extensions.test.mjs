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

test("goal tracking and planning are not bundled first-party extensions", () => {
  assert.ok(firstParty.FIRST_PARTY_EXTENSIONS.every(({ id }) => id !== "piora:goal" && id !== "piora:plan"));
});

test("the core prompt protocol and composer contain no Goal or Plan mode switches", () => {
  for (const source of [rpc, route, input, messageTypes]) {
    assert.doesNotMatch(source, /goalMode|planMode|planExecution|promptMode/);
  }
  assert.doesNotMatch(rpc, /runGoalModeContinuations|enterPlanMode|projectPlanArtifactTaskRun/);
  assert.doesNotMatch(input, /chat\.goalMode|chat\.planMode|composer-mode-chip/);
});
