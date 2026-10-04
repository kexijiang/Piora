/* Error diagnostics only: prepare against a read-only private image, never execute SQL. */
/* eslint-disable @typescript-eslint/no-require-imports -- Packaged CommonJS worker asset. */
"use strict";
const { readFile, stat } = require("node:fs/promises");

exports.sqliteErrorOffset = async function sqliteErrorOffset(path, sql, message) {
  if (typeof sql !== "string" || sql.length > 4096 || typeof message !== "string") return undefined;
  let db;
  try {
    const size = (await stat(path)).size;
    if (size < 100 || size > 64 * 1024 * 1024) return undefined;
    const { default: init } = await import("@sqlite.org/sqlite-wasm");
    const sqlite = await init({ print: () => {}, printErr: () => {},
      wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: 2048 }) });
    const bytes = await readFile(path);
    if (bytes.length !== size) return undefined;
    const data = sqlite.wasm.allocFromTypedArray(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    db = new sqlite.oo1.DB(":memory:");
    const status = sqlite.capi.sqlite3_deserialize(db.pointer, "main", data, BigInt(size), BigInt(size),
      sqlite.capi.SQLITE_DESERIALIZE_READONLY | sqlite.capi.SQLITE_DESERIALIZE_FREEONCLOSE);
    if (status !== sqlite.capi.SQLITE_OK) return undefined;
    sqlite.wasm.scopedAllocPush();
    try {
      const output = sqlite.wasm.scopedAllocPtr();
      const result = sqlite.capi.sqlite3_prepare_v3(db.pointer, sql, -1, 0, output, 0);
      const diagnostic = sqlite.capi.sqlite3_errmsg(db.pointer);
      const offset = sqlite.capi.sqlite3_error_offset(db.pointer);
      const statement = sqlite.wasm.peekPtr(output);
      if (statement) sqlite.capi.sqlite3_finalize(statement);
      // Engine versions or compiled features can differ. Only matching failures may supply a location.
      return result !== sqlite.capi.SQLITE_OK && diagnostic === message && Number.isInteger(offset)
        && offset >= 0 && offset <= Buffer.byteLength(sql, "utf8") ? offset : undefined;
    } finally { sqlite.wasm.scopedAllocPop(); }
  } catch { return undefined; }
  finally { try { db?.close(); } catch { /* Diagnostics cannot replace the original query error. */ } }
};
