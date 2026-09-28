/* Standalone worker asset: inspect a private database copy with no write access. */
/* eslint-disable @typescript-eslint/no-require-imports -- Worker is packaged as CommonJS. */
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");

function compact(value) {
  if (value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  if (value instanceof Uint8Array) return { blobHex: Buffer.from(value.subarray(0, 64)).toString("hex"), size: value.length, truncated: value.length > 64 };
  return String(value).slice(0, 400);
}

let db;
try {
  const { path, table, offset } = workerData;
  db = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 250 });
  db.exec("PRAGMA query_only=ON");
  const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 201").all()
    .filter(row => typeof row.name === "string" && row.name.length <= 256 && !/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(row.sql || ""))
    .slice(0, 200).map(row => row.name);
  if (!table) parentPort.postMessage({ tables });
  else {
    if (!tables.includes(table)) throw new Error("Choose an ordinary table from this database");
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const statement = db.prepare(`SELECT * FROM ${quoted} LIMIT 51 OFFSET ?`);
    statement.setReadBigInts(true);
    const rawRows = statement.all(offset);
    const columns = statement.columns().map(column => column.name);
    if (columns.length > 100) throw new Error("Table has more than 100 columns");
    const rows = rawRows.slice(0, 50).map(row => columns.map(column => compact(row[column])));
    parentPort.postMessage({ tables, table, columns, rows, offset, hasMore: rawRows.length > 50 });
  }
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message.slice(0, 300) : "Database inspection failed" });
} finally { db?.close(); }
