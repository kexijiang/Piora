import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getAgentRuntimeProfile } from "./agent-runtime-profile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { assertRemotePrincipalCurrent, authorizeRemoteCreation } from "./remote-control-auth";
import { findRemoteSessionCreation, getRemoteControlStorePath, grantRemoteCapabilitySession } from "./remote-control-store";
import type { RemoteCapabilityPrincipal } from "./remote-control-types";
import type { CreateSessionInput, CreatedSession } from "./session-creation";

export interface RemoteSessionReservation {
  sessionId: string;
  sessionFile: string;
}

export interface RemoteCreationResult {
  sessionId: string;
  cwd?: string;
  runtimeProfile?: string;
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: string;
  idempotent: boolean;
}

interface CreationIntent extends RemoteSessionReservation {
  version: 1;
  owner: string;
  fingerprint: string;
  phase: "reserved" | "initializing" | "ready";
  seed: string;
  result?: RemoteCreationResult;
}

export class RemoteSessionCreationError extends Error {
  constructor(readonly code: "REMOTE_CREATION_CONFLICT" | "REMOTE_CREATION_INVALID" | "REMOTE_CREATION_BUSY", message: string) {
    super(message);
    this.name = "RemoteSessionCreationError";
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const invalid = () => new RemoteSessionCreationError("REMOTE_CREATION_INVALID", "The saved session creation cannot be safely recovered. Do not retry with a new key before checking Piora.");

function readIntent(path: string, owner: string, fingerprint: string): CreationIntent | undefined {
  let value: CreationIntent;
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 131_072) throw invalid();
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw invalid();
  }
  if (!value || value.version !== 1 || value.owner !== owner || typeof value.fingerprint !== "string"
    || !/^[a-f0-9]{64}$/.test(value.fingerprint) || typeof value.sessionId !== "string"
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[47][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.sessionId)
    || typeof value.sessionFile !== "string" || resolve(value.sessionFile) !== value.sessionFile
    || typeof value.seed !== "string" || !value.seed.endsWith("\n")
    || !["reserved", "initializing", "ready"].includes(value.phase)) throw invalid();
  if (value.fingerprint !== fingerprint) throw new RemoteSessionCreationError("REMOTE_CREATION_CONFLICT", "This creation key belongs to different session settings. Recover the original request instead.");
  try {
    const entries = value.seed.trimEnd().split("\n").map(line => JSON.parse(line));
    if (entries.length < 2 || entries[0].type !== "session" || entries[0].id !== value.sessionId
      || entries[1].type !== "custom" || entries[1].customType !== "piora-remote-creation"
      || entries[1].data.owner !== owner || entries[1].data.fingerprint !== fingerprint) throw invalid();
    const policy = entries[1].data.policy;
    if (policy !== "notes" && policy !== "agent") throw invalid();
    if (policy === "notes" ? entries.length !== 3 || entries[2].type !== "custom" || entries[2].customType !== "piora-remote-policy" || entries[2].data?.policy !== "notes" : entries.length !== 2) throw invalid();
  } catch { throw invalid(); }
  if (value.phase === "ready") {
    const result = value.result;
    if (!result || result.sessionId !== value.sessionId || typeof result.cwd !== "string"
      || !["normal", "device-control"].includes(result.runtimeProfile ?? "")
      || typeof result.thinkingLevel !== "string" || typeof result.idempotent !== "boolean"
      || (result.model !== null && (!result.model || typeof result.model.provider !== "string" || typeof result.model.modelId !== "string"))) throw invalid();
  }
  return value;
}

function assertSeedFile(intent: CreationIntent): void {
  const expected = Buffer.from(intent.seed, "utf8");
  let descriptor: number | undefined;
  try {
    const info = lstatSync(intent.sessionFile);
    if (!info.isFile() || info.isSymbolicLink()) throw invalid();
    descriptor = openSync(intent.sessionFile, "r");
    if (fstatSync(descriptor).size < expected.length) throw invalid();
    const actual = Buffer.alloc(expected.length);
    let offset = 0;
    while (offset < actual.length) {
      const count = readSync(descriptor, actual, offset, actual.length - offset, offset);
      if (!count) throw invalid();
      offset += count;
    }
    if (!actual.equals(expected)) throw invalid();
  } catch { throw invalid(); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export async function createRemoteSession(
  principal: RemoteCapabilityPrincipal,
  key: string,
  input: CreateSessionInput,
  create: (reservation: RemoteSessionReservation) => Promise<CreatedSession>,
): Promise<RemoteCreationResult> {
  const mode = input.remotePolicy;
  if (mode !== "notes" && mode !== "agent") throw invalid();
  if (!key || key.length > 512) throw invalid();
  const cwd = authorizeRemoteCreation(principal, mode, input.cwd);
  const runtimeProfile = getAgentRuntimeProfile();
  if (mode === "notes" && runtimeProfile !== "normal") throw invalid();
  const owner = digest(JSON.stringify([principal.tokenId, key]));
  const fingerprint = digest(JSON.stringify({ cwd, mode, runtimeProfile, provider: input.initialModel?.provider ?? null, modelId: input.initialModel?.modelId ?? null, thinkingLevel: input.thinkingLevel ?? null, name: input.name ?? null }));
  const directory = join(dirname(getRemoteControlStorePath()), "session-creations");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, owner + ".json");
  const lockTarget = path + ".target";
  openSync(lockTarget, "a");
  let compromised = false;
  const assertLease = () => { if (compromised) throw new RemoteSessionCreationError("REMOTE_CREATION_BUSY", "Session creation lock was lost; retry the same request."); };
  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(lockTarget, {
      realpath: false, stale: 10_000, update: 2_000,
      retries: { retries: 120, factor: 1, minTimeout: 100, maxTimeout: 100 },
      onCompromised: () => { compromised = true; },
    });
  } catch { throw new RemoteSessionCreationError("REMOTE_CREATION_BUSY", "Session creation is still in progress; retry the same request."); }
  let live: CreatedSession | undefined;
  const save = (intent: CreationIntent) => { assertLease(); writePrivateFileAtomicSync(path, JSON.stringify(intent) + "\n"); };
  try {
    assertLease();
    authorizeRemoteCreation(principal, mode, cwd);
    let intent = readIntent(path, owner, fingerprint);
    const existing = findRemoteSessionCreation(principal.tokenId, key);
    if (existing) {
      if (intent && existing !== intent.sessionId) throw invalid();
      assertRemotePrincipalCurrent(principal, "session.create", existing);
      return { sessionId: existing, idempotent: true };
    }
    const recovered = Boolean(intent);
    if (!intent) {
      const manager = SessionManager.create(cwd);
      manager.appendCustomEntry("piora-remote-creation", { owner, fingerprint, policy: mode });
      if (mode === "notes") manager.appendCustomEntry("piora-remote-policy", { policy: "notes" });
      const sessionFile = manager.getSessionFile();
      if (!sessionFile) throw invalid();
      intent = { version: 1, owner, fingerprint, phase: "reserved", sessionId: manager.getSessionId(), sessionFile, seed: [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n" };
      save(intent);
    }
    if (intent.phase === "reserved") {
      assertLease();
      if (!existsSync(intent.sessionFile)) writePrivateFileAtomicSync(intent.sessionFile, intent.seed);
      assertSeedFile(intent);
      intent.phase = "initializing";
      save(intent);
    }
    assertSeedFile(intent);
    if (intent.phase !== "ready") {
      assertLease();
      authorizeRemoteCreation(principal, mode, cwd);
      live = await create({ sessionId: intent.sessionId, sessionFile: intent.sessionFile });
      if (live.sessionId !== intent.sessionId || resolve(live.cwd) !== resolve(cwd) || live.runtimeProfile !== runtimeProfile) throw invalid();
      intent.result = { sessionId: live.sessionId, cwd: live.cwd, runtimeProfile: live.runtimeProfile, model: live.model, thinkingLevel: live.thinkingLevel, idempotent: recovered };
      intent.phase = "ready";
      save(intent);
    }
    assertLease();
    authorizeRemoteCreation(principal, mode, cwd);
    await grantRemoteCapabilitySession(principal.tokenId, intent.sessionId, key, undefined, { policy: mode, cwd });
    assertLease();
    assertRemotePrincipalCurrent(principal, "session.create", intent.sessionId);
    return { ...intent.result!, idempotent: recovered };
  } catch (error) {
    live?.session.destroy();
    throw error;
  } finally {
    if (!compromised) await release();
  }
}
