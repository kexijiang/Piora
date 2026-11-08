import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { workerEnvironment, HypiumWorkerClient } = await jiti.import("./harmony/runtime/worker-client.ts");
const { acquireDeviceLock } = await jiti.import("./harmony/runtime/device-lock.ts");
test("worker HDC environment does not change parent PATH", () => {
  const before = process.env.PATH;
  const env = workerEnvironment(resolve("fake/hdc.exe"), { Path: "original", TEST: "kept" });
  assert.match(env.Path, /original$/); assert.equal(env.TEST, "kept"); assert.equal(process.env.PATH === before, true, "Parent PATH must stay unchanged");
});
test("compiled worker starts and exits without loading a device or mutating parent PATH", async () => {
  const child = spawn(process.execPath, [resolve(".harmony-worker/harmony/runtime/worker-entry.js")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let errors = ""; child.stderr.on("data", chunk => errors += chunk);
  await new Promise(resolve => child.once("spawn", resolve));
  const exited = new Promise(resolve => child.once("exit", (code) => resolve(code)));
  child.disconnect();
  assert.equal(await exited, 0, errors);
});
test("worker timeout and crash retain unknown dispatch rather than triggering fallback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-worker-test-"));
  const entry = join(directory, "fake.cjs");
  writeFileSync(entry, 'process.on("message", m => { if (m.args[0] === "crash") process.exit(2); if (m.args[0] === "ok") process.send({protocol:m.protocol,epoch:m.epoch,id:m.id,value:{used:true,value:1}}); });');
  const client = new HypiumWorkerClient("fake-hdc", entry, 300);
  try {
    assert.deepEqual(await client.execute("a", "ok", []), { used: true, value: 1 });
    await assert.rejects(client.execute("a", "crash", []), error => error.code === "AUTOMATION_DRIVER_FAILED" && error.details.dispatchState === "unknown");
    await assert.rejects(client.execute("b", "hang", []), error => error.code === "COMMAND_TIMEOUT" && error.details.dispatchState === "unknown");
  } finally { await client.reset(); rmSync(directory, { recursive: true, force: true }); }
});

test("reset lets an idle worker release its own transport before exiting", async () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-worker-cleanup-"));
  const entry = join(directory, "fake.cjs"), marker = join(directory, "released");
  writeFileSync(entry, `process.on('message',m=>process.send({protocol:m.protocol,epoch:m.epoch,id:m.id,value:{used:true}}));process.on('disconnect',()=>setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'released');process.exit(0)},50));`);
  const client = new HypiumWorkerClient("fake-hdc", entry);
  try {
    await client.execute("phone", "tap", [1, 1]);
    await client.reset();
    assert.equal(existsSync(marker), true, "reset must wait for owned RPC transport cleanup");
  } finally { await client.reset(); rmSync(directory, { recursive: true, force: true }); }
});
test("physical device ownership is exclusive across processes and separate across serials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "piora-device-lock-"));
  const first = acquireDeviceLock("phone", directory);
  const second = acquireDeviceLock("phone-2", directory);
  try {
    assert.throws(() => acquireDeviceLock("phone", directory), error => error.code === "DEVICE_BUSY");
    const script = `const { acquireDeviceLock } = require(${JSON.stringify(resolve(".harmony-worker/harmony/runtime/device-lock.js"))}); try { acquireDeviceLock("phone",process.argv[1]); process.exit(1) } catch(e) { process.exit(e.code === "DEVICE_BUSY" ? 0 : 2) }`;
    const child = spawn(process.execPath, ["-e", script, directory], { windowsHide: true, stdio: "ignore" });
    assert.equal(await new Promise(resolve => child.once("exit", resolve)), 0);
  } finally { first.release(); second.release(); rmSync(directory, { recursive: true, force: true }); }
});


test("worker protocol rejects foreign epochs, expired requests and arbitrary commands before dispatch", async () => {
  const { validateWorkerRequest } = await jiti.import("./harmony/runtime/worker-protocol.ts");
  const request = { protocol: 1, epoch: "current", id: 1, deadline: Date.now() + 30000, serial: "phone", method: "execute", args: ["tap", [10, 20]] };
  assert.doesNotThrow(() => validateWorkerRequest(request, "current", "phone"));
  assert.doesNotThrow(()=>validateWorkerRequest({...request,args:["display_geometry",[]]},"current","phone"));
  assert.throws(()=>validateWorkerRequest({...request,args:["display_geometry",["shell"]]},"current","phone"));
  for (const key of ["volume_up", "volume_down", "power"]) assert.doesNotThrow(() => validateWorkerRequest({...request,args:["press_key",[key]]},"current","phone"));
  assert.throws(() => validateWorkerRequest({...request,args:["press_key",["shell"]]},"current","phone"));
  for (const changed of [{ epoch: "old" }, { protocol: 2 }, { serial: "other" }, { deadline: Date.now() - 1 }, { args: ["shell", ["echo x"]] }]) {
    assert.throws(() => validateWorkerRequest({ ...request, ...changed }, "current", "phone"), error => error.details.dispatchState === "not-sent");
  }
});
