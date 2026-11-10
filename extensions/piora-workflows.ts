import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getWorkflowRuntime, planToolAllowed, type WorkflowRuntime } from "../lib/workflow-runtime.ts";
import type { WorkflowStore } from "../lib/workflow-store.ts";

/** Workflow controls use unique tool names, leaving installed /plan and /goal commands intact. */
export function createWorkflowExtension(options: { store?: WorkflowStore } = {}) {
  return (api: ExtensionAPI) => {
    let runtime: WorkflowRuntime | undefined;
    let detach: (() => void) | undefined;
    api.on("session_start", (_event, ctx) => {
      detach?.();
      runtime = getWorkflowRuntime(ctx.sessionManager.getSessionId(), options.store);
      detach = runtime.attach(() => api.getActiveTools());
    });
    api.on("session_shutdown", () => { runtime?.dispose(); detach?.(); detach = undefined; });
    api.on("before_agent_start", event => {
      const instruction = runtime?.beginTurn();
      if (instruction) return { systemPrompt: `${event.systemPrompt}\n\n<piora_workflow>\n${instruction}\n</piora_workflow>` };
    });
    // SDK follow-up runs emit agent_start without another before_agent_start.
    // Capture every loop's identity so budget settlement cannot silently stop.
    api.on("agent_start", () => { runtime?.beginTurn(); });
    api.on("context", event => {
      const snapshot = runtime?.getSnapshot();
      if (!snapshot?.current || snapshot.mode === "agent") return;
      return { messages: [...event.messages, {
        role: "custom" as const, customType: "piora-workflow-context", display: false, timestamp: Date.now(),
        content: `Current host workflow state. Preserve the original objective; this snapshot survives context compaction.\n${JSON.stringify(snapshot.current)}`,
      }] };
    });
    api.on("tool_call", event => {
      let state;
      try { state = runtime?.getSnapshot(); }
      catch { return { block: true, reason: "Workflow state cannot be read safely. No tool was executed; restore the workflow state before continuing." }; }
      if (state?.mode === "plan" && !planToolAllowed(event.toolName, event.input)) return { block: true, reason: "Plan mode permits inspection and plan submission only. This tool/action was not executed. Ask the user to approve the plan or switch to Agent before implementation. Shell and unknown tools are unavailable in Plan mode." };
      if (state?.mode === "plan" && state.current?.status === "awaiting_approval") return { block: true, reason: "The plan is awaiting user review; no further tools may run until the user decides." };
      if (state?.mode === "goal" && state.current && state.current.status !== "running") return { block: true, reason: "The goal is no longer running. Wait for the user's next action." };
    });
    api.on("tool_result", event => { if (!event.isError) runtime?.recordToolEvidence(event.toolName, event.content); });
    api.on("agent_end", event => {
      const last = [...event.messages].reverse().find(message => message.role === "assistant");
      const error = last && "stopReason" in last && ["error", "aborted"].includes(last.stopReason);
      if (last && "stopReason" in last && last.stopReason === "aborted") { runtime?.onAbort(); return; }
      const continuation = runtime?.endTurn(Boolean(error));
      if (continuation) api.sendUserMessage(continuation, { deliverAs: "followUp" });
    });
    api.registerTool(defineTool({
      name: "piora_submit_plan", label: "Submit plan", description: "Submit a complete plan for user review in Piora Plan mode. Include objective, scope, implementation steps and validation. The host persists this exact Markdown snapshot; this does not authorize implementation.",
      executionMode: "sequential",
      parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 500 }), markdown: Type.String({ minLength: 1, maxLength: 100_000 }) }),
      async execute(_id, params) {
        if (!runtime) throw new Error("Workflow session unavailable");
        const snapshot = runtime.submitPlan(params.title, params.markdown);
        return { content: [{ type: "text" as const, text: "Plan saved and awaiting user review. Stop planning and wait for the user's action." }], details: { workflow: snapshot } };
      },
    }));
    api.registerTool(defineTool({
      name: "piora_update_goal", label: "Update goal", description: "Record progress and acceptance evidence for the current Piora Goal. The original objective cannot be changed. Criteria are locked after their first declaration. Completed requires every criterion verified with concrete observed evidence; waiting requires a reason. Do not report unrun checks as verified.",
      executionMode: "sequential",
      parameters: Type.Object({
        progress: Type.String({ minLength: 1, maxLength: 20_000 }),
        criteria: Type.Optional(Type.Array(Type.Object({ id: Type.String({ minLength: 1, maxLength: 100 }), text: Type.String({ minLength: 1, maxLength: 5000 }), evidence: Type.String({ maxLength: 20_000 }), status: Type.Union([Type.Literal("pending"), Type.Literal("verified")]) }), { minItems: 1, maxItems: 50 })),
        status: Type.Optional(Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("waiting")])),
        reason: Type.Optional(Type.String({ maxLength: 5000 })),
      }),
      async execute(_id, params) {
        if (!runtime) throw new Error("Workflow session unavailable");
        const snapshot = runtime.updateGoal(params);
        return { content: [{ type: "text" as const, text: `Goal state: ${snapshot.current?.status}. Evidence is recorded as the agent's report.` }], details: { workflow: snapshot } };
      },
    }));
  };
}

export default createWorkflowExtension();
