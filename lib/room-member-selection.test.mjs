import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "piora-member-selection-"));
process.env.PIORA_ROOMS_ROOT = root;
const jiti = createJiti(import.meta.url, { alias: { "@": join(import.meta.dirname, "..") } });
const rooms = await jiti.import("./room-store.ts");
const { selectRoomMessageHandler } = await jiti.import("./room-member-selection.ts");
const { assessRoomMember, parseRoomSelfAssessment } = await jiti.import("./room-member-assessment.ts");
const { submitRoomMessage, listRoomSubmissions, startRoomIntakeTask } = await jiti.import("./room-submissions.ts");
const { GET: getMessages } = await jiti.import("../app/api/rooms/[id]/messages/route.ts");
const commands = new Map();
let failNext = false;
globalThis.__pioraSessionMessageRouter = {
  async dispatchSessionMessage(input) {
    const existing = [...commands.values()].find(command => command.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
    const command = { ...input, commandId: randomUUID(), status: failNext ? "failed" : "queued" };
    failNext = false; commands.set(command.commandId, command); return command;
  },
  async getCommand(id) { return commands.get(id); },
  subscribeEvents() { return () => {}; },
};
const { resetTeamRunStoreForTests } = await jiti.import("./team-run-store.ts");
const { resetTeamCoordinatorForTests } = await jiti.import("./team-coordinator-service.ts");
test.after(() => {
  resetTeamCoordinatorForTests(); resetTeamRunStoreForTests();
  delete globalThis.__pioraSessionMessageRouter; delete globalThis.__pioraRoomSubmissionFlights;
  delete process.env.PIORA_ROOMS_ROOT; rmSync(root, { recursive: true, force: true });
});
function room() {
  let value = rooms.createRoom({ name: "选人", creator: { sessionId: randomUUID(), name: "负责人", role: "coordinator", cwd: root } });
  value = rooms.addRoomMember(value.id, { sessionId: randomUUID(), name: "开发", role: "worker", cwd: root });
  value = rooms.addRoomMember(value.id, { sessionId: randomUUID(), name: "审查", role: "reviewer", cwd: root });
  return value;
}
const input = r => ({ sessionId: r.members[0].binding.sessionId, clientPromptId: randomUUID(), content: "帮我修复登录问题" });
const result = (suitable, confidence, reason = "符合我的职责") => ({ suitable, confidence, reason });

test("each member assesses before exactly one winner receives the original message; concurrent retries reuse the durable decision", async () => {
  const r = room(), value = input(r), seen = [];
  const before = commands.size;
  const services = { assess: async (_room, member) => { seen.push(member.memberId); return result(true, member.profile.role === "worker" ? 95 : 40); } };
  const values = await Promise.all(Array.from({ length: 6 }, () => submitRoomMessage(r.id, value, services)));
  assert.equal(seen.length, 3); assert.equal(new Set(seen).size, 3);
  assert.equal(commands.size - before, 1);
  const receipt = values[0].submission;
  assert.equal(receipt.status, "delivered");
  assert.equal(receipt.memberSelection.selectedMemberId, r.members[1].memberId);
  const command = commands.get(receipt.commandIds[0]);
  assert.equal(command.targetSessionId, r.members[1].binding.sessionId);
  assert.match(command.content, /帮我修复登录问题/);
  assert.match(command.content, /Answer the message directly/);
  assert.doesNotMatch(command.content, /delegate through piora_room action start_run/);
  const assignment = rooms.listRoomMessages(r.id).filter(message => message.correlationId?.startsWith(`room-selection:${values[0].message.id}:`));
  assert.equal(assignment.length, 1); assert.match(assignment[0].content, /由 开发 处理/);
  assert.equal(listRoomSubmissions(r.id)[0].memberSelection.assessments.length, 3);
  await assert.rejects(startRoomIntakeTask(r.id, r.members[2].binding.sessionId, values[0].message.id, "偷跑"), { code: "TEAM_INVALID_CONTEXT" });
});

test("failed dispatch retries the same selected owner without reassessing or duplicating the assignment", async () => {
  const r = room(), value = input(r); let calls = 0; failNext = true;
  const services = { assess: async () => { calls++; return result(true, 50); } };
  const first = await submitRoomMessage(r.id, value, services);
  assert.equal(first.submission.status, "error"); assert.equal(first.submission.commandIds.length, 1);
  const second = await submitRoomMessage(r.id, value, services);
  assert.equal(second.submission.status, "delivered"); assert.equal(calls, 3);
  assert.equal(second.submission.commandIds.length, 2);
  assert.equal(rooms.listRoomMessages(r.id).filter(message => message.correlationId?.startsWith(`room-selection:${first.message.id}:`)).length, 1);
});

test("a fresh process resumes the persisted election without asking members again", async () => {
  const r = room(), value = input(r);
  const first = await submitRoomMessage(r.id, value, { assess: async (_room, member) => result(true, member.profile.role === "worker" ? 95 : 30) });
  const path = join(r.paths.shared, "submissions", createHash("sha256").update(value.clientPromptId).digest("hex") + ".json");
  const record = JSON.parse(readFileSync(path, "utf8")); record.status = "accepted"; record.commandIds = [];
  writeFileSync(path, JSON.stringify(record));
  const script = `const {createJiti}=require('jiti');const j=createJiti(${JSON.stringify(import.meta.url)});(async()=>{
    globalThis.__pioraSessionMessageRouter={async dispatchSessionMessage(input){return {...input,commandId:'restored',status:'queued'}},async getCommand(){return {status:'queued'}},subscribeEvents(){return ()=>{}}};
    const {submitRoomMessage}=await j.import('./room-submissions.ts');const result=await submitRoomMessage(${JSON.stringify(r.id)},${JSON.stringify(value)},{assess:async()=>{throw Error('must reuse persisted votes')}});
    console.log(JSON.stringify({status:result.submission.status,selected:result.submission.memberSelection.selectedMemberId}));process.exit(0);
  })().catch(error=>{console.error(error);process.exit(1)});`;
  const restored = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30000 }).trim());
  assert.equal(restored.status, "delivered"); assert.equal(restored.selected, first.submission.memberSelection.selectedMemberId);
  assert.equal(rooms.listRoomMessages(r.id).filter(message => message.correlationId?.startsWith(`room-selection:${first.message.id}:`)).length, 1);
});

test("explicit @mentions, broadcast, and reply ownership skip self-selection", async () => {
  const r = room(); let calls = 0;
  const services = { assess: async () => { calls++; throw new Error("must not assess"); } };
  const parent = rooms.appendRoomMessage(r.id, { authorKind: "session", authorId: r.members[2].binding.sessionId, content: "审查意见" });
  for (const extra of [{ content: "@开发 请修复" }, { content: "@所有人 给出意见" }, { content: "继续解释", replyTo: parent.id }]) {
    const sent = await submitRoomMessage(r.id, { ...input(r), ...extra }, services);
    assert.equal(sent.submission.status, "delivered"); assert.equal(sent.submission.memberSelection, undefined);
  }
  assert.equal(calls, 0);
});

test("all abstentions choose one clarification contact and prohibit starting work", async () => {
  const r = room(); const sent = await submitRoomMessage(r.id, input(r), { assess: async () => result(false, 90, "缺少必要背景") });
  assert.equal(sent.submission.memberSelection.clarificationOnly, true);
  const command = commands.get(sent.submission.commandIds[0]); assert.match(command.content, /single clarification contact/);
  await assert.rejects(startRoomIntakeTask(r.id, command.targetSessionId, sent.message.id, "直接修改"), /澄清/);
});

test("provider failures do not invent votes; retry only reassesses failed members", async () => {
  const r = room(), value = input(r); let fail = true; const counts = new Map();
  const services = { assess: async (_room, member) => { counts.set(member.memberId, (counts.get(member.memberId) ?? 0) + 1);
    if (fail) throw new Error("secret provider URL"); return result(true, 75); } };
  const before = commands.size;
  const failed = await submitRoomMessage(r.id, value, services);
  assert.equal(failed.submission.status, "error"); assert.equal(commands.size, before);
  assert.doesNotMatch(JSON.stringify(listRoomSubmissions(r.id)), /secret provider/);
  fail = false;
  const retry = await submitRoomMessage(r.id, value, services);
  assert.equal(retry.submission.status, "delivered"); assert.equal([...counts.values()].every(count => count === 2), true);
});

test("a slow assessment cannot block history reads or another submission, or dispatch early", { timeout: 10000 }, async () => {
  const r = room(); let release;
  const gate = new Promise(resolve => { release = resolve; });
  let started; const ready = new Promise(resolve => { started = resolve; });
  const before = commands.size;
  const pending = submitRoomMessage(r.id, input(r), { assess: async () => { started(); await gate; return result(true, 60); } });
  await ready;
  const history = await getMessages(new Request(`http://localhost/api?sessionId=${r.members[0].binding.sessionId}`), { params: Promise.resolve({ id: r.id }) });
  assert.equal(history.status, 200);
  assert.equal((await history.json()).submissions[0].status, "accepted");
  const shared = await submitRoomMessage(r.id, { ...input(r), intent: "share" });
  assert.equal(shared.submission.status, "delivered"); assert.equal(commands.size, before);
  release(); assert.equal((await pending).submission.status, "delivered");
});

test("timeouts settle without execution, while one failed member does not block an eligible winner", async () => {
  const r = room(); const selection = { assessments: [] };
  const winner = await selectRoomMessageHandler(r.id, randomUUID(), "修复", selection, () => {}, {
    timeoutMs: 20, assess: async (_room, member) => member.profile.role === "reviewer" ? new Promise(() => {}) : result(true, member.profile.role === "worker" ? 80 : 30),
  });
  assert.equal(winner, r.members[1].memberId); assert.equal(selection.assessments.filter(item => item.status === "error").length, 1);
});

test("changed membership is revalidated before election and only changed profiles are reassessed", async () => {
  const r = room(); const selection = { assessments: [] }; let mutate = true; const seen = [];
  const services = { assess: async (_room, member) => { seen.push(member.memberId);
    if (mutate && member.memberId === r.members[0].memberId) { mutate = false; rooms.addRoomMember(r.id, { sessionId: randomUUID(), name: "新成员", role: "participant" }); }
    return result(true, 50); } };
  await assert.rejects(selectRoomMessageHandler(r.id, randomUUID(), "问题", selection, () => {}, services), /配置已变化/);
  await selectRoomMessageHandler(r.id, randomUUID(), "问题", selection, () => {}, services);
  assert.equal(seen.length, 4);
});

test("assessment schema rejects invalid scores and executable output", () => {
  assert.deepEqual(parseRoomSelfAssessment('```json\n{"suitable":true,"confidence":81,"reason":"适合"}\n```'), result(true, 81, "适合"));
  for (const text of ['{"suitable":true,"confidence":101,"reason":"x"}', '{"suitable":"true","confidence":50,"reason":"x"}', '{"suitable":false,"confidence":0,"reason":""}', 'execute bash']) assert.throws(() => parseRoomSelfAssessment(text));
});

test("production assessment uses the member model in a separate tool-free request", async () => {
  const r = room(), member = r.members[1]; let called = 0;
  const model = { id: "test", provider: "test", api: "openai-completions", reasoning: false };
  const assessment = await assessRoomMember(r, member, "修复登录", new AbortController().signal, async id => {
    assert.equal(id, member.binding.sessionId);
    return { session: { inner: { model, getActiveToolNames: () => ["read"], modelRuntime: { getModel: () => model, async completeSimple(selected, context, options) {
      called++; assert.equal(selected, model); assert.equal(context.tools, undefined);
      const data = JSON.parse(context.messages[0].content); assert.equal(data.member.name, member.profile.name);
      assert.deepEqual(data.member.tools, ["read"]);
      assert.equal(data.request, "修复登录"); assert.ok(options.signal);
      return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(result(true, 95)) }] };
    } }, prompt() { throw new Error("assessment must not prompt the private session"); } } } };
  });
  assert.equal(assessment.confidence, 95); assert.equal(called, 1);
});
