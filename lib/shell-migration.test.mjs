import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { migrateLegacyShellHistory } = await createJiti(import.meta.url).import("./shell/legacy-history.ts");
const prefix = "piora-terminal-history-v1:";
function storage(entries) {
  const values = new Map(entries);
  return { get length() { return values.size; }, key: index => [...values.keys()].sort()[index] ?? null,
    getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
}

test("migration snapshots directories before receipt keys reorder storage and restores root paths", async () => {
  const local = storage([[prefix + "f:", '["echo windows-root"]'], [prefix, '["echo unix-root"]'], [prefix + "/project", '["echo project"]']]);
  const rows = [];
  await migrateLegacyShellHistory(local, async entries => { rows.push(...entries); return { durable: true }; });
  assert.deepEqual(rows.map(row => row.cwd).sort(), ["/", "/project", "f:/"].sort());
  assert.equal(rows.length, 3);
  await migrateLegacyShellHistory(local, async () => { throw new Error("Already acknowledged history must not be resent"); });
  assert.equal(local.getItem(prefix + "f:"), '["echo windows-root"]', "migration keeps the original source copy");
});

test("large Unicode history stays within the API byte limit and failed batches remain retryable", async () => {
  const key = prefix + "f:/project";
  const commands = Array.from({ length: 12 }, (_, index) => "中".repeat(60000) + index);
  const content = JSON.stringify(commands), local = storage([[key, content]]);
  let calls = 0;
  await assert.rejects(migrateLegacyShellHistory(local, async entries => {
    assert.ok(Buffer.byteLength(JSON.stringify({ entries }), "utf8") < 512 * 1024);
    return { durable: ++calls !== 2 };
  }), /durable receipt/);
  assert.equal(local.getItem("piora-shell-migrated:" + key), null);
  assert.equal(local.getItem(key), content);
  const rows = [];
  await migrateLegacyShellHistory(local, async entries => {
    assert.ok(Buffer.byteLength(JSON.stringify({ entries }), "utf8") < 512 * 1024);
    rows.push(...entries); return { durable: true };
  });
  assert.deepEqual(rows.map(row => row.command), commands);
  assert.equal(local.getItem("piora-shell-migrated:" + key), content);
});

test("a legacy write during migration is not acknowledged as already imported", async () => {
  const key = prefix + "/project", local = storage([[key, '["echo first"]']]);
  await migrateLegacyShellHistory(local, async () => { local.setItem(key, '["echo first","echo later"]'); return { durable: true }; });
  assert.equal(local.getItem("piora-shell-migrated:" + key), '["echo first"]');
  const rows = [];
  await migrateLegacyShellHistory(local, async entries => { rows.push(...entries); return { durable: true }; });
  assert.deepEqual(rows.map(row => row.command), ["echo first", "echo later"]);
});
