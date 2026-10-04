import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { parseHarmonyScreenLockState } = await createJiti(import.meta.url).import("./harmony/hdc-backend.ts");

test("HDC lock diagnostic accepts the Mate 60 whitespace format and older labeled formats", () => {
  assert.equal(parseHarmonyScreenLockState(" * screenLocked  \t\tfalse\t\t100\r\n"), "unlocked");
  assert.equal(parseHarmonyScreenLockState(" * screenLocked  \t\ttrue\t\t100\r\n"), "locked");
  assert.equal(parseHarmonyScreenLockState("screenLocked: false\n"), "unlocked");
  assert.equal(parseHarmonyScreenLockState("screenLocked = true\n"), "locked");
  assert.equal(parseHarmonyScreenLockState("screenLocked maybe\n"), "unknown");
  assert.equal(parseHarmonyScreenLockState("screenLocked false\nscreenLocked true\n"), "unknown");
});
