import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { verifyPackagedCoreTools } from "../scripts/verify-packaged-web.mjs";

const tools = [
  { name: "browser", active: true },
  { name: "harmony_control", active: true },
  { name: "piora_room", active: false },
];
const mirrorTools = tools.filter(entry => entry.name !== "harmony_control");
const verifyRestricted = entries => verifyPackagedCoreTools(entries, { harmonyWorkbench: false });

test("packaged workbench default requires the active gateway and coding preset", () => {
  assert.equal(verifyPackagedCoreTools(tools).filter(entry => entry.active).length, 2);
  for (const name of ["browser", "harmony_control", "piora_room"]) {
    assert.throws(() => verifyPackagedCoreTools(tools.filter(entry => entry.name !== name)), /failed to load/);
  }
  assert.throws(() => verifyPackagedCoreTools(tools.map(entry => ({ ...entry, active: false }))), /coding preset/);
  assert.throws(() => verifyPackagedCoreTools(tools.map(entry => ({ ...entry, active: true }))), /coding preset/);
  for (const active of [true, false]) {
    assert.throws(() => verifyPackagedCoreTools([...tools, { name: "harmony_tap", active }]), /one gateway/);
    assert.throws(() => verifyPackagedCoreTools([...tools, { name: "computer_control", active }]), /disabled by default/);
  }
});

test("explicit restricted verification keeps Harmony registrations absent", () => {
  assert.equal(verifyRestricted(mirrorTools).filter(entry => entry.active).length, 1);
  for (const name of ["browser", "piora_room"]) {
    assert.throws(() => verifyRestricted(mirrorTools.filter(entry => entry.name !== name)), /failed to load/);
  }
  assert.throws(() => verifyRestricted(mirrorTools.map(entry => ({ ...entry, active: false }))), /coding preset/);
  assert.throws(() => verifyRestricted(mirrorTools.map(entry => ({ ...entry, active: true }))), /coding preset/);
  assert.throws(() => verifyRestricted([...mirrorTools, { name: "computer_control", active: false }]), /disabled by default/);
  for (const name of ["harmony_control", "harmony_tap"]) {
    for (const active of [true, false]) {
      assert.throws(() => verifyRestricted([...mirrorTools, { name, active }]), /disabled in mirror mode/);
    }
  }
});

test("host flags cannot change the isolated packaged verification contract", t => {
  const prior = process.env.PIORA_HARMONY_WORKBENCH;
  t.after(() => {
    if (prior === undefined) delete process.env.PIORA_HARMONY_WORKBENCH;
    else process.env.PIORA_HARMONY_WORKBENCH = prior;
  });
  for (const value of ["0", "1"]) {
    process.env.PIORA_HARMONY_WORKBENCH = value;
    assert.doesNotThrow(() => verifyPackagedCoreTools(tools));
    assert.throws(() => verifyPackagedCoreTools(mirrorTools), /failed to load/);
    assert.doesNotThrow(() => verifyRestricted(mirrorTools));
  }
});

test("the default verifier accepts the real extension gateway registration", async t => {
  const prior = process.env.PIORA_HARMONY_WORKBENCH;
  delete process.env.PIORA_HARMONY_WORKBENCH;
  t.after(() => {
    if (prior === undefined) delete process.env.PIORA_HARMONY_WORKBENCH;
    else process.env.PIORA_HARMONY_WORKBENCH = prior;
  });
  const { default: register } = await createJiti(import.meta.url).import("../extensions/piora-harmony.ts");
  const registered = [];
  register({ registerTool(tool) { registered.push({ name: tool.name, active: true }); }, on() {} });
  assert.deepEqual(registered.map(entry => entry.name), ["harmony_control"]);
  assert.doesNotThrow(() => verifyPackagedCoreTools([...mirrorTools, ...registered]));
});
