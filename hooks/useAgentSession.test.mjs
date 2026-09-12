import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { randomUUID } from "node:crypto";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");

function historyHarness(overrides = {}) {
  const callbacks = source.slice(source.indexOf("  const switchHistoryBranch = useCallback"), source.indexOf("  const handleModelChange = useCallback"));
  const events = [];
  const env = {
    useCallback: callback => callback, sessionIdRef: { current: "session" }, agentRunningRef: { current: false }, bashRunningRef: { current: false }, isCompacting: false,
    t: key => key, sendAgentCommand: async (_id, command) => { events.push(command.type); return command.type === "fork" ? { newSessionId: "new-session" } : {}; },
    loadContext: async () => { events.push("context"); return true; }, setActiveLeafId: id => events.push(`leaf:${id}`),
    setDraft: (id, draft) => events.push({ id, draft }), onSessionForked: id => events.push(`open:${id}`), ...overrides,
  };
  const js = ts.transpileModule(callbacks, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return { ...new Function("env", `with(env) { ${js}; return { switchHistoryBranch, forkHistoryQuestion }; }`)(env), events };
}

test("history switches only after success and preserves the preview on cancellation or load failure", async () => {
  const success = historyHarness();
  assert.equal(await success.switchHistoryBranch("leaf"), true);
  assert.deepEqual(success.events, ["navigate_tree", "context", "leaf:leaf"]);
  const cancelled = historyHarness({ sendAgentCommand: async () => ({ cancelled: true }) });
  assert.equal(await cancelled.switchHistoryBranch("leaf"), false);
  assert.deepEqual(cancelled.events, []);
  const failed = historyHarness({ loadContext: async () => false });
  await assert.rejects(failed.switchHistoryBranch("leaf"), /history.loadError/);
  assert.deepEqual(failed.events, ["navigate_tree"]);
});

test("history fork seeds the original question and attachments without sending; busy sessions cannot fork", async () => {
  const draft = { value: "检查图片", images: [{ data: "YWJj", mimeType: "image/png" }], files: [{ name: "note.txt", text: "备注", size: 6 }] };
  const fork = historyHarness();
  assert.equal(await fork.forkHistoryQuestion("question", draft), true);
  assert.deepEqual(fork.events, ["fork", { id: "new-session", draft }, "open:new-session"]);
  const busy = historyHarness({ agentRunningRef: { current: true } });
  await assert.rejects(busy.forkHistoryQuestion("question", draft), /history.busy/);
  assert.deepEqual(busy.events, []);
});

function sendHarness(overrides = {}) {
  const send = source.slice(source.indexOf("  const handleSend = useCallback"), source.indexOf("  const executeBash = useCallback"));
  const env = { useCallback: (callback) => callback, isNew: false, newSessionCwd: null, session: { id: "session" }, crypto: { randomUUID },
    t: (key) => key, userMessageKey: JSON.stringify, dispatch() {}, promoteNewSession() {}, addNotice() {}, closeEvents() {},
    ensureNewSession: async () => "session", ensureEventsConnected: async () => {}, waitForPromptSettlement() {},
    uploadPromptMaterialFiles: async () => [], AgentCommandError: class extends Error {}, EventStreamConnectionError: class extends Error {},
    savePendingPrompt: async (record) => { env.saved = structuredClone(record); }, sendAgentCommand: async () => {},
  };
  for (const name of new Set(send.match(/\b\w+Ref\b/g))) env[name] = { current: null };
  for (const name of new Set(send.match(/\bset[A-Z]\w+(?=\()/g))) env[name] = () => {};
  env.promptRunIdRef.current = 0;
  env.sessionIdRef.current = "session";
  env.promptSettlementByRunRef.current = new Map(); env.promptSettlementPollByRunRef.current = new Map();
  env.messages = [];
  env.setMessages = (update) => { env.messages = typeof update === "function" ? update(env.messages) : update; };
  Object.assign(env, overrides);
  const js = ts.transpileModule(send, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const run = new Function("env", `with(env) { ${js}; return handleSend; }`)(env);
  return { env, run };
}

test("actual send callback commits recovery before network and keeps input after stop during acknowledgement", async () => {
  let acknowledge;
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const { env, run } = sendHarness({ sendAgentCommand: async (_sid, command) => {
    assert.equal(command.idempotencyKey, env.saved.id);
    assert.equal(env.saved.draft.value, "long original\n".repeat(5000));
    requestStarted(); await new Promise((resolve) => { acknowledge = resolve; });
  } });
  const sending = run("long original\n".repeat(5000), [{ data: "YWJj", mimeType: "image/png" }], [{ name: "file", text: "full attachment", size: 15 }]);
  await started;
  env.cancelledPromptRunIdRef.current = env.promptRunIdRef.current;
  acknowledge();
  assert.equal(await sending, false, "composer must not clear after a late acknowledgement");
  assert.equal(env.messages.length, 1);
  assert.equal(env.saved.draft.files[0].text, "full attachment");
  assert.equal(env.saved.draft.images[0].data, "YWJj");
});

test("actual send callback never starts the network when its durable recovery commit fails", async () => {
  let requested = false;
  const { env, run } = sendHarness({ savePendingPrompt: async () => { throw new Error("quota exceeded"); }, sendAgentCommand: async () => { requested = true; } });
  assert.equal(await run("retain me"), false);
  assert.equal(requested, false);
  assert.equal(env.messages[0].content, "retain me");
  assert.equal(env.messages[0].sendError, "quota exceeded");
});

test("retry lineage is durable before the replacement prompt is admitted", async () => {
  let acknowledged;
  const { env, run } = sendHarness();
  assert.equal(await run("retry contents", undefined, undefined, id => { acknowledged = id; }, ["failed-send"]), true);
  assert.equal(acknowledged, env.saved.id);
  assert.deepEqual(env.saved.draft.retryOfPromptIds, ["failed-send"]);
  assert.notEqual(env.saved.id, "failed-send", "a retry remains a new idempotent send");
});

test("composer acknowledgement follows durable storage but precedes slow network setup", async () => {
  let commit, connect;
  let durable = false;
  const order = [];
  const { run } = sendHarness({
    savePendingPrompt: () => new Promise((resolve) => { commit = () => { order.push("stored"); resolve(); }; }),
    ensureEventsConnected: () => new Promise((resolve) => { order.push("connecting"); connect = resolve; }),
    sendAgentCommand: async () => { order.push("sent"); },
  });
  const sending = run("original", undefined, undefined, () => { durable = true; order.push("clear"); });
  assert.equal(durable, false);
  commit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(durable, true);
  assert.deepEqual(order, ["stored", "clear", "connecting"]);
  connect(); assert.equal(await sending, true);
});

test("closes the session event stream only after prompt settlement or a pre-prompt failure", () => {
  const finishSource = source.slice(
    source.indexOf("const finishPromptWithoutStream"),
    source.indexOf("const waitForPromptSettlement"),
  );
  const agentEndSource = source.slice(
    source.indexOf('case "agent_end"'),
    source.indexOf('case "prompt_done"'),
  );
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );

  assert.match(finishSource, /closeEvents\(\)/);
  assert.match(finishSource, /promptSettlementByRunRef\.current\.get\(runId\)/);
  assert.match(finishSource, /loadSession\(sid, false, true\)/);
  assert.doesNotMatch(agentEndSource, /closeEvents\(\)/);
  assert.doesNotMatch(agentEndSource, /loadSession\(/);
  assert.doesNotMatch(agentEndSource, /fetch\(/);
  assert.match(agentEndSource, /Keep the stream open until prompt_done/);
  assert.match(sendSource, /e instanceof AgentCommandError && e\.status >= 400 && e\.status < 500/);
  assert.match(sendSource, /if \(promptRequestStarted && sentSessionId && !definitivelyRejected\) \{[\s\S]*?waitForPromptSettlement/);
  assert.match(sendSource, /if \(promptRequestStarted && sentSessionId && !definitivelyRejected\) \{[\s\S]*?return false;[\s\S]*?\}[\s\S]*?closeEvents\(\)/);
});

test("cancels stale session loads when switching tasks", () => {
  const loadSource = source.slice(
    source.indexOf("  const loadSession = useCallback"),
    source.indexOf("  const loadContext = useCallback"),
  );

  assert.match(loadSource, /sessionLoadAbortRef\.current\?\.abort\(\)/);
  assert.match(loadSource, /signal: controller\.signal/);
  assert.match(loadSource, /if \(controller\.signal\.aborted\) return null/);
  assert.match(loadSource, /throw await sessionResponseError\(res\)/);
});

function sessionLoadHarness(overrides = {}) {
  const load = source.slice(source.indexOf("  const loadSession = useCallback"), source.indexOf("  const loadContext = useCallback"));
  const env = {
    useCallback: callback => callback, AbortController, URLSearchParams,
    sessionLoadAbortRef: { current: null }, sessionIdRef: { current: "session" }, promptRunIdRef: { current: 0 },
    translateRef: { current: key => key }, invalidatePrefetchedSession() {},
    setTimeout: callback => { env.expire = callback; return 1; }, clearTimeout() {},
    readPendingPrompts: async () => [], mergePendingPrompts: messages => ({ messages, entryIds: [], confirmedIds: [] }),
    confirmPendingPrompts: async () => {}, selectionFromSystemPromptBinding: () => null, systemPromptSelectionRef: { current: null },
  };
  for (const name of new Set(load.match(/\bset[A-Z]\w+(?=\()/g))) {
    if (!(name in env)) env[name] = value => { env[name + "Value"] = value; };
  }
  Object.assign(env, overrides);
  const js = ts.transpileModule(load, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const run = new Function("env", `with(env) { ${js}; return loadSession; }`)(env);
  return { env, run };
}

test("a stalled prefetch or recovery read releases session loading and reports a retryable timeout", async () => {
  const payload = { context: { messages: [], entryIds: [] }, leafId: null };
  for (const phase of ["prefetch", "recovery"]) {
    const never = new Promise(() => {});
    const { env, run } = sessionLoadHarness(phase === "recovery" ? { readPendingPrompts: () => never } : {});
    const pending = run("session", true, false, phase === "prefetch" ? never : Promise.resolve(payload));
    await Promise.resolve();
    env.expire();
    assert.equal(await pending, null);
    assert.equal(env.setLoadingValue, false);
    assert.equal(env.setErrorValue, "chat.loadSessionTimeout");
    assert.equal(env.sessionLoadAbortRef.current, null);
  }
});

test("a silent replacement load clears an initial spinner without showing a cancelled load error", async () => {
  const { env, run } = sessionLoadHarness();
  let release;
  const initial = run("session", true, false, new Promise(resolve => { release = resolve; }));
  const replacement = run("session", false, false, Promise.resolve({ context: { messages: [], entryIds: [] }, leafId: null }));
  await replacement;
  release(null);
  await Promise.all([initial, replacement]);
  assert.equal(env.setLoadingValue, false);
  assert.equal(env.setErrorValue, null);
});

test("settles the local stream as soon as the server accepts an abort", () => {
  const abortSource = source.slice(
    source.indexOf("  const handleAbort = useCallback"),
    source.indexOf("  const handleFork = useCallback"),
  );

  assert.match(abortSource, /const runId = promptRunIdRef\.current/);
  assert.match(abortSource, /setAgentPhase\(\{ kind: "stopping" \}\)/);
  assert.match(abortSource, /await sendAgentCommand(?:<[^>]+>)?\(sid, \{ type: "abort" \}, \{ timeoutMs: 10_000 \}\);[\s\S]*?void finishPromptWithoutStream\(sid, runId\)/);
  assert.match(abortSource, /addNotice\(\{ type: "error", message: t\("chat.stopFailed"/);
});

test("visible termination precedes a stalled history reload and is idempotent", async () => {
  const finishSource = source.slice(source.indexOf("const finishPromptWithoutStream"), source.indexOf("const waitForPromptSettlement"));
  // Execute the actual hook callback with isolated refs/setters (no DOM or model).
  const js = finishSource.replace("sid: string | null =", "sid =");
  const calls = [];
  let releaseHistory;
  const history = new Promise((resolve) => { releaseHistory = resolve; });
  const refs = {
    sessionIdRef: { current: "session" }, promptRunIdRef: { current: 1 },
    agentRunningRef: { current: true }, optimisticUserMessageKeyRef: { current: "user" },
    suppressCompletionNotificationRef: { current: true }, promptSettlementByRunRef: { current: new Map() },
  };
  const deps = {
    ...refs, useCallback: (callback) => callback,
    closeEvents: () => calls.push("close"),
    setAgentRunning: (value) => calls.push(["running", value]),
    setReplyHistorySettling: (value) => calls.push(["replySettling", value]),
    setAgentPhase: () => {}, setRetryInfo: () => {}, setIsCompacting: () => {},
    setExtensionDialog: () => {}, setExtensionCustomUi: () => {},
    dispatch: (action) => calls.push(action.type), onAgentEnd: () => calls.push("notify"),
    loadSession: () => { calls.push("history"); return history; },
  };
  const finish = new Function(...Object.keys(deps), `${js}; return finishPromptWithoutStream;`)(...Object.values(deps));
  const pending = finish("session", 1);
  assert.equal(refs.agentRunningRef.current, false);
  assert.ok(calls.indexOf("end") < calls.indexOf("history"));
  assert.ok(calls.some((call) => Array.isArray(call) && call[0] === "replySettling" && call[1] === true));
  assert.equal(calls.includes("notify"), false);
  assert.equal(finish("session", 1), pending);
  refs.promptRunIdRef.current = 2;
  refs.agentRunningRef.current = true;
  await finish("session", 1);
  assert.equal(refs.agentRunningRef.current, true, "a late old settlement must not stop the next run");
  releaseHistory();
  await pending;
  assert.equal(refs.agentRunningRef.current, true);
  assert.equal(calls.some((call) => Array.isArray(call) && call[0] === "replySettling" && call[1] === false), false, "old hydration must not enable suggestions for a newer run");
});

test("cancelled preparation and replaced SSE connections cannot restart a prompt", () => {
  const sendSource = source.slice(source.indexOf("const handleSend"), source.indexOf("const executeBash ="));
  assert.match(sendSource, /await uploadPromptMaterialFiles\(materialFiles\)[\s\S]*?if \(!isCurrentPrompt\(\)\) return/);
  assert.match(sendSource, /await ensureEventsConnected\(sid\);\s*if \(!isCurrentPrompt\(\)\) return/);
  assert.match(sendSource, /await ensureEventsConnected\(session.id\);\s*if \(!isCurrentPrompt\(\)\) return/);
  assert.match(source, /if \(eventSourceRef.current !== es\) return/);
  assert.match(source, /if \(cancelledPromptRunIdRef.current === promptRunIdRef.current\) return/);
});

test("keeps the first prompt as the new-session title and restores failed material drafts", () => {
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );
  assert.ok(sendSource.indexOf("promoteNewSession(0, displayMessage.slice(0, 2_000))") < sendSource.indexOf("await ensureEventsConnected(sid)"));
  assert.match(sendSource, /uploadPromptMaterialFiles\(materialFiles\)/);
  assert.match(sendSource, /await savePendingPrompt\(recovery\)/);
  assert.match(sendSource, /recoveryDraft/);
});

test("refreshes context usage during streaming and after assistant messages", () => {
  const reconcileSource = source.slice(
    source.indexOf("const reconcileAgentState"),
    source.indexOf("// Recovery net for missed SSE events"),
  );
  const messageUpdateSource = source.slice(
    source.indexOf('case "message_update"'),
    source.indexOf('case "message_end"'),
  );
  const messageEndSource = source.slice(
    source.indexOf('case "message_end"'),
    source.indexOf('case "tool_execution_start"'),
  );

  assert.ok(
    reconcileSource.indexOf("setContextUsage(state.contextUsage ?? null)")
      < reconcileSource.indexOf("if (busy || !agentRunningRef.current) return"),
  );
  assert.match(messageUpdateSource, /CONTEXT_USAGE_REFRESH_MS/);
  assert.match(messageUpdateSource, /refreshContextUsage\(sessionIdRef\.current\)/);
  assert.match(messageEndSource, /completed\?\.role === "assistant"[\s\S]*refreshContextUsage/);
});

test("browser tool execution does not force open the workspace panel", () => {
  const toolStartSource = source.slice(
    source.indexOf('case "tool_execution_start"'),
    source.indexOf('case "tool_execution_end"'),
  );

  assert.doesNotMatch(toolStartSource, /dispatchEvent|piora:show-browser/);
  assert.match(toolStartSource, /setAgentPhase/);
});

test("shows steering and follow-up messages in the composer tray immediately", () => {
  const steerSource = source.slice(
    source.indexOf("  const handleSteer = useCallback"),
    source.indexOf("  const handlePromptWithStreamingBehavior = useCallback"),
  );
  const promptSource = source.slice(
    source.indexOf("  const handlePromptWithStreamingBehavior = useCallback"),
    source.indexOf("  const handleFollowUp = useCallback"),
  );
  const followUpSource = source.slice(
    source.indexOf("  const handleFollowUp = useCallback"),
    source.indexOf("  const handleAbortCompaction = useCallback"),
  );

  assert.match(steerSource, /setQueuedMessages[\s\S]*appendQueuedMessage\(current, "steering", message\)[\s\S]*await sendAgentCommand/);
  assert.match(steerSource, /catch[\s\S]*removeLastQueuedMessage\(current, "steering", message\)/);
  assert.match(promptSource, /queueKind = behavior === "steer" \? "steering" : "followUp"/);
  assert.match(promptSource, /setQueuedMessages[\s\S]*appendQueuedMessage\(current, queueKind, message\)/);
  assert.match(followUpSource, /setQueuedMessages[\s\S]*appendQueuedMessage\(current, "followUp", message\)[\s\S]*await sendAgentCommand/);
});

test("waits for the session scroll container before consuming the initial bottom scroll", () => {
  const scrollEffectSource = source.slice(
    source.indexOf("// Loading may publish the message array"),
    source.indexOf("// Load model list"),
  );

  assert.match(scrollEffectSource, /if \(loading \|\| messages\.length === 0\) return/);
  assert.match(scrollEffectSource, /startInitialBottomPin\(\)/);
  assert.match(scrollEffectSource, /\[messages\.length, agentRunning, liveOutputAutoScrollEnabled, loading,/);
});

test("pins a newly selected session to the bottom while async content settles", () => {
  const pinSource = source.slice(
    source.indexOf("const startInitialBottomPin"),
    source.indexOf("const handleScrollToBottom"),
  );
  const userIntentSource = source.slice(
    source.indexOf("const markUserScrollIntent"),
    source.indexOf("const handleScrollPositionChange"),
  );

  assert.match(pinSource, /followChatBottom\(container, \(\) => scrollToBottom\("instant"\)\)/);
  const jumpSource = source.slice(source.indexOf("const handleScrollToBottom"), source.indexOf("const scrollUserMsgToTop"));
  assert.match(jumpSource, /startInitialBottomPin\(\)/);
  assert.match(userIntentSource, /stopInitialBottomPin\(\)/);
});

test("keeps live session output pinned to the newest content", () => {
  const livePinStart = source.lastIndexOf(
    "useLayoutEffect(() => {",
    source.indexOf("const pinLiveOutputToBottom"),
  );
  const livePinSource = source.slice(
    livePinStart,
    source.indexOf("// Loading may publish the message array"),
  );

  assert.match(livePinSource, /if \(!liveOutputAutoScrollEnabled \|\| \(!agentRunning && !bashRunning\) \|\| loading\) return/);
  assert.match(livePinSource, /scrollToBottom\("instant"\)/);
  assert.match(livePinSource, /if \(!liveOutputFollowRef\.current\) return/);
  assert.match(livePinSource, /new ResizeObserver\(schedulePin\)/);
  assert.match(livePinSource, /container\.addEventListener\("load", schedulePin, true\)/);
  assert.match(livePinSource, /pinLiveOutputToBottom\(\)[\s\S]*schedulePin\(\)/);
  assert.match(source, /completionScrollAllowedRef\.current && liveOutputAutoScrollEnabled/);
});

test("manual scrolling pauses live follow until jump-to-latest resumes it", () => {
  const scrollIntentSource = source.slice(
    source.indexOf("const markUserScrollIntent"),
    source.indexOf("// Load session on mount"),
  );
  const jumpSource = source.slice(
    source.indexOf("const handleScrollToBottom"),
    source.indexOf("const scrollUserMsgToTop"),
  );

  assert.match(scrollIntentSource, /event instanceof WheelEvent/);
  assert.match(scrollIntentSource, /target\?\.closest\("\.chat-column-scroll-rail"\)/);
  assert.match(scrollIntentSource, /liveOutputFollowRef\.current = false/);
  assert.match(scrollIntentSource, /setLiveOutputFollowPaused\(true\)/);
  assert.match(jumpSource, /liveOutputFollowRef\.current = true/);
  assert.match(jumpSource, /setLiveOutputFollowPaused\(false\)/);
  assert.match(source, /case "agent_start":[\s\S]*liveOutputFollowRef\.current = true;[\s\S]*setLiveOutputFollowPaused\(false\)/);
  assert.match(source, /window\.addEventListener\("pointerdown", markUserScrollIntent, \{ capture: true, passive: true \}\)/);
  assert.match(source, /window\.addEventListener\("wheel", markUserScrollIntent, \{ capture: true, passive: true \}\)/);
});

test("clamps the native chat scroller before it enters the live tail spacer", () => {
  const clampSource = source.slice(
    source.indexOf("const clampLiveTailScroll"),
    source.indexOf("const markUserScrollIntent"),
  );
  const positionChangeSource = source.slice(
    source.indexOf("const handleScrollPositionChange"),
    source.indexOf("// Load session on mount"),
  );

  assert.match(clampSource, /getLiveTailScrollLimit/);
  assert.match(clampSource, /pinnedScrollTop: liveTailPinnedScrollTopRef\.current/);
  assert.match(clampSource, /container\.scrollTop = maxScrollTop/);
  assert.match(positionChangeSource, /if \(clampLiveTailScroll\(\)\) return/);
});
