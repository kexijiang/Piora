import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
const require = createRequire(import.meta.url);
const { ShellDatabase } = require("./shell/runtime/store-worker.cjs");
const { parseHistory, parsePi, importSources } = require("./shell/runtime/history-import.cjs");

test("native history parsers preserve multiline commands and unknown metadata", () => {
  const complete = "Get-ChildItem\nWrite-Output `\n'中文'\n";
  assert.deepEqual(parseHistory(complete + "unfinished", "powershell"), { records: [{ command: "Get-ChildItem", executedAt: null }, { command: "Write-Output \n'中文'", executedAt: null }], consumed: complete.length });
  const bash = parseHistory("#1700000000\necho 'line one\nline two'\nfalse\n", "bash");
  assert.equal(bash.records[0].command, "echo 'line one\nline two'");
  assert.equal(bash.records[0].executedAt, 1700000000000); assert.equal(bash.records[1].executedAt, null);
  const zsh = parseHistory(": 1700000000:0;echo line\\\ntwo\n", "zsh");
  assert.deepEqual(zsh.records, [{ command: "echo line\ntwo", executedAt: 1700000000000 }]);
  const heredoc = "cat <<'END'\nhello\nEND\n";
  assert.equal(parseHistory(heredoc, "bash").records[0].command, heredoc.trimEnd());
});

test("Pi import includes all tool-call records, matches results and does not invent exit codes", () => {
  const state = {};
  const text = [
    { type: "session", id: "session1", cwd: "/project" },
    { type: "message", id: "m1", timestamp: "2026-09-01T00:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call1", name: "bash", arguments: { command: "git status" } }] } },
    { type: "message", id: "m2", message: { role: "toolResult", toolCallId: "call1", isError: false } },
  ].map(item => JSON.stringify(item)).join("\n") + "\n";
  const { records } = parsePi(text, { id: "source1" }, state);
  assert.equal(records.length, 2); assert.equal(records[0].id, records[1].id);
  assert.equal(records[1].status, "completed"); assert.equal(records[1].exitCode, null);
  assert.equal(records[1].cwd, "/project");
});

test("history import commits cursors, handles appends/rotation, and preserves deletion tombstones", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-shell-history-"));
  const db = new ShellDatabase(root);
  t.after(async () => { db.dispatch("close"); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const file = path.join(root, "history.txt"); await writeFile(file, "git status\n");
  const sources = [{ id: "test-source", path: file, kind: "bash", enabled: true }];
  await importSources(db, { sources }); await importSources(db, { sources });
  let records = db.queryHistory({}).records; assert.equal(records.length, 1);
  assert.equal(records[0].cwd, null); assert.equal(records[0].executedAt, null);
  await appendFile(file, "npm run dev\n"); await importSources(db, { sources });
  assert.equal(db.queryHistory({}).records.length, 2);
  db.dispatch("deleteHistory", { id: records[0].id });
  await writeFile(file, "git status\n"); await importSources(db, { sources });
  assert.equal(db.queryHistory({ query: "git status" }).records.length, 0);
  await appendFile(file, "echo 'unfinished\n"); await importSources(db, { sources });
  await appendFile(file, "finished'\n"); await importSources(db, { sources });
  records = db.queryHistory({ query: "unfinished" }).records;
  assert.equal(records.length, 1); assert.equal(records[0].command, "echo 'unfinished\nfinished'");
});
