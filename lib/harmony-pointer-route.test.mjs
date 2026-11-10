import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": join(import.meta.dirname, "..") } });
const source = await readFile(new URL("../app/api/harmony/pointer/route.ts", import.meta.url), "utf8");
const dependencies = Object.fromEntries(await Promise.all([
  ["../_shared", "../app/api/harmony/_shared.ts"],
  ["@/lib/harmony/errors", "./harmony/errors.ts"],
  ["@/lib/bounded-json", "./bounded-json.ts"],
  ["@/lib/request-security", "./request-security.ts"],
].map(async ([name, path]) => [name, await jiti.import(path)])));

test("pointer route authenticates, bounds input and preserves the release identity", async t => {
  const previous = process.env.PI_DESKTOP_TOKEN; process.env.PI_DESKTOP_TOKEN = "a".repeat(64);
  t.after(() => { if (previous === undefined) delete process.env.PI_DESKTOP_TOKEN; else process.env.PI_DESKTOP_TOKEN = previous; });
  const calls = [], exports = {}, gestureId = "f".repeat(32);
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, URL, Response,
    require(name) {
      if (dependencies[name]) return dependencies[name];
      if (name === "@/lib/harmony") return { getHarmonyDeviceManager: () => ({
        async beginManualPointer(value) { calls.push(["begin", value]); return { gestureId }; },
        async updateManualPointer(value) { calls.push(["update", value]); },
      }) };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  const body = { serial: "phone", leaseToken: "lease", phase: "down", x: 12, y: 34, geometryId: "geometry", generation: 3 };
  const request = (value, overrides = {}) => new Request("http://localhost:30141/api/harmony/pointer", {
    method: "POST", headers: { host: "localhost:30141", "Content-Type": "application/json", "x-pi-desktop-token": process.env.PI_DESKTOP_TOKEN, ...overrides }, body: typeof value === "string" ? value : JSON.stringify(value),
  });
  assert.equal((await exports.POST(request(body, { "x-pi-desktop-token": "wrong" }))).status, 403);
  assert.equal((await exports.POST(request(body, { origin: "https://untrusted.example" }))).status, 403);
  assert.equal((await exports.POST(request(body, { "Content-Type": "text/plain" }))).status, 415);
  assert.equal((await exports.POST(request("{"))).status, 400);
  assert.equal((await exports.POST(request({ ...body, padding: "x".repeat(2048) }))).status, 413);
  for (const invalid of [null, { ...body, x: NaN }, { ...body, x: -1 }, { ...body, x: 1.5 }, { ...body, y: 16385 }, { ...body, generation: 0 }, { ...body, phase: "move", gestureId: "foreign" }]) {
    assert.equal((await exports.POST(request(invalid))).status, 400);
  }
  assert.deepEqual(calls, []);
  const response = await exports.POST(request(body));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { gestureId });
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(calls[0][1].coordinateSpace, "frame"); assert.equal(calls[0][1].signal.aborted, false);
  assert.equal((await exports.POST(request({ serial: "phone", leaseToken: "lease", phase: "up", gestureId }))).status, 200);
  assert.equal(calls[1][1].gestureId, gestureId); assert.equal(calls[1][1].leaseToken, "lease");
});
