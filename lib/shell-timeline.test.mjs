import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { ShellStore } = await jiti.import("./shell/store.ts");
const { mergeShellTimeline, resolveShellOutputFile } = await jiti.import("./shell/client.ts");

test("output links use the execution directory and retain parent-relative paths", () => {
  assert.equal(resolveShellOutputFile(".\\src\\file.ts:12:3", "F:\\project\\subdir"), "F:/project/subdir/src/file.ts");
  assert.equal(resolveShellOutputFile("../file.ts:12", "F:/project/subdir"), "F:/project/file.ts");
  assert.equal(resolveShellOutputFile("../file.ts", "/project/subdir"), "/project/file.ts");
  assert.equal(resolveShellOutputFile("D:\\other\\file.ts", "F:/project"), "D:/other/file.ts");
});

test("timeline cursors preserve all older records across updates and new insertions", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-shell-timeline-"));
  const store = new ShellStore(directory, false);
  t.after(async () => { await store.close(); assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith("piora-shell-timeline-")); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  for (let index = 0; index < 235; index++) await store.put(index % 3 ? "command" : "run", String(index), { id: String(index), status: "running" }, "first");
  await store.put("command", "other", { id: "other" }, "second");
  const first = await store.call("timeline", { terminalId: "first" });
  assert.equal(first.commands.length + first.runs.length, 100);
  await store.put("command", "1", { id: "1", status: "completed" }, "first");
  await store.put("command", "new", { id: "new" }, "first");
  const records = [...first.commands, ...first.runs];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await store.call("timeline", { terminalId: "first", before: Number(cursor) });
    records.push(...page.commands, ...page.runs); cursor = page.nextCursor;
  }
  assert.equal(records.length, 235);
  assert.equal(new Set(records.map(item => item.id)).size, 235, "updates must not move a record between pages");
  assert.equal(records.find(item => item.id === "1").status, "completed");
  assert.equal(records.some(item => item.id === "other" || item.id === "new"), false);
  const live = { commands: [{ id: "234", status: "completed" }, { id: "new" }], runs: [], session: { id: "first" }, sequence: 10 };
  const merged = mergeShellTimeline(live, { commands: records, runs: [] });
  assert.equal(merged.commands.length, 236);
  assert.equal(merged.commands.find(item => item.id === "234").status, "completed", "live status wins over an older archive page");
});
