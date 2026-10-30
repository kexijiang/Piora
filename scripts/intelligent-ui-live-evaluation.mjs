/** Explicit real-model adapter for the synthetic evaluation suite. No shell,
 * browser, project extensions, arbitrary code or external action tools load. */
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { Agent, runToolCall } from "@earendil-works/pi-agent-core";
import { createJiti } from "jiti";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createUiModelAdapter } from "./intelligent-ui-model-adapter.mjs";
import { verifyIntelligentUiAdmission } from "./patch-intelligent-ui-admission.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const protocol = await jiti.import("../lib/intelligent-ui/surface-document.ts");
const { intelligentUiPlanPrompt, intelligentUiRichPlanPrompt, intelligentUiSurfacePrompt, INTELLIGENT_UI_POLICY_VERSION } = await jiti.import("../lib/intelligent-ui/decision-policy.ts");
const { compileUiPlan, UiPlanError } = await jiti.import("../lib/intelligent-ui/plan.ts");
const { compileUiRichPlan } = await jiti.import("../lib/intelligent-ui/rich-plan.ts");
const planSchema = await jiti.import("../lib/intelligent-ui/plan-schema.ts");
const richPlanSchema = await jiti.import("../lib/intelligent-ui/rich-plan-schema.ts");
const { bindAnswerOutputAdmission } = await jiti.import("../lib/answer-output-admission.ts");
const { UI_ADMISSION_DEFAULTS } = await jiti.import("../lib/intelligent-ui/admission.ts");
const { surfaceDiagnostic } = await jiti.import("../lib/intelligent-ui/surface-diagnostic.ts");
export const evaluationAdmission = Object.freeze({ version: 1, ...UI_ADMISSION_DEFAULTS,
  implementation: "production-binding-and-sdk-runToolCall", lifetime: "one-synthetic-user-turn",
  persistence: "not-tested", permissions: "not-tested", browserInteraction: "not-tested" });
const frozen = JSON.parse(await readFile(join(root, "tests/fixtures/intelligent-ui/phase1-tool.json"), "utf8"));
const source = await readFile(join(root, "tests/fixtures/intelligent-ui/phase1-extension-source.txt"), "utf8");
if (createHash("sha256").update(source).digest("hex") !== frozen.sourceSha256) throw new Error("Frozen baseline source changed");

const commonPrompt = "You are Piora, a helpful assistant. Respond in the user's language. Answer the user's task using the available tools only when they help. Never invent capabilities, business facts, data sources or successful actions.";
export async function evaluationVariant(version) {
  let declaration, representation = "surface-v1";
  if (version === "phase1") declaration = frozen.tool;
  else if (version === INTELLIGENT_UI_POLICY_VERSION) {
    declaration = { ...frozen.tool, ...intelligentUiSurfacePrompt() };
  } else if (version === "plan-1") {
    declaration = { name: "piora_render_ui_plan", ...intelligentUiPlanPrompt(), parameters: planSchema.uiPlanSchema };
    representation = "plan-v1";
  } else if (version === "plan-2") {
    declaration = { name: "piora_render_ui_plan", ...intelligentUiRichPlanPrompt(), parameters: richPlanSchema.uiRichPlanSchema };
    representation = "plan-v2";
  } else throw new Error("Unknown evaluation policy version");
  if (!declaration.parameters) throw new Error("Missing evaluation tool schema");
  return { protocol: representation, admission: evaluationAdmission,
    tools: [{ name: declaration.name, description: declaration.description, parameters: declaration.parameters }],
    systemPrompt: [commonPrompt, declaration.promptSnippet, ...declaration.promptGuidelines].join("\n\n") };
}

export async function isolatedUiExecutor({ call, protocol: representation, state, signal }) {
  signal.throwIfAborted();
  let surface, stage = "schema";
  try {
    if (representation === "plan-v1" || representation === "plan-v2") {
      stage = "plan";
      const compile = representation === "plan-v2" ? compileUiRichPlan : compileUiPlan;
      surface = compile(call.arguments, { revision: (state.get(call.arguments?.id)?.revision ?? 0) + 1 }).surface;
    } else {
      const argumentsValue = validateToolArguments(frozen.tool, structuredClone(call));
      stage = "surface";
      const revision = (state.get(argumentsValue.id)?.revision ?? 0) + 1;
      surface = protocol.validateSurface({ version: 1, revision, ...argumentsValue });
    }
    const snapshot = protocol.formatSnapshot(surface);
    signal.throwIfAborted();
    state.set(surface.id, surface);
    return { content: snapshot, committed: false,
      evidence: { generationValid: true, defaultCalculationsAvailable: !snapshot.includes("[calculation unavailable]"),
        surface, snapshot, persistence: "not-tested", browserInteraction: "not-tested" } };
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof UiPlanError) return { isError: true, committed: false, errorCode: error.diagnostic.code,
      content: JSON.stringify(error.diagnostic), evidence: { generationValid: false, diagnostic: error.diagnostic } };
    const diagnostic = stage === "surface" ? surfaceDiagnostic(error) : undefined;
    return { isError: true, committed: false, errorCode: diagnostic?.code ?? "UI_SCHEMA_INVALID",
      content: "The UI arguments do not meet the declared component, reference or value constraints. Check them against the tool schema.",
      evidence: { generationValid: false, validationStage: stage, ...(diagnostic ? { diagnostic } : {}),
        // Only this explicitly synthetic offline adapter records generated
        // arguments. Production diagnostics must not log arbitrary user data.
        arguments: JSON.stringify(call.arguments).slice(0, 64_000) } };
  }
}

let verifiedAdmission;
/** Share the real pre-validation hook and SDK execution/settlement, while keeping
 * generated state in memory. This does not stand in for publication or UI tests. */
export async function createAdmittedUiTurn({ configuration, signal }) {
  verifiedAdmission ??= verifyIntelligentUiAdmission(root);
  await verifiedAdmission;
  const agent = new Agent();
  let active = true, stopped = false;
  const binding = bindAnswerOutputAdmission({ agent,
    identity: { sessionId: `evaluation-${randomUUID()}`, runId: randomUUID() },
    loadedTools: configuration.tools, isActive: () => active && !signal.aborted,
    onRepeatedDenial: () => { stopped = true; } });
  // Retain the originating binding even after close, exactly like an SDK context.
  const admitToolCall = agent.admitToolCall;
  return {
    snapshot: () => binding.snapshot(),
    close: () => { active = false; binding.cancel(); },
    async execute({ call, state }) {
      signal.throwIfAborted();
      const staged = new Map(state);
      const tools = configuration.tools.map(declaration => ({ ...declaration,
        label: "Intelligent UI", executionMode: "sequential",
        async execute(id, args, executionSignal) {
          const value = await isolatedUiExecutor({ call: { id, name: declaration.name, arguments: args },
            protocol: configuration.protocol, state: staged, signal: executionSignal });
          return { content: [{ type: "text", text: value.evidence?.diagnostic ? JSON.stringify(value.evidence.diagnostic) : value.content }],
            isError: value.isError === true, details: { evaluationEvidence: value.evidence,
              ...(value.evidence?.diagnostic ? { intelligentUiDiagnostic: value.evidence.diagnostic } : {}) } };
        } }));
      const outcome = await runToolCall(structuredClone(call), { signal, tools, admitToolCall,
        context: { systemPrompt: configuration.systemPrompt, tools, messages: [] },
        assistantMessage: { role: "assistant", content: [call], stopReason: "toolUse" } });
      signal.throwIfAborted();
      const diagnostic = outcome.result.details?.intelligentUiDiagnostic;
      const evidence = outcome.isError ? { generationValid: false, ...(diagnostic ? { diagnostic } : {}) }
        : outcome.result.details?.evaluationEvidence;
      if (!outcome.isError) {
        state.clear();
        for (const [key, value] of staged) state.set(key, value);
      }
      // Synthetic evaluation data only. Keep this out of the model transcript
      // and production logs; pre-validation failures need reproducible inputs too.
      if (outcome.isError) {
        try {
          const serialized = JSON.stringify(call.arguments);
          evidence.arguments = serialized.slice(0, 64_000);
          evidence.argumentsTruncated = serialized.length > 64_000;
        } catch { evidence.argumentsUnavailable = true; }
      }
      return { isError: outcome.isError, committed: false, terminate: stopped || outcome.result.terminate === true,
        content: outcome.result.content.filter(item => item.type === "text").map(item => item.text).join("\n"),
        ...(outcome.isError ? { errorCode: diagnostic?.code ?? "executor-error" } : {}),
        evidence: { ...evidence, admission: binding.snapshot(), persistence: "not-tested", browserInteraction: "not-tested" } };
    },
  };
}

let runtimePromise;
async function getRuntime() {
  const agentDir = getAgentDir();
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
  if (runtime.getError()) throw new Error("Model configuration could not be loaded; inspect Piora model settings");
  return runtime;
}
export function evaluationSettings(input = {}) {
  const defaults = { maxRequestsPerTurn: 4, maxToolAttemptsPerTurn: 8, timeoutMs: 120_000,
    maxTokens: 8_192, reasoning: "low", maxRetries: 0 };
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !(key in defaults))) throw new Error("Unsupported evaluation model setting");
  const settings = { ...defaults, ...input };
  if (settings.maxRetries !== 0 || !["off", "minimal", "low", "medium", "high", "xhigh"].includes(settings.reasoning)) {
    throw new Error("Evaluation requires an explicit thinking level and no hidden network retries");
  }
  return settings;
}
export async function describeEvaluation({ policyVersions, modelSettings, baselinePath }) {
  const paths = ["scripts/intelligent-ui-model-adapter.mjs", "lib/intelligent-ui/decision-policy.ts",
    "lib/answer-output-admission.ts", "lib/intelligent-ui/admission.ts", "lib/intelligent-ui/plan-admission.ts",
    "lib/intelligent-ui/surface-diagnostic.ts", "scripts/patch-intelligent-ui-admission.mjs", "scripts/pi-tool-admission-1.4.0.json",
    "lib/intelligent-ui/plan.ts", "lib/intelligent-ui/plan-types.ts", "lib/intelligent-ui/plan-schema.ts", "lib/intelligent-ui/plan2-expressions.ts",
    "lib/intelligent-ui/rich-plan.ts", "lib/intelligent-ui/rich-plan-schema.ts",
    "lib/intelligent-ui/rich-protocol.ts", "lib/intelligent-ui/surface-document.ts",
    "lib/intelligent-ui/protocol.ts", "package-lock.json", "tests/fixtures/intelligent-ui/phase1-tool.json",
    "node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js",
    "node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js",
    "node_modules/@earendil-works/pi-ai/package.json"];
  const digests = Object.fromEntries(await Promise.all(paths.map(async path => [path,
    createHash("sha256").update(await readFile(join(root, path))).digest("hex")])));
  await verifyIntelligentUiAdmission(root);
  return { version: 2, node: process.versions.node, settings: evaluationSettings(modelSettings),
    scope: "isolated-model-generation", feedback: "production-admission-and-sdk-validation", admission: evaluationAdmission,
    variants: Object.fromEntries(await Promise.all(policyVersions.map(async version => [version, await evaluationVariant(version)]))),
    baselineSha256: createHash("sha256").update(await readFile(baselinePath ?? join(root, "tests/fixtures/intelligent-ui/phase1-tool.json"))).digest("hex"),
    sourceDigests: digests };
}
export async function runTask(input) {
  if (input.baselinePath) {
    const supplied = await readFile(input.baselinePath, "utf8");
    if (createHash("sha256").update(supplied).digest("hex") !== createHash("sha256").update(await readFile(join(root, "tests/fixtures/intelligent-ui/phase1-tool.json"), "utf8")).digest("hex")) {
      throw new Error("This live adapter requires the frozen phase 1 baseline");
    }
  }
  runtimePromise ??= getRuntime();
  const adapter = createUiModelAdapter({ runtime: await runtimePromise, variant: evaluationVariant,
    createTurnExecutor: createAdmittedUiTurn, ...evaluationSettings(input.modelSettings) });
  return adapter.runTask(input);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--catalog") throw new Error("Use --catalog or load this adapter through evaluate-intelligent-ui.mjs");
  const runtime = await getRuntime();
  console.log(JSON.stringify((await runtime.getAvailable()).map(model => ({ model: `${model.provider}/${model.id}`, api: model.api })), null, 2));
}
