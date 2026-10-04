import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { HarmonySqliteQueryError, sqliteQueryPosition } = await createJiti(import.meta.url).import("./harmony/sqlite-query-error.ts");

test("SQL locations count Unicode characters and preserve the submitted selection's UTF-16 offset", () => {
  const full = "SELECT 1\r\nSELECT '中文😀' FRM sample";
  assert.deepEqual(sqliteQueryPosition(full, full.indexOf("sample")), { line: 2, column: 18 });
  assert.deepEqual(sqliteQueryPosition("\nSELECT x\r\n", 1), { line: 2, column: 1 });
  assert.equal(sqliteQueryPosition(full, -1), undefined);
  assert.equal(sqliteQueryPosition(full, full.length + 1), undefined);
  const error = new HarmonySqliteQueryError({ code: "INVALID_RESPONSE", message: "syntax error", details: { sqlErrorOffset: 12 } }, 502);
  assert.equal(error.offset, 12);
  assert.equal(error.messageFor(true), "syntax error", "native SQL diagnostics keep their exact text and location");
  assert.equal(new HarmonySqliteQueryError({ code: "DEVICE_BUSY", details: { sqlErrorOffset: 12 } }, 409).offset, undefined);
  assert.equal(new HarmonySqliteQueryError({ code: "INVALID_RESPONSE", details: { sqlErrorOffset: "12" } }, 502).offset, undefined);
});

test("database consistency refusals preserve structured recovery without fabricating SQL locations", () => {
  const refusal = new HarmonySqliteQueryError({ code: "CAPABILITY_UNAVAILABLE", message: "Active WAL", details: {
    reason: "database-active-journal", sqlErrorOffset: 12,
  } }, 501);
  assert.match(refusal.messageFor(true), /WAL.*无法验证一致性.*未读取数据.*一致备份/);
  assert.match(refusal.messageFor(true), /关闭数据库后.*仍可能保留/);
  assert.match(refusal.messageFor(false), /remain after writes stop/);
  assert.match(refusal.messageFor(false), /No data was read.*consistent backup/);
  assert.equal(refusal.offset, undefined);
  const unrelated = new HarmonySqliteQueryError({ code: "COMMAND_FAILED", message: "Actual command failure", details: {
    reason: "database-active-journal",
  } }, 502);
  assert.equal(unrelated.messageFor(true), "Actual command failure", "a mismatched reason must not hide the actual device failure");
  const recovering = new HarmonySqliteQueryError({ code: "DEVICE_BUSY", details: { state: "recovering" } }, 409);
  assert.match(recovering.messageFor(true), /清理尚未确认/);
});
