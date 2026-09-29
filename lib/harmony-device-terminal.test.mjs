import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const jiti = createJiti(import.meta.url);
const { startDeviceTerminal, getDeviceTerminal, controlDeviceTerminal } = await jiti.import("./harmony/device-terminal.ts");

test("interactive HDC terminal keeps shell state in one owned PTY and closes on lease loss", async () => {
  const originalSpawn = pty.spawn;
  const previousManager = globalThis.__pioraHarmonyDeviceManager;
  const calls = [];
  let dataListener, exitListener, killed = false, valid = true;
  pty.spawn = (executable, args, options) => {
    calls.push({ executable, args, options });
    return {
      onData(listener) { dataListener = listener; },
      onExit(listener) { exitListener = listener; },
      write(data) { calls.push({ write: data }); },
      resize(cols, rows) { calls.push({ resize: [cols, rows] }); },
      kill() { killed = true; exitListener?.({ exitCode: 0 }); },
    };
  };
  const lease = { token: "test-lease", serial: "test-phone", owner: { kind: "manual", id: "test" } };
  globalThis.__pioraHarmonyDeviceManager = {
    renewLease(token) { if (!valid || token !== lease.token) throw new Error("expired"); return lease; },
    async listDevices() { return [{ serial: lease.serial, state: "online" }]; },
    getState() { return { runtime: { hdcPath: "C:\\SDK\\hdc.exe" }, leases: valid ? [lease] : [] }; },
  };
  let id;
  try {
    id = await startDeviceTerminal("test-phone", "test-lease", { kind: "sandbox", bundleName: "com.example.app" });
    assert.deepEqual(calls[0].args, ["-t", "test-phone", "shell", "-b", "com.example.app"]);
    const events = [];
    const unsubscribe = getDeviceTerminal(id).subscribe(event => events.push(event));
    dataListener("$ ");
    controlDeviceTerminal(id, "test-lease", "input", "cd data/storage\r");
    controlDeviceTerminal(id, "test-lease", "resize", undefined, 90, 25);
    controlDeviceTerminal(id, "test-lease", "keepalive");
    assert(calls.some(call => call.write === "cd data/storage\r"));
    assert(calls.some(call => JSON.stringify(call.resize) === "[90,25]"));
    assert(events.some(event => event.type === "output" && event.data === "$ "));
    assert.throws(() => controlDeviceTerminal(id, "wrong-lease", "input", "pwd\r"));
    unsubscribe();
    valid = false;
    await new Promise(resolve => setTimeout(resolve, 5_100));
    assert.equal(killed, true);
    assert.throws(() => getDeviceTerminal(id));
  } finally {
    if (id) { try { controlDeviceTerminal(id, "test-lease", "stop"); } catch { /* Already stopped. */ } }
    pty.spawn = originalSpawn;
    globalThis.__pioraHarmonyDeviceManager = previousManager;
  }
});
