import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import {normalizeRemoteCreationPolicy,parseRemoteCreationPolicy,resolveRemoteCreationCwd} from "./remote-creation-policy";
import { REMOTE_CONTROL_SCOPES, type PublicRemoteCapabilityToken, type RemoteControlScope, type RemoteCapabilityTokenRecord } from "./remote-control-types";

interface RemoteControlStoreFile {
  version: 1;
  tokens: RemoteCapabilityTokenRecord[];
  sessionCreations: RemoteSessionCreationRecord[];
}

interface RemoteSessionCreationRecord {
  tokenId: string;
  idempotencyKey: string;
  sessionId: string;
  createdAt: number;
}

function rootPath(): string {
  return resolve(process.env.PIORA_REMOTE_CONTROL_ROOT ?? join(getAgentDir(), "piora", "remote-control"));
}

export function getRemoteControlStorePath(): string {
  return join(rootPath(), "tokens.json");
}

export function readRemoteServerId(path = join(rootPath(), "identity.json")): string {
  const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; serverId?: unknown };
  if (value?.version !== 1 || typeof value.serverId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.serverId)) throw new Error("Remote server identity is invalid.");
  return value.serverId;
}

export async function getRemoteServerId(path = join(rootPath(), "identity.json")): Promise<string> {
  try { return readRemoteServerId(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return withStoreLock(path, () => {
    try { return readRemoteServerId(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const serverId = randomUUID();
    writePrivateFileAtomicSync(path, JSON.stringify({ version: 1, serverId }) + "\n");
    return serverId;
  });
}

function parseStore(raw: string): RemoteControlStoreFile {
  const value = JSON.parse(raw) as Partial<RemoteControlStoreFile>;
  if (value.version !== 1 || !Array.isArray(value.tokens)) throw new Error("Remote control token store is invalid.");
  const tokens = value.tokens.flatMap((token) => {
    if (!token || typeof token !== "object" || typeof token.id !== "string" || typeof token.tokenHash !== "string" || typeof token.name !== "string") return [];
    const scopes = Array.isArray(token.scopes) ? token.scopes.filter((scope): scope is RemoteControlScope => REMOTE_CONTROL_SCOPES.includes(scope as RemoteControlScope)) : [];
    let creationPolicy;
    try { creationPolicy = token.creationPolicy === undefined ? undefined : parseRemoteCreationPolicy(token.creationPolicy); }
    catch { return []; }
    return [{
      ...token,
      ...(creationPolicy ? { creationPolicy } : {}),
      scopes: [...new Set(scopes)],
      allowedSessionIds: Array.isArray(token.allowedSessionIds) ? token.allowedSessionIds.filter((id): id is string => typeof id === "string") : [],
      allowedRoomIds: Array.isArray(token.allowedRoomIds) ? token.allowedRoomIds.filter((id): id is string => typeof id === "string") : [],
    }];
  });
  const rawCreations = (value as Partial<RemoteControlStoreFile>).sessionCreations;
  const sessionCreations = Array.isArray(rawCreations) ? rawCreations.filter((entry): entry is RemoteSessionCreationRecord => (
    Boolean(entry)
    && typeof entry.tokenId === "string"
    && typeof entry.idempotencyKey === "string"
    && typeof entry.sessionId === "string"
    && typeof entry.createdAt === "number"
  )) : [];
  return { version: 1, tokens, sessionCreations };
}

export function readRemoteCapabilityStore(path = getRemoteControlStorePath()): RemoteControlStoreFile {
  if (!existsSync(path)) return { version: 1, tokens: [], sessionCreations: [] };
  try { return parseStore(readFileSync(path, "utf8")); }
  catch { return { version: 1, tokens: [], sessionCreations: [] }; }
}

async function withStoreLock<T>(path: string, operation: () => T | Promise<T>): Promise<T> {
  const directory = resolve(path, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(directory, {
    lockfilePath: `${path}.lock`,
    realpath: false,
    retries: { retries: 50, factor: 1.15, minTimeout: 4, maxTimeout: 50 },
  });
  try { return await operation(); }
  finally { await release(); }
}

function persist(path: string, store: RemoteControlStoreFile): void {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, `${JSON.stringify(store, null, 2)}\n`);
}

export function hashRemoteCapabilityToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicToken(record: RemoteCapabilityTokenRecord): PublicRemoteCapabilityToken {
  const rest = { ...record } as Partial<RemoteCapabilityTokenRecord>;
  delete rest.tokenHash;
  return { ...rest, active: !record.revokedAt && (record.expiresAt === undefined || record.expiresAt > Date.now()) } as PublicRemoteCapabilityToken;
}

export interface CreateRemoteCapabilityTokenInput {
  name: string;
  scopes: RemoteControlScope[];
  allowedSessionIds?: string[];
  allowedRoomIds?: string[];
  expiresAt?: number;
  creationPolicy?: unknown;
}

export async function createRemoteCapabilityToken(input: CreateRemoteCapabilityTokenInput, path = getRemoteControlStorePath()): Promise<{ token: string; record: PublicRemoteCapabilityToken }> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new Error("A token name is required.");
  const scopes = [...new Set(input.scopes)].filter((scope): scope is RemoteControlScope => REMOTE_CONTROL_SCOPES.includes(scope));
  if (scopes.length === 0) throw new Error("At least one remote-control scope is required.");
  if (input.expiresAt !== undefined && (!Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now())) throw new Error("Token expiry must be in the future.");
  const creationPolicy = scopes.includes("session.create") ? normalizeRemoteCreationPolicy(input.creationPolicy === undefined ? { allowedPolicies: ["notes"], cwdRoots: [] } : input.creationPolicy) : undefined;
  const token = randomBytes(32).toString("base64url");
  const record: RemoteCapabilityTokenRecord = {
    id: `rct_${randomUUID()}`,
    tokenHash: hashRemoteCapabilityToken(token),
    name,
    scopes,
    allowedSessionIds: [...new Set((input.allowedSessionIds ?? []).filter(Boolean))],
    allowedRoomIds: [...new Set((input.allowedRoomIds ?? []).filter(Boolean))],
    createdAt: Date.now(),
    ...(creationPolicy ? { creationPolicy } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  };
  await withStoreLock(path, () => {
    const store = readRemoteCapabilityStore(path);
    store.tokens.push(record);
    persist(path, store);
  });
  return { token, record: publicToken(record) };
}

export function listRemoteCapabilityTokens(path = getRemoteControlStorePath()): PublicRemoteCapabilityToken[] {
  return readRemoteCapabilityStore(path).tokens.map(publicToken);
}

export async function revokeRemoteCapabilityToken(id: string, path = getRemoteControlStorePath()): Promise<boolean> {
  return withStoreLock(path, () => {
    const store = readRemoteCapabilityStore(path);
    const token = store.tokens.find((candidate) => candidate.id === id);
    if (!token) return false;
    if (!token.revokedAt) {
      token.revokedAt = Date.now();
      persist(path, store);
    }
    return true;
  });
}

export function authenticateRemoteCapabilityToken(token: string, path = getRemoteControlStorePath()): RemoteCapabilityTokenRecord | undefined {
  if (!token || token.length > 512) return undefined;
  const hash = hashRemoteCapabilityToken(token);
  const records = readRemoteCapabilityStore(path).tokens;
  for (const record of records) {
    if (!hashesEqual(hash, record.tokenHash)) continue;
    if (record.revokedAt || (record.expiresAt !== undefined && record.expiresAt <= Date.now())) return undefined;
    return record;
  }
  return undefined;
}

export async function deleteRemoteCapabilityToken(id: string, path = getRemoteControlStorePath()): Promise<"deleted" | "not_found" | "active"> {
  return withStoreLock(path, () => {
    const store = readRemoteCapabilityStore(path);
    const token = store.tokens.find((candidate) => candidate.id === id);
    if (!token) return "not_found";
    if (publicToken(token).active) return "active";
    store.tokens = store.tokens.filter((candidate) => candidate.id !== id);
    store.sessionCreations = store.sessionCreations.filter((entry) => entry.tokenId !== id);
    persist(path, store);
    return "deleted";
  });
}

export async function touchRemoteCapabilityToken(id: string, path = getRemoteControlStorePath()): Promise<void> {
  await withStoreLock(path, () => {
    const store = readRemoteCapabilityStore(path);
    const record = store.tokens.find((candidate) => candidate.id === id);
    if (!record || record.revokedAt) return;
    record.lastUsedAt = Date.now();
    persist(path, store);
  });
}

export function findRemoteSessionCreation(
  tokenId: string,
  idempotencyKey: string,
  path = getRemoteControlStorePath(),
): string | undefined {
  return readRemoteCapabilityStore(path).sessionCreations.find((entry) => (
    entry.tokenId === tokenId && entry.idempotencyKey === idempotencyKey
  ))?.sessionId;
}

/** Atomically makes a remotely-created Session controllable by its creating token. */
export async function grantRemoteCapabilitySession(
  tokenId: string,
  sessionId: string,
  idempotencyKey: string,
  path = getRemoteControlStorePath(),
  creation?: { policy: "notes" | "agent"; cwd: string },
): Promise<void> {
  if (!sessionId || !idempotencyKey || idempotencyKey.length > 512) throw new Error("Invalid remote Session grant.");
  await withStoreLock(path, () => {
    const store = readRemoteCapabilityStore(path);
    const token = store.tokens.find((candidate) => candidate.id === tokenId);
    if (!token || token.revokedAt || (token.expiresAt !== undefined && token.expiresAt <= Date.now())) {
      throw new Error("Remote capability token is no longer active.");
    }
    if (!token.scopes.includes("session.create")) throw new Error("Remote capability does not grant Session creation.");
    if (creation) {
      try { resolveRemoteCreationCwd(token.creationPolicy, creation.policy, creation.cwd); }
      catch { throw new Error("Remote capability creation policy no longer allows this session."); }
    }
    const existingCreation = store.sessionCreations.find((entry) => entry.tokenId === tokenId && entry.idempotencyKey === idempotencyKey);
    if (existingCreation && existingCreation.sessionId !== sessionId) {
      throw new Error("Remote session creation key is already bound to another session.");
    }
    if (!token.allowedSessionIds.includes(sessionId)) token.allowedSessionIds.push(sessionId);
    if (!existingCreation) {
      store.sessionCreations.push({ tokenId, idempotencyKey, sessionId, createdAt: Date.now() });
    }
    persist(path, store);
  });
}

export function resetRemoteCapabilityStoreForTests(): void {
  // Tests inject a temporary root; no process-global cache is kept.
}
