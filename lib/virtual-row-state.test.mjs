import assert from "node:assert/strict";
import test from "node:test";
import { createVirtualRowState } from "./virtual-row-state.ts";

test("recycled rows retain expansion independently without retaining message payloads", () => {
  const first = createVirtualRowState();
  const second = createVirtualRowState();
  let renders = 0;
  const unmount = first.subscribe("thinking:1", () => renders++);
  first.set("thinking:1", true);
  first.set("thinking:1", true);
  assert.equal(renders, 1);
  unmount();
  first.set("thinking:1", false);
  assert.equal(renders, 1);
  first.set("thinking:1", true);
  assert.equal(first.get("thinking:1", false), true, "a remounted row reads the retained choice");
  assert.equal(second.get("thinking:1", false), false, "another row has independent state");
  assert.equal(first.get("tool:bash", true), true, "unmodified defaults remain available");
});
