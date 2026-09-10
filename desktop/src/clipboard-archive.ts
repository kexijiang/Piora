import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, openSync, readFileSync, readSync, writeSync } from "node:fs";
import { mkdir, open, rename, rm, statfs, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createGunzip, createGzip } from "node:zlib";
import { ClipboardDatabase, type ClipboardArchiveRecord } from "./clipboard-database.js";
import { CLIPBOARD_PAYLOAD_LIMIT, type ClipboardSettings } from "./clipboard-types.js";

const MAGIC = Buffer.from("PIORACL2");
const MAX_FRAME = 128 * 1024 ** 2;
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const frame = (value: unknown) => {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_FRAME) throw new Error("剪贴板归档条目过大。");
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length); return Buffer.concat([header, body]);
};

export async function removeClipboardStage(parent: string, stage: string) {
  const base = resolve(parent), target = resolve(stage);
  if (dirname(target) !== base || !/^[a-f0-9-]{36}$/.test(target.slice(base.length + 1))) throw new Error("临时归档目录无效。");
  await rm(target, { recursive: true, force: true });
}

/** Exports a stable snapshot. Content-addressed assets appear once, regardless of reference count. */
export async function exportClipboardArchive(database: ClipboardDatabase, file: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(temporary, "wx", 0o600); await handle.write(MAGIC); await handle.close();
  async function* records() {
    const checksum = createHash("sha256"); let assets = 0, records = 0;
    const emit = (value: unknown) => { const bytes = frame(value); checksum.update(bytes); return bytes; };
    yield emit({ type: "manifest", version: 2, settings: database.settings(), createdAt: Date.now() });
    for (const asset of database.archiveAssets()) {
      assets++; yield emit({ type: "asset", hash: asset.hash, bytes: asset.bytes });
      const digest = createHash("sha256"); let bytes = 0;
      for await (const chunk of createReadStream(asset.path, { highWaterMark: 64 * 1024 })) {
        const buffer = chunk as Buffer; digest.update(buffer); bytes += buffer.length; yield emit({ type: "data", data: buffer.toString("base64") });
      }
      if (digest.digest("hex") !== asset.hash || bytes !== asset.bytes) throw new Error("归档图片或富文本校验失败，原历史未更改。");
      yield emit({ type: "asset-end" });
    }
    for (const record of database.archiveRecords()) { records++; yield emit({ type: "record", record }); }
    yield frame({ type: "complete", assets, records, checksum: checksum.digest("hex") });
  }
  try {
    await pipeline(Readable.from(records()), createGzip(), createWriteStream(temporary, { flags: "a", mode: 0o600 }));
    const written = await open(temporary, "r+"); try { await written.sync(); } finally { await written.close(); }
    await rename(temporary, file);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

function validateRecord(value: unknown): ClipboardArchiveRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("归档记录格式无效。");
  const item = value as ClipboardArchiveRecord;
  if (typeof item.id !== "string" || !item.id || item.id.length > 128 || typeof item.title !== "string" || item.title.length > 120 || typeof item.remark !== "string" || item.remark.length > 2000 || item.text !== null && typeof item.text !== "string") throw new Error("归档记录文字或标识无效。");
  for (const key of ["htmlHash", "rtfHash", "imageHash"] as const) if (item[key] !== null && !validHash(item[key])) throw new Error("归档内容引用无效。");
  for (const key of ["createdAt", "copiedAt", "copies"] as const) if (!Number.isSafeInteger(item[key]) || item[key] < (key === "copies" ? 1 : 0)) throw new Error("归档记录时间或次数无效。");
  if (typeof item.starred !== "boolean" || item.deletedAt !== null && (!Number.isSafeInteger(item.deletedAt) || item.deletedAt < 0) || item.shelfOrder !== null && (!Number.isSafeInteger(item.shelfOrder) || item.shelfOrder < 0) || !Array.isArray(item.files) || !item.source || typeof item.source.name !== "string" || typeof item.source.executable !== "string") throw new Error("归档记录元数据无效。");
  return item;
}

function* savedRecords(file: string): Generator<ClipboardArchiveRecord> {
  const fd = openSync(file, "r"), decoder = new StringDecoder("utf8"), buffer = Buffer.alloc(64 * 1024);
  let text = "";
  try {
    for (;;) {
      const bytes = readSync(fd, buffer); if (!bytes) break;
      text += decoder.write(buffer.subarray(0, bytes));
      let end;
      while ((end = text.indexOf("\n")) >= 0) { yield validateRecord(JSON.parse(text.slice(0, end))); text = text.slice(end + 1); }
      if (Buffer.byteLength(text) > MAX_FRAME) throw new Error("归档记录过大。");
    }
    text += decoder.end(); if (text) throw new Error("归档记录不完整。");
  } finally { closeSync(fd); }
}

/** Parses only a framed data format; imported archives can never supply SQL or paths to extract. */
export async function importClipboardArchive(database: ClipboardDatabase, file: string, options: { restoreSettings?: boolean; mappings?: Array<{ from: string; to: string }> } = {}) {
  const directory = join(database.directory, "imports"), stage = join(directory, randomUUID());
  await mkdir(stage, { recursive: true, mode: 0o700 });
  const recordsPath = join(stage, "records.jsonl"), recordsFile = openSync(recordsPath, "wx", 0o600);
  const magic = Buffer.alloc(MAGIC.length);
  let filesystem: Awaited<ReturnType<typeof statfs>>;
  try {
    const handle = await open(file, "r");
    try { await handle.read(magic, 0, magic.length, 0); } finally { await handle.close(); }
    if (!magic.equals(MAGIC)) throw new Error("这不是受支持的 Piora 剪贴板归档。");
    filesystem = await statfs(stage);
  } catch (error) { closeSync(recordsFile); await removeClipboardStage(directory, stage); throw error; }
  const source = createReadStream(file, { start: MAGIC.length }), stream = source.pipe(createGunzip());
  source.on("error", error => stream.destroy(error));
  const iterator = stream[Symbol.asyncIterator](); let chunk: Buffer = Buffer.alloc(0), offset = 0, expanded = 0;
  const limit = Math.min(2 * 1024 ** 4, Math.floor(Number(filesystem.bavail) * Number(filesystem.bsize) * .8));
  const take = async (length: number, eof = false): Promise<Buffer | null> => {
    const result = Buffer.allocUnsafe(length); let written = 0;
    while (written < length) {
      if (offset === chunk.length) {
        const next = await iterator.next();
        if (next.done) { if (!written && eof) return null; throw new Error("剪贴板归档不完整。"); }
        chunk = next.value as Buffer; offset = 0; expanded += chunk.length;
        if (expanded > limit) throw new Error("归档展开后超过剩余磁盘空间或安全容量上限。");
      }
      const count = Math.min(length - written, chunk.length - offset); chunk.copy(result, written, offset, offset + count); offset += count; written += count;
    }
    return result;
  };
  let active: { fd: number; hash: ReturnType<typeof createHash>; expectedHash: string; bytes: number; expectedBytes: number } | null = null;
  let settings: ClipboardSettings | undefined, complete = false, records = 0, assets = 0;
  const seenAssets = new Set<string>(), seenIds = new Set<string>(), digest = createHash("sha256");
  try {
    if (!magic.equals(MAGIC)) throw new Error("这不是受支持的 Piora 剪贴板归档。");
    for (;;) {
      const header = await take(4, true); if (!header) break;
      const length = header.readUInt32LE(); if (!length || length > MAX_FRAME) throw new Error("归档数据段长度无效。");
      const bytes = (await take(length))!, value = JSON.parse(bytes.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) || complete) throw new Error("归档结构无效。");
      if (value.type !== "complete") { digest.update(header); digest.update(bytes); }
      if (!settings) {
        if (value.type !== "manifest" || value.version !== 2 || !value.settings || typeof value.settings !== "object") throw new Error("归档版本或设置无效。");
        settings = value.settings as ClipboardSettings; continue;
      }
      if (value.type === "asset") {
        if (active || records || !validHash(value.hash) || seenAssets.has(value.hash) || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > CLIPBOARD_PAYLOAD_LIMIT || ++assets > 3_000_000) throw new Error("归档附件无效。");
        seenAssets.add(value.hash); active = { fd: openSync(join(stage, value.hash), "wx", 0o600), hash: createHash("sha256"), expectedHash: value.hash, bytes: 0, expectedBytes: value.bytes };
      } else if (value.type === "data") {
        if (!active || typeof value.data !== "string" || value.data.length > 90_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) throw new Error("归档附件数据无效。");
        const data = Buffer.from(value.data, "base64"); active.bytes += data.length;
        if (active.bytes > active.expectedBytes) throw new Error("归档附件长度不一致。");
        active.hash.update(data); let written = 0;
        while (written < data.length) { const count = writeSync(active.fd, data, written); if (!count) throw new Error("写入导入临时文件失败。"); written += count; }
      } else if (value.type === "asset-end") {
        if (!active || active.bytes !== active.expectedBytes || active.hash.digest("hex") !== active.expectedHash) throw new Error("归档附件校验失败。");
        closeSync(active.fd); active = null;
      } else if (value.type === "record") {
        if (active || ++records > 1_000_000) throw new Error("归档记录数量无效。");
        const entry = validateRecord(value.record);
        if (seenIds.has(entry.id)) throw new Error("归档包含重复的记录标识。"); seenIds.add(entry.id);
        for (const id of [entry.htmlHash, entry.rtfHash, entry.imageHash]) if (id && !seenAssets.has(id)) throw new Error("归档缺少引用的内容。");
        const line = Buffer.from(JSON.stringify(entry) + "\n"); let written = 0;
        while (written < line.length) { const count = writeSync(recordsFile, line, written); if (!count) throw new Error("写入导入记录失败。"); written += count; }
      } else if (value.type === "complete") {
        if (active || value.records !== records || value.assets !== assets || value.checksum !== digest.digest("hex")) throw new Error("归档校验失败或缺少内容。"); complete = true;
      } else throw new Error("归档包含不支持的数据段。");
    }
    if (!complete || !settings) throw new Error("归档尚未完整导出。");
    function* mappedRecords() {
      for (const entry of savedRecords(recordsPath)) {
        if (options.mappings?.length) entry.files = entry.files.map(file => {
          const normalized = file.path.replace(/\\/g, "/");
          for (const mapping of [...options.mappings!].sort((a, b) => b.from.length - a.from.length)) {
            const from = mapping.from.replace(/\\/g, "/").replace(/\/$/, ""), insensitive = /^[a-z]:\//i.test(from);
            const left = insensitive ? normalized.toLowerCase() : normalized, right = insensitive ? from.toLowerCase() : from;
            if (left === right || left.startsWith(right + "/")) return { ...file, path: join(mapping.to, ...normalized.slice(from.length).split("/").filter(Boolean)) };
          }
          return file;
        });
        yield entry;
      }
    }
    return database.importRecords(mappedRecords(), id => { if (!validHash(id) || !seenAssets.has(id)) throw new Error("归档引用无效。"); return readFileSync(join(stage, id)); }, options.restoreSettings ? settings : undefined);
  } finally {
    source.destroy(); stream.destroy(); if (active) closeSync(active.fd); closeSync(recordsFile);
    await removeClipboardStage(directory, stage);
  }
}
