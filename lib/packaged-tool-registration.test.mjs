import assert from "node:assert/strict";
import test from "node:test";
import { verifyPackagedCoreTools } from "../scripts/verify-packaged-web.mjs";

const tools = [
  { name: "browser", active: true },
  { name: "harmony_control", active: true },
  { name: "piora_room", active: false },
];
const mirrorTools = tools.filter(entry => entry.name !== 'harmony_control');

test('packaged mirror default requires browser and room while keeping all Harmony tools absent', () => {
  assert.equal(verifyPackagedCoreTools(mirrorTools).filter(entry => entry.active).length, 1);
  for (const name of ['browser', 'piora_room']) {
    assert.throws(() => verifyPackagedCoreTools(mirrorTools.filter(entry => entry.name !== name)), /failed to load/);
  }
  assert.throws(() => verifyPackagedCoreTools(mirrorTools.map(entry => ({...entry, active:false}))), /coding preset/);
  assert.throws(() => verifyPackagedCoreTools(mirrorTools.map(entry => ({...entry, active:true}))), /coding preset/);
  assert.throws(() => verifyPackagedCoreTools([...mirrorTools,{name:'computer_control',active:false}]), /disabled by default/);
});

test('packaged mirror verification rejects registered Harmony gateways and legacy tools even when inactive', () => {
  for (const name of ['harmony_control','harmony_tap']) {
    for (const active of [true,false]) {
      assert.throws(() => verifyPackagedCoreTools([...mirrorTools,{name,active}]), /disabled in mirror mode/);
    }
  }
});

test('a host workbench flag cannot change the default packaged verification contract', t => {
  const prior = process.env.PIORA_HARMONY_WORKBENCH;
  process.env.PIORA_HARMONY_WORKBENCH = '1';
  t.after(() => {
    if (prior === undefined) delete process.env.PIORA_HARMONY_WORKBENCH;
    else process.env.PIORA_HARMONY_WORKBENCH = prior;
  });
  assert.doesNotThrow(() => verifyPackagedCoreTools(mirrorTools));
  assert.throws(() => verifyPackagedCoreTools(tools), /disabled in mirror mode/);
});

test("explicit workbench verification retains compact gateway registration and optional-extension requirements", () => {
  const verify = entries => verifyPackagedCoreTools(entries, { harmonyWorkbench:true });
  assert.equal(verify(tools).filter((entry) => entry.active).length, 2);
  assert.throws(() => verify(tools.filter((entry) => entry.name !== "harmony_control")), /failed to load/);
  assert.throws(() => verify(tools.map((entry) => ({ ...entry, active: false }))), /coding preset/);
  assert.throws(() => verify([...tools, { name: "harmony_tap", active: false }]), /one gateway/);
  assert.throws(() => verify([...tools, { name: "computer_control", active: false }]), /disabled by default/);
});
