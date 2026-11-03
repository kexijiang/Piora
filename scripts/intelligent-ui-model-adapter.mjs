/**
 * Real-provider evaluation transport. Only synthetic task turns and the selected
 * UI declaration are sent; labels, expectations and reviews never enter context.
 * This is an evaluation harness, not the production PromptRun admission gate.
 */
export function createUiModelAdapter({ runtime, variant, executeUi, createTurnExecutor, maxRequestsPerTurn = 4,
  maxToolAttemptsPerTurn = 8, timeoutMs = 120_000, maxTokens = 8_192, reasoning = "low" }) {
  if (!runtime?.completeSimple || typeof variant !== "function" || !(typeof executeUi === "function" || typeof createTurnExecutor === "function")) {
    throw new TypeError("A model runtime, variant resolver and isolated UI executor are required");
  }
  for (const [key, value] of Object.entries({ maxRequestsPerTurn, maxToolAttemptsPerTurn, timeoutMs, maxTokens })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid ${key}`);
  }
  return {
    async runTask({ task, model: modelKey, policyVersion, signal }) {
      const separator = modelKey.indexOf("/");
      if (separator < 1) throw new TypeError("Model must be provider/modelId");
      const model = runtime.getModel(modelKey.slice(0, separator), modelKey.slice(separator + 1));
      if (!model) throw new Error("Requested evaluation model is not configured");
      const configuration = await variant(policyVersion);
      const tools = configuration.tools;
      if (!Array.isArray(tools) || tools.length > 1) throw new Error("Evaluation exposes at most one UI tool");
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => { if (signal?.reason?.name === "TimeoutError") timedOut = true; controller.abort(); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
      const messages = [];
      const turns = [];
      let outcome = "completed";
      let turnStarted = performance.now();
      let turnExecutor;
      // State belongs to this task alone. The executor may persist only in its
      // own isolated fixture; it never receives the user's ordinary workspace.
      const state = new Map();
      const transport = { maxRequestsPerTurn, maxToolAttemptsPerTurn, timeoutMs, maxTokens, reasoning,
        maxRetries: 0, protocol: configuration.protocol, scope: "isolated-model-generation",
        ...(configuration.admission ? { admission: configuration.admission } : {}) };
      try {
        for (let turnIndex = 0; turnIndex < task.turns.length; turnIndex++) {
          const user = task.turns[turnIndex].user;
          if (typeof user !== "string") throw new TypeError("Task turns require user text");
          turnStarted = performance.now();
          const turn = { user, assistant: "", uiAttempts: [], otherToolAttempts: [], durationMs: 0, responses: [] };
          turns.push(turn);
          turnExecutor = await createTurnExecutor?.({ configuration, signal: controller.signal, turnIndex });
          messages.push({ role: "user", content: user, timestamp: Date.now() });
          let settled = false;
          for (let request = 0; request < maxRequestsPerTurn; request++) {
            controller.signal.throwIfAborted();
            let response;
            try {
              response = await withAbort(runtime.completeSimple(model, {
                systemPrompt: configuration.systemPrompt, tools, messages,
              }, { signal: controller.signal, maxTokens, reasoning, maxRetries: 0,
                timeoutMs, transport: "sse" }), controller.signal);
            } catch {
              controller.signal.throwIfAborted();
              outcome = "provider-error"; turn.errorCode = "provider-request-failed"; break;
            }
            controller.signal.throwIfAborted();
            if (!response || !Array.isArray(response.content)) {
              outcome = "provider-error"; turn.errorCode = "provider-malformed-response"; break;
            }
            // Keep reasoning only in the in-memory provider transcript, as
            // required for provider continuity. Never include it in reports.
            messages.push(response);
            const failedResponse = response.stopReason === "error" || response.stopReason === "aborted";
            const text = failedResponse ? "" : response.content.filter(item => item.type === "text").map(item => item.text).join("\n");
            turn.assistant += (turn.assistant && text ? "\n" : "") + text;
            turn.responses.push({ text, stopReason: response.stopReason,
              responseModel: response.responseModel ?? response.model,
              usage: response.usage, durationMs: response.durationMs });
            if (failedResponse) {
              // Provider errors may echo headers or credentials. Persist only
              // an error class, never the raw error message or response body.
              outcome = controller.signal.aborted ? (timedOut ? "timeout" : "cancelled") : "provider-error";
              turn.errorCode = response.stopReason === "error" ? "provider-error" : "provider-aborted";
              recordUnexecutedCalls(turn, response.content, tools, maxToolAttemptsPerTurn, turn.errorCode);
              break;
            }
            if (response.stopReason === "length") {
              // A truncated tool call is still evidence of UI selection. Keep
              // it out of execution, but do not misclassify it as a routing miss.
              recordUnexecutedCalls(turn, response.content, tools, maxToolAttemptsPerTurn, "output-token-limit");
              outcome = "timeout"; turn.errorCode = "output-token-limit"; break;
            }
            const calls = response.content.filter(item => item.type === "toolCall");
            if (!calls.length) { settled = true; break; }
            for (const call of calls) {
              controller.signal.throwIfAborted();
              const attempt = { toolCallId: call.id, toolName: call.name, committed: false };
              const knownUiTool = tools.some(tool => tool.name === call.name);
              (knownUiTool ? turn.uiAttempts : turn.otherToolAttempts).push(attempt);
              let result;
              if (turn.uiAttempts.length + turn.otherToolAttempts.length > maxToolAttemptsPerTurn) {
                attempt.errorCode = "evaluation-tool-limit";
                outcome = "timeout"; turn.errorCode = "evaluation-tool-limit"; break;
              }
              if (!knownUiTool) {
                result = { isError: true, errorCode: "unknown-tool", content: "This tool is unavailable." };
              } else {
                try {
                  result = await withAbort(Promise.resolve().then(() => (turnExecutor?.execute ?? executeUi)({ call,
                    protocol: configuration.protocol, state, signal: controller.signal, turnIndex })), controller.signal);
                } catch {
                  controller.signal.throwIfAborted();
                  result = { isError: true, errorCode: "executor-error", content: "The UI evaluation executor failed." };
                }
              }
              controller.signal.throwIfAborted();
              Object.assign(attempt, { committed: result.committed === true,
                ...(result.errorCode ? { errorCode: result.errorCode } : {}),
                ...(result.evidence ? { evidence: result.evidence } : {}) });
              messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name,
                isError: result.isError === true, content: [{ type: "text", text: result.content }], timestamp: Date.now() });
              if (result.terminate === true) {
                outcome = "admission-stopped"; turn.errorCode = result.errorCode ?? "admission-stopped"; break;
              }
            }
            if (outcome !== "completed") break;
          }
          turn.durationMs = performance.now() - turnStarted;
          if (turnExecutor) {
            turn.admission = turnExecutor.snapshot();
            turnExecutor.close(); turnExecutor = undefined;
          }
          if (outcome !== "completed") break;
          if (!settled) {
            // A turn still calling tools at the harness cap is a failed result,
            // never a completed success or a silently dropped assistant turn.
            turn.errorCode = "evaluation-request-limit";
            outcome = "timeout";
            break;
          }
        }
      } catch (error) {
        if (controller.signal.aborted) outcome = timedOut ? "timeout" : "cancelled";
        else if (error instanceof TypeError) throw error;
        else outcome = "provider-error";
        if (turns.length) turns.at(-1).errorCode ??= outcome;
      } finally {
        if (turnExecutor) {
          if (turns.length) turns.at(-1).admission = turnExecutor.snapshot();
          turnExecutor.close();
        }
        if (turns.length) turns.at(-1).durationMs = performance.now() - turnStarted;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
      return { outcome, turns, transport };
    },
  };
}

function recordUnexecutedCalls(turn, content, tools, limit, errorCode) {
  for (const call of content.filter(item => item.type === "toolCall").slice(0, limit)) {
    const collection = tools.some(tool => tool.name === call.name) ? turn.uiAttempts : turn.otherToolAttempts;
    if (collection.some(attempt => attempt.toolCallId === call.id)) continue;
    collection.push({ toolCallId: call.id, toolName: call.name, committed: false, errorCode });
  }
}

/** Providers/executors that ignore AbortSignal must not hold the runner open. */
function withAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason); };
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener("abort", aborted); resolve(value); },
      error => { signal.removeEventListener("abort", aborted); reject(error); });
  });
}
