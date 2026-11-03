import { answerCanonicalJson } from "../answer-output-data";
import { compileMiniAppPlan, validateMiniAppResult } from "./plan";
import { boundedJson } from "./json";
import { MiniAppError } from "./limits";
import type { MiniAppOutput, MiniAppSaveRequest } from "./state-service";
import type { MiniAppSaveReceipt } from "./state-store";
import type { MiniAppVmReply } from "./vm";

export interface MiniAppEnvelopeIdentity { operationId: string; planDigest: string; revision: number; runtimeVersion: string }
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function miniAppEnvelopeIdentity(value: unknown): MiniAppEnvelopeIdentity {
  boundedJson(value, 2048);
  const data = value as MiniAppEnvelopeIdentity;
  if (!data || !id(data.operationId) || !hash(data.planDigest) || !id(data.runtimeVersion) || !Number.isSafeInteger(data.revision) || data.revision < 1) throw new MiniAppError("IDENTITY", "Invalid mini app publication identity");
  return { operationId: data.operationId, planDigest: data.planDigest, revision: data.revision, runtimeVersion: data.runtimeVersion };
}
export async function miniAppBrowserDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(answerCanonicalJson(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function parseMiniAppOutput(value: unknown, toolCallId: string, identity: MiniAppEnvelopeIdentity): Promise<MiniAppOutput> {
  const data = value as MiniAppOutput;
  if (!data || data.kind !== "mini-app" || data.version !== 1 || data.toolCallId !== toolCallId || !id(data.leafId)
    || typeof data.writable !== "boolean" || !Number.isSafeInteger(data.stateRevision) || data.stateRevision < 0 || !hash(data.checkpointDigest)
    || !(data.savedAt === null || Number.isSafeInteger(data.savedAt) && data.savedAt >= 0)
    || data.publication?.id !== identity.operationId || data.publication.planDigest !== identity.planDigest
    || data.publication.runtimeVersion !== identity.runtimeVersion || data.publication.revision !== identity.revision
    || !["candidate", "committed", "aborted", "awaiting_confirmation", "superseded"].includes(data.publication.status)) throw new MiniAppError("IDENTITY", "Saved mini app identity changed");
  const compiled = compileMiniAppPlan(data.plan), result = validateMiniAppResult(compiled, data.result as unknown as MiniAppVmReply);
  if (await miniAppBrowserDigest(compiled.plan) !== identity.planDigest || await miniAppBrowserDigest(result.snapshot) !== data.checkpointDigest) throw new MiniAppError("IDENTITY", "Saved mini app content does not match its receipt");
  return { kind: "mini-app", version: 1, toolCallId, leafId: data.leafId, writable: data.writable, stateRevision: data.stateRevision,
    checkpointDigest: data.checkpointDigest, savedAt: data.savedAt, plan: compiled.plan, result,
    publication: { id: identity.operationId, planDigest: identity.planDigest, runtimeVersion: identity.runtimeVersion, revision: identity.revision, status: data.publication.status } };
}
export async function validateMiniAppReceipt(value: unknown, request: MiniAppSaveRequest): Promise<MiniAppSaveReceipt> {
  boundedJson(value, 4096);
  const data = value as MiniAppSaveReceipt;
  if (!data || data.requestId !== request.requestId || data.publicationId !== request.publicationId || !id(data.leafId)
    || !Number.isSafeInteger(data.stateRevision) || data.stateRevision < request.expectedRevision || !Number.isSafeInteger(data.savedAt) || data.savedAt < 0
    || data.requestDigest !== await miniAppBrowserDigest(request) || data.checkpointDigest !== await miniAppBrowserDigest(request.checkpoint)) {
    throw new MiniAppError("RECEIPT", "Mini app save has no matching durable receipt");
  }
  return { requestId: data.requestId, requestDigest: data.requestDigest, publicationId: data.publicationId, leafId: data.leafId,
    stateRevision: data.stateRevision, checkpointDigest: data.checkpointDigest, savedAt: data.savedAt };
}
