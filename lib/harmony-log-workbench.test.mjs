import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
// Include the upstream behavioral suites in the repository's root test glob.
import "./harmony/log-library/tests/log-packages.test.mjs";
import "./harmony/log-library/tests/session-search.test.mjs";

function load(file) {
  const output = {};
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("exports", code)(output);
  return output;
}
const { LogRingBuffer } = load("./harmony/log-buffer.ts");
const { createLogMatcher, logHighlightParts } = load("./harmony/log-workbench-filter.ts");
const { logApplicationPids, logBelongsToApplication } = load("./harmony/log-application.ts");
const row = id => ({ id, raw: "entry " + id, message: "message " + id });

test("live ring keeps ordered retained rows and reports eviction without copying the old buffer", () => {
  const ring = new LogRingBuffer(3, 1024);
  ring.push([row(1), row(2)]); assert.equal(ring.push([row(3), row(4)]).removed, 1);
  assert.deepEqual(ring.snapshot().map(item => item.id), [2, 3, 4]);
  ring.clear(); assert.equal(ring.length, 0); assert.equal(ring.bytes, 0);
  assert.throws(() => new LogRingBuffer(0, 1), /budget/);
});
test("live byte budget evicts oversized payloads before the row limit", () => {
  const ring = new LogRingBuffer(100, 80);
  ring.push([row(1), row(2), row(3)]);
  assert.ok(ring.bytes <= 80); assert.ok(ring.length < 3);
  ring.push([{ id: 4, raw: "x".repeat(100), message: "x".repeat(100) }]);
  assert.equal(ring.length, 0); assert.equal(ring.bytes, 0);
});
test("live app membership matches subprocesses and does not include similar bundle names", () => {
  const pids = logApplicationPids([{ pid: 1, name: "com.example.app:worker" }, { pid: 2, name: "com.example.application" }], "com.example.app");
  assert.ok(pids.has(1)); assert.ok(!pids.has(2));
  assert.equal(logBelongsToApplication({ pid: 1 }, "com.example.app", pids), true);
  assert.equal(logBelongsToApplication({ pid: 2 }, "com.example.app", pids), false);
});
test("live bounded regex and highlight preserve text and case-sensitive matching", () => {
  assert.ok(createLogMatcher("(a+)+$", true).error);
  assert.equal(createLogMatcher("Error", false, true).matches("error"), false);
  assert.equal(createLogMatcher("Error", false, false).matches("error"), true);
  const parts = logHighlightParts("first Error then error", "error");
  assert.equal(parts.map(part => part.text).join(""), "first Error then error");
  assert.equal(parts.filter(part => part.match).length, 2);
});
