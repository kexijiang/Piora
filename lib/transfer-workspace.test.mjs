import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { closeTransferTab, restoreTransferTabs, transferTreeRows, transferFolderPath } = await createJiti(import.meta.url).import("./transfer-workspace.ts");
const items = [{ id: "folder", kind: "folder", title: "资料", content: "" }, { id: "a", kind: "note", title: "Alpha", content: "draft", parentId: "folder" }, { id: "b", kind: "note", title: "Beta", content: "" }];
test("closing a tab selects its neighbor, closing all stays closed across reload", () => {
  const closed = closeTransferTab({ ids: ["a", "b"], activeId: "a" }, "a");
  assert.deepEqual(closed, { ids: ["b"], activeId: "b" });
  assert.deepEqual(restoreTransferTabs(closeTransferTab(closed, "b"), items), { ids: [], activeId: null });
  assert.deepEqual(restoreTransferTabs({ ids: ["missing", "folder", "a", "a"], activeId: "missing" }, items), { ids: ["a"], activeId: "a" });
});
test("folder collapse and searching reveal the correct ancestry", () => {
  assert.deepEqual(transferTreeRows(items, new Set(["folder"]), "").map(({ item }) => item.id), ["folder", "b"]);
  assert.deepEqual(transferTreeRows(items, new Set(["folder"]), "draft").map(({ item, depth }) => [item.id, depth]), [["folder", 0], ["a", 1]]);
  assert.equal(transferFolderPath(items, "folder"), "资料");
});
