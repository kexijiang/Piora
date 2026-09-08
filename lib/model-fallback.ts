import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentSessionLike } from "./pi-types";
import { applyConfiguredImageInput } from "./model-capabilities";
import { resolveVisibleModels } from "./model-scope";

export const MAX_MODEL_FALLBACKS = 3;

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Only provider availability failures; never replay a refusal or an invalid request. */
export function isModelUnavailable(error: unknown): boolean {
  const text = errorText(error);
  if (/abort|cancel|context.{0,25}(length|window|limit)|too many tokens|content.?filter|safety|policy|invalid.{0,20}(schema|tool|parameter)|unsupported.{0,20}(image|tool|parameter)/i.test(text)) return false;
  return /\b(401|402|403|404|408|429|5\d\d)\b|rate.?limit|too many requests|overload|service unavailable|temporarily unavailable|capacity|quota|insufficient.{0,20}(credit|balance|fund)|credit balance|billing|no api key|invalid.{0,10}api.?key|authentication|unauthorized|token.{0,10}expired|model.{0,60}(not found|does not exist|unavailable|not available|not supported|decommissioned|deprecated)|no model selected|fetch failed|network error|connection (error|reset|refused)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timed? ?out|限流|额度|余额不足|模型.{0,20}(不可用|不存在)|服务不可用/i.test(text);
}

const key = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

export async function availableFallbackModels(runtime: ModelRuntime, patterns?: string[]): Promise<Model<Api>[]> {
  const scope = await resolveVisibleModels(runtime, patterns);
  // Unlike the interactive selector, an invalid explicit scope must not silently
  // authorize every model for unattended execution.
  if (patterns?.some((pattern) => pattern.trim()) && scope.scopedModels.length === 0) return [];
  const authenticated = new Set((await runtime.getAvailable()).map(key));
  return scope.visible.filter((model) => authenticated.has(key(model))).map((model) => applyConfiguredImageInput(model));
}

function lastMessage(session: AgentSessionLike): unknown {
  return session.agent.state?.messages?.at(-1);
}

function assistantError(message: unknown): string | undefined {
  const value = message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
  return value?.role === "assistant" && value.stopReason === "error"
    ? value.errorMessage || "Model request failed"
    : undefined;
}

function hasImages(messages: readonly unknown[]): boolean {
  return messages.some((message) => {
    const content = (message as { content?: unknown } | null)?.content;
    return Array.isArray(content) && content.some((block) => block?.type === "image");
  });
}

/** Keep recovery inside the owning PromptRun, using the SDK's normal agent loop. */
export async function runPromptWithModelFallback(options: {
  session: AgentSessionLike;
  enabled: () => boolean;
  prompt: (admitted: () => void) => Promise<void>;
  assertActive: () => void;
  images?: boolean;
  onSwitch: (from: string, to: string) => void;
  lastAssistant?: () => unknown;
}): Promise<void> {
  const { session, assertActive } = options;
  const attempted = new Set<string>();
  if (session.model) attempted.add(key(session.model));
  let admitted = false;
  let switches = 0;
  let invoke = () => options.prompt(() => { admitted = true; });
  for (;;) {
    assertActive();
    const before = lastMessage(session);
    const beforeAssistant = options.lastAssistant?.();
    const currentFailure = () => {
      const assistant = options.lastAssistant?.();
      if (assistant !== beforeAssistant) return assistantError(assistant);
      const after = lastMessage(session);
      return after !== before ? assistantError(after) : undefined;
    };
    let failure: unknown;
    try {
      await invoke();
      assertActive();
      failure = currentFailure();
      if (!failure) return;
    } catch (error) {
      assertActive();
      // A thrown tool/extension/preflight error is not proof of a failed model
      // call. Only credential/model preflight errors may retry the original prompt.
      if (currentFailure()) failure = currentFailure();
      else if (!admitted && /no api key|no model selected|authentication|invalid.{0,10}api.?key|model.{0,50}(not found|not available)/i.test(errorText(error))) failure = error;
      else throw error;
    }
    if (!options.enabled() || !isModelUnavailable(failure) || switches >= MAX_MODEL_FALLBACKS) throw new Error(errorText(failure));
    // Re-read scope for every switch so a model disabled between attempts is
    // not selected from an earlier snapshot.
    await session.settingsManager.reload();
    const candidates = await availableFallbackModels(session.modelRuntime, session.settingsManager.getEnabledModels());
    assertActive();
    const requiresImages = options.images || hasImages(session.agent.state?.messages ?? []);
    const contextTokens = session.getContextUsage()?.tokens;
    const current = session.model;
    // Prefer the same model through another provider, then another provider to
    // escape a shared outage/quota. Preserve catalog order within each group.
    const rank = (model: Model<Api>) => model.id === current?.id ? 0 : model.provider !== current?.provider ? 1 : 2;
    candidates.sort((a, b) => rank(a) - rank(b));
    let selected: Model<Api> | undefined;
    for (const candidate of candidates) {
      if (attempted.has(key(candidate)) || (requiresImages && !candidate.input.includes("image"))) continue;
      if (contextTokens && candidate.contextWindow <= contextTokens + 4_096) continue;
      if (switches >= MAX_MODEL_FALLBACKS) break;
      if (!options.enabled()) throw new Error(errorText(failure));
      attempted.add(key(candidate));
      switches += 1;
      assertActive();
      try {
        await session.setModel(candidate);
        assertActive();
        selected = candidate;
        break;
      } catch (error) {
        assertActive();
        if (!isModelUnavailable(error)) throw error;
      }
    }
    if (!selected) throw new Error(errorText(failure));
    const from = current ? key(current) : "unavailable model";
    const to = key(selected);
    options.onSwitch(from, to);
    const notice = {
      customType: "piora-model-fallback",
      content: `Model automatically switched: ${from} → ${to}. Continue the current task using the existing conversation and tool results. Check completed actions before taking further action; do not restart the task or repeat completed operations.`,
      display: true,
      details: { from, to, attempt: switches },
    };
    if (admitted) {
      // A custom continuation avoids resubmitting the user prompt or discarding
      // tool results, and still uses SDK retry/compaction/extension settlement.
      invoke = () => session.sendCustomMessage(notice, { triggerTurn: true });
    } else {
      await session.sendCustomMessage(notice, { triggerTurn: false });
      assertActive();
    }
  }
}
