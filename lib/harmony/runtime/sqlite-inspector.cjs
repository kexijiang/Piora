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

function quoteIdentifier(name) { return `"${name.replaceAll('"', '""')}"`; }

function describeIndex(database, name, table, info) {
  // index_info loses expression keys and sorting. index_xinfo also includes
  // auxiliary storage columns, which are not declared index keys.
  const keyParts = database.prepare(`PRAGMA index_xinfo(${quoteIdentifier(name)})`).all()
    .filter(column => column.key === 1).slice(0, 100).map(column => ({
      kind: column.cid === -2 ? "expression" : column.cid === -1 ? "rowid" : "column",
      ...(typeof column.name === "string" ? { name: column.name } : {}),
      descending: Boolean(column.desc),
      ...(typeof column.coll === "string" ? { collation: column.coll } : {}),
    }));
  const definition = database.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(name)?.sql;
  return { name, table, unique: Boolean(info?.unique), partial: Boolean(info?.partial),
    origin: info?.origin === "u" ? "unique" : info?.origin === "pk" ? "primary-key" : "created",
    columns: keyParts.filter(part => part.kind === "column").map(part => part.name), keyParts,
    ...(typeof definition === "string" ? { definition: definition.slice(0, 10_000) } : {}),
  };
}

let db;
(async () => {
try {
  const { path, table, offset, sql, mode, format, outputPath, exportRange, exportOffset, encoding } = workerData;
  db = new DatabaseSync(path, { readOnly: true, allowExtension: false, timeout: 250 });
  db.exec("PRAGMA query_only=ON");
  if (!table && !sql && mode !== "export") {
    const integrity = db.prepare("PRAGMA quick_check(1)").get();
    if (Object.values(integrity ?? {})[0] !== "ok") throw new Error("Database integrity could not be verified");
  }
  const objects = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 401").all()
    .filter(row => typeof row.name === "string" && row.name.length <= 256 && !/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(row.sql || ""));
  const tables = objects.filter(row => row.type === "table").slice(0, 200).map(row => row.name);
  const views = objects.filter(row => row.type === "view").slice(0, 200).map(row => row.name);
  const indexes = db.prepare("SELECT name, tbl_name FROM sqlite_schema WHERE type='index' ORDER BY name LIMIT 201").all()
    .filter(row => typeof row.name === "string" && row.name.length <= 256 && tables.includes(row.tbl_name))
    .slice(0, 200).map(row => {
      const info = db.prepare(`PRAGMA index_list(${quoteIdentifier(row.tbl_name)})`).all().find(item => item.name === row.name);
      return describeIndex(db, row.name, row.tbl_name, info);
    });
  if (mode === "export") {
    if (table && !tables.includes(table) && !views.includes(table)) throw new Error("Choose an ordinary table or view from this database");
    const quoted = table ? `"${table.replaceAll('"', '""')}"` : undefined;
    const statement = db.prepare(sql || `SELECT * FROM ${quoted}`);
    statement.setReadBigInts(true);
    statement.setReturnArrays(true);
    const columns = statement.columns().map(column => column.name);
    if (columns.length > 100) throw new Error("Export has more than 100 columns");
    let fd, bytes = 0, rows = 0, inspected = 0;
    const write = value => {
      const chunk = Buffer.from(value, encoding === "utf-16le" ? "utf16le" : "utf8");
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
      if (encoding === "utf-8-bom" || encoding === "utf-16le") write("\uFEFF");
      if (format === "csv") write(`${columns.map(csvCell).join(",")}\r\n`);
      else write(`{"columns":${JSON.stringify(columns)},"rows":[`);
      for (const row of statement.iterate()) {
        if (exportRange === "page" && inspected++ < exportOffset) continue;
        if (exportRange === "page" && rows >= 200) break;
        if (rows >= 100_000) throw new Error("Export exceeds 100000 rows");
        if (format === "csv") write(`${row.map(csvCell).join(",")}\r\n`);
        else write(`${rows ? "," : ""}${JSON.stringify(row.map(exportValue))}`);
        rows++;
      }
      if (format === "json") write("]}");
    } finally { if (fd !== undefined) closeSync(fd); }
    parentPort.postMessage({ bytes, rows });
  } else if (!table && !sql) parentPort.postMessage({ tables, views, indexes });
  else if (sql) {
    const statement = db.prepare(sql);
    statement.setReadBigInts(true);
    statement.setReturnArrays(true);
    const columns = statement.columns().map(column => column.name);
    if (columns.length > 100) throw new Error("Query has more than 100 columns");
    const rows = [];
    const pageLimit = Math.min(200, 1000 - offset);
    let hasMore = false, index = 0;
    for (const row of statement.iterate()) {
      if (index++ < offset) continue;
      if (rows.length === pageLimit) { hasMore = offset + pageLimit < 1000; break; }
      rows.push(row.map(compact));
    }
    parentPort.postMessage({ tables, views, indexes, sql, columns, rows, offset, hasMore });
  } else {
    if (!tables.includes(table) && !views.includes(table)) throw new Error("Choose an ordinary table or view from this database");
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const statement = db.prepare(`SELECT * FROM ${quoted} LIMIT 201 OFFSET ?`);
    statement.setReadBigInts(true);
    statement.setReturnArrays(true);
    const rawRows = statement.all(offset);
    const columns = statement.columns().map(column => column.name);
    if (columns.length > 100) throw new Error("Table has more than 100 columns");
    const fields = db.prepare(`PRAGMA table_xinfo(${quoted})`).all().filter(row => row.hidden !== 1).map(row => ({
      name: String(row.name), type: String(row.type || ""), notNull: Boolean(row.notnull), primaryKey: Number(row.pk || 0),
      defaultValue: row.dflt_value == null ? null : String(row.dflt_value).slice(0, 500),
      ...(row.hidden === 2 ? { generated: "virtual" } : row.hidden === 3 ? { generated: "stored" } : {}),
    }));
    const foreignKeys = tables.includes(table) ? db.prepare(`PRAGMA foreign_key_list(${quoted})`).all().slice(0, 100).map(row => ({
      from: String(row.from), table: String(row.table), to: row.to == null ? null : String(row.to)
    })) : [];
    const tableIndexes = tables.includes(table) ? db.prepare(`PRAGMA index_list(${quoted})`).all().slice(0, 100)
      .map(row => describeIndex(db, String(row.name), table, row)) : [];
    const definition = String(objects.find(object => object.name === table)?.sql || "").slice(0, 10_000);
    const rows = rawRows.slice(0, 200).map(row => row.map(compact));
    parentPort.postMessage({ tables, views, table, columns, fields, indexes: tableIndexes, foreignKeys, definition, rows, offset, hasMore: rawRows.length > 200 });
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "Database inspection failed";
  const sqlErrorOffset = error?.code === "ERR_SQLITE_ERROR" && error.errcode === 1 && workerData.sql
    ? await require("./sqlite-error-location.cjs").sqliteErrorOffset(workerData.path, workerData.sql, message) : undefined;
  parentPort.postMessage({ error: message.slice(0, 300), ...(sqlErrorOffset === undefined ? {} : { sqlErrorOffset }) });
} finally { db?.close(); }
})().catch(() => parentPort.postMessage({ error: "Database inspection failed" }));
