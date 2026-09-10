import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { ShellStore } = await jiti.import("./shell/store.ts");
const { searchHistoryByIntent, normalizeHistoryFilters } = await jiti.import("./shell/history-search.ts");
const reply = value => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const record = (id, extra = {}) => ({ id, sourceId: "source", source: "human", command: "npm run dev", cwd: "/project", shell: "bash", executedAt: null, importedAt: Date.now(), exitCode: null, status: null, favorite: true, terminalId: null, sessionId: null, ...extra });
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-shell-semantic-"));
  const store = new ShellStore(directory, false);
  t.after(async () => { await store.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith("piora-shell-semantic-")); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return { store, session: { state: { cwd: "/project", profile: { kind: "bash" } }, store } };
}
const services = complete => ({ sync: async () => [], resolveModel: async () => ({ model: {}, modelRuntime: { completeSimple: complete } }) });

test("semantic history respects filters and returns only authoritative local records", async t => {
  const { store, session } = await fixture(t);
  const actual = record("actual", { command: "npm run dev --token confidential-test-value" });
  await store.recordHistory([actual, record("other-directory", { cwd: "/elsewhere" }), record("other-source", { source: "pi-agent" }), record("not-favorite", { favorite: false }), record("other-shell", { shell: "powershell" })]);
  let calls = 0;
  const result = await searchHistoryByIntent(session, "上次启动开发服务的命令", new AbortController().signal, normalizeHistoryFilters({ cwd: "/project", source: "human", favorite: true, shell: "bash" }), services(async (_model, context) => {
    if (!calls++) return reply(["dev", "npm"]);
    const data = JSON.parse(context.messages[0].content);
    assert.deepEqual(data.records.map(item => item.id), ["actual"]);
    assert.match(data.records[0].command, /\[REDACTED\]/); assert.doesNotMatch(data.records[0].command, /confidential-test-value/);
    return reply(["invented", { id: "actual", command: "model-rewrite" }, "actual", "actual", "other-directory"]);
  }));
  assert.equal(calls, 2); assert.deepEqual(result.records, [actual]);
  assert.equal(result.records[0].executedAt, null, "unknown dates stay unknown");
  assert.throws(() => normalizeHistoryFilters({ source: "invented" }), /Invalid history/);
  assert.throws(() => normalizeHistoryFilters({ favorite: "true" }), /Invalid history/);
});

test("a delayed semantic result cannot resurrect deletion or removed favorites", async t => {
  const { store, session } = await fixture(t);
  await store.recordHistory([record("removed"), record("unstarred"), record("retained")]);
  assert.equal(await store.call("favoriteHistory", { id: "missing", favorite: true }), false, "missing records cannot pretend to be saved favorites");
  let calls = 0;
  const result = await searchHistoryByIntent(session, "开发服务", new AbortController().signal, { favorite: true }, services(async () => {
    if (!calls++) return reply(["dev"]);
    await store.call("deleteHistory", { id: "removed" });
    await store.call("favoriteHistory", { id: "unstarred", favorite: false });
    return reply(["removed", "unstarred", "retained"]);
  }));
  assert.deepEqual(result.records.map(item => item.id), ["retained"]);
});

test("cancelled or malformed model searches cannot continue with fabricated results", async t => {
  const { store, session } = await fixture(t);
  await store.recordHistory([record("actual")]);
  let calls = 0;
  const controller = new AbortController();
  await assert.rejects(searchHistoryByIntent(session, "开发", controller.signal, {}, services(async () => { calls++; controller.abort(); return reply(["dev"]); })), /abort/i);
  assert.equal(calls, 1);
  await assert.rejects(searchHistoryByIntent(session, "开发", new AbortController().signal, {}, services(async () => ({ content: [{ type: "text", text: "I think you ran a command" }] }))), /valid history search result/);
});
