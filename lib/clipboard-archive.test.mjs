import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
const jiti = createJiti(import.meta.url);
const { ClipboardDatabase } = await jiti.import("../desktop/src/clipboard-database.ts");
const { exportClipboardArchive, importClipboardArchive } = await jiti.import("../desktop/src/clipboard-archive.ts");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "piora-clipboard-archive-")), opened = [];
  const database = name => { const db = new ClipboardDatabase(path.join(root, name)); opened.push(db); return db; };
  try { await fn({ root, database }); }
  finally { for (const db of opened) db.close(); assert.equal(path.dirname(root), path.resolve(tmpdir())); await rm(root, { recursive: true, force: true }); }
}
function editArchive(buffer, change) {
  const raw = gunzipSync(buffer.subarray(8)); const frames = []; let at = 0;
  while (at < raw.length) { const size = raw.readUInt32LE(at); frames.push(JSON.parse(raw.subarray(at + 4, at + 4 + size))); at += size + 4; }
  change(frames); const checksum = createHash("sha256"), output = [];
  for (const value of frames) {
    if (value.type === "complete") value.checksum = checksum.digest("hex");
    const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(body.length); const record = Buffer.concat([header, body]);
    if (value.type !== "complete") checksum.update(record); output.push(record);
  }
  return Buffer.concat([buffer.subarray(0, 8), gzipSync(Buffer.concat(output))]);
}

test("clipboard archive round trip preserves formats, metadata, trash, shelf and settings without duplicate assets", () => fixture(async ({ root, database }) => {
  const source = database("source"), destination = database("destination");
  const text = source.capture({ text: "原文\n多行", html: "<b>原文</b>", rtf: "{\\rtf1 original}", source: { name: "编辑器", executable: "editor.exe" } });
  source.capture({ text: "原文\n多行", html: "<b>原文</b>", rtf: "{\\rtf1 original}" });
  source.mutate({ type: "remark", id: text, value: "重要备注" }); source.mutate({ type: "star", ids: [text], value: true });
  const image = source.capture({ image: png }); const richImage = source.capture({ text: "图注", image: png });
  const file = source.capture({ files: [{ path: path.join(root, "missing.txt"), name: "missing.txt", directory: false }] });
  source.mutate({ type: "shelf-add", ids: [image, text] }); source.mutate({ type: "delete", ids: [image, file] });
  source.mutate({ type: "settings", value: { enabled: true, excludedApps: ["password.exe"] } });
  const archive = path.join(root, "history.piora-clipboard"); await exportClipboardArchive(source, archive);
  const result = await importClipboardArchive(destination, archive, { restoreSettings: true });
  assert.equal(result.imported, 4); assert.equal(result.merged, 0);
  for (const id of [text, image, richImage, file]) assert.deepEqual(destination.detail(id), source.detail(id));
  assert.deepEqual(destination.settings(), source.settings());
  assert.equal(destination.status().bytes, source.status().bytes);
  assert.equal((await readdir(path.join(destination.directory, "content"))).length, 3, "one PNG plus HTML and RTF");
  assert.deepEqual(destination.query({ filter: "shelf" }).items.map(item => item.id), [image, text]);
}));

test("merge is idempotent, preserves conflicting notes and safely resolves reused IDs", () => fixture(async ({ root, database }) => {
  const source = database("source"), destination = database("destination");
  const sourceId = source.capture({ text: "相同内容" }); source.mutate({ type: "remark", id: sourceId, value: "导入备注" });
  source.mutate({ type: "star", ids: [sourceId], value: true });
  const destinationId = destination.capture({ text: "相同内容" }); destination.mutate({ type: "remark", id: destinationId, value: "本机备注" });
  destination.capture({ text: "保留当前标识的另一条内容" }, { id: sourceId, title: "已有记录", createdAt: 1, copiedAt: 2, copies: 1, starred: false });
  const archive = path.join(root, "history.piora-clipboard"); await exportClipboardArchive(source, archive);
  for (let index = 0; index < 2; index++) {
    const result = await importClipboardArchive(destination, archive);
    assert.equal(result.imported, 0); assert.equal(result.merged, 1); assert.equal(result.warnings.length, 1);
    assert.equal(destination.detail(destinationId).remark, "本机备注"); assert.equal(destination.detail(destinationId).copies, 1);
    assert.equal(destination.detail(destinationId).starred, true); assert.equal(destination.detail(sourceId).text, "保留当前标识的另一条内容");
  }
}));

test("invalid, truncated, traversal and late budget failures never partially merge records or content files", () => fixture(async ({ root, database }) => {
  const source = database("source"), destination = database("destination");
  source.capture({ text: "should not remain", image: png }); source.capture({ text: "second" });
  destination.capture({ text: "original" }); const before = destination.query(), beforeFiles = await readdir(path.join(destination.directory, "content"));
  const archive = path.join(root, "good.piora-clipboard"); await exportClipboardArchive(source, archive); const bytes = await readFile(archive);
  const variants = [Buffer.from("invalid"), bytes.subarray(0, bytes.length - 8), editArchive(bytes, frames => { frames.find(item => item.type === "asset").hash = "../../outside"; }), editArchive(bytes, frames => { frames.filter(item => item.type === "record").at(-1).record.text = "x".repeat(2 * 1024 ** 2 + 1); })];
  for (const [index, data] of variants.entries()) {
    const bad = path.join(root, `bad-${index}`); await writeFile(bad, data);
    await assert.rejects(importClipboardArchive(destination, bad));
    assert.deepEqual(destination.query(), before); assert.deepEqual(await readdir(path.join(destination.directory, "content")), beforeFiles);
    assert.deepEqual(await readdir(path.join(destination.directory, "imports")), []);
  }
  const settings = destination.settings();
  for (let i = 0; i < 32; i++) destination.capture({ text: String(i).padStart(2, "0") + "x".repeat(2 * 1024 ** 2 - 2) });
  destination.mutate({ type: "settings", value: { budgetBytes: 64 * 1024 ** 2 } });
  const full = destination.status(); await assert.rejects(importClipboardArchive(destination, archive), /空间预算/);
  assert.deepEqual(destination.status(), full); assert.deepEqual(await readdir(path.join(destination.directory, "content")), beforeFiles);
  destination.mutate({ type: "settings", value: settings });
}));

test("snapshots retain assets after live GC and imported file mappings never change prose", () => fixture(async ({ root, database }) => {
  const source = database("source"), destination = database("destination");
  const oldRoot = path.join(root, "old-project"), newRoot = path.join(root, "new-project");
  const id = source.capture({ text: oldRoot, image: png, files: [{ path: path.join(oldRoot, "file.png"), name: "file.png", directory: false }] });
  const snapshotPath = path.join(root, "snapshot"); await mkdir(snapshotPath); source.createSnapshot(snapshotPath);
  source.mutate({ type: "delete", ids: [id] }); source.mutate({ type: "purge", ids: [id] });
  const snapshot = new ClipboardDatabase(snapshotPath, Date.now, { maintenance: false });
  try {
    const archive = path.join(root, "snapshot.piora-clipboard"); await exportClipboardArchive(snapshot, archive);
    await importClipboardArchive(destination, archive, { mappings: [{ from: oldRoot, to: newRoot }] });
    assert.equal(destination.detail(id).text, oldRoot); assert.equal(destination.detail(id).files[0].path, path.join(newRoot, "file.png"));
    assert.ok(destination.assetForClip(id));
  } finally { snapshot.close(); }
}));
