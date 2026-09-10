/* Packaged unchanged: SQLite is confined to this worker, never the Next event loop. */
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone worker asset runs as CommonJS. */
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const { mkdirSync } = require("node:fs");
const { join } = require("node:path");

class ShellDatabase {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "shell.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,parent TEXT,updated INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS entities_parent ON entities(kind,parent,updated);
      CREATE INDEX IF NOT EXISTS entities_timeline ON entities(parent);
      CREATE TABLE IF NOT EXISTS requests(terminal TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,kind TEXT NOT NULL,entity TEXT NOT NULL,PRIMARY KEY(terminal,id));
      CREATE TABLE IF NOT EXISTS values_store(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_occurrences(source TEXT NOT NULL,digest TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(source,digest));
      CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY,sourceId TEXT NOT NULL,source TEXT NOT NULL,command TEXT NOT NULL,cwd TEXT,shell TEXT,executedAt INTEGER,importedAt INTEGER NOT NULL,exitCode INTEGER,status TEXT,favorite INTEGER NOT NULL DEFAULT 0,terminalId TEXT,sessionId TEXT);
      CREATE INDEX IF NOT EXISTS history_time ON history(executedAt DESC,importedAt DESC);
      CREATE INDEX IF NOT EXISTS history_source ON history(sourceId,id);
      CREATE INDEX IF NOT EXISTS history_cwd ON history(cwd,executedAt DESC);
      CREATE TABLE IF NOT EXISTS tombstones(id TEXT PRIMARY KEY);
      CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(command,content=history,content_rowid=rowid,tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS history_insert AFTER INSERT ON history BEGIN INSERT INTO history_fts(rowid,command) VALUES(new.rowid,new.command); END;
      CREATE TRIGGER IF NOT EXISTS history_delete AFTER DELETE ON history BEGIN INSERT INTO history_fts(history_fts,rowid,command) VALUES('delete',old.rowid,old.command); END;
      CREATE TRIGGER IF NOT EXISTS history_update AFTER UPDATE OF command ON history BEGIN INSERT INTO history_fts(history_fts,rowid,command) VALUES('delete',old.rowid,old.command); INSERT INTO history_fts(rowid,command) VALUES(new.rowid,new.command); END;`);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  entity({ kind, id, parent = null, data }) {
    this.db.prepare("INSERT INTO entities(kind,id,parent,updated,data) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET parent=excluded.parent,updated=excluded.updated,data=excluded.data")
      .run(kind, id, parent, Date.now(), JSON.stringify(data));
    return data;
  }
  accept(args) {
    return this.transaction(() => {
      const previous = this.db.prepare("SELECT * FROM requests WHERE terminal=? AND id=?").get(args.terminalId, args.requestId);
      if (previous) {
        if (previous.fingerprint !== args.fingerprint) throw new Error("Request id was already used for different content");
        return { accepted: false, kind: previous.kind, id: previous.entity };
      }
      this.entity(args);
      this.db.prepare("INSERT INTO requests VALUES(?,?,?,?,?)").run(args.terminalId, args.requestId, args.fingerprint, args.kind, args.id);
      if (args.kind === "run") this.dispatch("setValue", { key: "transcript-owner:" + args.terminalId, value: args.id });
      return { accepted: true, kind: args.kind, id: args.id };
    });
  }
  historyUpsert({ records }, inTransaction = false) {
    const action = () => {
      const insert = this.db.prepare(`INSERT INTO history(id,sourceId,source,command,cwd,shell,executedAt,importedAt,exitCode,status,favorite,terminalId,sessionId)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM tombstones WHERE id=?)
        ON CONFLICT(id) DO UPDATE SET exitCode=excluded.exitCode,status=excluded.status,cwd=COALESCE(excluded.cwd,history.cwd),executedAt=COALESCE(excluded.executedAt,history.executedAt)`);
      let changed = 0;
      for (const r of records) {
        if (!r.id || typeof r.command !== "string" || !r.command.trim() || r.command.length > 65536) continue;
        changed += Number(insert.run(r.id,r.sourceId,r.source,r.command,r.cwd ?? null,r.shell ?? null,r.executedAt ?? null,r.importedAt ?? Date.now(),r.exitCode ?? null,r.status ?? null,r.favorite ? 1 : 0,r.terminalId ?? null,r.sessionId ?? null,r.id).changes);
      }
      return { changed };
    };
    return inTransaction ? action() : this.transaction(action);
  }
  queryHistory(q = {}) {
    const where = [], params = [];
    const terms = String(q.query || "").trim().split(/\s+/).filter(Boolean).slice(0, 12);
    const indexed = terms.filter(term => Array.from(term).length >= 3);
    if (indexed.length) {
      where.push("h.rowid IN (SELECT rowid FROM history_fts WHERE history_fts MATCH ?)");
      params.push(indexed.map(term => '"' + term.replaceAll('"', '""') + '"').join(" AND "));
    }
    for (const term of terms.filter(term => Array.from(term).length < 3)) { where.push("instr(lower(h.command),lower(?))>0"); params.push(term); }
    for (const field of ["source", "status"]) if (q[field]) { where.push(`h.${field}=?`); params.push(q[field]); }
    if (q.favorite) where.push("h.favorite=1");
    if (q.cwd && !q.suggestions) { where.push("h.cwd=?"); params.push(q.cwd); }
    if (q.shell && !q.suggestions) { where.push("h.shell=?"); params.push(q.shell); }
    const filter = where.length ? "WHERE " + where.join(" AND ") : "";
    const limit = Math.max(1, Math.min(200, q.limit || (q.suggestions ? 8 : 50)));
    const offset = Math.max(0, Math.min(1_000_000, q.offset || 0));
    // Deduplicate suggestions only; the history itself remains an execution archive.
    const select = q.suggestions
      ? `SELECT h.*,COUNT(*) AS frequency,MAX(COALESCE(h.executedAt,h.importedAt)) AS recent FROM history h ${filter} GROUP BY h.command,h.shell`
      : `SELECT h.* FROM history h ${filter}`;
    const order = q.suggestions
      ? " ORDER BY (lower(command)=lower(?)) DESC,(instr(lower(command),lower(?))=1) DESC,(cwd=?) DESC,(shell=?) DESC,recent DESC,frequency DESC"
      : " ORDER BY COALESCE(executedAt,importedAt) DESC,id DESC";
    const extra = q.suggestions ? [q.query || "",q.query || "",q.cwd || "",q.shell || ""] : [];
    const rows = this.db.prepare(select + order + " LIMIT ? OFFSET ?").all(...params,...extra,limit,offset);
    return { records: rows.map(r => ({ ...r, favorite: Boolean(r.favorite) })), hasMore: rows.length === limit };
  }
  recover() {
    return this.transaction(() => {
      for (const row of this.db.prepare("SELECT kind,id,parent,data FROM entities WHERE kind IN ('session','command','run')").all()) {
        const value = JSON.parse(row.data);
        if (row.kind === "session") {
          value.connected = false; value.integration = "unavailable"; value.owner = "human";
          value.activeRunId = null; value.activeCommandId = null;
        } else if (row.kind === "command" && ["accepted", "running"].includes(value.status)) {
          value.status = "unknown"; value.endedAt = Date.now();
        } else if (row.kind === "run" && ["running", "awaiting_input", "awaiting_approval"].includes(value.status)) {
          value.status = "interrupted"; value.endedAt = Date.now(); value.approval = null; value.question = null;
        } else continue;
        this.entity({ ...row, data: value });
      }
      this.db.prepare("UPDATE history SET status='unknown' WHERE status IN ('accepted','running')").run();
      return true;
    });
  }
  dispatch(op, args = {}) {
    switch (op) {
      case "putEntity": return this.entity(args);
      case "getEntity": { const row = this.db.prepare("SELECT data FROM entities WHERE kind=? AND id=?").get(args.kind,args.id); return row ? JSON.parse(row.data) : null; }
      case "listEntities": return this.db.prepare(`SELECT data FROM entities WHERE kind=? ${args.parent ? "AND parent=?" : ""} ORDER BY updated DESC LIMIT ? OFFSET ?`).all(args.kind,...(args.parent ? [args.parent] : []),Math.min(1000,args.limit || 100),args.offset || 0).map(r => JSON.parse(r.data));
      case "timeline": {
        const rows = this.db.prepare("SELECT rowid AS cursor,kind,data FROM entities WHERE parent=? AND kind IN ('command','run') AND rowid<? ORDER BY rowid DESC LIMIT 101").all(args.terminalId, args.before || Number.MAX_SAFE_INTEGER);
        const page = rows.slice(0, 100);
        return { commands: page.filter(row => row.kind === "command").map(row => JSON.parse(row.data)), runs: page.filter(row => row.kind === "run").map(row => JSON.parse(row.data)), nextCursor: rows.length > 100 ? String(page.at(-1).cursor) : null };
      }
      case "accept": return this.accept(args);
      case "getRequest": return this.db.prepare("SELECT fingerprint,kind,entity FROM requests WHERE terminal=? AND id=?").get(args.terminalId,args.requestId) || null;
      case "saveTranscript": return this.transaction(() => {
        this.entity({ kind: "run-transcript", id: args.runId, parent: args.terminalId, data: args.messages });
        if (this.dispatch("getValue", { key: "transcript-owner:" + args.terminalId }) === args.runId) {
          this.entity({ kind: "transcript", id: args.terminalId, parent: args.terminalId, data: args.messages });
          return true;
        }
        return false;
      });
      case "getValue": { const row = this.db.prepare("SELECT value FROM values_store WHERE key=?").get(args.key); return row ? JSON.parse(row.value) : null; }
      case "setValue": this.db.prepare("INSERT INTO values_store VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(args.key,JSON.stringify(args.value)); return args.value;
      case "historyUpsert": return this.historyUpsert(args);
      case "queryHistory": return this.queryHistory(args);
      case "getHistoryRecords": {
        const ids = [...new Set(args.ids || [])].filter(id => typeof id === "string").slice(0, 200);
        if (!ids.length) return [];
        return this.db.prepare("SELECT * FROM history WHERE id IN (" + ids.map(() => "?").join(",") + ")").all(...ids).map(row => ({ ...row, favorite: Boolean(row.favorite) }));
      }
      case "deleteHistory": return this.transaction(() => { this.db.prepare("INSERT OR IGNORE INTO tombstones VALUES(?)").run(args.id); this.db.prepare("DELETE FROM history WHERE id=?").run(args.id); return true; });
      case "favoriteHistory": return this.db.prepare("UPDATE history SET favorite=? WHERE id=?").run(args.favorite ? 1 : 0,args.id).changes > 0;
      case "recover": return this.recover();
      case "importSources": {
        if (!this.importing) this.importing = require("./history-import.cjs").importSources(this,args).finally(() => { this.importing = null; });
        return this.importing;
      }
      case "close": if (this.importing) return this.importing.catch(() => {}).then(() => { this.db.close(); return true; }); this.db.close(); return true;
      default: throw new Error("Unknown shell database operation");
    }
  }
}

module.exports = { ShellDatabase };
if (parentPort) {
  const database = new ShellDatabase(workerData.directory);
  parentPort.on("message", async ({ id, op, args }) => {
    try { parentPort.postMessage({ id, result: await database.dispatch(op,args) }); }
    catch (error) { parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
  });
}
