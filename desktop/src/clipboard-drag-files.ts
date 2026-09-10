import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, rename, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { basename, dirname, resolve } from "node:path";
import { statSync, utimesSync } from "node:fs";

const DAY = 24 * 60 * 60 * 1000;
const ownedName = /^[a-f0-9-]{36}\.png(?:\.tmp)?$/;

/** Copies are independent of archived assets: a drop target may modify its file. */
export class ClipboardDragFiles {
  private cached = new Map<string, { file: string; size: number; modified: number }>();
  private jobs = new Map<string, Promise<string>>();
  private maintenance: Promise<void> = Promise.resolve();
  private protectedFiles = new Set<string>();
  constructor(private directory: string, private now = Date.now) {}
  protect(files: string[]) { this.protectedFiles = new Set(files); }
  retain(files: string[]) {
    const time = new Date(this.now()), root = resolve(this.directory);
    for (const file of files) {
      if (dirname(resolve(file)) !== root || !ownedName.test(basename(file))) continue;
      utimesSync(file, time, time);
      const cached = [...this.cached.values()].find(entry => entry.file === file);
      if (cached) cached.modified = statSync(file).mtimeMs;
    }
  }

  image(hash: string, source: string): Promise<string> {
    const pending = this.jobs.get(hash); if (pending) return pending;
    const job = this.maintenance.then(() => this.prepare(hash, source));
    this.jobs.set(hash, job);
    void job.finally(() => this.jobs.delete(hash)).catch(() => {});
    return job;
  }
  private async prepare(hash: string, source: string) {
    await mkdir(this.directory, { recursive: true });
    const existing = this.cached.get(hash);
    if (existing) {
      const info = await lstat(existing.file).catch(() => null);
      if (info?.isFile() && info.size === existing.size && info.mtimeMs === existing.modified) {
        const time = new Date(this.now()); await utimes(existing.file, time, time);
        existing.modified = (await lstat(existing.file)).mtimeMs;
        this.cached.delete(hash); this.cached.set(hash, existing); return existing.file;
      }
      this.cached.delete(hash);
    }
    const file = join(this.directory, `${randomUUID()}.png`), temporary = `${file}.tmp`;
    try {
      await copyFile(source, temporary); await rename(temporary, file);
      const time = new Date(this.now()); await utimes(file, time, time);
      const info = await lstat(file);
      if (this.cached.size >= 256) this.cached.delete(this.cached.keys().next().value!);
      this.cached.set(hash, { file, size: info.size, modified: info.mtimeMs }); return file;
    } finally { await unlink(temporary).catch(() => {}); }
  }
  clean() {
    const admitted = [...this.jobs.values()];
    const work = this.maintenance.then(async () => { await Promise.allSettled(admitted); await cleanClipboardTemporaryFiles(this.directory, this.now(), file => this.protectedFiles.has(file)); });
    this.maintenance = work.catch(() => {}); return work;
  }
  async close() { await this.maintenance; await Promise.allSettled([...this.jobs.values()]); this.cached.clear(); }
}

/** Only app-named regular files, never user references or directories. */
export async function cleanClipboardTemporaryFiles(directory: string, now = Date.now(), keep: (file: string) => boolean = () => false) {
  await mkdir(directory, { recursive: true });
  for (const name of await readdir(directory)) {
    if (!ownedName.test(name)) continue;
    const file = join(directory, name), info = await lstat(file).catch(() => null);
    if (info?.isFile() && now - info.mtimeMs > DAY && !keep(file)) await unlink(file).catch(() => {});
  }
}
