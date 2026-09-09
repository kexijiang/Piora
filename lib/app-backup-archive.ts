import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, stat, lstat, writeFile, unlink } from "node:fs/promises";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";

const MAGIC = Buffer.from("PIORA001");
const HEADER_BYTES = 36;
const LIMIT = 100 * 1024 ** 3;
export interface BackupRoot { id: string; source: string; destination: string; files?: string[] }
export interface BackupManifest { product: "piora"; version: 1; exportedAt: string; platform: string; projects: string[]; roots: BackupRoot[]; warnings: string[]; files: number; bytes: number }
interface Entry { source: string; name: string; size: number; mtimeMs: number }
const line = (value: unknown) => JSON.stringify(value) + "\n";
async function key(password: string, salt: Buffer): Promise<Buffer> {
  if (typeof password !== "string" || password.length < 8 || password.length > 1024) throw new Error("backup_password");
  return new Promise((resolve, reject) => scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 }, (error, value) => error ? reject(error) : resolve(value)));
}
export function safeBackupPath(root: string, name: string): string {
  if (typeof name !== "string" || !name || name.length > 2000 || name.includes("\\") || name.startsWith("/") || name.split("/").some((part) => !part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("backup_path");
  const target = resolve(root, ...name.split("/")); const rel = relative(resolve(root), target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("backup_path");
  return target;
}
export async function backupInventory(roots: BackupRoot[], warnings: string[]): Promise<Entry[]> {
  const entries: Entry[] = [];
  for (const root of roots) {
    async function visit(name: string) {
      const source = name ? safeBackupPath(root.source, name) : root.source;
      let info;
      try { info = await lstat(source); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && !name) return; throw error; }
      if (info.isSymbolicLink()) { warnings.push(`Symbolic link excluded: ${source}`); return; }
      if (/(?:\.lock|\.tmp|\.partial)$/.test(name) || /(?:^|\/)import-client\.json$/.test(name)) return;
      if (info.isDirectory()) { for (const child of await readdir(source)) await visit(name ? `${name}/${child}` : child); }
      else if (info.isFile()) { entries.push({ source, name: `${root.id}/${name}`, size: info.size, mtimeMs: info.mtimeMs }); if (entries.length > 500_000) throw new Error("backup_limit"); }
    }
    if (root.files) { for (const file of root.files) await visit(file); } else await visit("");
  }
  return entries;
}

/** Streaming chunks keep model packs and long session histories out of the JS heap. */
export async function createBackupArchive(file: string, password: string, manifest: BackupManifest, entries: Entry[]): Promise<void> {
  const salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", await key(password, salt), iv);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, Buffer.concat([MAGIC, salt, iv]), { flag: "wx", mode: 0o600 });
  async function* records() {
    yield line({ manifest });
    for (const entry of entries) {
      yield line({ file: entry.name, size: entry.size });
      const hash = createHash("sha256"); let size = 0;
      for await (const chunk of createReadStream(entry.source, { highWaterMark: 64 * 1024 })) { const data = chunk as Buffer; hash.update(data); size += data.length; yield line({ data: data.toString("base64") }); }
      if (size !== entry.size) throw new Error("backup_changed");
      yield line({ end: hash.digest("hex") });
    }
    // Refuse a snapshot if any previously copied file changed while other files were copied.
    for (const entry of entries) { const now = await stat(entry.source); if (now.size !== entry.size || now.mtimeMs !== entry.mtimeMs) throw new Error("backup_changed"); }
    yield line({ complete: true });
  }
  await pipeline(Readable.from(records()), createGzip(), cipher, createWriteStream(file, { flags: "a", mode: 0o600 }));
  const handle = await open(file, "a"); try { await handle.write(cipher.getAuthTag()); await handle.sync(); } finally { await handle.close(); }
}

/** Authenticate the entire encrypted stream before interpreting any filenames or writing extracted files. */
export async function extractBackupArchive(file: string, password: string, output: string): Promise<BackupManifest> {
  const handle = await open(file, "r"); const header = Buffer.alloc(HEADER_BYTES), tag = Buffer.alloc(16); let size: number;
  try { size = (await handle.stat()).size; if (size < HEADER_BYTES + 17 || size > LIMIT) throw new Error("backup_format"); await handle.read(header, 0, header.length, 0); await handle.read(tag, 0, 16, size - 16); } finally { await handle.close(); }
  if (!header.subarray(0, 8).equals(MAGIC)) throw new Error("backup_format");
  const decipher = createDecipheriv("aes-256-gcm", await key(password, header.subarray(8, 24)), header.subarray(24)); decipher.setAuthTag(tag);
  const compressed = `${output}.verified.gz`;
  try { await pipeline(createReadStream(file, { start: HEADER_BYTES, end: size - 17 }), decipher, createWriteStream(compressed, { flags: "wx", mode: 0o600 })); }
  catch { await unlink(compressed).catch(() => {}); throw new Error("backup_auth"); }
  await mkdir(output, { recursive: true, mode: 0o700 });
  let buffer = "", total = 0, count = 0, complete = false;
  let manifest: BackupManifest | undefined;
  let active: { handle: Awaited<ReturnType<typeof open>>; size: number; expected: number; hash: ReturnType<typeof createHash> } | undefined;
  const names = new Set<string>();
  const stream = createReadStream(compressed).pipe(createGunzip()); stream.setEncoding("utf8");
  try {
    for await (const chunk of stream) {
      buffer += String(chunk);
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        if (index > 4 * 1024 * 1024) throw new Error("backup_limit");
        const record = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (complete) throw new Error("backup_format");
        if (!manifest) {
          manifest = record.manifest as BackupManifest;
          if (!manifest || manifest.product !== "piora" || manifest.version !== 1 || !Array.isArray(manifest.roots) || !Array.isArray(manifest.projects) || !Array.isArray(manifest.warnings) || !Number.isSafeInteger(manifest.files) || manifest.files > 500_000) throw new Error("backup_format");
          if (manifest.roots.some((root) => !/^[a-z][a-z0-9-]{0,30}$/.test(root.id) || typeof root.source !== "string" || typeof root.destination !== "string")) throw new Error("backup_format");
          continue;
        }
        if (typeof record.file === "string") {
          if (active || !Number.isSafeInteger(record.size) || record.size < 0 || record.size > LIMIT || names.has(record.file.toLowerCase()) || !manifest.roots.some((root) => record.file.startsWith(`${root.id}/`))) throw new Error("backup_format");
          const target = safeBackupPath(output, record.file); names.add(record.file.toLowerCase()); if (++count > manifest.files) throw new Error("backup_format");
          await mkdir(dirname(target), { recursive: true, mode: 0o700 }); active = { handle: await open(target, "wx", 0o600), hash: createHash("sha256"), size: 0, expected: record.size };
        } else if (typeof record.data === "string") {
          if (!active || record.data.length > 90_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.data)) throw new Error("backup_format");
          const data = Buffer.from(record.data, "base64"); active.size += data.length; total += data.length;
          if (active.size > active.expected || total > LIMIT) throw new Error("backup_limit");
          active.hash.update(data); let offset = 0; while (offset < data.length) { const written = await active.handle.write(data, offset); if (!written.bytesWritten) throw new Error("backup_write"); offset += written.bytesWritten; }
        } else if (typeof record.end === "string") {
          if (!active || active.size !== active.expected || active.hash.digest("hex") !== record.end) throw new Error("backup_checksum");
          await active.handle.sync(); await active.handle.close(); active = undefined;
        } else if (record.complete === true && !active) complete = true;
        else throw new Error("backup_format");
      }
      if (buffer.length > 4 * 1024 * 1024) throw new Error("backup_limit");
    }
    if (!manifest || !complete || active || buffer.trim() || count !== manifest.files || total !== manifest.bytes) throw new Error("backup_format");
    await writeFile(join(output, "manifest.json"), JSON.stringify(manifest), { flag: "wx", mode: 0o600 });
    return manifest;
  } finally { await active?.handle.close(); stream.destroy(); }
}
