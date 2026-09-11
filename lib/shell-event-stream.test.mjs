import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { shellEventStream } = await createJiti(import.meta.url).import("./shell/event-stream.ts");

function fixture() {
  const listeners = new Set();
  const state = { id: "terminal", generation: 1 };
  const session = { state, snapshot: () => ({ session: state, sequence: 0, output: "hello", commands: [], runs: [] }), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  return { session, listeners };
}

test("terminal stream disconnect releases its subscriber without stopping the terminal", async () => {
  for (const mode of ["abort", "cancel", "already-aborted"]) {
    const { session, listeners } = fixture();
    const controller = new AbortController();
    if (mode === "already-aborted") controller.abort();
    const response = shellEventStream(session, new Request("http://localhost/events", { signal: controller.signal }));
    if (mode !== "already-aborted") {
      assert.equal(listeners.size, 1);
      const reader = response.body.getReader();
      assert.match(new TextDecoder().decode((await reader.read()).value), /hello/);
      if (mode === "abort") controller.abort(); else await reader.cancel();
    }
    assert.equal(listeners.size, 0);
    assert.equal(session.snapshot().output, "hello");
  }
});

test("a stalled terminal stream has a bounded buffer and cannot retain a subscriber", async () => {
  const { session, listeners } = fixture();
  const response = shellEventStream(session, new Request("http://localhost/events"));
  const publish = [...listeners][0];
  for (let i = 1; i <= 20; i++) publish({ type: "output", terminalId: "terminal", generation: 1, sequence: i, data: "x".repeat(1024 * 1024) });
  assert.equal(listeners.size, 0);
  await response.body.cancel();
  assert.doesNotThrow(() => publish({ type: "output", data: "late" }));
});
