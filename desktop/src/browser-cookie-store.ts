import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Cookie, Cookies, CookiesSetDetails } from "electron";

interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export function sessionCookieDetails(cookie: Cookie): CookiesSetDetails | null {
  if (!cookie.session || !cookie.domain || typeof cookie.name !== "string" || typeof cookie.value !== "string") return null;
  const host = cookie.domain.replace(/^\./, "");
  if (!/^[a-z\d.:[\]-]+$/i.test(host)) return null;
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`,
    name: cookie.name, value: cookie.value, path: cookie.path || "/",
    ...(!cookie.hostOnly ? { domain: cookie.domain } : {}),
    secure: cookie.secure === true, httpOnly: cookie.httpOnly === true, sameSite: cookie.sameSite,
  };
}

/** Chromium persists dated cookies itself, but discards session cookies at exit.
 * Restore those like a browser's "continue where you left off" mode. Keep the
 * snapshot encrypted by the OS and never change a server-issued expiry date. */
export class BrowserCookieStore {
  constructor(private readonly file: string, private readonly cookies: Pick<Cookies, "get" | "set">, private readonly cipher: Cipher) {}
  async restore(): Promise<void> {
    if (!this.cipher.isEncryptionAvailable()) return;
    let bytes: Buffer;
    try { bytes = await readFile(this.file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (bytes.length > 4 * 1024 * 1024) return;
    const saved: unknown = JSON.parse(this.cipher.decryptString(bytes));
    if (!Array.isArray(saved)) return;
    const existing = await this.cookies.get({});
    const identity = (cookie: Cookie) => JSON.stringify([cookie.domain, cookie.path, cookie.name]);
    const keys = new Set(existing.map(identity));
    for (const cookie of saved as Cookie[]) {
      if (!cookie || typeof cookie !== "object" || keys.has(identity(cookie))) continue;
      const details = sessionCookieDetails(cookie);
      if (details) await this.cookies.set(details).catch(() => undefined);
    }
  }
  async save(): Promise<void> {
    if (!this.cipher.isEncryptionAvailable()) return;
    const cookies = await this.cookies.get({ session: true });
    const bytes = this.cipher.encryptString(JSON.stringify(cookies));
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, bytes, { mode: 0o600 });
    await rename(`${this.file}.tmp`, this.file);
  }
}
