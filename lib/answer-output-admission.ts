import type { PromptRunIdentity } from "./prompt-run-registry";
import type { UiAdmissionHook } from "./intelligent-ui/admission";

/** Shared chat code knows capability names, not component or expression protocols. */
const UI_TOOLS = ["piora_render_ui", "piora_render_ui_plan"] as const;
export interface AnswerOutputAdmissionAgent {
  pioraToolAdmissionVersion?: number;
  admitToolCall?: UiAdmissionHook;
}

export function bindAnswerOutputAdmission(options: {
  agent: AnswerOutputAdmissionAgent;
  identity: PromptRunIdentity;
  loadedTools: readonly { name: string }[];
  isActive(): boolean;
  onRepeatedDenial(): void;
}) {
  const loaded = new Set(options.loadedTools.map(tool => tool.name));
  const toolNames = UI_TOOLS.filter(name => loaded.has(name));
  if (toolNames.length && options.agent.pioraToolAdmissionVersion !== 2) {
    throw new Error("Intelligent UI requires the verified tool admission runtime. Reinstall dependencies before enabling this feature.");
  }
  // A closed-over binding belongs to exactly this run. The SDK captures it in
  // each tool context, including contexts later used by a nested worker.
  const identity = { ...options.identity };
  let disposed = false;
  let budget: import("./intelligent-ui/admission").UiAdmissionBudget | undefined;
  let loading: Promise<void> | undefined;
  const isActive = () => !disposed && options.isActive();
  const hook: UiAdmissionHook = async (context, signal) => {
    if (!UI_TOOLS.some(name => name === context.toolCall.name)) return undefined;
    if (!isActive() || !toolNames.includes(context.toolCall.name as typeof UI_TOOLS[number])) {
      return { immediate: { isError: true, result: {
        content: [{ type: "text", text: "Intelligent UI is unavailable for this originating task. Do not retry this operation." }],
        details: { intelligentUiDiagnostic: { code: "UI_RUN_UNAVAILABLE", repairable: false } }, isError: true,
      } } };
    }
    loading ??= import("./intelligent-ui/admission").then(({ UiAdmissionBudget }) => {
      budget = new UiAdmissionBudget({ ...identity, toolNames, isActive, onRepeatedDenial: () => {
        if (isActive()) options.onRepeatedDenial();
      } });
      if (!isActive()) budget.cancel();
    });
    await loading;
    const admission = await budget!.admit(context, signal);
    if (admission && !("immediate" in admission) && context.toolCall.name === "piora_render_ui_plan") {
      const { originalUiPlanDiagnostic } = await import("./intelligent-ui/plan-admission");
      const diagnostic = originalUiPlanDiagnostic(context.toolCall.arguments);
      if (diagnostic) return { immediate: admission.settle({ isError: true,
        result: { content: [{ type: "text", text: JSON.stringify(diagnostic) }],
          details: { intelligentUiDiagnostic: diagnostic }, isError: true } }, "execution") };
    }
    return admission;
  };
  // Off-mode requires no feature import. A supported SDK still retains a small
  // unavailable binding so an old tool context cannot gain a future capability.
  if (options.agent.pioraToolAdmissionVersion === 2) options.agent.admitToolCall = hook;
  return {
    identity,
    snapshot: () => budget?.snapshot(),
    cancel: () => {
      disposed = true;
      budget?.cancel();
      if (options.agent.admitToolCall === hook) options.agent.admitToolCall = undefined;
    },
  };
}
