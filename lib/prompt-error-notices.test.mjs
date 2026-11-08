import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { PromptErrorNotices } = await jiti.import("./prompt-error-notices.ts");
const { modelTimeoutDisplay } = await jiti.import("./model-timeout-display.ts");

test("terminal errors deduplicate in either arrival order without hiding distinct failures or future runs", () => {
  const tracker = new PromptErrorNotices();
  const first = tracker.record("session:1", "Error: timeout", "notice");
  assert.equal(first.show, true);
  assert.deepEqual(tracker.record("session:1", "timeout", "notice"), { id: first.id, show: false });
  assert.deepEqual(tracker.record("session:1", "timeout", "history"), { id: first.id, show: false });
  assert.equal(tracker.record("session:1", "different", "notice").show, true);
  tracker.record("session:2", "timeout", "history");
  assert.equal(tracker.record("session:2", "timeout", "notice").show, false);
  assert.equal(tracker.record("session:3", "timeout", "notice").show, true);
  assert.equal(tracker.record("other-session:3", "timeout", "notice").show, true);
});

test("only watchdog timeouts are localized; arbitrary provider errors stay intact", () => {
  assert.deepEqual(modelTimeoutDisplay("Model request timed out: the provider sent no response data within 12.5 seconds. The connection or provider may be stalled; the request can be retried."), { key: "chat.modelFirstEventTimeout", seconds: 12.5 });
  assert.deepEqual(modelTimeoutDisplay("Error: Model request timed out: the response stream stopped sending data for 300 seconds. The connection may have died silently; the request can be retried."), { key: "chat.modelStreamTimeout", seconds: 300 });
  for (const text of ["Request aborted", "HTTP 429", "Tool timed out", "Unknown provider error"]) assert.equal(modelTimeoutDisplay(text), null);
});
