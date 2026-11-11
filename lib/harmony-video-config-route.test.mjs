import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../app/api/harmony/config/route.ts", import.meta.url), "utf8");

function routeFixture() {
  const writes = [], exports = {};
  class HarmonyError extends Error { constructor(code, message) { super(message); this.code = code; } }
  const manager = { async updateConfig(patch) { writes.push(patch); return patch; }, async getDiagnostics() { return {}; } };
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, URL, Response,
    require(name) {
      if (name === "@/lib/bounded-json") return { parseJsonWithinLimit: request => request.json(), InvalidJsonBodyError: class extends Error {}, JsonBodyTooLargeError: class extends Error {} };
      if (name === "@/lib/harmony") return { getHarmonyDeviceManager: () => manager, discoverHdcCandidates: () => [] };
      if (name === "@/lib/harmony/artifacts") return { resolveHarmonyStorage: () => ({}) };
      if (name === "@/lib/harmony/errors") return { HarmonyError };
      if (name === "@/lib/request-security") return { hasJsonContentType: request => request.headers.get("content-type") === "application/json" };
      if (name === "../_shared") return { requireHarmonyAccess: () => null, noStoreJson: Response.json,
        harmonyErrorResponse: error => Response.json({ code: error.code, message: error.message }, { status: error.code === "INVALID_ARGUMENT" ? 400 : 500 }) };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return { writes, put: body => exports.PUT(new Request("http://localhost/api/harmony/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })) };
}

test("video settings accept only the bundled library and reject every external provider or path before reconfiguration", async () => {
  const { put, writes } = routeFixture();
  for (const video of [{ provider: "deveco" }, { provider: "hos-scrcpy", packageDirectory: "C:/external" }, { provider: "bundled", javaPath: "C:/java.exe" }, { provider: "bundled", packageDirectory: "C:/external" }, { provider: "unknown" }, {}, [], "external"]) {
    const response = await put({ video });
    assert.equal(response.status, 400, JSON.stringify(video));
    assert.equal((await response.json()).code, "INVALID_ARGUMENT");
  }
  assert.deepEqual(writes, []);
  const response = await put({ video: { provider: "bundled" }, storage: { recordingDirectory: "C:/recordings" } });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{ video: { provider: "bundled" }, storage: { recordingDirectory: "C:/recordings" } }]);
});
