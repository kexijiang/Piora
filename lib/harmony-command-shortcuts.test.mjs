import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { normalizeCommandShortcuts, parseShortcutArchive, serializeShortcutArchive, shortcutParameters, expandShortcut, mergeCommandShortcuts } =
  await createJiti(import.meta.url).import("../components/workspace/harmony/command-shortcuts.ts");

const device = { id: "first", name: "Show file", group: "Files", target: "device", command: "cat {{path}}", kind: "shared", favorite: true };

test("legacy shortcuts migrate and imported archives reject malformed or duplicate entries", () => {
  assert.deepEqual(normalizeCommandShortcuts([{ id: "old", name: "pwd", command: "pwd", kind: "shared" }])[0],
    { id: "old", name: "pwd", group: "", target: "device", command: "pwd", kind: "shared", favorite: false });
  assert.deepEqual(parseShortcutArchive(serializeShortcutArchive([device])), [device]);
  const invalid = JSON.stringify({ format: "piora-harmony-shortcuts", version: 1, shortcuts: [device, { ...device }] });
  assert.throws(() => parseShortcutArchive(invalid), /duplicate/i);
  assert.throws(() => parseShortcutArchive(JSON.stringify({ format: "piora-harmony-shortcuts", version: 1, shortcuts: [{ ...device, command: "echo '{{path}}'" }] })), /invalid/i);
});

test("shortcut parameters are visibly expanded as shell arguments and never execute on import", () => {
  assert.deepEqual(shortcutParameters("cp {{source}} {{target}} {{source}}"), ["source", "target"]);
  assert.equal(expandShortcut(device, { path: "a b'; echo unsafe" }), "cat 'a b'\\''; echo unsafe'");
  assert.throws(() => expandShortcut(device, { path: "a\nrm -rf /" }), /single-line/i);
  const local = { ...device, target: "local", command: "Get-Item {{path}}" };
  assert.equal(expandShortcut(local, { path: "C:\\work\\file.txt" }), "Get-Item C:\\work\\file.txt");
  assert.throws(() => expandShortcut(local, { path: "a b" }), /plain path/i);
  assert.throws(() => shortcutParameters("echo \\{{name}}"), /Escaped/);
});

test("shortcut import merges by group, name and target without overwriting existing commands", () => {
  const incoming = [{ ...device, id: "imported", command: "echo changed" }, { ...device, id: "other", name: "List", favorite: false }];
  const merged = mergeCommandShortcuts([device], incoming, () => "fresh-id");
  assert.equal(merged.added, 1);
  assert.equal(merged.skipped, 1);
  assert.equal(merged.shortcuts[0].command, "cat {{path}}");
  assert.equal(merged.shortcuts[1].id, "fresh-id");
});
