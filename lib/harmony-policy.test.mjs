import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { controlledBackend } from "./harmony/fixtures/controlled-backend.mjs";
const { createHarmonyDeviceManager } = await createJiti(import.meta.url).import("./harmony/index.ts");

for (const kind of ["agent", "manual"]) {
  test(kind + " controls a connected phone across applications without extra authorization", async () => {
    const { backend, calls, state } = controlledBackend();
    const manager = createHarmonyDeviceManager({ backend });
    try {
      const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind, id: "run" } });
      const tap = () => manager.tap({ serial: lease.serial, leaseToken: lease.token, x: 20, y: 30 });
      await tap();
      state.observation.quality.appId = "com.other.app";
      await tap();
      for (const key of ["home", "recents"]) await manager.pressKey({ serial: lease.serial, leaseToken: lease.token, key });
      assert.equal(calls.filter(call => call.action === "tap").length, 2);
      assert.equal(calls.filter(call => call.action === "press_key").length, 2);
      manager.releaseLease(lease.token);
      await assert.rejects(tap(), error => error.code === "LEASE_REQUIRED");
      const next = await manager.acquireLease({ serial: lease.serial, owner: { kind, id: "next" } });
      await manager.tap({ serial: next.serial, leaseToken: next.token, x: 20, y: 30 });
      assert.equal(calls.filter(call => call.action === "tap").length, 3);
    } finally { await manager.dispose(); }
  });
}
for (const action of ["clear_app_data", "uninstall_app"]) {
  test(action + " executes the requested target directly without one-use approval", async () => {
    const { backend, calls } = controlledBackend();
    const manager = createHarmonyDeviceManager({ backend });
    try {
      const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "run" } });
      for (const bundleName of ["com.test.app", "com.other.app"]) {
        const result = await manager.runScenario({ serial: lease.serial, leaseToken: lease.token,
          steps: [{ action, bundleName }], policy: { settleAfterAction: false } });
        assert.equal(result.status, "passed");
      }
      assert.deepEqual(calls.filter(call => call.action === action).map(call => call.bundleName), ["com.test.app", "com.other.app"]);
    } finally { await manager.dispose(); }
  });
}

test("direct HAP installation freezes the selected bytes and rejects corrupt cached artifacts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-hap-policy-"));
  const hapPath = join(directory, "app.hap");
  writeFileSync(hapPath, "first-build");
  const { backend } = controlledBackend();
  const installed = [];
  backend.installPackage = async (_serial, path) => {
    writeFileSync(hapPath, "second-build");
    installed.push({ path, bytes: readFileSync(path, "utf8") });
  };
  const manager = createHarmonyDeviceManager({ backend, configPath: join(directory, "config.json") });
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "run" } });
    const install = () => manager.installPackage({ serial: lease.serial, leaseToken: lease.token, hapPath });
    await install();
    assert.notEqual(installed[0].path, hapPath);
    assert.equal(installed[0].bytes, "first-build");
    await install();
    assert.equal(installed[1].bytes, "second-build");
    assert.notEqual(installed[0].path, installed[1].path);
    writeFileSync(installed[1].path, "corrupt");
    await assert.rejects(install(), error => error.code === "INVALID_ARGUMENT");
    assert.equal(installed.length, 2);
  } finally {
    await manager.dispose();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /piora-hap-policy-/);
    rmSync(directory, { recursive: true, force: true });
  }
});
