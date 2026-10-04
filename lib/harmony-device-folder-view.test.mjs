import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { deviceFolderViewKey, parseDeviceFolderView, readDeviceFolderView, writeDeviceFolderView } = await createJiti(import.meta.url).import("./harmony/device-folder-view.ts");

test("folder view metadata separates devices and application scopes without storing device rows", () => {
  const shared = { kind: "shared" }, app = { kind: "sandbox", bundleName: "dev.example.one" };
  const keys = [deviceFolderViewKey("one", shared), deviceFolderViewKey("two", shared), deviceFolderViewKey("one", app),
    deviceFolderViewKey("one", { ...app, bundleName: "dev.example.two" }), deviceFolderViewKey("one:shared", shared)];
  assert.equal(new Set(keys).size, keys.length);
  let saved;
  writeDeviceFolderView({ setItem: (key, value) => saved = value }, keys[0], { expandedPaths: ["/data/local/tmp"], renderCounts: { "/data/local/tmp": 400 },
    scrollTop: 210, extraRoot: "", files: [{ name: "stale-private-file" }], permissions: { readable: true } });
  assert.doesNotMatch(saved, /stale-private-file|permissions|readable/);
  assert.deepEqual(readDeviceFolderView({ getItem: () => saved }, keys[0], shared), {
    expandedPaths: ["/data/local/tmp"], renderCounts: { "/data/local/tmp": 400 }, scrollTop: 210, extraRoot: "" });
});

test("invalid or oversized remembered trees never become arbitrary device paths or unbounded restore jobs", () => {
  const value = { version: 1, expandedPaths: ["/data/local/tmp", "/data/local/tmp", "../escape", "/data/../escape", "/data/./file", "/data/\0bad", 1],
    renderCounts: { "/data/local/tmp": 400, "/data/x": -1, "/data/y": "400", "/data/z": 100_001 }, scrollTop: -50, extraRoot: "../escape" };
  assert.deepEqual(parseDeviceFolderView(JSON.stringify(value), { kind: "shared" }), {
    expandedPaths: ["/data/local/tmp"], renderCounts: { "/data/local/tmp": 400 }, scrollTop: 0, extraRoot: "" });
  assert.equal(parseDeviceFolderView("{broken", { kind: "shared" }), null);
  assert.equal(parseDeviceFolderView(" ".repeat(2_400_001), { kind: "shared" }), null);
  assert.equal(parseDeviceFolderView(JSON.stringify({ ...value, version: 9 }), { kind: "shared" }), null);
  const sandbox = parseDeviceFolderView(JSON.stringify({ ...value, expandedPaths: ["/data/local/tmp", "data/storage/el2/base/files", "data/storage/el1/database", "data/storage/el2/base/../escape"],
    scrollTop: 1e12 }), { kind: "sandbox", bundleName: "dev.example.one" });
  assert.deepEqual(sandbox.expandedPaths, ["data/storage/el2/base/files", "data/storage/el1/database"]);
  assert.equal(sandbox.scrollTop, 10_000_000);
  const many = parseDeviceFolderView(JSON.stringify({ ...value, expandedPaths: Array.from({ length: 1000 }, (_, i) => `/storage/dir-${i}`) }), { kind: "shared" });
  assert.equal(many.expandedPaths.length, 256);
  assert.equal(readDeviceFolderView({ getItem: () => { throw Error("storage disabled"); } }, "key", { kind: "shared" }), null);
  assert.doesNotThrow(() => writeDeviceFolderView({ setItem: () => { throw Error("quota full"); } }, "key", many));
});
