import assert from "node:assert/strict";
import test from "node:test";
import { verifyPackagedCoreTools } from "../scripts/verify-packaged-web.mjs";

const tools = [
  { name: "browser", active: true },
  { name: "harmony_control", active: true },
  { name: "piora_room", active: false },
];
test("packaged tool verification follows compact gateway registration and optional-extension defaults", () => {
  assert.equal(verifyPackagedCoreTools(tools).filter((entry) => entry.active).length, 2);
  assert.throws(() => verifyPackagedCoreTools(tools.filter((entry) => entry.name !== "harmony_control")), /failed to load/);
  assert.throws(() => verifyPackagedCoreTools(tools.map((entry) => ({ ...entry, active: false }))), /coding preset/);
  assert.throws(() => verifyPackagedCoreTools([...tools, { name: "harmony_tap", active: false }]), /one gateway/);
  assert.throws(() => verifyPackagedCoreTools([...tools, { name: "computer_control", active: false }]), /disabled by default/);
});
