import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { filterCommandHistory, rememberCommand, readCommandHistory, terminalHistoryKey } = await createJiti(import.meta.url).import("./command-history.ts");

test("terminal history is project scoped, deduplicated, bounded and tolerates invalid storage", () => {
  assert.equal(terminalHistoryKey("C:\\Workspace\\sample\\"), terminalHistoryKey("c:/workspace/sample"));
  assert.notEqual(terminalHistoryKey("/project/A"), terminalHistoryKey("/project/a"));
  assert.deepEqual(rememberCommand(["git diff", "git status"], " git status "), ["git status", "git diff"]);
  assert.equal(rememberCommand(Array.from({ length: 250 }, (_, index) => `echo ${index}`), "new").length, 200);
  const storage = { getItem: () => JSON.stringify(["git status", null, 42, "", "git status", "npm test"]) };
  assert.deepEqual(readCommandHistory(storage, "/project"), ["git status", "npm test"]);
  assert.deepEqual(readCommandHistory({ getItem: () => "bad json" }, "/project"), []);
});

test("command history suggestions rank exact, prefix, token, and substring matches", () => {
  const history = [
    "npm run lint",
    "git status --short",
    "npm test",
    "git diff --stat",
    "status-check",
  ];
  assert.deepEqual(filterCommandHistory(history, "git sta"), ["git status --short", "git diff --stat"]);
  assert.deepEqual(filterCommandHistory(history, "status"), ["status-check", "git status --short"]);
  assert.deepEqual(filterCommandHistory(history, "npm test"), ["npm test"]);
  assert.deepEqual(filterCommandHistory(history, "  "), []);
});

test("command history suggestions preserve recency and stay bounded", () => {
  assert.deepEqual(
    filterCommandHistory(["npm run test", "npm run lint", "npm run dev"], "npm", 2),
    ["npm run test", "npm run lint"],
  );
});
