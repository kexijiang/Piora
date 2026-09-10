import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const { ClipboardDatabase } = await createJiti(import.meta.url).import("../desktop/src/clipboard-database.ts");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
async function fixture(t, prepare) {
  const root = await mkdtemp(join(tmpdir(), "piora-clipboard-db-"));
  if (prepare) await prepare(root);
  let time = 1_800_000_000_000;
  const db = new ClipboardDatabase(root, () => time);
  t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, db, advance: ms => { time += ms; } };
}
test("multi-format history preserves originals and deduplicates by full format set", async t => {
  const { db, advance } = await fixture(t);
  const id = db.capture({ text: "hello", html: "<b>hello</b>", image: png, source: { name: "Editor", executable: "C:\\Editor.exe" } });
  db.mutate({ type: "star", ids: [id], value: true });
  db.mutate({ type: "remark", id, value: "important" });
  advance(100);
  assert.equal(db.capture({ text: "hello", html: "<b>hello</b>", image: png }), id);
  const detail = db.detail(id);
  assert.ok(db.status().databaseBytes > 0, 'database, index and WAL bytes are reported separately from the content budget');
  assert.equal(detail.copies, 2); assert.equal(detail.starred, true); assert.equal(detail.remark, "important");
  assert.equal(detail.html, "<b>hello</b>"); assert.equal(detail.text, "hello"); assert.equal(detail.image.width, 1);
  assert.notEqual(db.capture({ text: "hello", html: "<i>hello</i>" }), id);
  assert.equal(db.query().items[0].html, undefined, "list does not transfer full rich bodies");
});

test("status source seeks preserve distinct pairs, empty names, trash and the 200-source bound", async t => {
  const { db } = await fixture(t);
  const sourcePairs = [{ name: '', executable: 'unnamed.exe' }, { name: 'Editor', executable: 'a.exe' }, { name: 'Editor', executable: 'b.exe' }, { name: '编辑器', executable: 'c.exe' }];
  const ids = sourcePairs.map((source, i) => db.capture({ text: `source ${i}`, source }));
  db.capture({ text: 'duplicate source', source: sourcePairs[1] });
  db.capture({ text: 'unknown source', source: { name: 'Unknown', executable: '' } });
  db.mutate({ type: 'delete', ids: [ids[2]] });
  assert.deepEqual(db.status().sources, sourcePairs);
  assert.equal(db.status().total, 5); assert.equal(db.status().trash, 1);
  for (let i = 0; i < 205; i++) db.capture({ text: `extra ${i}`, source: { name: `Source${String(i).padStart(3, '0')}`, executable: `${i}.exe` } });
  const sources = db.status().sources;
  assert.equal(sources.length, 200);
  assert.deepEqual(sources.slice(0, 3), sourcePairs.slice(0, 3));
  assert.equal(sources.at(-1).name, 'Source196');
});
test("history is long-lived and exceeds 500 items; cursor ties and matching snippets work", async t => {
  const { db, advance } = await fixture(t);
  for (let i = 0; i < 510; i++) db.capture({ text: `Entry ${String(i).padStart(3, "0")} ${"ordinary ".repeat(30)}重点测试目标 ${i}` });
  advance(365 * 86400_000); db.prune();
  assert.equal(db.status().total, 510);
  const ids = new Set(); let cursor;
  do { const page = db.query({ ...(cursor ? { cursor } : {}), limit: 100 }); page.items.forEach(e => { assert.ok(!ids.has(e.id)); ids.add(e.id); }); cursor = page.nextCursor; } while (cursor);
  assert.equal(ids.size, 510);
  assert.equal(db.query({ text: "Entry 037 重点测试" }).items.length, 1);
  assert.match(db.query({ text: "重点测试目标" }).items[0].preview, /重点测试目标/);
  assert.equal(db.query({ text: "重点" }).items.length, 100);
  assert.throws(() => db.query({ text: "x", limit: 101 }));
});

test("short searches yield for cancellation, preserve literal wildcard semantics and only return bounded summaries", async t => {
  const { db, advance } = await fixture(t);
  const records = function* () {
    for (let i = 0; i < 2048; i++) yield { id: `search-${i}`, title: `Row ${i}`, remark: "", text: `Ordinary content ${i} ${i % 10 === 0 ? '重点' : ''}`, htmlHash: null, rtfHash: null, imageHash: null, files: [], source: { name: "Search", executable: "search.exe" }, createdAt: i, copiedAt: i, copies: 1, starred: false, deletedAt: null, shelfOrder: null };
  };
  db.importRecords(records(), () => { throw new Error("no assets"); });
  let cancelled = false, yielded = false;
  const searching = db.queryAsync({ text: "☄", requestId: 12 }, () => cancelled);
  setImmediate(() => { yielded = true; cancelled = true; });
  await assert.rejects(searching, /查询已取消/); assert.equal(yielded, true);
  assert.deepEqual(await db.queryAsync({ text: "重点" }), db.query({ text: "重点" }));
  const literal = db.capture({ text: "100%_\\ literal" });
  assert.equal((await db.queryAsync({ text: "%_" })).items[0].id, literal);
  advance(1);
  const large = db.capture({ text: "prefix ".repeat(20000) + "full body retained" });
  const page = await db.queryAsync({ limit: 1 }); assert.equal(page.items[0].id, large);
  assert.ok(JSON.stringify(page).length < 2000); assert.ok(page.items[0].preview.length <= 260);
  assert.ok(db.detail(large).text.length > 100000);
});

test("bidirectional cursors preserve tied ordering and inclusive reopen anchors for history and shelf", async t => {
  const { db } = await fixture(t);
  const ids = Array.from({ length: 12 }, (_, i) => db.capture({ text: `paging ${i}` }));
  db.mutate({ type: "shelf-add", ids });
  for (const filter of ["all", "shelf"]) {
    const first = db.query({ filter, limit: 4 });
    const second = db.query({ filter, limit: 4, cursor: first.nextCursor });
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 8);
    const back = db.query({ filter, limit: 4, cursor: second.previousCursor, direction: "newer" });
    assert.deepEqual(back.items.map(item => item.id), first.items.map(item => item.id));
    assert.equal(back.previousCursor, null);
    const restored = db.query({ filter, limit: 4, cursor: second.previousCursor, includeCursor: true });
    assert.deepEqual(restored.items.map(item => item.id), second.items.map(item => item.id));
  }
});
test("trash has seven-day recovery and shelf references survive history purge", async t => {
  const { db, advance } = await fixture(t);
  const imageId = db.capture({ image: png });
  const textId = db.capture({ text: "restorable" });
  db.mutate({ type: "shelf-add", ids: [imageId, textId] });
  db.mutate({ type: "shelf-reorder", ids: [textId, imageId] });
  assert.deepEqual(db.query({ filter: "shelf" }).items.map(e => e.id), [textId, imageId]);
  db.mutate({ type: "delete", ids: [imageId, textId] });
  assert.equal(db.query().items.length, 0); assert.equal(db.query({ filter: "trash" }).items.length, 2);
  db.mutate({ type: "restore", ids: [textId] });
  assert.equal(db.query().items[0].id, textId);
  db.mutate({ type: "empty-trash" }); advance(8 * 86400_000); db.prune();
  assert.ok(db.assetForClip(imageId).path);
  db.mutate({ type: "shelf-remove", ids: [imageId] });
  assert.throws(() => db.detail(imageId));
  assert.equal(db.query({ filter: "shelf" }).items[0].id, textId);
});

test("shelf menu moves are persistent, keep nonnegative archive positions and preserve history", async t => {
  const { db } = await fixture(t);
  const ids = ["first", "second", "third"].map(text => db.capture({ text }));
  db.mutate({ type: "shelf-add", ids });
  const order = () => db.query({ filter: "shelf" }).items.map(item => item.id);
  db.mutate({ type: "shelf-move", id: ids[2], direction: "top" }); assert.deepEqual(order(), [ids[2], ids[0], ids[1]]);
  db.mutate({ type: "shelf-move", id: ids[2], direction: "down" }); assert.deepEqual(order(), [ids[0], ids[2], ids[1]]);
  db.mutate({ type: "shelf-move", id: ids[2], direction: "up" }); assert.deepEqual(order(), [ids[2], ids[0], ids[1]]);
  db.mutate({ type: "shelf-remove", ids: [ids[0]] });
  db.mutate({ type: "shelf-move", id: ids[1], direction: "top" }); assert.deepEqual(order(), [ids[1], ids[2]]);
  assert.equal(db.status().total, 3); assert.ok([...db.archiveRecords()].every(item => item.shelfOrder === null || item.shelfOrder >= 0));
  assert.throws(() => db.mutate({ type: "shelf-move", id: ids[0], direction: "up" }), /已移出暂存/);
});
test("content dedup accounts shared image files once; budgets never evict history", async t => {
  const { db } = await fixture(t);
  db.capture({ text: "one", image: png }); const before = db.status().bytes;
  db.capture({ text: "two", image: png });
  assert.equal(db.status().bytes - before, Buffer.byteLength("two") + 2);
  db.mutate({ type: "settings", value: { budgetBytes: 64 * 1024 ** 2 } });
  const payload = "x".repeat(2 * 1024 ** 2 - 10);
  for (let i = 0; i < 32; i++) db.capture({ text: payload + String(i) });
  const count = db.status().total;
  assert.throws(() => db.capture({ text: payload + "full" }), /空间预算/);
  assert.equal(db.status().total, count);
  db.mutate({ type: "settings", value: { budgetBytes: 128 * 1024 ** 2 } });
  db.capture({ text: "after budget increase" });
  assert.equal(db.status().total, count + 1);
});
test("legacy migration salvages healthy rows, keeps original archive and settings", async t => {
  const old = { version: 1, enabled: true, items: [
    { id: "legacy", kind: "text", content: "keep this", title: "my title", createdAt: 100, updatedAt: 200, copies: 4, starred: true },
    { id: "bad", kind: "image", content: "broken", createdAt: 100, updatedAt: 200 },
  ] };
  const { db, root } = await fixture(t, root => writeFile(join(root, "history.json"), JSON.stringify(old)));
  assert.equal(db.status().settings.enabled, true); assert.equal(db.status().total, 1);
  assert.equal(db.status().migrationWarnings.length, 1); assert.ok(db.status().backupBytes > 0);
  const entry = db.detail("legacy"); assert.equal(entry.title, "my title"); assert.equal(entry.createdAt, 100); assert.equal(entry.copies, 4); assert.equal(entry.starred, true);
  assert.deepEqual(JSON.parse(await readFile(join(root, "history.json"), "utf8")), old);
});
test("edit-as-copy preserves original and failed validation does not mutate records", async t => {
  const { db } = await fixture(t);
  const id = db.capture({ text: "original" });
  db.mutate({ type: "edit-copy", id, text: "edited" });
  assert.equal(db.detail(id).text, "original"); assert.equal(db.status().total, 2);
  const image = db.capture({ image: png });
  assert.throws(() => db.mutate({ type: "edit-copy", id: image, text: "should not be saved" }));
  assert.equal(db.status().total, 3);
  assert.throws(() => db.mutate({ type: "star", ids: [id, "missing"], value: true }));
  assert.equal(db.detail(id).starred, false, "batch mutation rolls back atomically");
  assert.throws(() => db.capture({ text: "x".repeat(2 * 1024 ** 2 + 1) }), /2 MiB/);
});
