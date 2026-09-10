import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { ShellStore } = await jiti.import("./shell/store.ts");
const { ManagedShellSession } = await jiti.import("./shell/session.ts");
const { discoverShellProfiles } = await jiti.import("./shell/profiles.ts");
const { startShellAgent, controlShellAgent, shellAgentContext } = await jiti.import("./shell/agent.ts");
const model = { provider: "shell-test", id: "controlled-stream", name: "Controlled model", api: "openai-completions", baseUrl: "http://unused.invalid", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const tool = (name, args) => ({ type: "toolCall", id: randomUUID(), name, arguments: args });
function servicesFor(step, createTerminal) {
  let count = 0;
  return { createTerminal, resolveModel: async () => ({ model, thinking: "off", modelRuntime: { streamSimple: (_model, context) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      try {
        const content = await step(count++, context);
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, usage, timestamp: Date.now(), stopReason: content.some(part => part.type === "toolCall") ? "toolUse" : "stop" };
        stream.push({ type: "start", partial: message });
        content.forEach((part, index) => { if (part.type === "text") stream.push({ type: "text_delta", contentIndex: index, delta: part.text, partial: message }); });
        stream.push({ type: "done", reason: message.stopReason, message });
      } catch (error) {
        stream.push({ type: "error", reason: "error", error: { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], usage, timestamp: Date.now(), stopReason: "error", errorMessage: error.message } });
      }
    });
    return stream;
  } } }) };
}
async function until(read, check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (check(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("Timed out: " + JSON.stringify(await read()));
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-shell-agent-"));
  const store = new ShellStore(directory, false), sessions = [];
  const profile = (await discoverShellProfiles()).find(profile => profile.integrated);
  assert.ok(profile, "An integrated shell is required");
  const make = () => {
    const now = Date.now();
    const session = new ManagedShellSession({ id: randomUUID(), title: "Agent test", initialCwd: directory, cwd: directory, profile, createdAt: now, updatedAt: now, generation: 0, connected: false, integration: "starting", integrationError: null, owner: "human", activeCommandId: null, activeRunId: null, model: null, draft: "", closed: false }, store, directory);
    sessions.push(session); return session;
  };
  t.after(async () => {
    for (const session of sessions) { if (session.state.activeRunId) await controlShellAgent(session, "cancel").catch(() => {}); await session.dispose(); }
    await until(() => globalThis.__pioraShellAgentRuns?.size || 0, size => size === 0);
    await store.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith("piora-shell-agent-"));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { directory, store, make, profile, session: make() };
}
const finished = async (session, id, timeout) => until(() => session.store.get("run", id), run => run && ["completed", "failed", "interrupted", "cancelled"].includes(run.status), timeout);

test("resuming an interrupted tool call provides an honest unknown result without replay", () => {
  const messages = [{ role: "user", content: "start server", timestamp: 1 }, { role: "assistant", content: [tool("execute", { command: "npm run dev" })], timestamp: 2 }];
  const context = shellAgentContext(messages);
  assert.equal(messages.length, 2, "the recorded conversation is immutable");
  assert.equal(context.length, 3); assert.equal(context[2].toolCallId, messages[1].content[0].id);
  assert.equal(context[2].isError, true); assert.match(context[2].content[0].text, /execution may have occurred/);
});

test("a provider finishing after takeover cannot overwrite a newer task's transcript", { timeout: 30000 }, async t => {
  const { session, store } = await fixture(t);
  let finishOld, started = false;
  const stalled = new Promise(resolve => { finishOld = resolve; });
  try {
    const old = await startShellAgent(session, "old task", randomUUID(), [], servicesFor(() => { started = true; return stalled; }));
    await until(() => started, Boolean);
    await controlShellAgent(session, "takeover");
    const next = await startShellAgent(session, "new task", randomUUID(), [], servicesFor(() => [{ type: "text", text: "NEW_TASK_RESULT" }]));
    assert.equal((await finished(session, next.id)).status, "completed");
    const latest = await store.get("transcript", session.state.id);
    assert.match(JSON.stringify(latest), /NEW_TASK_RESULT/);
    finishOld([{ type: "text", text: "LATE_OLD_RESULT" }]);
    await until(() => globalThis.__pioraShellAgentRuns?.has(old.id), active => !active);
    assert.deepEqual(await store.get("transcript", session.state.id), latest);
    assert.ok(await store.get("run-transcript", old.id), "the old task still has its own durable archive");
  } finally { finishOld([{ type: "text", text: "test cleanup" }]); }
});

test("real Agent loop executes a natural-language task once and saves its independent transcript", { timeout: 60000 }, async t => {
  const { session, profile, store } = await fixture(t);
  const command = profile.kind === "powershell" ? "Write-Output 'AGENT_RESULT'" : "printf 'AGENT_RESULT\\n'";
  const services = servicesFor((index, context) => {
    if (!index) { assert.match(JSON.stringify(context.messages[0].content), /显示测试结果/); return [tool("execute", { command })]; }
    const result = context.messages.findLast(message => message.role === "toolResult");
    assert.match(JSON.stringify(result), /AGENT_RESULT/);
    return [{ type: "text", text: "执行完成，已检查输出。" }];
  });
  const requestId = randomUUID();
  const [first, duplicate] = await Promise.all([startShellAgent(session, "显示测试结果", requestId, [], services), startShellAgent(session, "显示测试结果", requestId, [], services)]);
  assert.equal(first.id, duplicate.id);
  const run = await finished(session, first.id);
  assert.equal(run.status, "completed", run.error); assert.match(run.response, /已检查输出/);
  assert.equal(session.snapshot().commands.length, 1);
  assert.equal(session.state.owner, "human");
  const transcript = await store.get("transcript", session.state.id);
  assert.equal(transcript.filter(message => message.role === "user").length, 1);
  assert.ok(transcript.some(message => message.role === "toolResult"));
  await assert.rejects(startShellAgent(session, "另一项任务", requestId, [], services), /different content/);
});

test("approval binds the exact command and terminal, and stale answers cannot execute it", { timeout: 60000 }, async t => {
  const { session, directory, profile } = await fixture(t);
  const target = path.join(directory, "approval-proof.txt"); await writeFile(target, "temporary test data");
  const command = profile.kind === "powershell" ? `Remove-Item -LiteralPath '${target.replaceAll("'", "''")}'` : `rm '${target}'`;
  const services = servicesFor(index => index ? [{ type: "text", text: "已删除测试文件。" }] : [tool("execute", { command })]);
  const run = await startShellAgent(session, "删除测试文件", randomUUID(), [], services);
  const waiting = await until(() => session.store.get("run", run.id), value => value?.approval);
  assert.equal(waiting.approval.command, command); assert.equal(await realpath(waiting.approval.cwd), await realpath(directory)); assert.equal(waiting.approval.generation, session.state.generation);
  await access(target); assert.equal(session.snapshot().commands.length, 0);
  await assert.rejects(controlShellAgent(session, "approve", randomUUID()), /no longer active/);
  await access(target);
  await controlShellAgent(session, "approve", waiting.approval.id);
  assert.equal((await finished(session, run.id)).status, "completed");
  await assert.rejects(access(target), { code: "ENOENT" });
});

test("a routine package script executes through the Agent without an approval detour", { timeout: 45000 }, async t => {
  const { session, directory } = await fixture(t);
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ scripts: { test: "echo ROUTINE_SCRIPT_RESULT" } }));
  const approvals = [];
  const unsubscribe = session.subscribe(event => { if (event.type === "run" && event.run.approval) approvals.push(event.run.approval); });
  t.after(unsubscribe);
  const run = await startShellAgent(session, "运行项目测试", randomUUID(), [], servicesFor((index, context) => {
    if (!index) return [tool("execute", { command: "npm test" })];
    assert.match(JSON.stringify(context.messages.findLast(message => message.role === "toolResult")), /ROUTINE_SCRIPT_RESULT/);
    return [{ type: "text", text: "测试已执行完成。" }];
  }));
  const result = await finished(session, run.id);
  assert.equal(result.status, "completed", result.error); assert.equal(approvals.length, 0);
  assert.equal(session.snapshot().commands[0].status, "completed");
});

test("takeover does not wait on model discovery and late resolution cannot reclaim the terminal", { timeout: 30000 }, async t => {
  const { session } = await fixture(t);
  let resolveModel;
  const modelPromise = new Promise(resolve => { resolveModel = resolve; });
  const services = { resolveModel: () => modelPromise };
  const run = await startShellAgent(session, "等待模型", randomUUID(), [], services);
  await Promise.race([controlShellAgent(session, "takeover"), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Takeover waited for the model")), 1000); timer.unref(); })]);
  assert.equal(session.state.owner, "human"); assert.equal(session.state.activeRunId, null);
  session.claim("new-owner");
  resolveModel(await servicesFor(() => []).resolveModel());
  await until(() => globalThis.__pioraShellAgentRuns?.has(run.id), active => !active);
  assert.equal(session.state.activeRunId, "new-owner"); session.release("new-owner");
  assert.equal((await finished(session, run.id)).status, "cancelled");
  assert.equal(session.snapshot().commands.length, 0);
});

test("cancellation between durable admission and PTY write never starts the command", { timeout: 30000 }, async t => {
  const { session, store, profile } = await fixture(t); await session.start();
  const controller = new AbortController(), accept = store.accept.bind(store);
  store.accept = async (...args) => { const result = await accept(...args); controller.abort(); return result; };
  await assert.rejects(session.execute(profile.kind === "powershell" ? "Write-Output 'MUST_NOT_EXECUTE'" : "echo MUST_NOT_EXECUTE", randomUUID(), null, controller.signal), /abort/i);
  const [block] = session.snapshot().commands;
  assert.equal(block.status, "interrupted"); assert.equal(block.output, ""); assert.equal(session.state.activeCommandId, null);
  assert.doesNotMatch(session.snapshot().output, /MUST_NOT_EXECUTE/);
});

test("a model cannot mark an unfinished foreground command completed", { timeout: 45000 }, async t => {
  const { session, profile } = await fixture(t);
  const command = profile.kind === "powershell" ? "Start-Sleep -Seconds 30" : "sleep 30";
  const services = servicesFor(index => index ? [{ type: "text", text: "完成。" }] : [tool("execute", { command })]);
  const run = await startShellAgent(session, "等待一会", randomUUID(), [], services);
  const result = await finished(session, run.id);
  assert.equal(result.status, "interrupted"); assert.match(result.error, /foreground command is still running/);
  assert.ok(session.state.activeCommandId); assert.equal(session.state.owner, "human");
  session.interrupt();
});

test("background terminals stay owned during review and delayed failures count once per command", { timeout: 60000 }, async t => {
  const { session, profile, make } = await fixture(t);
  const command = profile.kind === "powershell" ? "Start-Sleep -Seconds 2; Write-Error 'DELAYED_FAILURE'" : "sleep 2; false";
  const children = [], approved = new Set(), replies = [];
  const unsubscribe = session.subscribe(event => {
    if (event.type !== "run" || !event.run.approval || approved.has(event.run.approval.id)) return;
    const approval = event.run.approval; approved.add(approval.id);
    assert.equal(approval.command, command);
    assert.equal(children.at(-1).state.owner, "agent");
    assert.equal(children.at(-1).state.activeRunId, event.run.id);
    replies.push(controlShellAgent(session, "approve", approval.id));
  });
  t.after(unsubscribe);
  const services = servicesFor((index, context) => {
    if (index % 3 === 0) return [tool("execute", { command, background: true })];
    const previous = context.messages.findLast(message => message.role === "toolResult");
    const result = JSON.parse(previous.content[0].text);
    if (index % 3 === 1) assert.equal(result.status, "running", "failure must occur after the first execute result");
    return [tool("wait_command", { terminalId: result.terminalId, commandId: result.id, waitMs: 5000 })];
  }, async () => { const child = make(); children.push(child); return child; });
  const run = await startShellAgent(session, "验证延迟失败与暂停", randomUUID(), [], services);
  const result = await finished(session, run.id);
  await Promise.all(replies);
  assert.equal(result.status, "interrupted", result.error);
  assert.equal(result.steps, 8, "reading one failed command twice must not count as two failures");
  assert.equal(children.length, 3); assert.equal(approved.size, 3);
  for (const child of children) { assert.equal(child.state.owner, "human"); assert.equal(child.state.activeRunId, null); assert.equal(child.snapshot().commands[0].status, "failed"); }
});

test("the real Agent loop stops after thirty tool steps", { timeout: 60000 }, async t => {
  const { session, profile } = await fixture(t);
  const command = profile.kind === "powershell" ? "Write-Output 'bounded step'" : "echo bounded-step";
  let calls = 0;
  const services = servicesFor(() => { calls++; return [tool("execute", { command })]; });
  const run = await startShellAgent(session, "重复检查并遵守步数限制", randomUUID(), [], services);
  const result = await finished(session, run.id, 40000);
  assert.equal(result.status, "interrupted", result.error); assert.equal(result.steps, 30);
  assert.equal(calls, 30); assert.equal(session.snapshot().commands.length, 30);
});
