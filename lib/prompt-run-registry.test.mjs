import assert from "node:assert/strict";
import test from "node:test";

const {
  beginPromptRun,
  finishPromptRun,
  getActivePromptRun,
  registerPromptRunCleanup,
  requirePromptToolIdentity,
  resetPromptRunRegistryForTests,
} = await import("./prompt-run-registry.ts");

test.afterEach(() => resetPromptRunRegistryForTests());

test("only UI runs carry their originating submission identity across registry reads", () => {
  const ui=beginPromptRun("ui-session",{source:"ui",submissionId:"message-identity"});
  assert.equal(ui.submissionId,"message-identity");assert.deepEqual(getActivePromptRun("ui-session"),ui);
  const automatic=beginPromptRun("automatic-session",{source:"scheduler",submissionId:"message-identity"});
  assert.equal(automatic.submissionId,undefined);assert.equal(getActivePromptRun("automatic-session").submissionId,undefined);
});

test("tool identity is derived from the active session run and real tool call id", () => {
  const run = beginPromptRun("session-a");
  const identity = requirePromptToolIdentity("session-a", "tool-call-a");
  assert.deepEqual(identity, { ...run, toolCallId: "tool-call-a" });
  assert.throws(() => requirePromptToolIdentity("session-b", "tool-call-b"), /active prompt run/);
});

test("only one run is active per session", () => {
  beginPromptRun("session-a");
  assert.throws(() => beginPromptRun("session-a"), /already has an active prompt run/);
});

test("prompt origin metadata remains attached to the active run", () => {
  const run = beginPromptRun("session-room", {
    source: "room",
    roomContext: { roomId: "room-a", messageId: "message-a" },
  });
  assert.deepEqual(getActivePromptRun("session-room"), run);
});

test("finishing a prompt removes identity before running lease cleanup", async () => {
  const run = beginPromptRun("session-a");
  const observations = [];
  registerPromptRunCleanup(run, (reason) => {
    observations.push([reason, getActivePromptRun("session-a")]);
  });
  await finishPromptRun(run, "idle");
  assert.deepEqual(observations, [["idle", undefined]]);
  assert.equal(getActivePromptRun("session-a"), undefined);
});

test("cleanup is idempotent across abort and late prompt settlement", async () => {
  const run = beginPromptRun("session-a");
  let releases = 0;
  registerPromptRunCleanup(run, () => { releases += 1; });
  await Promise.all([
    finishPromptRun(run, "abort"),
    finishPromptRun(run, "idle"),
  ]);
  assert.equal(releases, 1);
});
