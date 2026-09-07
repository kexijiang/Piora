import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { acquireDesktopUpdateLease, releaseDesktopUpdateLease, beginPromptRun, finishPromptRun, resetPromptRunRegistryForTests } = await jiti.import("./prompt-run-registry.ts");
test.afterEach(resetPromptRunRegistryForTests);

test("idle update lease fences background prompts until released", () => {
  const token = acquireDesktopUpdateLease(); assert.ok(token);
  assert.throws(() => beginPromptRun("background"), /installing an update/);
  releaseDesktopUpdateLease("wrong-token"); assert.throws(() => beginPromptRun("background"), /installing/);
  releaseDesktopUpdateLease(token); assert.ok(beginPromptRun("background"));
});
test("an active prompt prevents update admission", async () => {
  const run = beginPromptRun("busy"); assert.equal(acquireDesktopUpdateLease(), undefined);
  await finishPromptRun(run, "idle"); assert.ok(acquireDesktopUpdateLease());
});
