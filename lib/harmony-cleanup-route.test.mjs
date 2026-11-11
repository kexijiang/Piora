import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": join(import.meta.dirname, "..") } });
const shared = await jiti.import("../app/api/harmony/_shared.ts");
const errors = await jiti.import("./harmony/errors.ts");
const boundedJson = await jiti.import("./bounded-json.ts");
const requestSecurity = await jiti.import("./request-security.ts");
const source = await readFile(new URL("../app/api/harmony/recovery/route.ts", import.meta.url), "utf8");

test("mirror recovery authenticates, retries owned cleanup and requires explicit release confirmation", async t => {
  const previous = { token: process.env.PI_DESKTOP_TOKEN, mode: process.env.PIORA_HARMONY_WORKBENCH };
  process.env.PI_DESKTOP_TOKEN = "a".repeat(64); process.env.PIORA_HARMONY_WORKBENCH = "0";
  t.after(() => {
    for (const [key, value] of [["PI_DESKTOP_TOKEN", previous.token], ["PIORA_HARMONY_WORKBENCH", previous.mode]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const calls = [], exports = {};
  let pending = false, cleanupConfirmed = false;
  const device = { serial: "phone", state: "online", generation: 7 };
  const manager = {
    async retryCleanup(serial) { calls.push(["retry", serial]); return { cleanup: "uncertain" }; },
    async confirmCleanup(serial) {
      calls.push(["confirm", serial]);
      if (pending) throw new errors.HarmonyError("DEVICE_BUSY", "Old driver is still stopping", { details: { serial, state: "stopping" } });
      cleanupConfirmed = true;
      return { cleanup: "manual-confirmed" };
    },
    getState: () => ({ devices: [device], controls: cleanupConfirmed ? [] : [{ serial: "phone", status: "recovering" }], leases: [{ token: "never-expose" }] }),
  };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, require(name) {
      if (name === "../_shared") return shared;
      if (name === "@/lib/harmony/errors") return errors;
      if (name === "@/lib/bounded-json") return boundedJson;
      if (name === "@/lib/request-security") return requestSecurity;
      if (name === "@/lib/harmony") return { getHarmonyDeviceManager: () => manager };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  const request = (body, { auth = true, origin, json = true } = {}) => new Request("http://localhost:30141/api/harmony/recovery", {
    method: "POST", headers: { host: "localhost:30141", ...(json ? { "content-type": "application/json" } : {}),
      ...(auth ? { "x-pi-desktop-token": process.env.PI_DESKTOP_TOKEN } : {}), ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
  const retry = { action: "retry", serial: "phone" };
  assert.equal((await exports.POST(request(retry, { auth: false }))).status, 403);
  assert.equal((await exports.POST(request(retry, { origin: "https://untrusted.example" }))).status, 403);
  assert.equal((await exports.POST(request(retry, { json: false }))).status, 415);
  for (const body of [null, {}, { ...retry, serial: "" }, { ...retry, serial: "x".repeat(257) }, { ...retry, action: "tap" },
    { action: "confirm", serial: "phone" }, { action: "confirm", serial: "phone", released: true }]) {
    assert.equal((await exports.POST(request(body))).status, 400);
  }
  assert.deepEqual(calls, [], "rejected requests must not touch cleanup or input");
  const response = await exports.POST(request(retry));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cleanup: "uncertain", controlStatus: "recovering", device });
  assert.deepEqual(calls, [["retry", "phone"]], "reconnect does not acknowledge physical release");
  assert.match(response.headers.get("cache-control"), /no-store/);
  const confirmation = { action: "confirm", serial: "phone", released: true, recordingStopped: true };
  pending = true;
  const blocked = await exports.POST(request(confirmation));
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error.details.state, "stopping");
  pending = false;
  const recovered = await exports.POST(request(confirmation));
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { cleanup: "manual-confirmed", controlStatus: null, device });
});
