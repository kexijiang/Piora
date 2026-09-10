import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import {
  CLIPBOARD_PAYLOAD_LIMIT, CLIPBOARD_TEXT_LIMIT, CLIPBOARD_TRASH_AGE, DEFAULT_CLIPBOARD_SETTINGS,
  type ClipboardAsset, type ClipboardCapture, type ClipboardDetail, type ClipboardFile, type ClipboardItem,
  type ClipboardKind, type ClipboardMutation, type ClipboardPage, type ClipboardQuery, type ClipboardSettings, type ClipboardStatus,
} from "./clipboard-types.js";

type Row = Record<string, string | number | null>;
export interface ClipboardArchiveRecord {
  id: string; title: string; remark: string; text: string | null; htmlHash: string | null; rtfHash: string | null; imageHash: string | null;
  files: ClipboardFile[]; source: { name: string; executable: string }; createdAt: number; copiedAt: number; copies: number;
  starred: boolean; deletedAt: number | null; shelfOrder: number | null;
}
type StoreStatus = Pick<ClipboardStatus, "settings" | "total" | "trash" | "shelf" | "bytes" | "budgetState" | "revision" | "sources" | "migrationWarnings" | "backupBytes" | "databaseBytes">;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const byteLength = (value: string | null | undefined) => value ? Buffer.byteLength(value) : 0;
const quoteLike = (value: string) => value.replace(/[\\%_]/g, "\\$&");
const asNumber = (value: unknown) => typeof value === "number" ? value : 0;
const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function validateClipboardCapture(input: ClipboardCapture): ClipboardCapture {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("剪贴板内容无效。");
  const result: ClipboardCapture = {};
  let size = 0;
  for (const key of ["text", "html", "rtf"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "string") throw new Error("剪贴板文字格式无效。");
    const bytes = byteLength(input[key]);
    if (key === "text" && bytes > CLIPBOARD_TEXT_LIMIT) throw new Error("文字超过单条 2 MiB 上限，已跳过。");
    size += bytes; result[key] = input[key];
  }
  if (input.image !== undefined) {
    if (!(input.image instanceof Uint8Array)) throw new Error("图片数据无效。");
    const image = Buffer.from(input.image);
    if (image.length < 24 || !image.subarray(0, 8).equals(pngHeader)) throw new Error("图片必须是有效的 PNG 数据。");
    const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
    if (!width || !height || width > 65536 || height > 65536 || width * height > 100_000_000) throw new Error("图片尺寸过大，已跳过。");
    result.image = image; result.width = width; result.height = height; size += image.length;
  }
  if (input.files !== undefined) {
    if (!Array.isArray(input.files) || input.files.length > 1000) throw new Error("单次最多收录 1000 个文件引用。");
    const seen = new Set<string>();
    result.files = input.files.map(file => {
      if (!file || typeof file.path !== "string" || file.path.length > 32767 || file.path.includes("\0") || !file.path.trim() || !/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(file.path)) throw new Error("文件引用路径无效。");
      return { path: file.path, name: basename(file.path.replace(/\\/g, "/")), directory: file.directory === true };
    }).filter(file => { const key = process.platform === "win32" ? file.path.toLowerCase() : file.path; if (seen.has(key)) return false; seen.add(key); return true; });
    size += byteLength(JSON.stringify(result.files));
  }
  if (size > CLIPBOARD_PAYLOAD_LIMIT) throw new Error("单条内容超过 64 MiB 上限，已跳过。");
  if (input.source) {
    if (typeof input.source.name !== "string" || typeof input.source.executable !== "string") throw new Error("来源信息无效。");
    result.source = { name: input.source.name.slice(0, 120), executable: input.source.executable.slice(0, 32767) };
  }
  if (!result.text && !result.html && !result.rtf && !result.image && !result.files?.length) throw new Error("剪贴板中没有可收录的内容。");
  return result;
}

/** Synchronous implementation confined to its database worker in production. */
export class ClipboardDatabase {
  private db: DatabaseSync;
  private statements = new Map<string, StatementSync>();
  private warnings: string[] = [];
  private backupBytes = 0;
  private blobs: string;
  private transactionDepth = 0;
  private transactionFiles: string[] = [];
  constructor(readonly directory: string, private now = Date.now, options: { maintenance?: boolean } = {}) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.blobs = join(directory, "content"); mkdirSync(this.blobs, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "clipboard.sqlite"));
    // Inspect the version before any schema or journal mutation.
    if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get()) {
      const version = this.db.prepare("SELECT value FROM meta WHERE key='version'").get()?.value;
      if (version !== "2") { this.db.close(); throw new Error("剪贴板数据库版本较新，请使用对应版本的 Piora。"); }
    }
    // Bound mapped reads to 256 MiB, avoiding per-page Windows I/O during scans.
    // The OS pages this mapping on demand; durable writes still use FULL + WAL.
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000; PRAGMA cache_size=-16384; PRAGMA mmap_size=268435456;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta VALUES('version','2'),('revision','0'),('bytes','0');
      CREATE TABLE IF NOT EXISTS assets(hash TEXT PRIMARY KEY,bytes INTEGER NOT NULL,mime TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS clips(
        id TEXT PRIMARY KEY,identity TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,title TEXT NOT NULL,remark TEXT NOT NULL DEFAULT '',
        text TEXT,html_hash TEXT REFERENCES assets(hash),rtf_hash TEXT REFERENCES assets(hash),image_hash TEXT REFERENCES assets(hash),
        width INTEGER,height INTEGER,files TEXT NOT NULL DEFAULT '[]',inline_bytes INTEGER NOT NULL,bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,copied_at INTEGER NOT NULL,copies INTEGER NOT NULL DEFAULT 1,starred INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER,source_name TEXT NOT NULL DEFAULT '',source_executable TEXT NOT NULL DEFAULT '',search_text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shelf(clip_id TEXT PRIMARY KEY REFERENCES clips(id) ON DELETE CASCADE,position INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS clips_recent ON clips(deleted_at,copied_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS clips_kind ON clips(kind,deleted_at,copied_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS clips_star ON clips(starred,deleted_at,copied_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS clips_source ON clips(source_executable,deleted_at,copied_at DESC);
      CREATE INDEX IF NOT EXISTS clips_source_names ON clips(source_name,source_executable) WHERE source_executable<>'';
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(search_text,content='clips',content_rowid='rowid',tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS clips_ai AFTER INSERT ON clips BEGIN
        INSERT INTO search(rowid,search_text) VALUES(new.rowid,new.search_text);
        UPDATE meta SET value=CAST(value AS INTEGER)+new.inline_bytes WHERE key='bytes'; END;
      CREATE TRIGGER IF NOT EXISTS clips_ad AFTER DELETE ON clips BEGIN
        INSERT INTO search(search,rowid,search_text) VALUES('delete',old.rowid,old.search_text);
        UPDATE meta SET value=CAST(value AS INTEGER)-old.inline_bytes WHERE key='bytes'; END;
      CREATE TRIGGER IF NOT EXISTS clips_au AFTER UPDATE OF search_text ON clips BEGIN
        INSERT INTO search(search,rowid,search_text) VALUES('delete',old.rowid,old.search_text);
        INSERT INTO search(rowid,search_text) VALUES(new.rowid,new.search_text); END;
      CREATE TRIGGER IF NOT EXISTS assets_ai AFTER INSERT ON assets BEGIN UPDATE meta SET value=CAST(value AS INTEGER)+new.bytes WHERE key='bytes'; END;
      CREATE TRIGGER IF NOT EXISTS assets_ad AFTER DELETE ON assets BEGIN UPDATE meta SET value=CAST(value AS INTEGER)-old.bytes WHERE key='bytes'; END;`);
    if (this.meta("version") !== "2") throw new Error("剪贴板数据库版本较新，请使用对应版本的 Piora。");
    if (options.maintenance !== false) { this.migrateLegacy(); this.prune(); }
  }
  private statement(sql: string) { let s = this.statements.get(sql); if (!s) { s = this.db.prepare(sql); if (this.statements.size > 100) this.statements.clear(); this.statements.set(sql, s); } return s; }
  private row(sql: string, ...args: SQLInputValue[]) { return this.statement(sql).get(...args) as Row | undefined; }
  private rows(sql: string, ...args: SQLInputValue[]) { return this.statement(sql).all(...args) as Row[]; }
  private run(sql: string, ...args: SQLInputValue[]) { return this.statement(sql).run(...args); }
  private meta(key: string) { return String(this.row("SELECT value FROM meta WHERE key=?", key)?.value ?? ""); }
  private setMeta(key: string, value: string) { this.run("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value); }
  private transaction<T>(fn: () => T): T {
    if (this.transactionDepth) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1; this.transactionFiles = [];
    try { const result = fn(); this.run("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'"); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); for (const file of this.transactionFiles) { try { unlinkSync(file); } catch { /* Orphan GC retries transient file locks. */ } } throw error; }
    finally { this.transactionDepth = 0; this.transactionFiles = []; }
  }
  settings(): ClipboardSettings {
    const raw = this.meta("settings");
    return raw ? { ...DEFAULT_CLIPBOARD_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_CLIPBOARD_SETTINGS, excludedApps: [] };
  }
  revision() { return Number(this.meta("revision")); }
  private usedBytes() { return Number(this.meta("bytes")); }
  status(): StoreStatus {
    const settings = this.settings(), bytes = this.usedBytes();
    const databaseBytes = ["clipboard.sqlite", "clipboard.sqlite-wal", "clipboard.sqlite-shm"].reduce((total, name) => {
      try { return total + statSync(join(this.directory, name)).size; } catch { return total; }
    }, 0);
    const counts = this.row("SELECT (SELECT COUNT(*) FROM clips WHERE deleted_at IS NULL) total,(SELECT COUNT(*) FROM clips WHERE deleted_at IS NOT NULL) trash")!;
    return { settings, bytes, total: Number(counts.total), trash: Number(counts.trash),
      shelf: Number(this.row("SELECT COUNT(*) n FROM shelf")!.n), budgetState: bytes >= settings.budgetBytes ? "full" : bytes >= settings.budgetBytes * .9 ? "warning" : "ok",
      revision: this.revision(), backupBytes: this.backupBytes, databaseBytes, migrationWarnings: [...this.warnings],
      sources: this.sources() };
  }
  private sources(): StoreStatus["sources"] {
    // Seek past duplicate source ranges instead of scanning every history row.
    // Separate scalar seeks also skip equal tuples in SQLite's composite index.
    const sources: StoreStatus["sources"] = [];
    const select = "SELECT source_name,source_executable FROM clips WHERE source_executable<>''";
    const order = " ORDER BY source_name,source_executable LIMIT 1";
    let row = this.row(select + order);
    while (row && sources.length < 200) {
      const name = String(row.source_name), executable = String(row.source_executable);
      sources.push({ name, executable });
      if (sources.length === 200) break;
      row = this.row(select + " AND source_name=? AND source_executable>?" + order, name, executable)
        ?? this.row(select + " AND source_name>?" + order, name);
    }
    return sources;
  }
  private assetPath(id: string) { if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("内容引用无效。"); return join(this.blobs, id); }
  private ensureAsset(id: string, data: Buffer, mime: string) {
    if (this.row("SELECT hash FROM assets WHERE hash=?", id)) return;
    const file = this.assetPath(id);
    if (!existsSync(file)) {
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { writeFileSync(temporary, data, { mode: 0o600 }); renameSync(temporary, file); this.transactionFiles.push(file); }
      finally { if (existsSync(temporary)) unlinkSync(temporary); }
    }
    else if (hash(readFileSync(file)) !== id) throw new Error("内容文件校验失败，原历史已保留。");
    this.run("INSERT INTO assets(hash,bytes,mime) VALUES(?,?,?)", id, data.length, mime);
  }
  private searchText(text: string | null, title: string, remark: string, files: ClipboardFile[]) {
    return [text ?? "", title, remark, ...files.flatMap(f => [f.name, f.path])].join("\n");
  }
  capture(raw: ClipboardCapture, preserved?: { id: string; createdAt: number; copiedAt: number; copies: number; starred: boolean; title: string; remark?: string; deletedAt?: number | null }): string {
    const input = validateClipboardCapture(raw);
    const image = input.image ? Buffer.from(input.image) : null;
    const html = input.html ? Buffer.from(input.html) : null, rtf = input.rtf ? Buffer.from(input.rtf) : null;
    const text = input.text ?? null, files = input.files ?? [], filesJSON = JSON.stringify(files);
    const imageHash = image ? hash(image) : null, htmlHash = html ? hash(html) : null, rtfHash = rtf ? hash(rtf) : null;
    const identity = hash(JSON.stringify({ text, htmlHash, rtfHash, imageHash, files: files.map(f => f.path) }));
    const existing = this.row("SELECT id,copies,deleted_at FROM clips WHERE identity=?", identity);
    const source = input.source ?? { name: "", executable: "" };
    if (existing) {
      if (preserved) return String(existing.id);
      this.transaction(() => this.run("UPDATE clips SET copied_at=?,copies=copies+1,deleted_at=NULL,source_name=?,source_executable=? WHERE id=?", this.now(), source.name, source.executable, String(existing.id)));
      return String(existing.id);
    }
    const inlineBytes = byteLength(text) + byteLength(filesJSON);
    const assets = [[imageHash, image, "image/png"], [htmlHash, html, "text/html"], [rtfHash, rtf, "text/rtf"]] as const;
    const extra = inlineBytes + assets.reduce((sum, [id, data]) => sum + (id && data && !this.row("SELECT hash FROM assets WHERE hash=?", id) ? data.length : 0), 0);
    if (!preserved && this.usedBytes() + extra > this.settings().budgetBytes) throw new Error("剪贴板空间预算不足，已暂停新增。请增加预算或清理最近删除；现有历史不会自动删除。");
    const kind: ClipboardKind = files.length ? "files" : image ? "image" : /^https?:\/\/\S+$/i.test(text?.trim() ?? "") ? "link" : "text";
    const title = preserved?.title.slice(0, 120) || (files.length ? files.length === 1 ? files[0]!.name : `${files[0]!.name} 等 ${files.length} 个文件` : image ? "剪贴板图片" : (text || "富文本内容").trim().split(/\r?\n/)[0]!.slice(0, 100));
    const id = preserved?.id ?? randomUUID(), createdAt = preserved?.createdAt ?? this.now(), copiedAt = preserved?.copiedAt ?? this.now();
    const remark = preserved?.remark?.slice(0, 2000) ?? "";
    this.transaction(() => {
      for (const [id, data, mime] of assets) if (id && data) this.ensureAsset(id, data, mime);
      this.run(`INSERT INTO clips(id,identity,kind,title,remark,text,html_hash,rtf_hash,image_hash,width,height,files,inline_bytes,bytes,created_at,copied_at,copies,starred,deleted_at,source_name,source_executable,search_text)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, identity, kind, title, remark, text, htmlHash, rtfHash, imageHash,
        input.width ?? null, input.height ?? null, filesJSON, inlineBytes, inlineBytes + (image?.length ?? 0) + (html?.length ?? 0) + (rtf?.length ?? 0),
        createdAt, copiedAt, preserved?.copies ?? 1, preserved?.starred ? 1 : 0, preserved?.deletedAt ?? null, source.name, source.executable, this.searchText(text, title, remark, files));
    });
    return id;
  }
  /** Immutable snapshot, including hard-linked assets, created while this worker owns writes. */
  createSnapshot(directory: string) {
    mkdirSync(join(directory, "content"), { recursive: true, mode: 0o700 });
    this.db.prepare("VACUUM INTO ?").run(join(directory, "clipboard.sqlite"));
    for (const { hash: id } of this.rows("SELECT hash FROM assets")) {
      const source = this.assetPath(String(id)), destination = join(directory, "content", String(id));
      try { linkSync(source, destination); } catch { copyFileSync(source, destination); }
    }
  }
  *archiveRecords(): Generator<ClipboardArchiveRecord> {
    for (const result of this.statement(`${this.select} ORDER BY c.id`).iterate()) {
      const row = result as Row;
      yield { id: String(row.id), title: String(row.title), remark: String(row.remark), text: row.text as string | null,
        htmlHash: row.html_hash as string | null, rtfHash: row.rtf_hash as string | null, imageHash: row.image_hash as string | null,
        files: JSON.parse(String(row.files)), source: { name: String(row.source_name), executable: String(row.source_executable) },
        createdAt: Number(row.created_at), copiedAt: Number(row.copied_at), copies: Number(row.copies), starred: Boolean(row.starred),
        deletedAt: row.deleted_at === null ? null : Number(row.deleted_at), shelfOrder: row.shelf_order == null ? null : Number(row.shelf_order) };
    }
  }
  *archiveAssets(): Generator<{ hash: string; bytes: number; path: string }> {
    for (const row of this.statement("SELECT hash,bytes FROM assets ORDER BY hash").iterate()) yield { hash: String(row.hash), bytes: Number(row.bytes), path: this.assetPath(String(row.hash)) };
  }
  importRecords(records: Iterable<ClipboardArchiveRecord>, asset: (id: string) => Buffer, restoreSettings?: ClipboardSettings) {
    let imported = 0, merged = 0, conflictCount = 0;
    const warnings: string[] = [], shelf: Array<{ id: string; order: number }> = [];
    this.transaction(() => {
      for (const entry of records) {
        const input: ClipboardCapture = { ...(entry.text === null ? {} : { text: entry.text }), files: entry.files, source: entry.source };
        if (entry.htmlHash) input.html = asset(entry.htmlHash).toString("utf8");
        if (entry.rtfHash) input.rtf = asset(entry.rtfHash).toString("utf8");
        if (entry.imageHash) input.image = asset(entry.imageHash);
        // A foreign archive may reuse an ID for different content. Full-format
        // identity decides merging; an unrelated existing record keeps its ID.
        const idCollision = Boolean(this.row("SELECT id FROM clips WHERE id=?", entry.id));
        const requestedId = idCollision ? randomUUID() : entry.id;
        const id = this.capture(input, { ...entry, id: requestedId });
        if (id === requestedId) {
          // capture already inserted the preserved metadata and FTS document.
          // Rewriting identical search_text here doubles bulk-import indexing.
          imported++;
          if (entry.shelfOrder !== null) shelf.push({ id, order: entry.shelfOrder });
          continue;
        }
        const current = this.row("SELECT remark,created_at,copied_at,copies,starred FROM clips WHERE id=?", id)!;
        merged++;
        if (current.remark && entry.remark && current.remark !== entry.remark) {
          conflictCount++; if (warnings.length < 100) warnings.push(`「${entry.title}」已有不同备注，保留当前备注。`);
        }
        const remark = String(current.remark || entry.remark);
        this.run("UPDATE clips SET remark=?,starred=?,created_at=?,copied_at=?,copies=?,search_text=? WHERE id=?", remark, current.starred || entry.starred ? 1 : 0,
          Math.min(Number(current.created_at), entry.createdAt), Math.max(Number(current.copied_at), entry.copiedAt), Math.max(Number(current.copies), entry.copies), this.searchText(input.text ?? null, String(this.row("SELECT title FROM clips WHERE id=?", id)!.title), remark, entry.files), id);
        if (entry.shelfOrder !== null) shelf.push({ id, order: entry.shelfOrder });
      }
      if (restoreSettings) this.mutate({ type: "settings", value: restoreSettings });
      if (!restoreSettings && this.usedBytes() > this.settings().budgetBytes) throw new Error("导入后将超出剪贴板空间预算。请先增加容量预算再导入，现有历史未更改。");
      for (const entry of shelf.sort((a, b) => a.order - b.order)) this.run("INSERT OR IGNORE INTO shelf(clip_id,position) VALUES(?,COALESCE((SELECT MAX(position)+1 FROM shelf),0))", entry.id);
    });
    if (conflictCount > 100) warnings.push(`另有 ${conflictCount - 100} 条备注冲突，同样保留当前备注。`);
    return { imported, merged, warnings };
  }
  private summary(row: Row, query = ""): ClipboardItem {
    const formats: ClipboardItem["formats"] = [];
    if (row.has_text !== undefined ? Boolean(row.has_text) : row.text !== null) formats.push("text"); if (row.html_hash) formats.push("html"); if (row.rtf_hash) formats.push("rtf"); if (row.image_hash) formats.push("image");
    const files: ClipboardFile[] = row.files === undefined ? [] : JSON.parse(String(row.files)); const fileCount = row.file_count === undefined ? files.length : Number(row.file_count); if (fileCount) formats.push("files");
    let preview = String(row.list_preview ?? row.text ?? (files.length ? files.map(f => f.name).join(" · ") : row.image_hash ? "PNG 图片" : "富文本内容"));
    const term = query.trim().split(/\s+/)[0]?.toLocaleLowerCase();
    if (term) { const at = preview.toLocaleLowerCase().indexOf(term); if (at > 60) preview = `…${preview.slice(at - 40)}`; }
    return { id: String(row.id), kind: row.kind as ClipboardKind, title: String(row.title), remark: String(row.remark), preview: preview.slice(0, 260),
      createdAt: Number(row.created_at), copiedAt: Number(row.copied_at), copies: Number(row.copies), starred: Boolean(row.starred), deletedAt: row.deleted_at === null ? null : Number(row.deleted_at),
      source: { name: String(row.source_name), executable: String(row.source_executable) }, bytes: Number(row.bytes), fileCount, formats,
      image: row.image_hash ? { hash: String(row.image_hash), bytes: asNumber(row.image_bytes), mime: "image/png", width: asNumber(row.width), height: asNumber(row.height) } : null,
      shelfOrder: row.shelf_order === null || row.shelf_order === undefined ? null : Number(row.shelf_order) };
  }
  private select = "SELECT c.*,s.position shelf_order,a.bytes image_bytes FROM clips c LEFT JOIN shelf s ON s.clip_id=c.id LEFT JOIN assets a ON a.hash=c.image_hash";
  private *querySteps(input: ClipboardQuery): Generator<void, ClipboardPage> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("查询参数无效。");
    const filter = input.filter ?? "all";
    if (input.direction !== undefined && !["older", "newer"].includes(input.direction) || input.includeCursor !== undefined && typeof input.includeCursor !== "boolean") throw new Error("分页方向无效。");
    const newer = input.direction === "newer";
    if (!["all", "text", "image", "files", "starred", "trash", "shelf"].includes(filter)) throw new Error("筛选类型无效。");
    if (input.text !== undefined && (typeof input.text !== "string" || input.text.length > 1000)) throw new Error("搜索内容过长。");
    const query = input.text?.trim() ?? "", args: SQLInputValue[] = [], where: string[] = [];
    where.push(filter === "trash" ? "c.deleted_at IS NOT NULL" : filter === "shelf" ? "s.clip_id IS NOT NULL" : "c.deleted_at IS NULL");
    if (filter === "text") where.push("c.kind IN ('text','link')");
    if (filter === "image" || filter === "files") { where.push("c.kind=?"); args.push(filter); }
    if (filter === "starred") where.push("c.starred=1");
    if (input.source) { if (typeof input.source !== "string" || input.source.length > 32767) throw new Error("来源筛选无效。"); where.push("c.source_executable=?"); args.push(input.source); }
    for (const [key, op] of [["after", ">="], ["before", "<="]] as const) if (input[key] !== undefined) { if (!Number.isFinite(input[key])) throw new Error("时间筛选无效。"); where.push(`c.copied_at ${op} ?`); args.push(input[key]!); }
    const terms = query.split(/\s+/).filter(Boolean);
    const indexedTerms = terms.filter(t => [...t].length >= 3);
    if (indexedTerms.length) { where.push("c.rowid IN (SELECT rowid FROM search WHERE search MATCH ?)"); args.push(indexedTerms.map(t => `"${t.replace(/"/g, '""')}"`).join(" AND ")); }
    const shortTerms = terms.filter(t => [...t].length < 3);
    const shortMatch = shortTerms.map(() => "c.search_text LIKE ? ESCAPE '\\'").join(" AND ") || "1";
    const shortArgs = shortTerms.map(term => `%${quoteLike(term)}%`);
    const ascending = (filter === "shelf") !== newer;
    const order = filter === "shelf" ? `s.position ${ascending ? "ASC" : "DESC"},c.id ${ascending ? "ASC" : "DESC"}` : `c.copied_at ${ascending ? "ASC" : "DESC"},c.id ${ascending ? "ASC" : "DESC"}`;
    let position: [number, string] | null = null;
    if (input.cursor) {
      if (typeof input.cursor !== "string" || input.cursor.length > 1024) throw new Error("分页游标无效。");
      let cursor: unknown; try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString()); } catch { throw new Error("分页游标无效。"); }
      if (!Array.isArray(cursor) || cursor.length !== 2 || !Number.isFinite(cursor[0]) || typeof cursor[1] !== "string" || cursor[1].length > 128) throw new Error("分页游标无效。");
      position = cursor as [number, string];
    }
    const limit = input.limit === undefined ? 100 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("每页最多 100 条。");
    const matches: Row[] = [], seen = new Set<string>();
    const field = filter === "shelf" ? "s.position" : "c.copied_at", op = ascending ? ">" : "<";
    const scanLimit = shortTerms.length ? 1024 : limit + 1;
    let inclusive = input.includeCursor === true;
    for (;;) {
      const cursorWhere = position ? ` AND (${field},c.id) ${op}${inclusive ? "=" : ""} (?,?)` : "";
      // Evaluate short-term predicates on at most 1024 candidate rows per step.
      // LIMIT applies to the scan, not to matches, so an absent term also yields.
      const rows = this.rows(`SELECT c.id,c.copied_at,s.position shelf_order,(${shortMatch}) matched FROM clips c LEFT JOIN shelf s ON s.clip_id=c.id WHERE ${where.join(" AND ")}${cursorWhere} ORDER BY ${order} LIMIT ?`, ...shortArgs, ...args, ...(position ?? []), scanLimit);
      for (const row of rows) {
        if (row.matched && !seen.has(String(row.id))) { matches.push(row); seen.add(String(row.id)); }
        if (matches.length > limit) break;
      }
      if (matches.length > limit || rows.length < scanLimit) break;
      const last = rows.at(-1); if (!last) break;
      position = [Number(filter === "shelf" ? last.shelf_order : last.copied_at), String(last.id)];
      inclusive = false;
      yield;
    }
    const more = matches.length > limit; if (more) matches.pop();
    if (newer) matches.reverse();
    const first = matches[0], last = matches.at(-1);
    const cursorFor = (row: Row | undefined) => row ? Buffer.from(JSON.stringify([filter === "shelf" ? row.shelf_order : row.copied_at, row.id])).toString("base64url") : null;
    return { items: this.summaries(matches.map(row => String(row.id)), query), nextCursor: (newer ? Boolean(input.cursor) : more) ? cursorFor(last) : null,
      previousCursor: (newer ? more : Boolean(input.cursor)) ? cursorFor(first) : null,
      revision: this.revision(), requestId: Number.isSafeInteger(input.requestId) ? input.requestId! : 0 };
  }
  private summaries(ids: string[], query: string): ClipboardItem[] {
    if (!ids.length) return [];
    const body = "COALESCE(c.text,CASE WHEN json_array_length(c.files)>0 THEN c.search_text WHEN c.image_hash IS NOT NULL THEN 'PNG 图片' ELSE '富文本内容' END)";
    // Bound every list body inside SQLite. Full text, rich formats and file paths
    // are loaded only by detail(); a page cannot copy 100 × 2 MiB into JavaScript.
    const columns = "id,kind,title,remark,created_at,copied_at,copies,starred,deleted_at,source_name,source_executable,bytes,html_hash,rtf_hash,image_hash,width,height".split(",").map(name => `c.${name}`).join(",");
    const preview = query ? `substr(${body},max(1,instr(lower(${body}),lower(?))-40),260)` : `substr(${body},1,260)`;
    const rows = this.rows(`SELECT ${columns},c.text IS NOT NULL has_text,json_array_length(c.files) file_count,${preview} list_preview,s.position shelf_order,a.bytes image_bytes FROM clips c LEFT JOIN shelf s ON s.clip_id=c.id LEFT JOIN assets a ON a.hash=c.image_hash WHERE c.id IN (${ids.map(() => "?").join(",")})`, ...(query ? [query.split(/\s+/)[0] ?? ""] : []), ...ids);
    const byId = new Map(rows.map(row => [String(row.id), row]));
    return ids.flatMap(id => { const row = byId.get(id); return row ? [this.summary(row, query)] : []; });
  }
  query(input: ClipboardQuery = {}): ClipboardPage {
    const steps = this.querySteps(input); let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  }
  async queryAsync(input: ClipboardQuery = {}, cancelled: () => boolean = () => false): Promise<ClipboardPage> {
    const steps = this.querySteps(input);
    for (;;) {
      if (cancelled()) throw new Error("剪贴板查询已取消。");
      const step = steps.next();
      if (step.done) return step.value;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  detail(id: string): ClipboardDetail {
    if (typeof id !== "string") throw new Error("记录 ID 无效。");
    const row = this.row(`${this.select} WHERE c.id=?`, id); if (!row) throw new Error("这条记录已被移除。");
    return { ...this.summary(row), text: row.text === null ? null : String(row.text),
      html: row.html_hash ? this.readAsset(String(row.html_hash)).toString("utf8") : null,
      rtf: row.rtf_hash ? this.readAsset(String(row.rtf_hash)).toString("utf8") : null,
      files: (JSON.parse(String(row.files)) as ClipboardFile[]).map(file => ({ ...file, exists: existsSync(file.path) })) };
  }
  readAsset(id: string): Buffer {
    if (!this.row("SELECT hash FROM assets WHERE hash=?", id)) throw new Error("内容不存在。");
    return readFileSync(this.assetPath(id));
  }
  assetForClip(id: string): { path: string; asset: ClipboardAsset } {
    const row = this.row("SELECT image_hash,width,height FROM clips WHERE id=?", id);
    if (!row?.image_hash) throw new Error("该记录没有图片。");
    const asset = this.row("SELECT bytes FROM assets WHERE hash=?", row.image_hash);
    if (!asset) throw new Error("图片内容缺失。");
    return { path: this.assetPath(String(row.image_hash)), asset: { hash: String(row.image_hash), mime: "image/png", bytes: Number(asset.bytes), width: Number(row.width), height: Number(row.height) } };
  }
  mutate(input: ClipboardMutation): { id: string } | void {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("操作无效。");
    if (input.type === "edit-copy") {
      const entry = this.detail(input.id); if (typeof input.text !== "string") throw new Error("文字格式无效。");
      if (!entry.formats.includes("text")) throw new Error("该记录不是可编辑文字。");
      return { id: this.capture({ text: input.text, source: { name: "Piora 编辑副本", executable: "piora:edit" } }) };
    }
    this.transaction(() => {
      if (input.type === "settings") {
        const value = input.value;
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !(k in DEFAULT_CLIPBOARD_SETTINGS))) throw new Error("设置无效。");
        for (const key of ["enabled", "captureText", "captureImages", "captureFiles"] as const) if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error("记录开关无效。");
        if (value.budgetBytes !== undefined && (!Number.isSafeInteger(value.budgetBytes) || value.budgetBytes < 64 * 1024 ** 2 || value.budgetBytes > 1024 ** 4)) throw new Error("空间预算应在 64 MiB 至 1 TiB 之间。");
        if (value.excludedApps !== undefined && (!Array.isArray(value.excludedApps) || value.excludedApps.length > 200 || value.excludedApps.some(s => typeof s !== "string" || s.length > 32767))) throw new Error("应用排除规则无效。");
        this.setMeta("settings", JSON.stringify({ ...this.settings(), ...value })); return;
      }
      if (input.type === "remark") {
        if (typeof input.value !== "string" || input.value.length > 2000) throw new Error("备注最多 2000 字符。");
        const row = this.row("SELECT text,title,files FROM clips WHERE id=?", input.id); if (!row) throw new Error("记录不存在。");
        this.run("UPDATE clips SET remark=?,search_text=? WHERE id=?", input.value, this.searchText(row.text as string | null, String(row.title), input.value, JSON.parse(String(row.files))), input.id); return;
      }
      if (input.type === "clear-history") { this.run("UPDATE clips SET deleted_at=? WHERE deleted_at IS NULL AND starred=0", this.now()); return; }
      if (input.type === "empty-trash") { this.run("DELETE FROM clips WHERE deleted_at IS NOT NULL AND id NOT IN (SELECT clip_id FROM shelf)"); this.run("UPDATE clips SET deleted_at=0 WHERE deleted_at IS NOT NULL"); return; }
      if (input.type === "clear-shelf") { this.run("DELETE FROM shelf"); return; }
      if (input.type === "shelf-move") {
        if (typeof input.id !== "string" || !["top", "up", "down"].includes(input.direction)) throw new Error("暂存排序操作无效。");
        const current = this.row("SELECT position FROM shelf WHERE clip_id=?", input.id);
        if (!current) throw new Error("这条记录已移出暂存。");
        if (input.direction === "top") {
          const first = this.row("SELECT clip_id,position FROM shelf ORDER BY position,clip_id LIMIT 1");
          if (first && first.clip_id !== input.id) {
            this.run("UPDATE shelf SET position=position+1 WHERE position<?", Number(current.position));
            this.run("UPDATE shelf SET position=0 WHERE clip_id=?", input.id);
          }
        } else {
          const op = input.direction === "up" ? "<" : ">", order = input.direction === "up" ? "DESC" : "ASC";
          const neighbor = this.row(`SELECT clip_id,position FROM shelf WHERE position ${op} ? ORDER BY position ${order},clip_id ${order} LIMIT 1`, Number(current.position));
          if (neighbor) { this.run("UPDATE shelf SET position=? WHERE clip_id=?", Number(neighbor.position), input.id); this.run("UPDATE shelf SET position=? WHERE clip_id=?", Number(current.position), String(neighbor.clip_id)); }
        }
        return;
      }
      if (!("ids" in input) || !Array.isArray(input.ids) || input.ids.length > 10000 || input.ids.some(id => typeof id !== "string" || id.length > 128)) throw new Error("选择的记录无效。");
      const ids = [...new Set(input.ids)];
      for (const id of ids) {
        if (!this.row("SELECT id FROM clips WHERE id=?", id)) throw new Error("部分记录已被移除，请刷新后重试。");
        switch (input.type) {
          case "star": if (typeof input.value !== "boolean") throw new Error("收藏状态无效。"); this.run("UPDATE clips SET starred=? WHERE id=?", input.value ? 1 : 0, id); break;
          case "delete": this.run("UPDATE clips SET deleted_at=? WHERE id=?", this.now(), id); break;
          case "restore": this.run("UPDATE clips SET deleted_at=NULL WHERE id=?", id); break;
          case "purge": if (this.row("SELECT clip_id FROM shelf WHERE clip_id=?", id)) this.run("UPDATE clips SET deleted_at=0 WHERE id=?", id); else this.run("DELETE FROM clips WHERE id=? AND deleted_at IS NOT NULL", id); break;
          case "shelf-add": this.run("INSERT OR IGNORE INTO shelf(clip_id,position) VALUES(?,COALESCE((SELECT MAX(position)+1 FROM shelf),0))", id); break;
          case "shelf-remove": this.run("DELETE FROM shelf WHERE clip_id=?", id); break;
          case "shelf-reorder": break;
          default: throw new Error("不支持的剪贴板操作。");
        }
      }
      if (input.type === "shelf-reorder") {
        const all = this.rows("SELECT clip_id FROM shelf").map(r => String(r.clip_id));
        if (ids.length !== all.length || all.some(id => !ids.includes(id))) throw new Error("暂存排序必须包含全部条目。");
        ids.forEach((id, index) => this.run("UPDATE shelf SET position=? WHERE clip_id=?", index, id));
      }
    });
    if (["purge", "empty-trash", "shelf-remove", "clear-shelf"].includes(input.type)) this.prune();
  }
  prune(): void {
    const cutoff = this.now() - CLIPBOARD_TRASH_AGE;
    const expired = this.row("SELECT id FROM clips WHERE deleted_at IS NOT NULL AND deleted_at<=? AND id NOT IN (SELECT clip_id FROM shelf) LIMIT 1", cutoff);
    if (expired) this.transaction(() => this.run("DELETE FROM clips WHERE deleted_at IS NOT NULL AND deleted_at<=? AND id NOT IN (SELECT clip_id FROM shelf)", cutoff));
    const garbage = this.rows("SELECT hash FROM assets WHERE hash NOT IN (SELECT html_hash FROM clips WHERE html_hash IS NOT NULL UNION SELECT rtf_hash FROM clips WHERE rtf_hash IS NOT NULL UNION SELECT image_hash FROM clips WHERE image_hash IS NOT NULL)");
    if (garbage.length) {
      this.transaction(() => { for (const row of garbage) this.run("DELETE FROM assets WHERE hash=?", row.hash!); });
      for (const row of garbage) { try { unlinkSync(this.assetPath(String(row.hash))); } catch { /* Retry orphan collection below. */ } }
    }
    for (const file of readdirSync(this.blobs)) if (/^[a-f0-9]{64}(?:\.[a-f0-9-]+\.tmp)?$/.test(file) && !this.row("SELECT hash FROM assets WHERE hash=?", file)) {
      try { unlinkSync(join(this.blobs, file)); } catch { /* A transient file lock is retried on the next collection. */ }
    }
  }
  private migrateLegacy() {
    const file = join(this.directory, "history.json");
    if (!existsSync(file)) return;
    this.backupBytes = statSync(file).size;
    if (this.meta("legacy-migrated")) { this.warnings = JSON.parse(this.meta("migration-warnings") || "[]"); return; }
    if (this.backupBytes > 100 * 1024 ** 2) { this.warnings = ["旧历史文件超过 100 MiB，已保留，请通过导入功能处理。"]; return; }
    let data: { version: number; enabled?: boolean; items?: unknown[] };
    try { data = JSON.parse(readFileSync(file, "utf8")); if (data.version !== 1 || !Array.isArray(data.items)) throw new Error("格式错误"); }
    catch { this.warnings = ["旧历史文件无法解析，原文件已保留；新数据库可正常使用。"]; return; }
    const migrated = new Set<string>(JSON.parse(this.meta("legacy-ids") || "[]"));
    for (const [index, raw] of data.items!.entries()) {
      try {
        if (!raw || typeof raw !== "object") throw new Error("记录格式无效");
        const item = raw as Record<string, unknown>;
        if (typeof item.id !== "string" || item.id.length > 128 || typeof item.content !== "string" || !["text", "link", "image"].includes(String(item.kind))) throw new Error("内容格式无效");
        if (migrated.has(item.id)) continue;
        if (!Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt)) throw new Error("时间无效");
        const input: ClipboardCapture = item.kind === "image" ? { image: Buffer.from(item.content.replace(/^data:image\/png;base64,/, ""), "base64") } : { text: item.content };
        this.capture(input, { id: item.id, title: typeof item.title === "string" ? item.title : "", createdAt: Number(item.createdAt), copiedAt: Number(item.updatedAt), copies: Number.isSafeInteger(item.copies) ? Math.max(1, Number(item.copies)) : 1, starred: item.starred === true });
        migrated.add(item.id); this.setMeta("legacy-ids", JSON.stringify([...migrated]));
      } catch (cause) { this.warnings.push(`旧记录 ${index + 1} 未导入：${cause instanceof Error ? cause.message : "格式错误"}`); }
    }
    this.transaction(() => {
      if (!this.meta("settings")) this.setMeta("settings", JSON.stringify({ ...DEFAULT_CLIPBOARD_SETTINGS, enabled: data.enabled === true }));
      this.setMeta("migration-warnings", JSON.stringify(this.warnings)); this.setMeta("legacy-migrated", "1");
    });
  }
  close() { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); this.db.close(); }
}
