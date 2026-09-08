import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { createMarkdownDraft } = await createJiti(import.meta.url).import("./markdown-draft.ts");
const item = { id: "doc", title: "Title", content: "original", updatedAt: 1 };
const memory = () => { const values = new Map(); return { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }; };

test("edits made during an in-flight save are serialized with the returned revision", async () => {
  let release;
  const writes = [];
  const draft = createMarkdownDraft(item, async (value) => {
    writes.push(value);
    if (writes.length === 1) await new Promise((resolve) => { release = resolve; });
    return { ...item, ...value, updatedAt: writes.length + 1 };
  }, memory());
  draft.update({ content: "first" });
  const saving = draft.save();
  draft.update({ content: "typed while saving" });
  release();
  assert.equal(await saving, true);
  assert.deepEqual(writes.map(({ content, expectedUpdatedAt }) => [content, expectedUpdatedAt]), [["first", 1], ["typed while saving", 2]]);
  assert.equal(draft.getSnapshot().dirty, false);
  draft.dispose();
});

test("failed saves survive reload and retry against the original revision", async () => {
  const storage = memory();
  const first = createMarkdownDraft(item, async () => { throw new Error("offline"); }, storage);
  first.update({ title: "Recovered", content: "unsaved" });
  assert.equal(await first.save(), false);
  assert.equal(first.getSnapshot().dirty, true);
  let expected;
  const restored = createMarkdownDraft({ ...item, updatedAt: 9 }, async (value) => { expected = value.expectedUpdatedAt; throw new Error("conflict"); }, storage);
  assert.equal(restored.getSnapshot().content, "unsaved");
  assert.equal(restored.getSnapshot().recovered, true);
  assert.equal(await restored.save(), false);
  assert.equal(expected, 1, "must not silently overwrite a newer disk version");
  assert.equal(restored.getSnapshot().error, "conflict");
});

test("empty documents and title normalization settle without looping", async () => {
  const draft = createMarkdownDraft(item, async (value) => ({ ...item, ...value, updatedAt: 2 }), memory());
  draft.update({ content: "", title: "" });
  assert.equal(await draft.save(), true);
  assert.equal(draft.getSnapshot().title, "未命名文档");
  assert.equal(draft.getSnapshot().content, "");
  assert.equal(draft.getSnapshot().dirty, false);
});

test("moving a file advances its save revision without replacing text being edited", async () => {
  const storage = memory();
  let write;
  const draft = createMarkdownDraft(item, async (value) => { write = value; return { ...item, ...value, updatedAt: 3 }; }, storage);
  draft.update({ content: "still typing" });
  draft.syncMetadata({ ...item, parentId: "folder", updatedAt: 2 });
  assert.equal(draft.getSnapshot().content, "still typing");
  assert.equal(await draft.save(), true);
  assert.equal(write.expectedUpdatedAt, 2);
  draft.dispose();
});
