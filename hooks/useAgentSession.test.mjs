import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");

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
  assert.match(sendSource, /if \(promptRequestStarted && sentSessionId && !definitivelyRejected\) \{[\s\S]*?return;[\s\S]*?\}[\s\S]*?closeEvents\(\)/);
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

test("settles the local stream as soon as the server accepts an abort", () => {
  const abortSource = source.slice(
    source.indexOf("  const handleAbort = useCallback"),
    source.indexOf("  const handleFork = useCallback"),
  );

  assert.match(abortSource, /const runId = promptRunIdRef\.current/);
  assert.match(abortSource, /setAgentPhase\(\{ kind: "stopping" \}\)/);
  assert.match(abortSource, /await sendAgentCommand\(sid, \{ type: "abort" \}, \{ timeoutMs: 10_000 \}\);[\s\S]*?void finishPromptWithoutStream\(sid, runId\)/);
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
    setAgentPhase: () => {}, setRetryInfo: () => {}, setIsCompacting: () => {},
    setExtensionDialog: () => {}, setExtensionCustomUi: () => {},
    dispatch: (action) => calls.push(action.type), onAgentEnd: () => calls.push("notify"),
    loadSession: () => { calls.push("history"); return history; },
  };
  const finish = new Function(...Object.keys(deps), `${js}; return finishPromptWithoutStream;`)(...Object.values(deps));
  const pending = finish("session", 1);
  assert.equal(refs.agentRunningRef.current, false);
  assert.ok(calls.indexOf("end") < calls.indexOf("history"));
  assert.equal(calls.includes("notify"), false);
  assert.equal(finish("session", 1), pending);
  refs.promptRunIdRef.current = 2;
  refs.agentRunningRef.current = true;
  await finish("session", 1);
  assert.equal(refs.agentRunningRef.current, true, "a late old settlement must not stop the next run");
  releaseHistory();
  await pending;
  assert.equal(refs.agentRunningRef.current, true);
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
  assert.match(sendSource, /restoreFailedPrompt\(message, files, images\)/);
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

  assert.match(pinSource, /new ResizeObserver\(schedulePin\)/);
  assert.match(pinSource, /container\.addEventListener\("load", schedulePin, true\)/);
  assert.match(pinSource, /pinToBottom\(\)[\s\S]*schedulePin\(\)/);
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

  assert.match(livePinSource, /if \(!liveOutputAutoScrollEnabled \|\| !agentRunning \|\| loading\) return/);
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
