import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";

const { NestedToolCallsStore } = await createJiti(import.meta.url).import("../lib/nested-tool-calls.ts");
const { buildLocalFilePrompt } = await createJiti(import.meta.url).import("../lib/file-attachments.ts");
const { normalizeToolCalls } = await createJiti(import.meta.url).import("../lib/normalize.ts");
const { replaceFailedPromptMessage } = await createJiti(import.meta.url).import("../lib/prompt-recovery.ts");
const { persistentChatInputOptions } = await createJiti(import.meta.url).import("../lib/chat-command-input.ts");

const source = (await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

function historyHarness(overrides = {}) {
  const callbacks = source.slice(source.indexOf("  const switchHistoryBranch = useCallback"), source.indexOf("  const handleModelChange = useCallback"));
  const events = [];
  const env = {
    flushPendingAnswerState: async () => {},
    answerOutputScope: 0, setAnswerOutputScope: update => { env.answerOutputScope = update(env.answerOutputScope); },
    nestedCallsStore: new NestedToolCallsStore(), statsRefreshSequence: { current: 0 },
    editedBranchRef: { current: null }, activeLeafId: null, data: null, entryIds: [],
    useCallback: callback => callback, sessionIdRef: { current: "session" }, agentRunningRef: { current: false }, bashRunningRef: { current: false }, isCompacting: false,
    t: key => key, sendAgentCommand: async (_id, command) => { events.push(command.type); return command.type === "fork" ? { newSessionId: "new-session" } : {}; },
    loadContext: async () => { events.push("context"); return true; }, setActiveLeafId: id => events.push(`leaf:${id}`),
    setDraft: (id, draft) => events.push({ id, draft }), onSessionForked: id => events.push(`open:${id}`), ...overrides,
  };
  const js = ts.transpileModule(callbacks, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return { ...new Function("env", `with(env) { ${js}; return { switchHistoryBranch, forkHistoryQuestion }; }`)(env), events, env };
}

test("history switches only after success and preserves the preview on cancellation or load failure", async () => {
  const success = historyHarness();
  assert.equal(await success.switchHistoryBranch("leaf"), true);
  assert.deepEqual(success.events, ["navigate_tree", "context", "leaf:leaf"]);
  assert.equal(success.env.answerOutputScope, 1);
  const cancelled = historyHarness({ sendAgentCommand: async () => ({ cancelled: true }) });
  assert.equal(await cancelled.switchHistoryBranch("leaf"), false);
  assert.deepEqual(cancelled.events, []);
  assert.equal(cancelled.env.answerOutputScope, 0);
  const failed = historyHarness({ loadContext: async () => false });
  await assert.rejects(failed.switchHistoryBranch("leaf"), /history.loadError/);
  assert.deepEqual(failed.events, ["navigate_tree"]);
  assert.equal(failed.env.answerOutputScope, 0);
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

test("command catalog requests cannot overwrite a switched session or a newer catalog", async () => {
  const callbacks = source.slice(source.indexOf("  const loadSlashCommands = useCallback"), source.indexOf("  const closeEvents = useCallback"));
  const pending = [];
  const env = {
    editedBranchRef: { current: null }, activeLeafId: null, data: null, entryIds: [],
    useCallback: callback => callback, ensureNewSession: async () => "old", sessionIdRef: { current: "old" },
    commandCatalogLoadRef: { current: 0 }, commandCatalogRef: { current: null }, commandCatalogErrorRef: { current: null },
    setSlashCommands(value) { env.commands = value; }, setCommandCatalog(value) { env.catalog = value; },
    setSlashCommandsError(value) { env.error = value; }, setSlashCommandsLoading(value) { env.loading = value; },
    sendAgentCommand: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  };
  const js = ts.transpileModule(callbacks, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const load = new Function("env", `with(env) { ${js}; return loadSlashCommands; }`)(env);
  const old = load();
  env.sessionIdRef.current = "new";
  const fresh = load();
  pending[1].resolve({ commands: [{ name: "new-command" }], catalog: { revision: "new" } });
  await fresh;
  pending[0].resolve({ commands: [{ name: "old-command" }], catalog: { revision: "old" } });
  await old;
  assert.equal(env.catalog.revision, "new");
  assert.deepEqual(env.commands, [{ name: "new-command" }]);
  const staleFailure = load();
  const newest = load();
  pending[3].resolve({ commands: [], catalog: { revision: "newest" } });
  await newest;
  pending[2].reject(new Error("old request failed"));
  await staleFailure;
  assert.equal(env.catalog.revision, "newest");
  assert.equal(env.error, null);
  assert.equal(env.loading, false);
});

function sendHarness(overrides = {}) {
  const send = source.slice(source.indexOf("  const handleSend = useCallback"), source.indexOf("  const executeBash = useCallback"));
  const env = {
    flushPendingAnswerState: async () => {},
    nestedCallsStore: new NestedToolCallsStore(), statsRefreshSequence: { current: 0 }, buildLocalFilePrompt, useCallback: (callback) => callback, isNew: false, newSessionCwd: null, session: { id: "session" }, crypto: { randomUUID },
    t: (key) => key, userMessageKey: JSON.stringify, dispatch() {}, promoteNewSession() {}, addNotice() {}, closeEvents() {},
    ensureNewSession: async () => "session", ensureEventsConnected: async () => {}, waitForPromptSettlement() {},
    uploadPromptMaterialFiles: async () => [], AgentCommandError: class extends Error {}, EventStreamConnectionError: class extends Error {},
    savePendingPrompt: async (record) => { env.saved = structuredClone(record); }, sendAgentCommand: async () => {},
    submitChatCommand: async () => { throw new Error("Unexpected command submission in ordinary prompt test"); },
    persistentChatInputOptions, replaceFailedPromptMessage,
  };
  for (const name of new Set(send.match(/\b\w+Ref\b/g))) env[name] = { current: null };
  for (const name of new Set(send.match(/\bset[A-Z]\w+(?=\()/g))) env[name] = () => {};
  env.promptRunIdRef.current = 0;
  env.sessionIdRef.current = "session";
  env.promptSettlementByRunRef.current = new Map(); env.promptSettlementPollByRunRef.current = new Map();
  env.entryIds = [];
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

test("follow-up saves answer controls after durable recovery and before model submission", async () => {
  const events = [];
  const h = sendHarness({
    savePendingPrompt: async record => { h.env.saved = record; events.push("recovery"); },
    flushPendingAnswerState: async sid => { assert.equal(sid, "session"); events.push("controls"); },
    sendAgentCommand: async () => { events.push("prompt"); },
  });
  assert.equal(await h.run("Explain my new settings"), true);
  assert.deepEqual(events, ["recovery", "controls", "prompt"]);
  let requested = false;
  const failed = sendHarness({ flushPendingAnswerState: async () => { throw new Error("Control save failed"); }, sendAgentCommand: async () => { requested = true; } });
  assert.equal(await failed.run("Keep this follow-up"), false);
  assert.equal(requested, false);
  assert.equal(failed.env.saved.draft.value, "Keep this follow-up");
  assert.equal(failed.env.messages[0].sendError, "Control save failed");
});

test("slash submissions delegate durability and save admission to the command hook without an outer preflight", async () => {
  let received;
  let acknowledgements = 0;
  const onDurable = () => { acknowledgements++; };
  const images = [{ data: "YWJj", mimeType: "image/png" }];
  const files = [{ name: "context.txt", text: "full context", size: 12 }];
  const h = sendHarness({
    flushPendingAnswerState: async () => assert.fail("the command hook must persist original input before waiting for answer saves"),
    submitChatCommand: async (...args) => { received = args; args[3]("durable-id"); return true; },
  });
  assert.equal(await h.run("/review context", images, files, onDurable, ["failed-original"], { delivery: "followUp" }), true);
  assert.deepEqual(received, ["/review context", images, files, onDurable, { delivery: "followUp" }, ["failed-original"]]);
  assert.equal(acknowledgements, 1);
});

test("failed control saves preserve the current branch and block a fork", async () => {
  for (const operation of ["switchHistoryBranch", "forkHistoryQuestion"]) {
    const h = historyHarness({ flushPendingAnswerState: async () => { throw new Error("Control save failed"); } });
    await assert.rejects(h[operation]("leaf", { value: "question" }), /Control save failed/);
    assert.deepEqual(h.events, []);
  }
});

test("resumed queue text uses durable prompt submission without reinterpreting a leading bang as a shell command", async () => {
  const commands = [];
  const { env, run } = sendHarness({ sendAgentCommand: async (_sid, command) => { commands.push(command); } });
  assert.equal(await run("!This is guidance, not a shell command", undefined, undefined, undefined, undefined, undefined, "queue-handoff"), true);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, "prompt");
  assert.equal(commands[0].idempotencyKey, env.saved.id);
  assert.equal(env.saved.id, "queue-handoff", "a retried handoff uses the same durable submission identity");
  assert.equal(env.saved.draft.value, commands[0].message);
});

test("literal slash handoffs keep one identity and retries do not retain that identity", async () => {
  const commands = [];
  const { env, run } = sendHarness({ sendAgentCommand: async (_sid, command) => { commands.push(command); } });
  assert.equal(await run("/reload", undefined, undefined, undefined, undefined, { inputMode: "text", submissionId: "landing-id" }), true);
  assert.equal(env.saved.id, "landing-id");
  assert.deepEqual(env.saved.draft.commandInput, { inputMode: "text" });
  assert.equal(commands[0].type, "submit_input");
  assert.equal(commands[0].inputMode, "text");
});

test("resumed SDK slash guidance stays literal rather than becoming a fresh command", async () => {
  const commands = [];
  const { env, run } = sendHarness({ sendAgentCommand: async (_sid, command) => { commands.push(command); } });
  assert.equal(await run("/reload", undefined, undefined, undefined, undefined, undefined, "queue-slash-id"), true);
  assert.equal(env.saved.id, "queue-slash-id");
  assert.equal(commands[0].type, "submit_input");
  assert.equal(commands[0].inputMode, "text");
});

function abortHarness(overrides = {}) {
  const handler = source.slice(source.indexOf("  const handleAbort = useCallback"), source.indexOf("  const handleDeleteMessage = useCallback"));
  const calls = [];
  const env = {
    nestedCallsStore: new NestedToolCallsStore(), statsRefreshSequence: { current: 0 },
    editedBranchRef: { current: null }, activeLeafId: null, data: null, entryIds: [],
    useCallback: callback => callback, t: key => key, addNotice: notice => calls.push(notice), crypto: { randomUUID },
    normalizeQueuedMessages: queue => ({ steering: queue?.steering ?? [], followUp: queue?.followUp ?? [] }),
    sendAgentCommand: async () => ({ queuedMessages: { id: "queue-handoff", steering: ["correct this", "correct this"], followUp: ["then verify"] } }),
    opts: { chatInputRef: { current: { prependText: (text, ids) => calls.push(["restore", text, ids]) } } },
    getDraft: () => ({ value: "new draft", images: [], files: [{ name: "keep.txt", text: "attachment", size: 10 }] }),
    setDraft: (sid, draft) => calls.push(["draft", sid, draft]),
    finishPromptWithoutStream: () => { calls.push("finish"); env.agentRunningRef.current = false; return new Promise(() => {}); },
    handleSend: async (text, ...args) => { assert.equal(env.agentRunningRef.current, false); calls.push(["send", text, args.at(-1)]); env.promptRunIdRef.current += 1; return true; },
  };
  for (const name of new Set(handler.match(/\b\w+Ref\b/g))) {
    if (name !== "chatInputRef") env[name] = { current: null };
  }
  for (const name of new Set(handler.match(/\bset[A-Z]\w+(?=\()/g))) {
    if (!(name in env)) env[name] = () => {};
  }
  env.sessionIdRef.current = "session";
  env.promptRunIdRef.current = 1;
  env.agentRunningRef.current = true;
  Object.assign(env, overrides);
  const js = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return { env, calls, run: new Function("env", `with(env){${js};return handleAbort;}`)(env) };
}

test("stop never resubmits queued input or changes drafts, including repeated stops and session switches", async () => {
  const stopped = abortHarness();
  await stopped.run();
  assert.deepEqual(stopped.calls, ["finish"]);
  stopped.env.agentRunningRef.current = true;
  await stopped.run();
  assert.deepEqual(stopped.calls, ["finish", "finish"]);
  const delivered = abortHarness({ sendAgentCommand: async () => ({ accepted: true }) });
  await delivered.run();
  assert.deepEqual(delivered.calls, ["finish"]);
  let reply;
  let stops = 0;
  const pending = abortHarness({ sendAgentCommand: async () => { stops++; return new Promise(resolve => { reply = resolve; }); } });
  const stopping = pending.run();
  await pending.run();
  assert.equal(stops, 1);
  pending.env.sessionIdRef.current = "other-session";
  pending.env.promptRunIdRef.current++;
  reply({ queuedMessages: { id: "queue-once", steering: ["same", "same"] } });
  await stopping;
  assert.deepEqual(pending.calls, [], "late stop replies cannot edit either session's composer or start a run");
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

function promptSettlementHarness() {
  const commandGuard = source.indexOf("  const isPromptCommandSettled = useCallback");
  const settlement = source.slice(commandGuard < 0 ? source.indexOf("  const finishPromptWithoutStream = useCallback") : commandGuard, source.indexOf("  const waitForBashSettlement = useCallback"));
  const reconciliation = source.slice(source.indexOf("  const reconcileAgentState = useCallback"), source.indexOf("  // Recovery net for missed SSE events"));
  const callbacks = `${settlement}\n${reconciliation}`;
  const calls = [], delays = [];
  let now = 0;
  const env = {
    nestedCallsStore: new NestedToolCallsStore(), statsRefreshSequence: { current: 0 },
    editedBranchRef: { current: null }, activeLeafId: null, data: null, entryIds: [],
    useCallback: callback => callback, AbortController, AbortSignal, Date: { now: () => now },
    PROMPT_SETTLE_INITIAL_DELAY_MS: 800, PROMPT_SETTLE_POLL_MS: 600, PROMPT_SETTLE_MAX_MS: 20000,
    delay: ms => new Promise(resolve => delays.push({ ms, resolve })),
    closeEvents: () => calls.push(["close"]), loadSession: async sid => calls.push(["load", sid]),
    dispatch() {}, restoreStatusClock() {}, selectionFromSystemPromptBinding: () => null,
    acceptToolPermission: permission => calls.push(["permission", permission]),
    normalizeQueuedMessages: queue => ({ steering: queue?.steering ?? [], followUp: queue?.followUp ?? [] }),
    onAgentEnd() {}, response: { running: true, state: { runtime: "running", isStreaming: false, isPromptRunning: false, isCompacting: false } },
  };
  for (const name of new Set(callbacks.match(/\b\w+Ref\b/g))) env[name] = { current: null };
  for (const name of new Set(callbacks.match(/\bset[A-Z]\w+(?=\()/g))) env[name] = () => {};
  env.sessionIdRef.current = "session-a"; env.promptRunIdRef.current = 1; env.agentRunningRef.current = true;
  env.phaseEventRevisionRef.current = 0; env.suppressCompletionNotificationRef.current = true;
  env.promptSettlementByRunRef.current = new Map(); env.promptSettlementPollByRunRef.current = new Map();
  env.fetch = async () => ({ ok: true, json: async () => env.response });
  const js = ts.transpileModule(callbacks, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const actual = new Function("env", `with(env) { ${js}; return { reconcileAgentState, waitForPromptSettlement, finishPromptWithoutStream }; }`)(env);
  return { env, calls, ...actual, advanceDelay: async () => {
    assert.ok(delays.length, "the actual settlement callback must request its next delay");
    const next = delays.shift(); now += next.ms; next.resolve();
    await new Promise(resolve => setImmediate(resolve));
  } };
}

test("reconciliation keeps SSE open while server runtime is running after the model ends, then closes once at idle", async () => {
  const h = promptSettlementHarness();
  await h.reconcileAgentState("session-a");
  assert.deepEqual(h.calls, [], "server prompt cleanup is still running even though all model flags are false");
  assert.equal(h.env.agentRunningRef.current, true);
  h.env.response.state.runtime = "idle";
  await h.reconcileAgentState("session-a");
  assert.deepEqual(h.calls, [["close"], ["load", "session-a"]]);
  await h.reconcileAgentState("session-a");
  assert.equal(h.calls.length, 2, "the same idle run must settle only once");
});

test("prompt settlement polling keeps SSE open while server runtime is running after the model ends", async () => {
  const h = promptSettlementHarness();
  const pending = h.waitForPromptSettlement("session-a");
  await h.advanceDelay();
  assert.deepEqual(h.calls, [], "prompt_done polling cannot close a still-running server cleanup");
  assert.equal(h.env.agentRunningRef.current, true);
  h.env.response.state.runtime = "idle";
  await h.advanceDelay(); await pending;
  assert.deepEqual(h.calls, [["close"], ["load", "session-a"]]);
  assert.equal(h.env.promptSettlementPollByRunRef.current.size, 0);
});

test("old reconciliation responses cannot close a new prompt run", async () => {
  const h = promptSettlementHarness();
  let respond;
  h.env.fetch = () => new Promise(resolve => { respond = resolve; });
  const old = h.reconcileAgentState("session-a");
  h.env.promptRunIdRef.current = 2;
  respond({ ok: true, json: async () => ({ running: true, state: { runtime: "idle" } }) });
  await old;
  assert.deepEqual(h.calls, []); assert.equal(h.env.agentRunningRef.current, true);
  h.env.fetch = async () => ({ ok: true, json: async () => ({ running: true, state: { runtime: "idle" } }) });
  await h.reconcileAgentState("session-a");
  assert.deepEqual(h.calls, [["close"], ["load", "session-a"]]);
});

test("old prompt settlement responses cannot close a new prompt run", async () => {
  const h = promptSettlementHarness();
  let respond;
  h.env.fetch = () => new Promise(resolve => { respond = resolve; });
  const old = h.waitForPromptSettlement("session-a");
  await h.advanceDelay();
  h.env.promptRunIdRef.current = 2;
  respond({ ok: true, json: async () => ({ running: true, state: { runtime: "idle" } }) });
  await old;
  assert.deepEqual(h.calls, []); assert.equal(h.env.agentRunningRef.current, true);
  assert.equal(h.env.promptSettlementPollByRunRef.current.size, 0);
});

function sessionMountHarness(response) {
  const h = promptSettlementHarness();
  const mount = source.slice(source.indexOf("  // Load session on mount"), source.indexOf("  useEffect(() => {\n    const sid = sessionIdRef.current;", source.indexOf("  // Load session on mount")));
  for (const name of new Set(mount.match(/\b\w+Ref\b/g))) {
    if (!(name in h.env)) h.env[name] = { current: null };
  }
  for (const name of new Set(mount.match(/\bset[A-Z]\w+(?=\()/g))) {
    if (!(name in h.env)) h.env[name] = () => {};
  }
  h.env.agentRunningRef.current = false;
  Object.assign(h.env, {
    session: { id: "session-a" }, initialSessionData: null, response,
    useEffect: callback => { h.cleanup = callback(); }, takePrefetchedSession: () => null,
    invalidatePrefetchedSession() {}, connectEvents: async sid => h.calls.push(["connect", sid]),
    loadSession: async sid => { h.calls.push(["load", sid]); return h.env.response; },
  });
  const js = ts.transpileModule(mount, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  new Function("env", `with(env) { ${js}; }`)(h.env);
  return h;
}

test("mount recovery reconnects SSE during server runtime cleanup and settles the same run only at idle", async () => {
  const h = sessionMountHarness({ running: true, state: { runtime: "running", isStreaming: false, isPromptRunning: false, isCompacting: false } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.env.agentRunningRef.current, true, "a refresh during prompt cleanup must restore the running span");
  assert.deepEqual(h.calls, [["load", "session-a"], ["connect", "session-a"]]);
  await h.reconcileAgentState("session-a");
  assert.equal(h.calls.length, 2, "the restored stream stays open until server cleanup completes");
  h.env.response.state.runtime = "idle";
  await h.reconcileAgentState("session-a");
  assert.deepEqual(h.calls, [["load", "session-a"], ["connect", "session-a"], ["close"], ["load", "session-a"]]);
  await h.reconcileAgentState("session-a");
  assert.equal(h.calls.length, 4, "the restored run settles only once");
});

test("mount recovery does not reconnect an idle server runtime", async () => {
  const h = sessionMountHarness({ running: true, state: { runtime: "idle", isStreaming: false, isPromptRunning: false, isCompacting: false } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.env.agentRunningRef.current, false);
  assert.deepEqual(h.calls, [["load", "session-a"]]);
});

function promptSubmissionHarness(overrides = {}) {
  const h = promptSettlementHarness();
  for (const extra of [sendHarness().env, abortHarness().env]) {
    for (const [name, value] of Object.entries(extra)) if (!(name in h.env)) h.env[name] = value;
  }
  const reviewCallback = source.slice(source.indexOf("  const acceptToolReviews = useCallback"), source.indexOf("  useEffect(() => {", source.indexOf("  const acceptToolReviews = useCallback")));
  const callbacks = reviewCallback + source.slice(source.indexOf("  const handleAgentEvent = useCallback"), source.indexOf("  handleAgentEventRef.current = handleAgentEvent;"))
    + source.slice(source.indexOf("  const handleSend = useCallback"), source.indexOf("  const executeBash = useCallback"))
    + source.slice(source.indexOf("  const handleAbort = useCallback"), source.indexOf("  const handleDeleteMessage = useCallback"));
  for (const name of new Set(callbacks.match(/\b\w+Ref\b/g))) if (!(name in h.env)) h.env[name] = { current: null };
  for (const name of new Set(callbacks.match(/\bset[A-Z]\w+(?=\()/g))) if (!(name in h.env)) h.env[name] = () => {};
  h.env.agentRunningRef.current = false; h.env.promptRunIdRef.current = 0; h.env.session = { id: "session-a" };
  Object.assign(h.env, {
    finishPromptWithoutStream: h.finishPromptWithoutStream, waitForPromptSettlement: h.waitForPromptSettlement,
    savePendingPrompt: async record => { h.env.saved = structuredClone(record); },
    setMessages: update => { h.env.messages = typeof update === "function" ? update(h.env.messages) : update; },
    reviews: [], setToolReviews: update => { h.env.reviews = typeof update === "function" ? update(h.env.reviews) : update; },
    reduceAgentPhase: (_phase, event) => ({ kind: event.type }), isRunProgressEvent: () => true,
    handleExtensionUiRequest() {}, refreshContextUsage() {},
    normalizeToolCalls,
    sendAgentCommand: async () => ({ accepted: true, sessionId: "session-a", commandId: "cmd-current", status: "queued" }),
    response: { running: true, state: { runtime: "idle", isStreaming: false, isPromptRunning: false, isCompacting: false }, promptCommand: { commandId: "cmd-current", status: "queued" } },
    ...overrides,
  });
  const js = ts.transpileModule(callbacks, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return { ...h, ...new Function("env", `with(env) { ${js}; return { handleSend, handleAbort, handleAgentEvent }; }`)(h.env) };
}

test("review events settle after cancellation without reviving streaming and reject old or other-session snapshots", () => {
  const h = promptSubmissionHarness();
  h.env.cancelledPromptRunIdRef.current = h.env.promptRunIdRef.current;
  const review = { id: "review", sessionId: "session-a", status: "reviewing", startedAt: 1, updatedAt: 1 };
  h.handleAgentEvent({ type: "tool_review", review });
  h.handleAgentEvent({ type: "tool_review", review: { ...review, status: "cancelled", updatedAt: 2 } });
  h.handleAgentEvent({ type: "tool_review", review });
  h.handleAgentEvent({ type: "tool_review", review: { ...review, sessionId: "other", updatedAt: 3 } });
  assert.equal(h.env.reviews.length, 1);
  assert.equal(h.env.reviews[0].status, "cancelled");
  assert.equal(h.env.agentRunningRef.current, false);
});

test("actual send keeps SSE open through a delayed prompt POST in both existing and new sessions", async () => {
  for (const isNew of [false, true]) {
    let acknowledge;
    const h = promptSubmissionHarness({ isNew, newSessionCwd: isNew ? "workspace" : null,
      sendAgentCommand: () => new Promise(resolve => { acknowledge = resolve; }) });
    const sending = h.handleSend("prepare the session");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof acknowledge, "function", "the real send callback must reach the prompt POST");
    await h.reconcileAgentState("session-a"); await h.reconcileAgentState("session-a");
    assert.deepEqual(h.calls, [], "idle before POST acknowledgement must not close or hydrate the stream");
    const polling = h.waitForPromptSettlement("session-a");
    await h.advanceDelay();
    assert.deepEqual(h.calls, [], "terminal polling must also wait for the in-flight POST");
    acknowledge({ accepted: true, sessionId: "session-a", commandId: "cmd-current", status: "queued" });
    assert.equal(await sending, true);
    h.env.response.promptCommand.status = "completed";
    await h.advanceDelay(); await polling;
    await h.reconcileAgentState("session-a");
    assert.deepEqual(h.calls, [["close"], ["load", "session-a"]]);
  }
});

test("actual accepted prompt stays open through every nonterminal command state and missing receipts", async () => {
  const h = promptSubmissionHarness();
  assert.equal(await h.handleSend("prepare the session"), true);
  const urls = [];
  h.env.fetch = async url => {
    urls.push(url);
    return { ok: true, json: async () => h.env.response };
  };
  for (const status of ["accepted", "queued", "dispatching", "delivered", "running"]) {
    h.env.response.promptCommand = { commandId: "cmd-current", status };
    await h.reconcileAgentState("session-a");
    assert.deepEqual(h.calls, [], `${status} must not settle an idle wrapper before this command finishes`);
  }
  for (const promptCommand of [null, undefined, { commandId: "cmd-other", status: "completed" }]) {
    h.env.response.promptCommand = promptCommand;
    await h.reconcileAgentState("session-a"); assert.deepEqual(h.calls, []);
  }
  h.handleAgentEvent({ type: "prompt_started", commandId: "cmd-current", runId: "server-run" });
  h.handleAgentEvent({ type: "agent_start" });
  h.env.response.state.runtime = "running";
  h.env.response.promptCommand = { commandId: "cmd-current", status: "completed" };
  await h.reconcileAgentState("session-a"); assert.deepEqual(h.calls, [], "command completion still requires server idle");
  h.env.response.state.runtime = "idle";
  await h.reconcileAgentState("session-a"); await h.reconcileAgentState("session-a");
  assert.deepEqual(h.calls, [["close"], ["load", "session-a"]]);
  assert.ok(urls.every(url => url === "/api/agent/session-a?promptCommandId=cmd-current"));
});

test("actual settlement polling waits for the exact accepted command to become terminal", async () => {
  const h = promptSubmissionHarness();
  await h.handleSend("prepare the session");
  const urls = [];
  h.env.fetch = async url => { urls.push(url); return { ok: true, json: async () => h.env.response }; };
  const polling = h.waitForPromptSettlement("session-a");
  await h.advanceDelay(); assert.deepEqual(h.calls, []);
  h.env.response.promptCommand = null;
  await h.advanceDelay(); assert.deepEqual(h.calls, []);
  h.env.response.promptCommand = { commandId: "cmd-current", status: "failed" };
  await h.advanceDelay(); await polling;
  assert.ok(urls.every(url => url === "/api/agent/session-a?promptCommandId=cmd-current"));
  assert.deepEqual(h.calls, [["close"], ["load", "session-a"]]);
});

test("every exact terminal command state settles an actual idle submission", async () => {
  for (const status of ["completed", "failed", "cancelled", "expired", "interrupted"]) {
    const h = promptSubmissionHarness();
    await h.handleSend("prepare the session");
    h.env.response.promptCommand.status = status;
    await h.reconcileAgentState("session-a");
    assert.deepEqual(h.calls, [["close"], ["load", "session-a"]], `${status} is terminal for this exact command`);
  }
});

test("old actual prompt POST acknowledgements cannot replace a newer run's command identity", async () => {
  let firstReply;
  let posts = 0;
  const h = promptSubmissionHarness({ sendAgentCommand: () => ++posts === 1
    ? new Promise(resolve => { firstReply = resolve; })
    : Promise.resolve({ accepted: true, sessionId: "session-a", commandId: "cmd-new", status: "queued" }) });
  const first = h.handleSend("first");
  await new Promise(resolve => setImmediate(resolve));
  h.env.agentRunningRef.current = false;
  assert.equal(await h.handleSend("second"), true);
  firstReply({ accepted: true, sessionId: "session-a", commandId: "cmd-old", status: "queued" });
  assert.equal(await first, false);
  const urls = [];
  h.env.fetch = async url => {
    urls.push(url);
    return { ok: true, json: async () => ({ running: true, state: { runtime: "idle" }, promptCommand: { commandId: "cmd-new", status: "queued" } }) };
  };
  await h.reconcileAgentState("session-a"); assert.deepEqual(h.calls, []);
  assert.deepEqual(urls, ["/api/agent/session-a?promptCommandId=cmd-new"]);
});

test("an old command GET cannot settle the next actual submission", async () => {
  const h = promptSubmissionHarness();
  await h.handleSend("first");
  let reply;
  h.env.fetch = () => new Promise(resolve => { reply = resolve; });
  const stale = h.reconcileAgentState("session-a");
  h.env.agentRunningRef.current = false;
  h.env.sendAgentCommand = async () => ({ accepted: true, sessionId: "session-a", commandId: "cmd-new", status: "queued" });
  await h.handleSend("second");
  reply({ ok: true, json: async () => ({ running: true, state: { runtime: "idle" }, promptCommand: { commandId: "cmd-current", status: "completed" } }) });
  await stale;
  assert.deepEqual(h.calls, []); assert.equal(h.env.agentRunningRef.current, true);
});

test("Stop during an actual prompt POST cancels its exact durable key rather than only cancelling preparation", async () => {
  let acknowledge;
  const commands = [];
  const h = promptSubmissionHarness({ sendAgentCommand: (_sid, command) => {
    commands.push(command);
    return command.type === "prompt" ? new Promise(resolve => { acknowledge = resolve; }) : Promise.resolve({ accepted: true });
  } });
  const sending = h.handleSend("prepare the session");
  await new Promise(resolve => setImmediate(resolve));
  await h.handleAbort();
  assert.equal(commands.length, 2);
  assert.equal(commands[0].type, "prompt");
  assert.deepEqual(commands[1], { type: "cancel_prompt_submission", idempotencyKey: h.env.saved.id });
  assert.deepEqual(h.calls, [["close"], ["load", "session-a"]]);
  acknowledge({ accepted: true, sessionId: "session-a", commandId: "cmd-current", status: "queued" });
  assert.equal(await sending, false);
});

test("tracked Stop never auto-submits the queued guidance or issues a second abort", async () => {
  const commands = [];
  const h = promptSubmissionHarness({ sendAgentCommand: async (_sid, command) => {
    commands.push(command);
    return command.type === "cancel_prompt_submission"
      ? { queuedMessages: { id: "queue-handoff", steering: ["continue safely"], followUp: [] } }
      : { accepted: true, sessionId: "session-a", commandId: commands.length === 1 ? "cmd-current" : "cmd-new", status: "queued" };
  } });
  await h.handleSend("original");
  const originalKey = h.env.saved.id;
  await h.handleAbort();
  assert.deepEqual(commands.map(command => command.type), ["prompt", "cancel_prompt_submission"]);
  assert.deepEqual(commands[1], { type: "cancel_prompt_submission", idempotencyKey: originalKey, promptCommandId: "cmd-current" });


});

test("actual ambiguous prompt failures retain idle recovery and definite 4xx failures close immediately", async () => {
  for (const status of [0, 409]) {
    const h = promptSubmissionHarness();
    h.env.sendAgentCommand = async () => { const error = new h.env.AgentCommandError("send failed"); error.status = status; throw error; };
    assert.equal(await h.handleSend("prepare the session"), false);
    if (status === 0) {
      assert.deepEqual(h.calls, [], "an ambiguous POST keeps the event stream alive");
      const polling = h.env.promptSettlementPollByRunRef.current.get(h.env.promptRunIdRef.current);
      assert.ok(polling);
      await h.advanceDelay(); await polling;
      assert.deepEqual(h.calls, [["close"], ["load", "session-a"]]);
    } else {
      assert.deepEqual(h.calls, [["close"]]);
      assert.equal(h.env.promptSettlementPollByRunRef.current.size, 0);
    }
  }
});

// Load the real router before the per-case admission/cancellation deadline.
// Cold TypeScript/SDK compilation is fixture setup, not prompt dispatch latency.
const routerJiti = createJiti(import.meta.url);
const [{ SessionMessageRouter }, { SessionControlStore }, { SessionCommandEventHub }, { dispatchChatInput }] = await Promise.all([
  routerJiti.import("../lib/session-message-router.ts"), routerJiti.import("../lib/session-control-store.ts"),
  routerJiti.import("../lib/session-command-events.ts"), routerJiti.import("../lib/chat-input-dispatch.ts"),
]);

async function routerSubmissionHarness() {
  const root = await mkdtemp(join(tmpdir(), "piora-hook-prompt-cancel-"));
  const sid = randomUUID();
  const listeners = new Set();
  let acknowledgeStart;
  const started = new Promise(resolve => { acknowledgeStart = resolve; });
  const session = {
    sessionId: sid, active: false, starts: [], aborts: [],
    isAlive: () => true, isRunning: () => session.active,
    getActivePromptRunId: () => session.runId,
    getTaskRuntimeSnapshot: () => ({ runtime: session.active ? "running" : "idle", pendingApproval: false, lastPromptFailed: false }),
    onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); }, onDestroy: () => () => {},
    emit: event => { for (const listener of listeners) listener(event); },
    startTrackedPrompt: async input => {
      session.active = true; session.runId = randomUUID(); session.starts.push(input);
      acknowledgeStart();
      session.emit({ type: "prompt_started", commandId: input.commandId, runId: session.runId });
      return { accepted: true, sessionId: sid, commandId: input.commandId, runId: session.runId };
    },
    send: async command => {
      session.aborts.push(command); session.active = false;
      session.emit({ type: "prompt_done", commandId: session.starts.at(-1)?.commandId, runId: session.runId, aborted: true });
      session.runId = undefined;
      return { accepted: true };
    },
    finish: () => {
      session.active = false;
      session.emit({ type: "prompt_done", commandId: session.starts.at(-1)?.commandId, runId: session.runId });
      session.runId = undefined;
    },
  };
  globalThis.__piSessions ??= new Map(); globalThis.__piSessions.set(sid, session);
  const store = new SessionControlStore({ root });
  const events = new SessionCommandEventHub(store);
  const router = new SessionMessageRouter({ store, events, resolver: async () => ({ session, realSessionId: sid, cwd: root }) });
  const previousRouter = globalThis.__pioraSessionMessageRouter;
  globalThis.__pioraSessionMessageRouter = router;
  const h = promptSubmissionHarness({ session: { id: sid } });
  h.env.sessionIdRef.current = sid;
  h.env.sendAgentCommand = async (_sid, command) => {
    assert.equal(_sid, sid);
    if (command.type === "prompt") return router.dispatchSessionMessage({ targetSessionId: sid, content: command.message, source: "ui", idempotencyKey: command.idempotencyKey });
    if (command.type === "submit_input") return dispatchChatInput(sid, command);
    assert.equal(command.type, "cancel_prompt_submission", "tracked cancellation must never fall through to generic abort");
    return router.cancelPromptSubmission({ targetSessionId: sid, idempotencyKey: command.idempotencyKey, ...(command.promptCommandId ? { promptCommandId: command.promptCommandId } : {}) });
  };
  return { ...h, sid, session, started, router, store, events, cleanup: async () => {
    globalThis.__pioraSessionMessageRouter = previousRouter;
    globalThis.__piSessions.delete(sid); globalThis.__piSessionInboxes?.delete(sid);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  } };
}

test("actual Stop intent prevents a late prompt POST from entering the real router while a new run proceeds", { timeout: 15_000 }, async () => {
  const h = await routerSubmissionHarness();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const send = h.env.sendAgentCommand;
  let firstKey;
  h.env.sendAgentCommand = async (sid, command) => {
    if (["prompt", "submit_input"].includes(command.type) && command.message === "first") { firstKey = command.idempotencyKey; await gate; }
    return send(sid, command);
  };
  try {
    const first = h.handleSend("first");
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(firstKey);
    await h.handleAbort();
    assert.equal(h.env.saved.id, firstKey, "a cancellation intent must not replace the original durable recovery record");
    assert.equal(await h.handleSend("second"), true);
    await h.started;
    assert.equal(h.session.starts.length, 1);
    const currentSubmission = h.env.promptSubmissionRef.current;
    release(); assert.equal(await first, false);
    assert.deepEqual(h.session.starts.map(input => input.message), ["second"], "cancelled late admission must never start a model or tool span");
    assert.equal(h.session.aborts.length, 0, "the old cancelled key cannot abort the new running command");
    assert.equal(h.env.promptSubmissionRef.current, currentSubmission);
    const cancelled = h.store.loadCommands(h.sid).find(command => command.idempotencyKey === firstKey);
    assert.equal(cancelled?.status, "cancelled");
    h.session.finish(); await h.router.resumeSession(h.sid);
  } finally { release(); if (h.session.active) h.session.finish(); await h.cleanup(); }
});

test("actual queued Stop removes only its exact real router command before idle drain", { timeout: 15_000 }, async () => {
  const h = await routerSubmissionHarness();
  h.session.active = true;
  try {
    assert.equal(await h.handleSend("queued"), true);
    const key = h.env.saved.id;
    await h.handleAbort();
    h.session.active = false; h.session.emit({ type: "session_idle" });
    await h.router.resumeSession(h.sid);
    assert.equal(h.session.starts.length, 0, "a cancelled queued command must not begin after the wrapper returns idle");
    assert.equal(h.session.aborts.length, 0, "queued cancellation must not abort an unrelated running span");
    assert.equal(h.store.loadCommands(h.sid).find(command => command.idempotencyKey === key)?.status, "cancelled");
  } finally { await h.cleanup(); }
});

test("actual Stop during the real router's dispatching await fences admission", { timeout: 15_000 }, async () => {
  const h = await routerSubmissionHarness();
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const dispatching = new Promise(resolve => { entered = resolve; });
  const publish = h.events.publish.bind(h.events);
  h.events.publish = async event => {
    if (event.type === "command_dispatching") { entered(); await gate; }
    return publish(event);
  };
  try {
    assert.equal(await h.handleSend("dispatching"), true);
    await dispatching;
    await h.handleAbort();
    release(); await h.router.resumeSession(h.sid);
    assert.equal(h.session.starts.length, 0, "cancelled canonical command state must win over an older local dispatching record");
    assert.equal(h.store.loadCommands(h.sid).find(command => command.idempotencyKey === h.env.saved.id)?.status, "cancelled");
  } finally { release(); await h.cleanup(); }
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
    nestedCallsStore: new NestedToolCallsStore(), statsRefreshSequence: { current: 0 },
    editedBranchRef: { current: null }, activeLeafId: null, data: null, entryIds: [],
    useCallback: callback => callback, AbortController, URLSearchParams,
    acceptToolPermission: value => { env.permission = value; },
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

test("normal hydration and stream settlement advance the leaf without invalidating answer controls", async () => {
  let scope = 12;
  const h = sessionLoadHarness({ setAnswerOutputScope: update => { scope = update(scope); } });
  for (const leafId of ["initial", "tool-result", "assistant-complete"]) {
    await h.run("session", false, false, Promise.resolve({ leafId, context: { messages: [], entryIds: [] } }));
    assert.equal(h.env.setActiveLeafIdValue, leafId);
    assert.equal(scope, 12, "ordinary leaf advances must preserve the mounted output and focus");
  }
});

test("successful persisted deletion invalidates answer state but local recovery removal and failure do not", async () => {
  const callback = source.slice(source.indexOf("  const handleDeleteMessage = useCallback"), source.indexOf("  const handleFork = useCallback"));
  const js = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const scenario of ["persisted", "recovery", "failed"]) {
    const message = { role: "user", content: "question", clientPromptId: "prompt-id" };
    const env = {
      useCallback: fn => fn, messageMutationRef: { current: false }, agentRunningRef: { current: false }, bashRunningRef: { current: false }, isCompacting: false,
      sessionIdRef: { current: "session" }, historyRevisionRef: { current: 0 }, sessionLoadAbortRef: { current: null },
      t: key => key, activeLeafId: null, messages: [message], entryIds: ["entry"],
      setDeletingMessage() {}, setMessages() {}, setEntryIds() {}, invalidatePrefetchedSession() {}, loadSession: async () => {}, loadContext: async () => true,
      setActiveLeafId() {}, confirmPendingPrompts: async () => {},
      fetch: async () => ({ ok: scenario !== "failed", status: 409, json: async () => ({ success: scenario !== "failed", deletedIds: ["entry"], error: "delete failed" }) }),
      answerOutputScope: 4, setAnswerOutputScope: update => { env.answerOutputScope = update(env.answerOutputScope); },
    };
    const remove = new Function("env", `with(env) { ${js}; return handleDeleteMessage; }`)(env);
    if (scenario === "failed") await assert.rejects(remove(message, "entry"), /delete failed/);
    else await remove(message, scenario === "persisted" ? "entry" : undefined);
    assert.equal(env.answerOutputScope, scenario === "persisted" ? 5 : 4);
    assert.equal(env.messageMutationRef.current, false);
  }
});

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

test("settles an untracked restored run only after the server accepts its ordinary abort", async () => {
  let acknowledge;
  const h = abortHarness({ sendAgentCommand: async (_sid, command) => {
    assert.equal(command.type, "abort");
    return new Promise(resolve => { acknowledge = resolve; });
  } });
  const stopping = h.run();
  assert.equal(typeof acknowledge, "function");
  assert.deepEqual(h.calls, [], "a restored run must stay visible until its real server stop is acknowledged");
  acknowledge({ accepted: true }); await stopping;
  assert.deepEqual(h.calls, ["finish"]);
  const failed = abortHarness({ sendAgentCommand: async () => { throw new Error("offline"); } });
  await failed.run();
  assert.deepEqual(failed.calls, [{ type: "error", message: "chat.stopFailed" }]);
  assert.equal(failed.env.agentRunningRef.current, true, "a rejected stop must not claim local settlement");
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
    nestedCallsStore: new NestedToolCallsStore(),
    ...refs, useCallback: (callback) => callback,
    closeEvents: () => calls.push("close"),
    setAgentRunning: (value) => calls.push(["running", value]),
    setReplyHistorySettling: (value) => calls.push(["replySettling", value]),
    setAgentPhase: () => {}, setRetryInfo: () => {}, setIsCompacting: () => {}, setCompactionStartedAt: () => {},
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

function compactionRecoveryHarness() {
  const end = "  }, [agentRunning, closeEvents, isCompacting, loadSession]);";
  const effect = source.slice(source.indexOf("  // A manual compaction"), source.indexOf(end) + end.length);
  let cleanup, poll;
  const calls = [];
  const listeners = new Map();
  const env = {
    nestedCallsStore: new NestedToolCallsStore(), statsRefreshSequence: { current: 0 },
    isCompacting: true, agentRunning: false,
    sessionIdRef: { current: "session-a" }, phaseEventRevisionRef: { current: 0 },
    agentRunningRef: { current: false }, bashRunningRef: { current: false }, manualCompactionPendingRef: { current: false },
    response: { state: { isCompacting: true, compactionStartedAt: 100_000 } },
    fetch: async () => ({ ok: true, json: async () => env.response }),
    useEffect: callback => { cleanup = callback(); },
    setCompactionStartedAt: value => calls.push(["startedAt", value]), setIsCompacting: value => calls.push(["active", value]),
    closeEvents: () => calls.push(["close"]), loadSession: async sid => calls.push(["load", sid]),
    AGENT_STATE_RECONCILE_MS: 2500, AbortSignal,
    window: {
      setInterval: callback => { poll = callback; return 1; }, clearInterval() {},
      addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name),
    },
    document: { visibilityState: "visible", addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) },
  };
  const js = ts.transpileModule(effect, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  new Function("env", `with(env) { ${js} }`)(env);
  return { env, calls, listeners, poll: () => poll(), cleanup: () => cleanup() };
}

test("manual compaction recovers its original clock and settles after a missed end event", async () => {
  const h = compactionRecoveryHarness();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls, [["startedAt", 100_000]]);
  h.env.response = { state: { isCompacting: false, compactionStartedAt: null } };
  h.env.manualCompactionPendingRef.current = true;
  h.poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1, "a command awaiting admission/response stays locked");
  h.env.manualCompactionPendingRef.current = false;
  h.listeners.get("online")();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.slice(1), [["active", false], ["startedAt", null], ["close"], ["load", "session-a"]]);
  h.cleanup();
  assert.equal(h.listeners.size, 0);
});

test("old compaction snapshots cannot overwrite newer events or a switched-away view", async () => {
  for (const boundary of ["event", "unmount", "session"]) {
    const h = compactionRecoveryHarness();
    await new Promise(resolve => setImmediate(resolve));
    let release;
    h.env.fetch = () => new Promise(resolve => { release = resolve; });
    h.poll();
    if (boundary === "event") h.env.phaseEventRevisionRef.current += 1;
    if (boundary === "session") h.env.sessionIdRef.current = "session-b";
    if (boundary === "unmount") h.cleanup();
    release({ ok: true, json: async () => ({ state: { isCompacting: false } }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(h.calls, [["startedAt", 100_000]], boundary);
    h.cleanup();
  }
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

function queueSubmissionHarness(overrides = {}) {
  const helpers = source.slice(source.indexOf("function appendQueuedMessage"), source.indexOf("type ExtensionUiDialogRequest"));
  const callbacks = source.slice(source.indexOf("  const handleSteer = useCallback"), source.indexOf("  const handleAbortCompaction = useCallback"));
  const env = {
    useCallback: callback => callback, sessionIdRef: { current: "session" }, createdSessionIdRef: { current: null }, promptRunIdRef: { current: 1 }, queueAdmissionRevisionRef: { current: 0 },
    queue: { steering: ["already queued"], followUp: ["already queued"] }, errors: [], requests: [],
    setQueuedMessages: update => { env.queue = update(env.queue); }, setError: error => env.errors.push(error),
    flushPendingAnswerState: async () => {},
    sendAgentCommand: async (id, command) => { env.requests.push({ id, command }); },
    console: { error() {} }, ...overrides,
  };
  const js = ts.transpileModule(helpers + callbacks, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return { ...new Function("env", `with(env) { ${js}; return { handleSteer, handleFollowUp, handlePromptWithStreamingBehavior }; }`)(env), env };
}

const queueSubmissionCases = [
  { name: "steer", kind: "steering", command: { type: "steer" }, invoke: (h, text, images) => h.handleSteer(text, images) },
  { name: "follow-up", kind: "followUp", command: { type: "follow_up" }, invoke: (h, text, images) => h.handleFollowUp(text, images) },
  ...["steer", "followUp"].map(behavior => ({ name: `prompt ${behavior}`, kind: behavior === "steer" ? "steering" : "followUp",
    command: { type: "prompt", streamingBehavior: behavior }, invoke: (h, text, images) => h.handlePromptWithStreamingBehavior(text, behavior, images) })),
];

test("all queue submissions wait for answer saves and preserve their command, image and success semantics", async () => {
  for (const entry of queueSubmissionCases) {
    let release;
    const h = queueSubmissionHarness({ flushPendingAnswerState: id => { assert.equal(id, "session"); return new Promise(resolve => { release = resolve; }); } });
    const images = [{ data: "YWJj", mimeType: "image/png" }];
    const pending = entry.invoke(h, "use edited parameters", images);
    assert.deepEqual(h.env.requests, [], entry.name);
    assert.deepEqual(h.env.queue[entry.kind], ["already queued", "use edited parameters"], "optimistic tray remains immediate");
    release();
    assert.equal(await pending, true, entry.name);
    assert.deepEqual(h.env.requests, [{ id: "session", command: { ...entry.command, message: "use edited parameters", images: [{ type: "image", ...images[0] }] } }]);
  }
});

test("queue save failures retain composer input and remove only their optimistic row", async () => {
  for (const entry of queueSubmissionCases) {
    const h = queueSubmissionHarness({ flushPendingAnswerState: async () => { throw new Error("Unable to save parameters"); } });
    assert.equal(await entry.invoke(h, "already queued"), false, `${entry.name} must not clear the composer`);
    assert.deepEqual(h.env.queue, { steering: ["already queued"], followUp: ["already queued"] });
    assert.deepEqual(h.env.errors, ["Unable to save parameters"]);
    assert.deepEqual(h.env.requests, []);
  }
});

test("switching chats while queue parameters save cannot send into the previous chat", async () => {
  for (const entry of queueSubmissionCases) {
    let release;
    const h = queueSubmissionHarness({ flushPendingAnswerState: () => new Promise(resolve => { release = resolve; }) });
    const pending = entry.invoke(h, "keep this draft");
    h.env.sessionIdRef.current = "other";
    h.env.queue = { steering: [], followUp: ["other chat"] };
    release();
    assert.equal(await pending, false, entry.name);
    assert.deepEqual(h.env.requests, []);
    assert.deepEqual(h.env.queue, { steering: [], followUp: ["other chat"] });
  }
});

test("stop, recall and a newer run cancel queue submissions still waiting for parameter saves", async () => {
  for (const action of ["stop", "recall", "new run"]) {
    for (const entry of queueSubmissionCases) {
      let release;
      const h = queueSubmissionHarness({ flushPendingAnswerState: () => new Promise(resolve => { release = resolve; }) });
      const pending = entry.invoke(h, "unsent draft");
      if (action === "stop") {
        const abort = abortHarness({ sessionIdRef: h.env.sessionIdRef, promptRunIdRef: h.env.promptRunIdRef, queueAdmissionRevisionRef: h.env.queueAdmissionRevisionRef,
          setQueuedMessages: value => { h.env.queue = value; } });
        await abort.run();
      } else if (action === "recall") {
        const callback = source.slice(source.indexOf("  const handleRecallQueue = useCallback"), source.indexOf("  const handleThinkingLevelChange = useCallback"));
        const js = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
        h.env.addNotice = () => {};
        await new Function("env", `with(env) { ${js}; return handleRecallQueue; }`)(h.env)();
      } else h.env.promptRunIdRef.current++;
      release();
      assert.equal(await pending, false, `${entry.name}: ${action} retains the composer`);
      assert.equal(h.env.requests.some(request => request.command.message === "unsent draft"), false);
      assert.equal(h.env.queue[entry.kind].includes("unsent draft"), false);
    }
  }
});

function pendingInputActionHarness(overrides = {}) {
  const callback = source.slice(source.indexOf("  const captureAnswerStateSubmissionGuard = useCallback"), source.indexOf("  const chatCommands = useChatCommandOperations"))
    + source.slice(source.indexOf("  const handlePendingInputAction = useCallback"), source.indexOf("  const handleRecallQueue = useCallback"));
  const js = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const pendingInputs = [{ id: "runtime-input", commandId: "existing-command", text: "already queued", kind: "steer" }];
  const h = queueSubmissionHarness({ queue: { steering: ["already queued"], followUp: [], pendingInputs }, ...overrides });
  return { ...h, ...new Function("env", `with(env) { ${js}; return { mutate: handlePendingInputAction, prepare: prepareAnswerStateForSubmission, capture: captureAnswerStateSubmissionGuard }; }`)(h.env) };
}

test("deleting one pending input stays available during answer saves without cancelling unrelated submissions", async () => {
  for (const entry of queueSubmissionCases) {
    let release;
    let saves = 0;
    const h = pendingInputActionHarness({ flushPendingAnswerState: () => { saves++; return new Promise(resolve => { release = resolve; }); } });
    const pendingInputs = h.env.queue.pendingInputs;
    const submitting = entry.invoke(h, "new input after edited parameters");
    await h.mutate("runtime-input", "delete");
    assert.deepEqual(h.env.requests, [{ id: "session", command: { type: "pending_input_action", inputId: "runtime-input", action: "delete" } }]);
    assert.equal(saves, 1, "deleting existing input cannot be blocked by optional answer saves");
    assert.equal(h.env.queueAdmissionRevisionRef.current, 0, "one input action must not cancel unrelated admission");
    assert.deepEqual(h.env.queue.pendingInputs, pendingInputs, "optimistic text does not invent or overwrite server identities");
    release();
    assert.equal(await submitting, true);
    assert.equal(h.env.requests[1].command.message, "new input after edited parameters");
  }
});

test("moving pending guidance to the next-turn queue waits for parameter saves before promotion", async () => {
  let release;
  const h = pendingInputActionHarness({ flushPendingAnswerState: () => new Promise(resolve => { release = resolve; }) });
  const promotion = h.mutate("runtime-input", "queue");
  assert.deepEqual(h.env.requests, []);
  release(); await promotion;
  assert.deepEqual(h.env.requests, [{ id: "session", command: { type: "pending_input_action", inputId: "runtime-input", action: "queue" } }]);
  assert.equal(h.env.queueAdmissionRevisionRef.current, 0);
});

test("queue promotion save and network failures preserve pending input identities for retry", async () => {
  for (const failure of ["save", "network"]) {
    const h = pendingInputActionHarness(failure === "save"
      ? { flushPendingAnswerState: async () => { throw new Error("Save unavailable"); } }
      : { sendAgentCommand: async () => { throw new Error("Queue archive unavailable"); } });
    const original = structuredClone(h.env.queue);
    await assert.rejects(h.mutate("runtime-input", "queue"), failure === "save" ? /Save unavailable/ : /Queue archive unavailable/);
    assert.deepEqual(h.env.queue, original);
    assert.equal(h.env.queueAdmissionRevisionRef.current, 0);
    assert.deepEqual(h.env.requests, []);
  }
});

test("the shared queue save guard rejects stale targets and cancels on stop, recall, session or run changes", async () => {
  const stale = pendingInputActionHarness({ flushPendingAnswerState: async () => assert.fail("stale target must not save another session") });
  assert.equal(await stale.prepare("other-session"), false);
  for (const action of ["stop", "recall", "session", "new run"]) {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = pendingInputActionHarness({ flushPendingAnswerState: () => gate });
    const prepared = h.prepare("session");
    const promotion = h.mutate("runtime-input", "queue");
    if (action === "stop") {
      await abortHarness({ sessionIdRef: h.env.sessionIdRef, promptRunIdRef: h.env.promptRunIdRef, queueAdmissionRevisionRef: h.env.queueAdmissionRevisionRef }).run();
    } else if (action === "recall") {
      const callback = source.slice(source.indexOf("  const handleRecallQueue = useCallback"), source.indexOf("  const handleThinkingLevelChange = useCallback"));
      const js = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      h.env.addNotice = () => {};
      await new Function("env", `with(env) { ${js}; return handleRecallQueue; }`)(h.env)();
    } else if (action === "session") h.env.sessionIdRef.current = "other";
    else h.env.promptRunIdRef.current++;
    release();
    assert.equal(await prepared, false, action);
    await assert.rejects(promotion, /Queue action cancelled/, action);
    assert.equal(h.env.requests.some(request => request.command.type === "pending_input_action"), false);
  }
});

test("captured admission observes cancellation during durable recovery before starting answer saves", async () => {
  for (const action of ["stop", "recall", "session", "new run"]) {
    let saves = 0;
    const h = pendingInputActionHarness({ flushPendingAnswerState: async () => { saves++; } });
    const guard = h.capture("session");
    assert.equal(saves, 0, "capture must remain synchronous and side-effect free before recovery commits");
    if (action === "stop") {
      await abortHarness({ sessionIdRef: h.env.sessionIdRef, promptRunIdRef: h.env.promptRunIdRef, queueAdmissionRevisionRef: h.env.queueAdmissionRevisionRef }).run();
    } else if (action === "recall") {
      const callback = source.slice(source.indexOf("  const handleRecallQueue = useCallback"), source.indexOf("  const handleThinkingLevelChange = useCallback"));
      const js = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
      h.env.addNotice = () => {};
      await new Function("env", `with(env) { ${js}; return handleRecallQueue; }`)(h.env)();
    } else if (action === "session") h.env.sessionIdRef.current = "other";
    else h.env.promptRunIdRef.current++;
    assert.equal(await guard(), false, action);
    assert.equal(saves, 0, "a cancelled durable submission must not begin optional persistence");
  }
  const fresh = pendingInputActionHarness({ sessionIdRef: { current: null }, flushPendingAnswerState: async () => assert.fail("a new chat has no answer state") });
  assert.equal(await fresh.capture()(), true, "a new chat may proceed from durable input to session creation");
  const gate = source.slice(source.indexOf("  const chatCommands = useChatCommandOperations"), source.indexOf("  const submitChatCommand = chatCommands.submit"));
  assert.match(gate, /captureSubmissionGuard: captureAnswerStateSubmissionGuard/);
});

test("new-chat admission permits its own creation result and rejects other sessions or later cancellation", async () => {
  const saved = [];
  const h = pendingInputActionHarness({ sessionIdRef: { current: null }, flushPendingAnswerState: async sid => { saved.push(sid); } });
  const guard = h.capture();
  assert.equal(await guard(), true);
  h.env.createdSessionIdRef.current = "created-for-this-chat";
  h.env.sessionIdRef.current = "created-for-this-chat";
  assert.equal(await guard("wrong-returned-id"), false, "the admission must use the actual ensure result");
  assert.equal(await guard("created-for-this-chat"), true);
  assert.deepEqual(saved, ["created-for-this-chat"]);
  h.env.sessionIdRef.current = "other";
  assert.equal(await guard("other"), false, "a promoted submission stays bound to its own chat");
  for (const boundary of ["existing session", "stop", "recall", "new run"]) {
    const fresh = pendingInputActionHarness({ sessionIdRef: { current: null }, flushPendingAnswerState: async () => assert.fail("cancelled or switched admission must not save") });
    const captured = fresh.capture();
    fresh.env.sessionIdRef.current = "new-id";
    if (boundary !== "existing session") fresh.env.createdSessionIdRef.current = "new-id";
    if (boundary === "stop" || boundary === "recall") fresh.env.queueAdmissionRevisionRef.current++;
    if (boundary === "new run") fresh.env.promptRunIdRef.current++;
    assert.equal(await captured("new-id"), false, boundary);
  }
  const ensure = source.slice(source.indexOf("  const ensureNewSession = useCallback"), source.indexOf("  const loadSlashCommands = useCallback"));
  assert.match(ensure, /const realId = result\.sessionId;\s*createdSessionIdRef\.current = realId;\s*sessionIdRef\.current = realId/);
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


test("nested live events stay under their parent and cancellation rejects late child events", () => {
  const h = promptSubmissionHarness();
  h.env.agentRunningRef.current = true; h.env.messages = [];
  h.handleAgentEvent({ type: "tool_execution_start", toolCallId: "root/0", parentToolCallId: "root", toolName: "read" });
  h.handleAgentEvent({ type: "tool_execution_update", toolCallId: "root/0", parentToolCallId: "root", partialResult: { content: [{ type: "text", text: "progress" }] } });
  assert.deepEqual(h.env.messages, [], "child output must not create a transcript message");
  assert.equal(h.env.nestedCallsStore.getSnapshot("root").calls[0].status, "running");
  h.env.cancelledPromptRunIdRef.current = h.env.promptRunIdRef.current;
  h.env.nestedCallsStore.finish();
  h.handleAgentEvent({ type: "tool_execution_end", toolCallId: "root/0", parentToolCallId: "root", isError: false });
  assert.equal(h.env.nestedCallsStore.getSnapshot("root").calls[0].status, "unfinished");
  h.env.nestedCallsStore.reset();
});

test("whole-session stats reject delayed responses across refreshes and run boundaries", async () => {
  const handler = source.slice(source.indexOf("  const refreshContextUsage = useCallback"), source.indexOf("  // Reconcile client streaming state"));
  const requests = [], snapshots = [];
  const env = { editedBranchRef: { current: null }, activeLeafId: null, data: null, entryIds: [], useCallback: callback => callback, promptRunIdRef: { current: 1 }, sessionIdRef: { current: "session" }, statsRefreshSequence: { current: 0 },
    fetch: () => new Promise(resolve => requests.push(resolve)), setSessionStatsOverride: stats => snapshots.push(stats), setContextUsage() {} };
  const js = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const refresh = new Function("env", `with(env) { ${js}; return refreshContextUsage; }`)(env);
  const response = cost => ({ ok: true, json: async () => ({ state: { stats: { cost } } }) });
  const first = refresh("session"), second = refresh("session");
  requests[1](response(2)); await second;
  requests[0](response(1)); await first;
  assert.deepEqual(snapshots, [{ cost: 2 }]);
  const oldRun = refresh("session"); env.promptRunIdRef.current++;
  requests[2](response(3)); await oldRun;
  assert.deepEqual(snapshots, [{ cost: 2 }]);
});


test("shell progress replaces cumulative snapshots and final result settles the same card", () => {
  const h = promptSubmissionHarness();
  h.env.agentRunningRef.current = true;
  h.env.messages = [];
  for (const text of ["first line", "first line\nsecond line"]) {
    h.handleAgentEvent({ type: "tool_execution_update", toolCallId: "shell-live", toolName: "powershell",
      partialResult: { content: [{ type: "text", text }] } });
    assert.equal(h.env.messages.length, 1);
    assert.equal(h.env.messages[0].content[0].text, text);
    assert.equal(h.env.messages[0].isStreaming, true);
  }
  h.handleAgentEvent({ type: "message_end", message: { role: "toolResult", toolCallId: "shell-live", toolName: "powershell",
    content: [{ type: "text", text: "first line\nsecond line\ndone" }] } });
  assert.equal(h.env.messages.length, 1);
  assert.equal(h.env.messages[0].content[0].text, "first line\nsecond line\ndone");
  assert.notEqual(h.env.messages[0].isStreaming, true);
});


test("queue submissions reuse only the matching open model event stream", async () => {
  const callback = source.slice(source.indexOf("  const ensureEventsConnected = useCallback"), source.indexOf("  const respondToExtensionUi = useCallback"));
  const calls = [];
  const original = { readyState: 1, url: 'http://localhost/api/agent/session/events?transport=delta', close() { calls.push('closed-original'); } };
  const env = { editedBranchRef: { current: null }, activeLeafId: null, data: null, entryIds: [], useCallback: callback => callback, EventSource: { OPEN: 1 }, eventSourceRef: { current: original },
    connectEvents: async sid => { calls.push(sid); return { status: 'connected', source: { readyState: 1 } }; },
    EventStreamConnectionError: Error,
  };
  const js = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const ensure = new Function('env', 'with(env) { ' + js + '; return ensureEventsConnected; }')(env);
  await ensure('session');
  assert.deepEqual(calls, [], 'queuing must not close or replace the current model stream');
  await ensure('other');
  assert.deepEqual(calls, ['other'], 'an open stream from another session cannot be reused');
  original.readyState = 0;
  await ensure('session');
  assert.deepEqual(calls, ['other', 'session'], 'a disconnected stream must be connected before sending');
});


test("queue receipts do not replace the live transcript before its run settles", () => {
  const start = source.indexOf('    onFinished: record => {');
  const body = source.slice(start + '    onFinished: '.length, source.indexOf('\n  });', start)).trim().replace(/,$/, '');
  const calls = [];
  const env = { sessionIdRef: {current:'session'}, agentRunningRef:{current:true}, promptRunIdRef:{current:1},
    loadSession: (...args)=>calls.push(['load',...args]), waitForPromptSettlement: (...args)=>calls.push(['settle',...args]) };
  const js = ts.transpileModule('const callback = '+body+';', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
  const callback = new Function('env','with(env){'+js+';return callback;}')(env);
  callback({targetSessionId:'session',status:'completed'});
  callback({targetSessionId:'session',status:'cancelled'});
  assert.equal(calls.filter(call=>call[0]==='load').length,0,'ordinary queue acknowledgements cannot overwrite ongoing messages with a disk snapshot');
  assert.equal(calls.filter(call=>call[0]==='settle').length,2);
  env.agentRunningRef.current=false;
  callback({targetSessionId:'session',status:'completed'});
  assert.equal(calls.filter(call=>call[0]==='load').length,1,'idle receipts still refresh durable history');
  callback({targetSessionId:'other',status:'completed'});
  assert.equal(calls.filter(call=>call[0]==='load').length,1);
});

function editNavigationHarness(overrides = {}) {
  const callback = source.slice(source.indexOf("  const handleNavigate = useCallback"), source.indexOf("  const handleRewindRecovery = useCallback"));
  const events = [];
  const env = { answerOutputScope: 0, setAnswerOutputScope: update => { env.answerOutputScope = update(env.answerOutputScope); }, flushPendingAnswerState: async () => {}, editedBranchRef: { current: null }, activeLeafId: null, data: null, entryIds: [], useCallback: fn => fn, sessionIdRef: { current: "session" }, agentRunningRef: { current: false }, bashRunningRef: { current: false }, isCompacting: false,
    t: key => key, sendAgentCommand: async () => { events.push("navigate"); return {}; }, loadContext: async () => { events.push("context"); return true; }, setActiveLeafId: id => events.push(id), ...overrides };
  const js = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return { navigate: new Function("env", `with(env) { ${js}; return handleNavigate; }`)(env), events, env };
}
test("edit navigation waits for server success and context, and propagates failure without changing the leaf", async () => {
  const ok = editNavigationHarness(); assert.equal(await ok.navigate("parent"), true); assert.deepEqual(ok.events, ["navigate", "context", "parent"]);
  assert.equal(ok.env.answerOutputScope, 1);
  const rejected = editNavigationHarness({ sendAgentCommand: async () => { throw new Error("provider unavailable"); } });
  await assert.rejects(rejected.navigate("parent"), /provider unavailable/); assert.deepEqual(rejected.events, []);
  const cancelled = editNavigationHarness({ sendAgentCommand: async () => ({ cancelled: true }) });
  assert.equal(await cancelled.navigate("parent"), false); assert.deepEqual(cancelled.events, []);
  const failed = editNavigationHarness({ loadContext: async () => false });
  await assert.rejects(failed.navigate("parent"), /history.loadError/); assert.deepEqual(failed.events, ["navigate"]);
  assert.equal(failed.env.answerOutputScope, 0);
});

function leafChangeHarness(overrides = {}) {
  const callback = source.slice(source.indexOf("  const handleLeafChange = useCallback"), source.indexOf("  const switchHistoryBranch = useCallback"));
  const events = [];
  const env = {
    useCallback: fn => fn, sessionIdRef: { current: "session" }, agentRunningRef: { current: false }, bashRunningRef: { current: false }, isCompacting: false,
    activeLeafId: "old", editedBranchRef: { current: null }, t: key => key,
    flushPendingAnswerState: async () => {}, sendAgentCommand: async () => { events.push("navigate"); return {}; },
    loadContext: async () => { events.push("context"); return true; },
    answerOutputScope: 3, setAnswerOutputScope: update => { env.answerOutputScope = update(env.answerOutputScope); events.push("scope"); },
    setActiveLeafId: leaf => { env.activeLeafId = leaf; events.push(`leaf:${leaf}`); },
    setError: error => { env.error = error; }, ...overrides,
  };
  const js = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return { change: new Function("env", `with(env) { ${js}; return handleLeafChange; }`)(env), events, env };
}

test("branch selection waits for navigation before refreshing outputs and preserves the old view on failure", async () => {
  let release;
  const response = new Promise(resolve => { release = resolve; });
  const h = leafChangeHarness({ sendAgentCommand: async () => { h.events.push("navigate"); return response; } });
  const changing = h.change("new");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.events, ["navigate"]);
  assert.equal(h.env.activeLeafId, "old");
  assert.equal(h.env.answerOutputScope, 3);
  release({}); await changing;
  assert.deepEqual(h.events, ["navigate", "context", "scope", "leaf:new"]);
  assert.equal(h.env.answerOutputScope, 4);
  for (const scenario of [
    { sendAgentCommand: async () => ({ cancelled: true }) },
    { sendAgentCommand: async () => { throw new Error("navigation failed"); } },
    { loadContext: async () => false },
    { agentRunningRef: { current: true } },
  ]) {
    const failed = leafChangeHarness(scenario); await failed.change("new");
    assert.equal(failed.env.activeLeafId, "old");
    assert.equal(failed.env.answerOutputScope, 3);
    assert.equal(failed.events.includes("scope"), false);
  }
  const latest = leafChangeHarness(); await latest.change(null);
  assert.deepEqual(latest.events, ["context", "scope", "leaf:null"], "latest view is a read without a fabricated navigation target");
  const same = leafChangeHarness(); await same.change("old");
  assert.equal(same.env.answerOutputScope, 3, "reselecting the same branch does not remount its controls");
});
test("historical context excludes unconfirmed recovery copies without deleting them", async () => {
  const callback = source.slice(source.indexOf("  const loadContext = useCallback"), source.indexOf("  const promoteNewSession = useCallback"));
  const js = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const pending = [{ id: "pending" }];
  const env = { editedBranchRef: { current: null }, activeLeafId: null, data: null, entryIds: [], useCallback: fn => fn, promptRunIdRef: { current: 1 }, historyRevisionRef: { current: 0 }, sessionIdRef: { current: "session" }, URLSearchParams,
    fetch: async () => ({ ok: true, json: async () => ({ context: { messages: ["ancestor"], entryIds: ["parent"] } }) }),
    readPendingPrompts: async () => pending, mergePendingPrompts: () => ({ messages: ["ancestor", "later failure"], entryIds: ["parent", ""], confirmedIds: [] }),
    setMessages: value => { env.messages = value; }, setEntryIds: value => { env.ids = value; }, confirmPendingPrompts: async ids => { assert.deepEqual(ids, []); } };
  const load = new Function("env", `with(env) { ${js}; return loadContext; }`)(env);
  assert.equal(await load("session", "parent"), true); assert.deepEqual(env.messages, ["ancestor"]); assert.deepEqual(env.ids, ["parent"]);
  assert.equal(await load("session", null), true); assert.deepEqual(env.messages, ["ancestor", "later failure"]); assert.equal(pending.length, 1);
});

test("edit then failed send and repeated reload retain the new branch and only its recovery message", async () => {
  const { mergePendingPrompts } = await createJiti(import.meta.url).import("../lib/prompt-recovery.ts");
  const pending = [{ id: "old-failure", scope: "session", branchAnchorId: "old-leaf", message: { role: "user", content: "old failure", timestamp: 2 }, draft: { value: "old failure", images: [], files: [] } }];
  const selection = { current: null };
  const nav = editNavigationHarness({ activeLeafId: "old-leaf", data: { leafId: "old-leaf" }, editedBranchRef: selection,
    readPendingPrompts: async () => pending, savePendingPrompt: async () => {} });
  assert.equal(await nav.navigate("parent"), true);
  const send = sendHarness({ entryIds: ["parent"], sendAgentCommand: async () => { throw new Error("provider unavailable"); } });
  assert.equal(await send.run("edited message"), false);
  assert.equal(send.env.saved.branchAnchorId, "parent");
  pending.push(send.env.saved);
  const ancestor = { role: "assistant", content: [], timestamp: 1 };
  const oldDisk = { leafId: "old-leaf", context: { messages: [ancestor, { role: "user", content: "abandoned" }], entryIds: ["parent", "old-leaf"] } };
  const h = sessionLoadHarness({ editedBranchRef: selection, mergePendingPrompts, readPendingPrompts: async () => pending,
    fetch: async () => ({ ok: true, json: async () => ({ context: { messages: [ancestor], entryIds: ["parent"] } }) }) });
  for (let i = 0; i < 3; i++) {
    await h.run("session", false, false, Promise.resolve(oldDisk));
    assert.equal(h.env.setErrorValue, null);
    assert.equal(h.env.setActiveLeafIdValue, "parent");
    assert.equal(h.env.setMessagesValue.length, 2);
    assert.equal(h.env.setMessagesValue[1].clientPromptId, send.env.saved.id);
  }
  assert.equal(pending.length, 2, "branch changes do not delete recovery bytes");
});

test("editing a failed prompt replaces its visible row even when the replacement send fails", async () => {
  const failed = { role: "user", clientPromptId: "original", content: "before", sendError: "error" };
  const h = sendHarness({ messages: [failed, { role: "user", clientPromptId: "unrelated", content: "before", sendError: "error" }], entryIds: ["", ""], ensureEventsConnected: async () => { throw new Error("still unavailable"); } });
  assert.equal(await h.run("after", undefined, undefined, undefined, ["original"]), false);
  assert.equal(h.env.messages.length, 2);
  assert.equal(h.env.messages[0].content, "after");
  assert.equal(h.env.messages[0].sendError, "still unavailable");
  assert.equal(h.env.messages[1].clientPromptId, "unrelated");
  assert.deepEqual(h.env.saved.draft.retryOfPromptIds, ["original"]);
});

test("edit-from-here rewinds each failed position and archives only its suffix with full recovery bytes retained", async () => {
  const callback = source.slice(source.indexOf("  const handleRewindRecovery = useCallback"), source.indexOf("  const handleLeafChange = useCallback"));
  const js = ts.transpileModule(callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const index of [0, 1, 2]) {
    const messages = [0, 1, 2].map(i => ({ role: "user", clientPromptId: `test${i}`, content: `test${i}`, recoveryDraft: { value: `test${i}`, images: [{ data: "image", mimeType: "image/png" }], files: [] } }));
    const archived = [];
    const env = { useCallback: fn => fn, messages, entryIds: ["", "", ""], agentRunningRef: { current: false }, bashRunningRef: { current: false }, isCompacting: false,
      t: key => key, sessionIdRef: { current: "session" }, historyRevisionRef: { current: 0 }, sessionLoadAbortRef: { current: null }, handleNavigate: async () => { throw new Error("local failures need no server navigation"); },
      dismissPendingPrompt: async id => archived.push(id), setMessages: value => { env.visible = value; }, setEntryIds: value => { env.ids = value; } };
    const rewind = new Function("env", `with(env) { ${js}; return handleRewindRecovery; }`)(env);
    assert.equal(await rewind(messages[index]), true);
    assert.deepEqual(env.visible, messages.slice(0, index));
    assert.deepEqual(archived, messages.slice(index).map(message => message.clientPromptId));
    assert.equal(messages[index].recoveryDraft.images[0].data, "image");
  }
});
