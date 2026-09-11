import { NextResponse } from "next/server";
import { parseJsonWithinLimit } from "@/lib/bounded-json";
import { getAutomationStore } from "@/lib/automation-store";
import type { CreateAutomationInput } from "@/lib/automation-types";

export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 128 * 1_024;

function errorResponse(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found|does not exist/i.test(message) ? 404 : /too long|too large/i.test(message) ? 413 : 400;
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  try {
    const query = new URL(request.url).searchParams;
    const sessionId = query.get("sessionId");
    const cwd = query.get("cwd");
    const automations = getAutomationStore().list().filter((automation) => {
      if (sessionId && (automation.target.type !== "session" || automation.target.sessionId !== sessionId)) return false;
      if (cwd && (automation.target.type !== "project" || automation.target.cwd.toLocaleLowerCase() !== cwd.toLocaleLowerCase())) return false;
      return true;
    });
    return NextResponse.json({ automations }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { resolveOrStartRpcSession } = await import("@/lib/session-runtime-resolver");
    const body = await parseJsonWithinLimit(request, MAX_BODY_BYTES) as CreateAutomationInput;
    if (!body || typeof body !== "object") throw new Error("Automation input is required.");
    if (body.kind === "heartbeat" && body.target?.type === "session") await resolveOrStartRpcSession(body.target.sessionId);
    const store = getAutomationStore();
    const automation = await store.create(body);
    if (automation.target.type === "session") {
      try {
        const { session } = await resolveOrStartRpcSession(automation.target.sessionId);
        session.appendAutomationCard({ automationId: automation.id, name: automation.name, rrule: automation.rrule });
      } catch (error) {
        // Do not return an error while silently leaving a task behind. A retry
        // must be able to create exactly one task and one visible chat card.
        await store.remove(automation.id);
        throw error;
      }
    }
    return NextResponse.json({ automation }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
