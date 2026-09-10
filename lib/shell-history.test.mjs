import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
const { ShellStore } = await createJiti(import.meta.url).import("./shell/store.ts");
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

test("the history worker serves queries during large imports and drains records across chunk boundaries", { skip: process.env.PIORA_SKIP_RESOURCE_TESTS === "1", timeout: process.env.CI ? 180000 : 90000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-shell-import-"));
  const store = new ShellStore(root, false);
  t.after(async () => { await store.close(); assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(root).startsWith("piora-shell-import-")); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  await store.recordHistory(Array.from({ length: 100000 }, (_, i) => ({ id: "seed" + i, sourceId: "benchmark", source: "human", command: i % 5 === 0 ? `npm run dev -- --port ${3000 + i % 100}` : `git log --max-count=${i}`, cwd: "/project", shell: "bash", executedAt: i, importedAt: i })));
  const file = path.join(root, "history.txt");
  const multiline = "echo '" + "中文跨块\n".repeat(3000) + "'\n";
  const text = Array.from({ length: 30000 }, (_, i) => `echo import-${i}\n`).join("") + multiline;
  await writeFile(file, text);
  let complete = false;
  const importing = store.call("importSources", { sources: [{ id: "large-source", path: file, kind: "bash", enabled: true }] }).then(value => { complete = true; return value; });
  const timings = [];
  for (let i = 0; i < 22 && !complete; i++) {
    const start = performance.now();
    const result = await store.history({ query: "npm run dev", suggestions: true, cwd: "/project", shell: "bash", limit: 8 });
    assert.equal(result.records.length, 8);
    if (i > 1) timings.push(performance.now() - start);
  }
  assert.ok(timings.length >= 3, "multiple foreground queries complete before the importer does");
  timings.sort((a, b) => a - b);
  const p95 = timings[Math.floor(timings.length * .95)];
  t.diagnostic(`100,000 existing rows during import; foreground query P95 ${p95.toFixed(1)}ms; samples ${timings.map(value => value.toFixed(1)).join(", ")}`);
  const foregroundBudgetMs = process.env.CI ? 1500 : 100;
  assert.ok(p95 < foregroundBudgetMs, `Import interfered with autocomplete: P95 ${p95.toFixed(1)}ms`);
  const [status] = await importing;
  assert.equal(status.offset, Buffer.byteLength(text)); assert.equal(status.imported, 30001); assert.equal(status.pending, false);
  assert.equal((await store.history({ query: "跨块", limit: 1 })).records[0].command, multiline.trimEnd());
  const checkpoint = await store.call("getValue", { key: "source:large-source" });
  assert.equal(checkpoint.counts, undefined, "checkpoints do not grow with every unique command");
  assert.ok(JSON.stringify(checkpoint).length < 1024);
  const [again] = await store.call("importSources", { sources: [{ id: "large-source", path: file, kind: "bash", enabled: true }] });
  assert.equal(again.imported, 30001);
});

test("100k history search is indexed, deduplicates suggestions and stays under the hot-query budget", { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-shell-search-"));
  const db = new ShellDatabase(root);
  t.after(async () => { db.dispatch("close"); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const records = Array.from({ length: 100000 }, (_, i) => ({ id: "h" + i, sourceId: "benchmark", source: "human", command: i % 5 === 0 ? `npm run dev -- --port ${3000 + i % 100}` : `git log --max-count=${i}`, cwd: "/project", shell: "bash", executedAt: i, importedAt: i }));
  db.historyUpsert({ records });
  const timings = [];
  for (let i = 0; i < 25; i++) {
    const start = performance.now(); const result = db.queryHistory({ query: "npm run dev", suggestions: true, cwd: "/project", shell: "bash", limit: 8 });
    const elapsed = performance.now() - start;
    assert.equal(result.records.length, 8); assert.equal(new Set(result.records.map(r => r.command)).size, 8);
    if (i > 2) timings.push(elapsed);
  }
  timings.sort((a, b) => a - b);
  const p95 = timings[Math.floor(timings.length * .95)];
  t.diagnostic(`100,000 history rows; hot search P95 ${p95.toFixed(1)}ms`);
  assert.ok(p95 < 100, `P95 ${p95.toFixed(1)}ms exceeds 100ms`);
});
