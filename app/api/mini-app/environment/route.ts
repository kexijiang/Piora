import { isApiRequestAllowed } from "@/lib/request-security";
import { readBetaFeatures } from "@/lib/beta-features";
import { miniAppRendererDigest } from "@/lib/mini-app/capability-host";
import { miniAppEnvironments } from "@/lib/mini-app/environment-store";
import { MINI_APP_RENDERER_PROTOCOL, validateMiniAppEnvironmentReport } from "@/lib/mini-app/environment-protocol";
import { boundedJson, exactKeys, jsonRecord } from "@/lib/mini-app/json";
import { isMiniAppError } from "@/lib/mini-app/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return new Response("Forbidden", { status: 403 });
  return Response.json({ enabled: readBetaFeatures().intelligentUi, protocol: MINI_APP_RENDERER_PROTOCOL, rendererDigest: miniAppRendererDigest() }, { headers });
}
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return new Response("Forbidden", { status: 403 });
  try {
    // Bound bytes before parsing; no model code, resource paths or permissions.
    const reader = request.body?.getReader(); if (!reader) throw new Error("Missing body");
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 4000) throw new Error("Body limit"); chunks.push(value); } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const text = Buffer.concat(chunks).toString("utf8"); boundedJson(JSON.parse(text), 4000);
    const body = jsonRecord(JSON.parse(text), "environment"); exactKeys(body, ["action", "report", "sessionId", "submissionId"], "environment");
    const report = validateMiniAppEnvironmentReport(body.report), store = miniAppEnvironments();
    if (body.action === "revoke") store.revoke(report.instance, report.epoch, report.sequence);
    else {
      if (!readBetaFeatures().intelligentUi) return Response.json({ error: "Intelligent UI is disabled" }, { status: 409, headers });
      const digest = miniAppRendererDigest();
      if (body.action === "prepare" && typeof body.sessionId === "string" && typeof body.submissionId === "string") store.prepare(body.sessionId, body.submissionId, report, digest);
      else if (body.action === "heartbeat" && body.sessionId === undefined && body.submissionId === undefined) store.report(report, digest);
      else throw new Error("Unknown environment action");
    }
    return Response.json({ accepted: true }, { headers });
  } catch (error) { return Response.json({ error: isMiniAppError(error) ? error.message : "Invalid renderer environment request" }, { status: 409, headers }); }
}
