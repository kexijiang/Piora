import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { controlledBackend, deferred } from "./harmony/fixtures/controlled-backend.mjs";
const { createHarmonyDeviceManager: rawManagerFactory } = await createJiti(import.meta.url).import("./harmony/index.ts");
import { authorizedManagerFactory } from "./harmony/fixtures/authorized-manager.mjs";
const createHarmonyDeviceManager = authorizedManagerFactory(rawManagerFactory);

test("releaseLease aborts an in-flight write only on its device, even for the same owner", async () => {
  const { backend, state } = controlledBackend();
  const started = deferred();
  const finish = deferred();
  const signals = new Map();
  state.tapHook = async (serial, signal) => { signals.set(serial, signal); if (signals.size === 2) started.resolve(); await finish.promise; };
  const manager = createHarmonyDeviceManager({ backend });
  try {
    const a = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "owner" } });
    const b = await manager.acquireLease({ serial: "phone-2", owner: { kind: "agent", id: "owner" } });
    const running = [manager.tap({ serial: a.serial, leaseToken: a.token, x: 1, y: 2 }), manager.tap({ serial: b.serial, leaseToken: b.token, x: 1, y: 2 })];
    const settled = Promise.allSettled(running);
    await started.promise;
    manager.releaseLease(a.token);
    assert.equal(signals.get("phone-1").aborted, true);
    assert.equal(signals.get("phone-2").aborted, false);
    finish.resolve(); await settled;
  } finally { finish.resolve(); await manager.dispose(); }
});

test("lease TTL expires without another API call", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const { backend } = controlledBackend();
  const manager = createHarmonyDeviceManager({ backend });
  try {
    const events = [];
    manager.subscribe(event => events.push(event));
    await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "run" }, ttlMs: 5000 });
    t.mock.timers.tick(5001);
    assert.equal(events.filter(event => event.type === "lease_released" && event.reason === "expired").length, 1);
  } finally { await manager.dispose(); }
});

test("lease revocation during a fresh observation prevents its subsequent tap", async () => {
  const { backend, state, calls } = controlledBackend();
  const manager = createHarmonyDeviceManager({ backend });
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "run" } });
    state.snapshotHook = async () => { manager.releaseLease(lease.token); };
    const result = await manager.runScenario({ serial: lease.serial, leaseToken: lease.token,
      steps: [{ action: "tap", selector: { id: "open" } }], policy: { settleAfterAction: false } }).catch(error => error);
    assert.notEqual(result.status, "passed");
    assert.equal(calls.filter(call => call.action === "tap").length, 0);
  } finally { await manager.dispose(); }
});

test("single-device stop blocks admission immediately while a recording download stalls", async () => {
  const { backend } = controlledBackend();
  const download = deferred();
  backend.startRecording = async () => {};
  backend.stopRecording = async () => { await download.promise; return 0; };
  const manager = createHarmonyDeviceManager({ backend, cleanupTimeoutMs: 30 });
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "owner" } });
    const start = () => manager.startRecording({ serial: "phone-1", ownerId: "owner", leaseToken: lease.token });
    await start();
    const stopping = manager.stopDevice("phone-1");
    await assert.rejects(manager.acquireLease({ serial: "phone-1", owner: { kind: "agent", id: "new" } }),
      error => error.code === "DEVICE_BUSY");
    const other = await manager.acquireLease({ serial: "phone-2", owner: { kind: "agent", id: "other" } });
    assert.ok(other.token);
    const receipt = await stopping;
    assert.equal(receipt.dispatchBlocked, true);
    assert.equal(receipt.cleanup, "uncertain");
  } finally { download.resolve(); await manager.dispose(); }
});
