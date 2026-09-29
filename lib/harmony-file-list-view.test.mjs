import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { visibleDeviceFiles } = await createJiti(import.meta.url).import("../components/workspace/harmony/file-list-view.ts");
const files = [
  { name: "file10", path: "/file10", kind: "file", size: 10, modifiedAt: 10 },
  { name: ".secret", path: "/.secret", kind: "file", size: 100 },
  { name: "folder", path: "/folder", kind: "directory" },
  { name: "file2", path: "/file2", kind: "file", size: 2, modifiedAt: 20 },
];

test("directory sorting is stable, natural and does not mutate source", () => {
  assert.deepEqual(visibleDeviceFiles(files, true, "name", false).map(file => file.name), ["folder", ".secret", "file2", "file10"]);
  assert.deepEqual(visibleDeviceFiles(files, true, "size", true).map(file => file.name), ["folder", ".secret", "file10", "file2"]);
  assert.deepEqual(visibleDeviceFiles(files, true, "modifiedAt", true).map(file => file.name), ["folder", "file2", "file10", ".secret"]);
  assert.equal(files[0].name, "file10");
});

test("hidden toggle filters dot entries without dropping directories", () => {
  assert.deepEqual(visibleDeviceFiles(files, false, "name", false).map(file => file.name), ["folder", "file2", "file10"]);
});
