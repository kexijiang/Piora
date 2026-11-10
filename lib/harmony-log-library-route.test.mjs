import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createLogLibrary } from "./harmony/log-library/vendor/log-library.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const native = createRequire(import.meta.url);
function loadRoute(library) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const record = { exports: {} }; cache.set(filename, record);
    const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const require = specifier => {
      if (specifier === "@/lib/harmony/log-library/runtime") return { getHarmonyLogLibrary: async () => library };
      if (specifier === "@/lib/session-reader") return { resolveSessionPath: async id => ["A", "B"].includes(id) ? "/fixture/" + id : null };
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return native(specifier);
      const base = specifier.startsWith("@/") ? join(root, specifier.slice(2)) : resolve(dirname(filename), specifier);
      const target = [base, base + ".ts", base + ".js"].find(file => existsSync(file));
      if (!target) throw new Error("Unresolved fixture import: " + specifier);
      return target.endsWith(".ts") ? load(target) : native(target);
    };
    new Function("require", "exports", "module", code)(require, record.exports, record);
    return record.exports;
  }
  return load(join(root, "app/api/harmony/log-library/[...operation]/route.ts"));
}
async function fixture(work) {
  const directory = await mkdtemp(join(tmpdir(), "piora-logs-route-"));
  const library = createLogLibrary(directory), routes = loadRoute(library);
  const previous = process.env.PI_DESKTOP_TOKEN; process.env.PI_DESKTOP_TOKEN = "log-route-fixture";
  const call = (operation, { sessionId = "A", method = "GET", body, headers = {}, rawBody, params = {} } = {}) => {
    const request = new Request("http://127.0.0.1:30141/api/harmony/log-library/" + operation + "?" + new URLSearchParams({ sessionId, ...params }), { method,
      headers: { host: "127.0.0.1:30141", "x-pi-desktop-token": "log-route-fixture", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(rawBody !== undefined ? { body: rawBody, duplex: "half" } : body === undefined ? {} : { body: JSON.stringify(body) }) });
    return routes[method](request, { params: Promise.resolve({ operation: operation.split("/") }) });
  };
  try { await work({ call, library }); }
  finally { if (previous === undefined) delete process.env.PI_DESKTOP_TOKEN; else process.env.PI_DESKTOP_TOKEN = previous; await library.dispose(); await rm(directory, { recursive: true, force: true }); }
}

test("log API requires desktop authentication, same-origin access and an existing session", () => fixture(async ({ call }) => {
  assert.equal((await call("list", { headers: { "x-pi-desktop-token": "wrong" } })).status, 403);
  assert.equal((await call("list", { headers: { origin: "https://untrusted.test" } })).status, 403);
  assert.equal((await call("list", { sessionId: "" })).status, 404);
  assert.equal((await call("list", { sessionId: "missing" })).status, 404);
  const response = await call("capabilities"); assert.equal(response.status, 200);
  assert.equal((await response.json()).sessionId, "A");
}));

test("chunked import, search, analysis and export preserve exact ownership and original lines", () => fixture(async ({ call }) => {
  const content = "first\n\nneedle token=secret-value\n";
  const begun = await call("begin", { method: "POST", body: { name: "fixture.log", size: Buffer.byteLength(content) } });
  assert.equal(begun.status, 200); const { id } = await begun.json();
  assert.equal((await call("chunk", { method: "POST", params: { id, index: "0" }, rawBody: Buffer.from(content) })).status, 200);
  assert.equal((await call("finish", { method: "POST", body: { id } })).status, 200);
  const page = await (await call("logs", { params: { id, query: "needle" } })).json();
  assert.equal(page.entries.length, 1); assert.equal(page.entries[0].sourceLine, 3);
  const results = await (await call("search", { params: { query: "needle" } })).json(); assert.equal(results.filteredTotal, 1);
  for (const operation of ["info", "logs", "source", "export"]) assert.equal((await call(operation, { sessionId: "B", params: { id } })).status, 400, operation);
  assert.equal((await call("rename", { sessionId: "B", method: "POST", body: { id, name: "wrong.log" } })).status, 400);
  assert.equal((await (await call("source", { params: { id } })).text()), content);
  const analysis = await (await call("analysis", { method: "POST", body: { id } })).json();
  const readable = await readFile(analysis.files[0].path, "utf8");
  assert.match(readable, /needle/); assert.doesNotMatch(readable, /secret-value/);
  assert.match(await (await call("export", { params: { id, query: "needle" } })).text(), /needle/);
  assert.equal((await (await call("list", { sessionId: "B" })).json()).total, 0);
}));

test("streamed oversized chunks and JSON are bounded even without content-length", () => fixture(async ({ call }) => {
  const stream = () => new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(256 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
  assert.equal((await call("chunk", { method: "POST", params: { id: "anything", index: "0" }, rawBody: stream() })).status, 413);
  assert.equal((await call("begin", { method: "POST", body: { name: "x".repeat(512 * 1024) } })).status, 413);
  assert.equal((await call("begin", { method: "POST", body: [] })).status, 400);
  assert.equal((await call("begin", { method: "POST", rawBody: "{}" })).status, 415);
}));
