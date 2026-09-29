import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { searchHarmonyFiles } = await createJiti(import.meta.url).import("./harmony/file-search.ts");

test("bounded file search traverses directories without following symlinks", async () => {
  const seen = [];
  const tree = {
    "/data/local/tmp": [
      { path: "/data/local/tmp/notes", name: "notes", kind: "directory" },
      { path: "/data/local/tmp/link", name: "link", kind: "symlink" },
    ],
    "/data/local/tmp/notes": [
      { path: "/data/local/tmp/notes/中文 notes.txt", name: "中文 notes.txt", kind: "file" },
    ],
  };
  const result = await searchHarmonyFiles({ kind: "shared" }, "/data/local/tmp", "NOTES", async path => {
    seen.push(path);
    return { files: tree[path] ?? [], truncated: false };
  });
  assert.deepEqual(seen, ["/data/local/tmp", "/data/local/tmp/notes"]);
  assert.deepEqual(result.files.map(file => file.name), ["notes", "中文 notes.txt"]);
  assert.equal(result.truncated, false);
});

test("search bounds work and reports inaccessible descendants", async () => {
  const result = await searchHarmonyFiles({ kind: "shared" }, "/data/local/tmp", "item", async path => {
    if (path.endsWith("/blocked")) throw new Error("permission denied");
    if (path === "/data/local/tmp") return { files: [
      { path: `${path}/blocked`, name: "blocked", kind: "directory" },
      { path: `${path}/deep`, name: "deep", kind: "directory" },
    ], truncated: false };
    return { files: Array.from({ length: 500 }, (_, i) => ({ path: `${path}/item-${i}`, name: `item-${i}`, kind: "file" })), truncated: true };
  });
  assert.equal(result.files.length, 200);
  assert.equal(result.skippedDirectories, 1);
  assert.equal(result.truncated, true);
  await assert.rejects(searchHarmonyFiles({ kind: "shared" }, "/data/local/tmp", "", async () => ({ files: [], truncated: false })));
  await assert.rejects(searchHarmonyFiles({ kind: "sandbox", bundleName: "bad;bundle" }, "data/storage", "a", async () => ({ files: [], truncated: false })));
});
