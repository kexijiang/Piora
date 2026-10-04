import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { fixtureQuality } from "./harmony/fixtures/authorized-manager.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { createHarmonyDeviceManager, HarmonyError } = await jiti.import("./harmony/index.ts");
const { ScenarioExecutionStore } = await jiti.import("./harmony/scenario/execution-store.ts");
const route = await jiti.import("../app/api/harmony/scenario/route.ts");

test("scenario screenshot artifacts and live progress survive the real route and journal without exposing inputs or replaying failures", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-scenario-screenshots-"));
  const oldToken = process.env.PI_DESKTOP_TOKEN, oldManager = globalThis.__pioraHarmonyDeviceManager;
  const token = randomBytes(32).toString("hex"); process.env.PI_DESKTOP_TOKEN = token;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a9sAAAAASUVORK5CYII=", "base64");
  let releaseCapture, captureStarted, missingScreenshot = false, mutations = 0, logReads = 0;
  const started = new Promise(resolve => captureStarted = resolve);
  const delayed = new Promise(resolve => releaseCapture = resolve);
  let first = true;
  const backend = { kind: "fixture", hdcPath: "fixture-hdc", async listDevices() { return [{ serial: "phone", state: "online", model: "Fixture phone", apiVersion: "26", osVersion: "Fixture OS", capabilities: { screenshot: true, uiTree: true, keys: true } }]; },
    async snapshot(_serial, options) {
      if (options.includeScreenshot && first) { first = false; captureStarted(); await delayed; }
      return { quality: fixtureQuality, nodes: [{ id: "ready", text: "Ready", ref: "ready" }],
        ...(options.includeScreenshot && !missingScreenshot ? { screenshot: { mimeType: "image/png", width: 1, height: 1, data: png } } : {}) };
    }, async readLogs() { logReads++; return [{ level: "info", raw: "fixture log", message: "fixture log", pid: 12 }]; }, async pressKey() { mutations++; }, async dispose() {} };
  await writeFile(path.join(root, "harmony.json"), JSON.stringify({ storage: { screenshotDirectory: path.join(root, "screenshots") } }));
  const manager = createHarmonyDeviceManager({ backend, configPath: path.join(root, "harmony.json") });
  globalThis.__pioraHarmonyDeviceManager = manager;
  const request = (body, headers = {}) => new Request("http://localhost:30141/api/harmony/scenario", { method: "POST", headers: { host: "localhost:30141", "content-type": "application/json", "x-pi-desktop-token": token, ...headers }, body: JSON.stringify(body) });
  const progress = (clientRunId, serial = "phone", headers = {}) => route.GET(new Request(`http://localhost:30141/api/harmony/scenario?serial=${encodeURIComponent(serial)}&clientRunId=${encodeURIComponent(clientRunId)}`, { headers: { host: "localhost:30141", "x-pi-desktop-token": token, ...headers } }));
  // The production manager intentionally unrefs its idle timers. Keep this
  // isolated test process alive until every awaited route operation settles.
  const testKeepAlive = setInterval(() => {}, 1_000);
  testKeepAlive.ref?.();
  try {
    const lease = await manager.acquireLease({ serial: "phone", owner: { kind: "manual", id: "fixture-owner" } });
    const clientRunId = randomUUID();
    const body = { serial: "phone", leaseToken: lease.token, clientRunId, policy: { captureFinalScreenshot: true, collectLogs: true }, steps: [{ action: "capture_screenshot", name: "first" }, { action: "capture_screenshot", name: "second" }] };
    const running = route.POST(request(body));
    let captureStartTimer;
    let captureStart;
    try {
      captureStart = await Promise.race([
        started.then(() => ({ kind: "started" })),
        running.then(async response => ({ kind: "response", status: response.status, body: await response.clone().text() })),
        new Promise(resolve => {
          captureStartTimer = setTimeout(() => resolve({ kind: "timeout" }), 5_000);
          captureStartTimer.ref?.();
        }),
      ]);
    } finally {
      clearTimeout(captureStartTimer);
    }
    assert.deepEqual(captureStart, { kind: "started" }, `scenario did not reach its first screenshot: ${JSON.stringify(captureStart)}`);
    const originalList = manager.listExecutions;
    manager.listExecutions = () => { throw Error("A progress read must not scan the execution journal"); };
    const live = await progress(clientRunId); assert.equal(live.status, 200);
    const liveRecord = (await live.json()).executions[0];
    assert.equal(liveRecord.clientRunId, clientRunId); assert.equal(liveRecord.steps[0].status, "running"); assert.equal(liveRecord.steps[1].status, "not-run");
    assert.equal((await (await progress(clientRunId, "other-phone")).json()).executions.length, 0);
    assert.equal((await (await progress(randomUUID())).json()).executions.length, 0);
    assert.equal((await progress("")).status, 400); assert.equal((await progress("not-a-uuid")).status, 400);
    assert.equal((await progress(clientRunId, "phone", { "x-pi-desktop-token": "wrong" })).status, 403);
    manager.listExecutions = originalList;
    releaseCapture();
    const completed = await running; assert.equal(completed.status, 200);
    const result = (await completed.json()).result;
    assert.equal(result.status, "passed"); assert.equal(result.steps.length, 2);
    assert.equal(result.steps[0].label, "first"); assert.equal(result.device.apiVersion, "26"); assert.equal(result.finalObservation.nodeCount, 1);
    assert.notEqual(result.steps[0].screenshot.path, result.steps[1].screenshot.path);
    assert.deepEqual(await readFile(result.finalScreenshot.path), png);
    assert.equal(new Set([result.finalScreenshot.filename, ...result.steps.map(step => step.screenshot.filename)]).size, 3);
    for (const step of result.steps) {
      assert.equal(step.receipt.dispatchState, "not-sent"); assert.equal(step.receipt.verification, "passed");
      assert.deepEqual(await readFile(step.screenshot.path), png); assert.equal(step.screenshot.size, png.length);
    }
    const restored = new ScenarioExecutionStore(path.join(root, "harmony-executions"));
    assert.equal(restored.getByClientRunId(clientRunId, "phone").status, "passed");
    assert.equal(restored.getByClientRunId(clientRunId, "phone").steps[1].screenshot.filename, result.steps[1].screenshot.filename);
    assert.equal(restored.getByClientRunId(clientRunId, "phone").device.apiVersion, "26"); assert.equal(restored.getByClientRunId(clientRunId, "phone").finalObservation.nodeCount, 1);
    assert.equal(restored.getByClientRunId(clientRunId, "phone").finalScreenshot.filename, result.finalScreenshot.filename);
    assert.equal(result.logs.status, "collected"); assert.equal(logReads, 1);
    assert.equal(restored.getByClientRunId(clientRunId, "phone").logs.entries[0].raw, "fixture log");
    assert.equal(JSON.stringify(restored.list()).includes(png.toString("base64")), false);
    assert.equal(JSON.stringify(restored.list()).includes(lease.token), false);
    assert.equal((await route.POST(request(body))).status, 400, "a duplicate run must not replay its screenshot steps");
    assert.equal((await route.POST(request({ ...body, clientRunId: "invalid" }))).status, 400);
    missingScreenshot = true;
    const failed = await route.POST(request({ ...body, clientRunId: randomUUID(), steps: [{ action: "capture_screenshot" }, { action: "press_key", key: "home" }] }));
    const failure = (await failed.json()).result;
    assert.equal(failure.status, "failed"); assert.equal(failure.steps[0].error.code, "INVALID_RESPONSE"); assert.equal(failure.steps[1].status, "not-run");
    assert.equal(mutations, 0);
    const readsBefore = logReads;
    await route.POST(request({ ...body, clientRunId: randomUUID(), policy: {}, steps: [{ action: "wait_idle" }] }));
    assert.equal(logReads, readsBefore, "report logs are never collected unless selected");
    manager.removeExecution(result.executionId, "phone");
    assert.equal(manager.getExecutionProgress(clientRunId, "phone"), undefined);
  } finally {
    clearInterval(testKeepAlive);
    releaseCapture(); await manager.dispose();
    globalThis.__pioraHarmonyDeviceManager = oldManager;
    if (oldToken === undefined) delete process.env.PI_DESKTOP_TOKEN; else process.env.PI_DESKTOP_TOKEN = oldToken;
    assert.equal(path.dirname(root), path.resolve(tmpdir())); await rm(root, { recursive: true, force: true });
  }
});

test("a runtime without screenshot persistence fails before any later device action", async () => {
  const { runHarmonyScenario } = await jiti.import("./harmony/scenario-executor.ts");
  let input = 0;
  const result = await runHarmonyScenario({ serial: "phone", leaseToken: "lease", steps: [{ action: "capture_screenshot" }, { action: "press_key", key: "home" }] }, {
    serial: "phone", generation: 1, signal: new AbortController().signal, backend: { kind: "fixture", async pressKey() { input++; } },
    invalidateSnapshot() {}, capture: async () => { throw new HarmonyError("CAPABILITY_UNAVAILABLE", "offline"); },
  });
  assert.equal(result.status, "failed"); assert.equal(result.steps[0].error.code, "CAPABILITY_UNAVAILABLE"); assert.equal(result.steps[1].status, "not-run"); assert.equal(input, 0);
});

test("required final screenshot failures never convert completed device steps into a false overall pass", async () => {
  const { runHarmonyScenario } = await jiti.import("./harmony/scenario-executor.ts");
  for (const failure of ["missing", "capture", "save"]) {
    let actions = 0;
    const result = await runHarmonyScenario({ serial: "phone", leaseToken: "lease", steps: [{ action: "wait_idle" }], policy: { captureFinalScreenshot: true } }, {
      serial: "phone", generation: 1, signal: new AbortController().signal,
      backend: { kind: "fixture", async waitForIdle() { actions++; } }, invalidateSnapshot() {},
      capture: async () => {
        if (failure === "capture") throw new HarmonyError("DEVICE_NOT_FOUND", "Phone disconnected before final capture");
        return { serial: "phone", generation: 1, revision: 9, capturedAt: new Date().toISOString(), nodes: [], quality: fixtureQuality,
          ...(failure === "save" ? { screenshot: { mimeType: "image/png", width: 1, height: 1, data: Buffer.from("fixture") } } : {}) };
      },
      saveScreenshot: async () => { throw new HarmonyError("INVALID_RESPONSE", "Screenshot could not be saved"); },
    });
    assert.equal(actions, 1); assert.equal(result.steps[0].status, "passed"); assert.equal(result.completedSteps, 1);
    assert.equal(result.status, "failed", failure); assert.equal(result.finalScreenshot, undefined);
    assert.equal(result.finalObservationError.code, failure === "capture" ? "DEVICE_NOT_FOUND" : "INVALID_RESPONSE");
  }
  const optional = await runHarmonyScenario({ serial: "phone", leaseToken: "lease", steps: [{ action: "wait_idle" }] }, {
    serial: "phone", generation: 1, signal: new AbortController().signal,
    backend: { kind: "fixture", async waitForIdle() {} }, invalidateSnapshot() {},
    capture: async () => { throw new HarmonyError("DEVICE_NOT_FOUND", "Final UI observation unavailable"); },
  });
  assert.equal(optional.status, "passed"); assert.equal(optional.finalObservationError.code, "DEVICE_NOT_FOUND");
});
