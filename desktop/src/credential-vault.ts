import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { VaultEntry, VaultSnapshot } from "./credential-vault-types.js";
interface Cipher { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string; getSelectedStorageBackend?: () => string }
interface Data { version: 1; salt: string; verifier: string; autofill: boolean; entries: VaultEntry[]; audit: VaultSnapshot["audit"] }
const error = () => new Error("凭据库操作失败，请检查主密码、系统加密与备份格式。");
export function credentialUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hostname.includes("xn--") || !url.hostname.includes(".") || /^[\d.]+$/.test(url.hostname)) throw error();
  if (/pay|checkout|billing|security|settings|password|reset|change|otp|2fa|mfa|verify|verification/i.test(url.pathname)) throw error();
  return url.origin + url.pathname;
}
function passwordKey(password: string, salt: Buffer) { if (typeof password !== "string" || password.length < 12 || password.length > 512) throw error(); return scryptSync(password, salt, 32); }
function entry(value: Partial<VaultEntry>, previous?: VaultEntry): VaultEntry {
  const field = (key: keyof VaultEntry, max: number) => { const text = value[key] ?? previous?.[key] ?? ""; if (typeof text !== "string" || text.length > max) throw error(); return text; };
  const name = field("name", 200), username = field("username", 500), password = field("password", 4096) || previous?.password || "";
  if (!name.trim() || !username || !password) throw error();
  return { id: previous?.id ?? randomUUID(), name, url: credentialUrl(field("url", 2048)), username, password, notes: field("notes", 2000), group: field("group", 100) };
}
export class CredentialVault {
  private data: Data | undefined;
  private expires = 0;
  constructor(private readonly file: string, private readonly cipher: Cipher) {}
  available() { return this.cipher.isEncryptionAvailable() && this.cipher.getSelectedStorageBackend?.() !== "basic_text"; }
  private requireData() { if (!this.available() || !this.data || Date.now() > this.expires) { this.lock(); throw error(); } return this.data; }
  private persist(data = this.requireData()) { const bytes = this.cipher.encryptString(JSON.stringify(data)); mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(`${this.file}.tmp`, bytes, { mode: 0o600 }); renameSync(`${this.file}.tmp`, this.file); this.data = data; }
  private verify(password: string) { const data = this.requireData(); if (!timingSafeEqual(passwordKey(password, Buffer.from(data.salt, "base64")), Buffer.from(data.verifier, "base64"))) throw error(); }
  status(): VaultSnapshot {
    if (Date.now() > this.expires) this.lock();
    return { available: this.available(), initialized: existsSync(this.file), unlocked: Boolean(this.data), autofill: this.data?.autofill ?? false, entries: this.data?.entries.map(({ password: _password, ...metadata }) => { void _password; return metadata; }) ?? [], audit: this.data?.audit ?? [] };
  }
  initialize(password: string) {
    if (existsSync(this.file) || !this.available()) throw error();
    const salt = randomBytes(16); const data: Data = { version: 1, salt: salt.toString("base64"), verifier: passwordKey(password, salt).toString("base64"), autofill: false, entries: [], audit: [] }; this.persist(data); this.expires = Date.now() + 10 * 60_000;
  }
  unlock(password: string) {
    this.lock();
    if (!this.available()) throw error();
    const bytes = readFileSync(this.file); if (bytes.length > 4 * 1024 * 1024) throw error();
    const data = JSON.parse(this.cipher.decryptString(bytes)) as Data;
    if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > 500 || typeof data.autofill !== "boolean" || !Array.isArray(data.audit) || data.audit.length > 100 || Buffer.from(data.salt, "base64").length !== 16 || Buffer.from(data.verifier, "base64").length !== 32) throw error();
    const ids = new Set<string>();
    for (const item of data.entries) { if (typeof item.id !== "string" || ids.has(item.id)) throw error(); entry(item, item); ids.add(item.id); }
    for (const item of data.audit) if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.origin !== "string" || !Number.isFinite(item.at)) throw error();
    this.data = data; this.expires = Date.now() + 10 * 60_000;
    try { this.verify(password); } catch { this.lock(); throw error(); }
  }
  lock() { this.data = undefined; this.expires = 0; }
  save(value: Partial<VaultEntry>) { const data = this.requireData(); const previous = data.entries.find(item => item.id === value.id); if (value.id && !previous) throw error(); if (!previous && data.entries.length >= 500) throw error(); const next = entry(value, previous); this.persist({ ...data, entries: [...data.entries.filter(item => item.id !== next.id), next] }); }
  remove(id: string) { const data = this.requireData(); this.persist({ ...data, entries: data.entries.filter(item => item.id !== id) }); }
  configure(enabled: boolean) { this.persist({ ...this.requireData(), autofill: enabled }); }
  candidates(url: string, automatic: boolean) { try { const data = this.requireData(); if (automatic && !data.autofill) return []; const target = credentialUrl(url); return data.entries.filter(item => item.url === target).map(item => ({ id: item.id, name: item.name })); } catch { return []; } }
  credential(id: string, url: string) { const data = this.requireData(); const target = credentialUrl(url); const found = data.entries.find(item => item.id === id && item.url === target); if (!found) throw error(); return found; }
  record(id: string, url: string) { const data = this.requireData(); const found = this.credential(id, url); this.persist({ ...data, audit: [{ id, name: found.name, origin: new URL(url).origin, at: Date.now() }, ...data.audit].slice(0, 100) }); }
  export(password: string): Buffer {
    this.verify(password); const data = this.requireData(); const salt = randomBytes(16), iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", passwordKey(password, salt), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ version: 1, entries: data.entries }), "utf8"), cipher.final()]);
    return Buffer.from(JSON.stringify({ version: 1, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") }));
  }
  import(bytes: Buffer, password: string) {
    const data = this.requireData(); if (bytes.length > 4 * 1024 * 1024) throw error();
    const envelope = JSON.parse(bytes.toString("utf8")); if (envelope.version !== 1) throw error();
    const salt = Buffer.from(envelope.salt, "base64"), iv = Buffer.from(envelope.iv, "base64"), tag = Buffer.from(envelope.tag, "base64");
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw error();
    const decipher = createDecipheriv("aes-256-gcm", passwordKey(password, salt), iv); decipher.setAuthTag(tag);
    const imported = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
    if (imported.version !== 1 || !Array.isArray(imported.entries) || imported.entries.length + data.entries.length > 500) throw error();
    const entries = imported.entries.map((item: Partial<VaultEntry>) => entry(item));
    this.persist({ ...data, entries: [...data.entries, ...entries] });
  }
}
