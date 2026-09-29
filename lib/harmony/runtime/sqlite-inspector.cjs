/* Standalone worker asset: inspect a private database copy with no write access. */
/* eslint-disable @typescript-eslint/no-require-imports -- Worker is packaged as CommonJS. */
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { openSync, writeSync, closeSync } = require("node:fs");

function compact(value) {
  if (value === null) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  if (value instanceof Uint8Array) return { blobHex: Buffer.from(value.subarray(0, 64)).toString("hex"), size: value.length, truncated: value.length > 64 };
  return String(value).slice(0, 400);
}

function exportValue(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return { base64: Buffer.from(value).toString("base64"), size: value.length };
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

function csvCell(value) {
  if (value === null) return "";
  let text;
  if (value instanceof Uint8Array) text = `0x${Buffer.from(value).toString("hex")}`;
  else if (typeof value === "string") text = /^[\s\u0000-\u001f]*[=+\-@]/.test(value) ? `'${value}` : value;
  else text = String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

let db;
try {
  const { path, table, offset, sql, mode, format, outputPath } = workerData;
  db = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 250 });
  db.exec("PRAGMA query_only=ON");
  const objects = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 401").all()
    .filter(row => typeof row.name === "string" && row.name.length <= 256 && !/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(row.sql || ""));
  const tables = objects.filter(row => row.type === "table").slice(0, 200).map(row => row.name);
  const views = objects.filter(row => row.type === "view").slice(0, 200).map(row => row.name);
  if (mode === "export") {
    if (table && !tables.includes(table) && !views.includes(table)) throw new Error("Choose an ordinary table or view from this database");
    const quoted = table ? `"${table.replaceAll('"', '""')}"` : undefined;
    const statement = db.prepare(sql || `SELECT * FROM ${quoted}`);
    statement.setReadBigInts(true);
    statement.setReturnArrays(true);
    const columns = statement.columns().map(column => column.name);
    if (columns.length > 100) throw new Error("Export has more than 100 columns");
    let fd, bytes = 0, rows = 0;
    const write = value => {
      const chunk = Buffer.from(value, "utf8");
      if (bytes + chunk.length > 64 * 1024 * 1024) throw new Error("Export exceeds 64 MiB");
      for (let offset = 0; offset < chunk.length;) {
        const written = writeSync(fd, chunk, offset, chunk.length - offset);
        if (written < 1) throw new Error("Export write made no progress");
        offset += written;
      }
      bytes += chunk.length;
    };
    try {
      fd = openSync(outputPath, "wx", 0o600);
      if (format === "csv") write(`${columns.map(csvCell).join(",")}\r\n`);
      else write(`{"columns":${JSON.stringify(columns)},"rows":[`);
      for (const row of statement.iterate()) {
        if (rows >= 100_000) throw new Error("Export exceeds 100000 rows");
        if (format === "csv") write(`${row.map(csvCell).join(",")}\r\n`);
        else write(`${rows ? "," : ""}${JSON.stringify(row.map(exportValue))}`);
        rows++;
      }
      if (format === "json") write("]}");
    } finally { if (fd !== undefined) closeSync(fd); }
    parentPort.postMessage({ bytes, rows });
  } else if (!table && !sql) parentPort.postMessage({ tables, views });
  else if (sql) {
    const statement = db.prepare(sql);
    statement.setReadBigInts(true);
    statement.setReturnArrays(true);
    const columns = statement.columns().map(column => column.name);
    if (columns.length > 100) throw new Error("Query has more than 100 columns");
    const rows = [];
    let hasMore = false, index = 0;
    for (const row of statement.iterate()) {
      if (index++ < offset) continue;
      if (rows.length === 200) { hasMore = offset < 800; break; }
      rows.push(row.map(compact));
    }
    parentPort.postMessage({ tables, views, sql, columns, rows, offset, hasMore });
  } else {
    if (!tables.includes(table) && !views.includes(table)) throw new Error("Choose an ordinary table or view from this database");
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const statement = db.prepare(`SELECT * FROM ${quoted} LIMIT 201 OFFSET ?`);
    statement.setReadBigInts(true);
    statement.setReturnArrays(true);
    const rawRows = statement.all(offset);
    const columns = statement.columns().map(column => column.name);
    if (columns.length > 100) throw new Error("Table has more than 100 columns");
    const fields = db.prepare(`PRAGMA table_xinfo(${quoted})`).all().filter(row => row.hidden === 0).map(row => ({
      name: String(row.name), type: String(row.type || ""), notNull: Boolean(row.notnull), primaryKey: Number(row.pk || 0)
    }));
    const indexes = tables.includes(table) ? db.prepare(`PRAGMA index_list(${quoted})`).all().slice(0, 100).map(row => ({ name: String(row.name), unique: Boolean(row.unique) })) : [];
    const rows = rawRows.slice(0, 200).map(row => row.map(compact));
    parentPort.postMessage({ tables, views, table, columns, fields, indexes, rows, offset, hasMore: rawRows.length > 200 });
  }
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message.slice(0, 300) : "Database inspection failed" });
} finally { db?.close(); }
