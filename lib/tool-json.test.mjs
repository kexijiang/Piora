import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { assertToolJsonObject } = await createJiti(import.meta.url).import("./tool-json.ts");

test("tool JSON boundary accepts nested tool data and rejects non-JSON runtime values", () => {
  const shared = { value: "你好" };
  assert.doesNotThrow(() => assertToolJsonObject({ shared, again: shared, nested: [null, 1, false, {}] }));
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [null, [], "text", { value: undefined }, { value: NaN }, { value: Infinity }, { value: 1n }, { value: new Date() }, cyclic]) {
    assert.throws(() => assertToolJsonObject(value), /JSON object/);
  }
});
