import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { resolveOrStartRpcSession, SessionRuntimeResolverError } from "@/lib/session-runtime-resolver";
import { resolveSessionAgentRuntimeProfile } from "@/lib/agent-profile-store";
import { getAgentRuntimeProfile } from "@/lib/agent-runtime-profile";
import { getSessionMessageRouter } from "@/lib/session-message-router";
import { readWorkflowSnapshot, WorkflowError, isWorkflowError } from "@/lib/workflow-runtime";
import { readLaboratorySettings } from "@/lib/laboratory-settings";
import { parseWorkflowAction, parseWorkflowPromptOptions, parseWorkflowRevision, WorkflowInputError } from "@/lib/workflow-input";

type Context = { params: Promise<{ id: string }> };
const noStore = { "Cache-Control": "no-store" };

function failure(error: unknown) {
  const status = error instanceof WorkflowInputError || error instanceof SyntaxError ? 400 : isWorkflowError(error) ? error.status
    : error instanceof SessionRuntimeResolverError && error.code === "SESSION_NOT_FOUND" ? 404
      : /busy|stopping|running/i.test(error instanceof Error ? error.message : "") ? 409 : 500;
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error), code: (error as { code?: string })?.code }, { status, headers: noStore });
}

async function assertSession(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new WorkflowInputError("Invalid session ID.");
  if (!getRpcSession(id)?.isAlive() && !await resolveSessionPath(id)) throw new SessionRuntimeResolverError("SESSION_NOT_FOUND", "Session not found.");
  await resolveSessionAgentRuntimeProfile(id, getAgentRuntimeProfile());
}

/** History hydration never creates an AgentSession or requests a model. */
export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    await assertSession(id);
    return NextResponse.json(readWorkflowSnapshot(id), { headers: noStore });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    await assertSession(id);
    const body = await request.json() as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new WorkflowInputError("Invalid workflow request.");
    if (body.action === "configure") {
      const workflow = parseWorkflowPromptOptions({ mode: body.mode, turnBudget: body.turnBudget });
      const expectedRevision = parseWorkflowRevision(body.expectedRevision);
      const { session } = await resolveOrStartRpcSession(id);
      const result = await session.send({ type: "workflow_configure", workflow, expectedRevision });
      return NextResponse.json(result, { headers: noStore });
    }
    const action = parseWorkflowAction(body);
    if (action.action === "approve" || action.action === "resume") {
      // A durable receipt makes retries, concurrent clicks, and a stop during
      // asynchronous runtime admission target exactly the same submission.
      const idempotencyKey = `workflow:${id}:${action.runId}:${action.expectedRevision}:${action.action}`;
      const router = getSessionMessageRouter();
      const previous = await router.findSubmissionReceipt(id, idempotencyKey);
      if (!previous && !readLaboratorySettings().planGoalEnabled) throw new WorkflowError("Enable Plan and Goal in Settings > Laboratory before continuing.", "WORKFLOW_LABORATORY_DISABLED", 409);
      const receipt = previous ?? await router.dispatchSessionMessage({
        targetSessionId: id, source: "ui", delivery: "next_turn", inputMode: "text", idempotencyKey,
        content: action.action === "approve" ? "Execute the approved plan." : "Resume the current workflow.",
        workflowAction: action,
      });
      if (["cancelled", "failed", "expired", "interrupted"].includes(receipt.status)) {
        const command = await router.getCommand(receipt.commandId);
        return NextResponse.json({ snapshot: readWorkflowSnapshot(id), promptStarted: false, commandId: receipt.commandId, idempotencyKey,
          error: command.errorMessage || `Workflow execution was ${receipt.status}. Review the current state before trying again.`,
        }, { status: 409, headers: noStore });
      }
      return NextResponse.json({ snapshot: readWorkflowSnapshot(id), promptStarted: ["accepted", "queued", "dispatching", "delivered", "running"].includes(receipt.status), commandId: receipt.commandId, idempotencyKey }, { headers: noStore });
    }
    const { session } = await resolveOrStartRpcSession(id);
    const result = await session.send({ type: "workflow_action", workflowAction: action });
    return NextResponse.json(result, { headers: noStore });
  } catch (error) { return failure(error); }
}
