import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("@/lib/session-reader");
const { readHistorySnapshot, readHistoryDetails } = await jiti.import("@/lib/session-history-store");
const { GET: exportHistory } = await jiti.import("../app/api/sessions/[id]/history/export/route.ts");
const { GET: deferredContent } = await jiti.import("../app/api/sessions/[id]/history/content/route.ts");

test("history GETs preserve the source file, raw export scope and snapshot version", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "piora-history-data-"));
  const file = path.join(directory, "session.jsonl");
  const id = randomUUID(), timestamp = "2026-09-12T03:00:00.000Z";
  const message = (id, parentId, message) => ({ type: "message", id, parentId, timestamp, message });
  const rows = [
    { type: "session", version: 3, id, timestamp, cwd: directory },
    message("q1", null, { role: "user", content: "压缩前的问题" }),
    message("a1", "q1", { role: "assistant", content: [{ type: "thinking", thinking: "保存的完整思考" }, { type: "text", text: "压缩前的回答" }] }),
    { type: "compaction", id: "compact", parentId: "a1", timestamp, summary: "历史摘要", firstKeptEntryId: "a1", tokensBefore: 100 },
    message("q2", "compact", { role: "user", content: "当前问题" }),
    message("branch", "q1", { role: "assistant", content: [{ type: "text", text: "另外的分支" }] }),
  ];
  const source = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  const previousListCache = globalThis.__piSessionListCache;
  try {
    writeFileSync(file, source); cacheSessionPath(id, file);
    globalThis.__piSessionListCache = { data: [], ts: Date.now() };
    const snapshot = await readHistorySnapshot(id);
    assert.equal(snapshot.entries.length, 5);
    const details = readHistoryDetails(snapshot, "q2", ["q1", "a1", "compact"]);
    assert.equal(details[0].message.content, "压缩前的问题");
    assert.equal(details[1].message.content[0].deferred, true);
    assert.equal(details[2].message.content, "历史摘要");
    assert.throws(() => readHistoryDetails(snapshot, "q2", ["branch"]), /selected branch/);
    const params = { params: Promise.resolve({ id }) };
    const url = `http://localhost/api/sessions/${id}/history`;
    const version = encodeURIComponent(snapshot.index.version);
    const thinking = await deferredContent(new Request(`${url}/content?entryId=a1&kind=thinking&blockIndex=0&version=${version}`), params);
    assert.deepEqual(await thinking.json(), { thinking: "保存的完整思考" });
    const raw = await exportHistory(new Request(`${url}/export?format=json&leafId=q2&entryId=q1&version=${version}`), params);
    assert.equal((await raw.json()).entries.length, 5, "JSON always includes every internal branch");
    const markdown = await exportHistory(new Request(`${url}/export?format=markdown&leafId=q2&version=${version}`), params);
    const body = await markdown.text();
    assert.match(body, /压缩前的问题/); assert.match(body, /历史摘要/); assert.doesNotMatch(body, /另外的分支/);
    assert.equal(readFileSync(file, "utf8"), source, "reading and exporting must not rewrite the session");
    writeFileSync(file, source + JSON.stringify(message("new", "branch", { role: "user", content: "新增记录" })) + "\n");
    const stale = await deferredContent(new Request(`${url}/content?entryId=a1&kind=thinking&blockIndex=0&version=${version}`), params);
    assert.equal(stale.status, 409);
  } finally {
    globalThis.__piSessionListCache = previousListCache;
    invalidateSessionPathCache(id);
    assert.ok(path.resolve(directory).startsWith(`${path.resolve(tmpdir())}${path.sep}piora-history-data-`));
    rmSync(directory, { recursive: true, force: true });
  }
});
