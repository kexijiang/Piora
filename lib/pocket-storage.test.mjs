import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const storage = await jiti.import("./pocket-storage.ts");
const transfer = await jiti.import("./transfer-station.ts");
const json = await jiti.import("./json-workspace-storage.ts");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6EAAAAABJRU5ErkJggg==";
function isolated(run) {
  const root = mkdtempSync(join(tmpdir(), "piora-pocket-"));
  try { return run({ PI_CODING_AGENT_DIR: join(root, "agent"), USERPROFILE: root, HOME: root }, root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
const draft = () => ({ activeId: "temp", drafts: [], temporaryContent: '{"id":9223372036854775807}', temporaryTitle: "临时", indent: 2, wrap: true, autoExtract: true, multiEscape: true });

test("folders persist parent links and reject cycles or deletion with children", () => isolated((env) => {
  const parent = transfer.addTransferItem({ title: "Parent", content: "", kind: "folder" }, env);
  const child = transfer.addTransferItem({ title: "Child", content: "", kind: "folder", parentId: parent.id }, env);
  const file = transfer.addTransferItem({ title: "Draft", content: "keep", parentId: child.id }, env);
  assert.throws(() => transfer.updateTransferItem(parent.id, { parentId: child.id }, env));
  assert.throws(() => transfer.updateTransferItem(parent.id, { remove: true }, env));
  transfer.updateTransferItem(file.id, { parentId: null }, env);
  assert.equal(transfer.readTransferItems(env).find((item) => item.id === file.id).content, "keep");
  transfer.updateTransferItem(child.id, { remove: true }, env);
  transfer.updateTransferItem(parent.id, { remove: true }, env);
  assert.equal(transfer.readTransferItems(env).length, 1);
}));

test("Markdown documents save blank content, advance revisions and reject stale edits", () => isolated((env) => {
  const document = transfer.addTransferItem({ title: "Draft", content: "", language: "markdown" }, env);
  transfer.updateTransferItem(document.id, { content: "# Hello\n\n**world**", expectedUpdatedAt: document.updatedAt }, env);
  const saved = transfer.readTransferItems(env)[0];
  assert.ok(saved.updatedAt > document.updatedAt);
  assert.throws(() => transfer.updateTransferItem(document.id, { content: "stale", expectedUpdatedAt: document.updatedAt }, env), transfer.TransferDocumentConflict);
  assert.equal(transfer.readTransferItems(env)[0].content, "# Hello\n\n**world**");
  transfer.updateTransferItem(document.id, { content: "", expectedUpdatedAt: saved.updatedAt }, env);
  assert.equal(transfer.readTransferItems(env)[0].content, "");
  assert.throws(() => transfer.updateTransferItem(document.id, { content: "x".repeat(200001) }, env));
}));
test("transfer captures untitled text losslessly and stores images as real files", () => isolated((env) => {
  const text = "  first line\n  second line\n";
  const note = transfer.addTransferItem({ content: text }, env);
  assert.equal(note.title, "first line"); assert.equal(note.content, text);
  const image = transfer.addTransferItem({ content: `data:image/png;base64,${png}`, kind: "image" }, env);
  assert.deepEqual(transfer.readTransferImage(image.id, env).bytes, Buffer.from(png, "base64"));
  assert.match(transfer.transferItemsForClient(env)[0].content, /^\/api\/companion\/library\/image\?id=/);
  const manifest = readFileSync(storage.getPocketStorageInfo("library", env).dataFile, "utf8");
  assert.ok(!manifest.includes(png));
  transfer.updateTransferItem(note.id, { pinned: true }, env);
  assert.equal(transfer.readTransferItems(env).find((item) => item.id === note.id).pinned, true);
  transfer.updateTransferItem(image.id, { remove: true }, env);
  assert.equal(transfer.readTransferImage(image.id, env), null);
  assert.equal(existsSync(join(storage.getPocketStorageInfo("library", env).directory, image.fileName)), false);
}));
test("legacy migration preserves ids and publishes once, leaving original data untouched", () => isolated((env) => {
  const legacy = [{ id: "legacy", title: "旧图片", content: `data:image/png;base64,${png}`, kind: "image", pinned: true, createdAt: 4, updatedAt: 9 }];
  assert.equal(transfer.migrateTransferItems(legacy, env), true);
  assert.equal(transfer.readTransferItems(env)[0].id, "legacy");
  assert.equal(transfer.readTransferItems(env)[0].pinned, true);
  assert.equal(transfer.migrateTransferItems(legacy, env), false);
  assert.equal(legacy[0].content, `data:image/png;base64,${png}`);
}));
test("failed legacy migration does not publish a partial manifest", () => isolated((env) => {
  assert.throws(() => transfer.migrateTransferItems([{ id: "a", title: "a", kind: "note", content: "safe" }, { id: "b", title: "b", kind: "image", content: "invalid" }], env));
  assert.equal(existsSync(storage.getPocketStorageInfo("library", env).dataFile), false);
}));
test("library and JSON paths migrate independently with verified recovery copies", () => isolated((env, root) => {
  const image = transfer.addTransferItem({ content: `data:image/png;base64,${png}`, kind: "image" }, env);
  json.writeJsonWorkspace(draft(), 0, env);
  const oldLibrary = storage.getPocketStorageInfo("library", env);
  const oldJson = storage.getPocketStorageInfo("json", env);
  const library = storage.updatePocketStorageDirectory("library", join(root, "my-stash"), env);
  assert.deepEqual(readFileSync(library.dataFile), readFileSync(oldLibrary.dataFile));
  assert.deepEqual(readFileSync(join(library.directory, image.fileName)), Buffer.from(png, "base64"));
  assert.equal(storage.getPocketStorageInfo("json", env).directory, oldJson.directory);
  const nextJson = storage.updatePocketStorageDirectory("json", join(root, "my-json"), env);
  assert.deepEqual(readFileSync(nextJson.dataFile), readFileSync(oldJson.dataFile));
  assert.equal(storage.getPocketStorageInfo("library", env).directory, library.directory);
  assert.equal(json.readJsonWorkspace(env).workbench.temporaryContent, draft().temporaryContent);
}));
test("unsafe, occupied and incomplete targets never replace the active path", () => isolated((env, root) => {
  transfer.addTransferItem({ content: "safe" }, env);
  const current = storage.getPocketStorageInfo("library", env);
  assert.throws(() => storage.updatePocketStorageDirectory("library", parse(root).root, env));
  assert.throws(() => storage.updatePocketStorageDirectory("library", "relative", env));
  const occupied = join(root, "occupied"); mkdirSync(occupied);
  writeFileSync(join(occupied, "transfer.json"), "do not overwrite");
  assert.throws(() => storage.updatePocketStorageDirectory("library", occupied, env));
  assert.equal(storage.getPocketStorageInfo("library", env).directory, current.directory);
  assert.equal(readFileSync(join(occupied, "transfer.json"), "utf8"), "do not overwrite");
}));
test("JSON file writes reject stale revisions and oversized drafts without data loss", () => isolated((env) => {
  assert.equal(json.readJsonWorkspace(env).workbench, null);
  json.writeJsonWorkspace(draft(), 0, env);
  assert.throws(() => json.writeJsonWorkspace({ ...draft(), temporaryContent: "lost update" }, 0, env), json.JsonWorkspaceConflict);
  assert.throws(() => json.writeJsonWorkspace({ ...draft(), temporaryContent: "x".repeat(200001) }, 1, env));
  assert.equal(json.readJsonWorkspace(env).workbench.temporaryContent, draft().temporaryContent);
  const file = storage.getPocketStorageInfo("json", env).dataFile;
  writeFileSync(file, "broken");
  assert.throws(() => json.writeJsonWorkspace(draft(), 0, env));
  assert.equal(readFileSync(file, "utf8"), "broken");
}));
