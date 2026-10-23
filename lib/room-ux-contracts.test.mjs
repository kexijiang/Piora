import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "piora-room-ux-"));
process.env.PIORA_ROOMS_ROOT = root;
const jiti = createJiti(import.meta.url, { alias: { "@": join(import.meta.dirname, "..") } });
const rooms = await jiti.import("./room-store.ts");
const { getTeamRunStore, resetTeamRunStoreForTests } = await jiti.import("./team-run-store.ts");
const { TeamCoordinatorService, resetTeamCoordinatorForTests } = await jiti.import("./team-coordinator-service.ts");
const { submitRoomMessage: submit, listRoomSubmissions } = await jiti.import("./room-submissions.ts");
const submitRoomMessage = (roomId, input) => submit(roomId, input, { assess: async () => ({ suitable: true, confidence: 50, reason: "可接待这条消息" }) });
const { isRoomBroadcast, resolveRoomMentions } = await jiti.import("./room-chat-routing.ts");
const { adjustRoomMentions } = await jiti.import("./room-composer.ts");
const { createManagedRoom } = await jiti.import("./room-creation.ts");
const { roomArtifactDownload } = await jiti.import("./room-downloads.ts");
const { GET: downloadArtifact } = await jiti.import("../app/api/rooms/[id]/artifacts/[artifactId]/route.ts");
const { POST: postMessage } = await jiti.import("../app/api/rooms/[id]/messages/route.ts");
const { GET: downloadAttachment } = await jiti.import("../app/api/rooms/[id]/messages/[messageId]/attachments/[index]/route.ts");
const { allowFileRoot } = await jiti.import("./allowed-roots.ts");
const commands = new Map();
let failNext = false;
let failCancellation = false;
const cancellationCalls = [];
const router = {
  async dispatchSessionMessage(input) {
    const existing = [...commands.values()].find((command) => command.idempotencyKey === input.idempotencyKey);
    if (existing) return { accepted: true, commandId: existing.commandId, sessionId: existing.targetSessionId, status: existing.status };
    const command = { ...input, commandId: randomUUID(), status: failNext ? "failed" : "queued" };
    failNext = false; commands.set(command.commandId, command);
    return { accepted: true, commandId: command.commandId, sessionId: input.targetSessionId, status: command.status };
  },
  async getCommand(id) { return commands.get(id); },
  subscribeEvents() { return () => {}; },
  async cancelCommand(id) { cancellationCalls.push(id); if (failCancellation) throw new Error("cancel transport unavailable"); commands.get(id).status = "cancelled"; },
};
globalThis.__pioraSessionMessageRouter = router;
const store = getTeamRunStore();
globalThis.__pioraTeamCoordinator = new TeamCoordinatorService({ store, router });
test.after(() => {
  resetTeamCoordinatorForTests(); resetTeamRunStoreForTests(); delete globalThis.__pioraSessionMessageRouter;
  delete process.env.PIORA_ROOMS_ROOT; rmSync(root, { recursive: true, force: true });
});

function room() {
  const result = rooms.createRoom({ name: "验收", creator: { sessionId: randomUUID(), name: "阿策", role: "coordinator", cwd: root } });
  rooms.addRoomMember(result.id, { sessionId: randomUUID(), name: "小研", role: "worker", cwd: root });
  return rooms.configureRoomCoordination(result.id, { mode: "team", coordinatorSessionId: result.members[0].binding.sessionId });
}
const input = (r, content, extra = {}) => ({ sessionId: r.members[0].binding.sessionId, clientPromptId: randomUUID(), content, ...extra });

test("concurrent retries create one durable message and one command; semantic defaults preserve the receipt", async () => {
  const r = room(); const value = input(r, "你好");
  const before = commands.size;
  const values = await Promise.all(Array.from({ length: 8 }, () => submitRoomMessage(r.id, value)));
  assert.equal(new Set(values.map((result) => result.message.id)).size, 1);
  assert.equal(commands.size - before, 1);
  assert.equal((await submitRoomMessage(r.id, { ...value, mentions: [], attachments: [], intent: "auto" })).submission.status, "delivered");
  await assert.rejects(submitRoomMessage(r.id, { ...value, content: "另一条" }), { code: "TEAM_REVISION_CONFLICT" });
});

test("known failed deliveries can retry without duplicating the user message", async () => {
  const r = room(); const value = input(r, "失败后重试"); failNext = true;
  const failed = await submitRoomMessage(r.id, value);
  assert.equal(failed.submission.status, "error");
  const retried = await submitRoomMessage(r.id, value);
  assert.equal(retried.submission.status, "delivered"); assert.equal(retried.message.id, failed.message.id);
  assert.equal(retried.submission.commandIds.length, 2);
});

test("a provider failure during intake remains in durable group history exactly once", async () => {
  const r = room(); const message = rooms.appendRoomMessage(r.id, { authorKind: "user", authorId: r.members[0].sessionId, content: "开始验收" });
  let listener;
  const failingRouter = {
    async dispatchSessionMessage() { return { accepted: true, commandId: "failed-intake", status: "running" }; },
    subscribeEvents(_id, callback) { listener = callback; return () => {}; },
    async getCommand() { return { status: "running" }; },
  };
  const { dispatchRoomChat } = await jiti.import("./room-chat.ts");
  await dispatchRoomChat(r.id, { messageId: message.id, content: message.content, router: failingRouter, intake: true });
  const event = { type: "command_failed", commandId: "failed-intake", errorMessage: "403: AccessDenied.Unpurchased" };
  listener(event); listener(event);
  const failures = rooms.listRoomMessages(r.id).filter((entry) => entry.correlationId === "room-command:failed-intake:error");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].replyTo, message.id);
  assert.match(failures[0].content, /403.*AccessDenied.Unpurchased/);
});

test("explicit queued tasks advance after termination without an open UI", async () => {
  const r = room(); const actor = r.members[0];
  const first = await store.createTeamRun({ roomId: r.id, objective: "first", coordinatorMemberId: actor.memberId, createdBy: { kind: "user", id: actor.binding.sessionId } });
  const queued = await submitRoomMessage(r.id, input(r, "second", { intent: "new_task" }));
  assert.equal(queued.submission.status, "queued");
  await globalThis.__pioraTeamCoordinator.cancelRun(r.id, first.id, "停止");
  const deadline = Date.now() + 5000;
  while (listRoomSubmissions(r.id)[0].status === "queued" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  const receipt = listRoomSubmissions(r.id)[0];
  assert.equal(receipt.status, "delivered"); assert.notEqual(receipt.teamRunId, first.id);
  await assert.rejects(globalThis.__pioraTeamCoordinator.resumeRun(r.id, first.id), { code: "TEAM_REVISION_CONFLICT" });
});

test("unrelated guidance stays waiting; old question generations cannot resume the current question", async () => {
  const r = room(); const value = await submitRoomMessage(r.id, input(r, "开展任务", { intent: "new_task" }));
  let run = store.getTeamRun(r.id, value.submission.teamRunId);
  run = await store.appendTeamRunEvents(r.id, run.id, run.revision, [{ type: "run.waiting_user", reason: "选 A 吗？" }]);
  const question = rooms.appendRoomMessage(r.id, { authorKind: "system", authorId: "piora", content: "选 A 吗？", kind: "question", teamRunId: run.id, correlationId: `team:${run.id}:question:0` });
  const guidance = await submitRoomMessage(r.id, input(r, "顺便检查布局"));
  assert.equal(store.getTeamRun(r.id, run.id).phase, "waiting_user");
  assert.equal(store.getTeamRun(r.id, run.id).guidance[0].messageId, guidance.message.id);
  const answer = await submitRoomMessage(r.id, input(r, "选 A", { intent: "answer", replyTo: question.id }));
  assert.equal(answer.submission.status, "delivered");
  run = store.getTeamRun(r.id, run.id);
  run = await store.appendTeamRunEvents(r.id, run.id, run.revision, [{ type: "run.waiting_user", reason: "另一个问题" }]);
  const stale = await submitRoomMessage(r.id, input(r, "旧问题的迟到回答", { intent: "answer", replyTo: question.id }));
  assert.equal(stale.submission.status, "error"); assert.equal(store.getTeamRun(r.id, run.id).phase, "waiting_user");
});

test("syncing a thread result publishes a message without starting or steering work", async () => {
  const r = room(); const before = commands.size;
  assert.equal((await submitRoomMessage(r.id, input(r, "话题结论", { intent: "share" }))).submission.status, "delivered");
  assert.equal(commands.size, before); assert.equal(store.listTeamRuns(r.id).length, 0);
});

test("a fresh process recovers an applied answer after a lost receipt without resuming a later question", async () => {
  const r = room();
  const started = await submitRoomMessage(r.id, input(r, "开始任务", { intent: "new_task" }));
  let run = store.getTeamRun(r.id, started.submission.teamRunId);
  run = await store.appendTeamRunEvents(r.id, run.id, run.revision, [{ type: "run.waiting_user", reason: "第一个问题" }]);
  const question = rooms.appendRoomMessage(r.id, { authorKind: "system", authorId: "piora", content: "第一个问题", kind: "question", teamRunId: run.id, correlationId: `team:${run.id}:question:0` });
  const answer = await submitRoomMessage(r.id, input(r, "回答第一个问题", { intent: "answer", replyTo: question.id }));
  assert.equal(answer.submission.status, "delivered");
  run = store.getTeamRun(r.id, run.id);
  run = await store.appendTeamRunEvents(r.id, run.id, run.revision, [{ type: "run.waiting_user", reason: "另一个待回答问题" }]);
  const receiptPath = join(r.paths.shared, "submissions", `${createHash("sha256").update(answer.submission.clientPromptId).digest("hex")}.json`);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.status = "accepted"; delete receipt.teamRunId;
  writeFileSync(receiptPath, JSON.stringify(receipt), { flush: true });
  const script = `import {createJiti} from 'jiti';
    const jiti=createJiti(process.cwd()+'/package.json');
    const {drainRoomSubmissions,listRoomSubmissions}=await jiti.import('./lib/room-submissions.ts');
    await drainRoomSubmissions(${JSON.stringify(r.id)});
    process.stdout.write(JSON.stringify(listRoomSubmissions(${JSON.stringify(r.id)})));`;
  const recovered = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: join(import.meta.dirname, ".."), encoding: "utf8", timeout: 20000,
    env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "isolated-agent") },
  })).find((item) => item.clientPromptId === answer.submission.clientPromptId);
  assert.equal(recovered.status, "delivered"); assert.equal(recovered.teamRunId, run.id);
  assert.equal(store.getTeamRun(r.id, run.id).phase, "waiting_user");
  assert.equal(store.listTeamRunEvents(r.id, run.id).filter((entry) => entry.event.type === "run.resumed").length, 1);
});

test("stable mention IDs survive rename; duplicates, prefixes and code cannot select an arbitrary member", () => {
  const r = room(); const selected = r.members[1];
  selected.profile.name = "小研二";
  assert.deepEqual(resolveRoomMentions(r, "@小研 请检查", [{ memberId: selected.memberId, start: 0, end: 3 }]), [selected.memberId]);
  assert.deepEqual(resolveRoomMentions(r, "@小研，请检查"), []);
  assert.deepEqual(resolveRoomMentions(r, "`@小研二`\n```\n@阿策\n```"), []);
  assert.equal(isRoomBroadcast("`@all`\n> @所有人 请看引用"), false);
  assert.equal(isRoomBroadcast("@Everyone 请发表意见"), true);
  selected.profile.name = "阿策";
  assert.deepEqual(resolveRoomMentions(r, "@阿策，请检查"), []);
  const mention = { memberId: selected.memberId, start: 2, end: 5 };
  assert.equal(adjustRoomMentions("前 @小研", "前缀 @小研", [mention])[0].start, 3);
  assert.deepEqual(adjustRoomMentions("前 @小研", "前 @小", [mention]), []);
});

test("template provisioning resumes a partially initialized team with stable room and member identities", async () => {
  const provisioned = []; let fail = true;
  const deps = {
    async resolveProfile(_room, profile) { return { ...profile, workspacePolicy: { mode: "shared", integration: "artifact_only" } }; },
    async provision(_room, _profile, id) {
      if (provisioned.length === 1 && fail) { fail = false; throw new Error("模拟成员初始化失败"); }
      provisioned.push(id); return { sessionId: `managed-${id}`, cwd: root, managedByPiora: true, boundAt: Date.now(), status: "ready" };
    },
  };
  const value = { clientCreationId: randomUUID(), cwd: root, template: "project" };
  await assert.rejects(createManagedRoom(value, deps), /初始化失败/);
  const result = await createManagedRoom(value, deps);
  assert.equal(result.members.length, 3); assert.equal(new Set(provisioned).size, 3); assert.equal(provisioned.length, 3);
  assert.equal((await createManagedRoom(value, deps)).id, result.id); assert.equal(provisioned.length, 3);
  assert.equal(result.coordination.mode, "team");
});

test("artifact downloads use copied content and membership authorization; paths cannot escape the artifact root", async () => {
  const r = room(); const actor = r.members[0].binding.sessionId;
  const artifact = rooms.publishRoomArtifact(r.id, actor, { kind: "report", name: "验收.md", summary: "检查", content: "验证内容" });
  const params = Promise.resolve({ id: r.id, artifactId: artifact.id });
  const response = await downloadArtifact(new Request(`http://localhost/api?sessionId=${actor}`), { params });
  assert.equal(response.status, 200); assert.equal(await response.text(), "验证内容");
  assert.match(response.headers.get("Content-Disposition"), /filename\*/);
  assert.equal((await downloadArtifact(new Request("http://localhost/api?sessionId=outsider"), { params })).status, 403);
  const outside = join(root, "outside.txt"); writeFileSync(outside, "private");
  assert.throws(() => roomArtifactDownload(join(r.paths.shared, "artifacts"), outside, "escape"), { code: "TEAM_INVALID_CONTEXT" });
});

test("custom groups need no predefined roles and keep owned sessions inside the group", async () => {
  const { getManagedRoomSessionIds } = await jiti.import("./room-session-visibility.ts");
  const profiles = [];
  const r = await createManagedRoom({
    clientCreationId: randomUUID(), cwd: root, template: "custom",
    agents: [{ name: "小林", roleDescription: "善于追问的写作搭档" }, { name: "小周" }],
  }, {
    async resolveProfile(_room, profile) { return profile; },
    async provision(_room, profile, id) {
      profiles.push(profile);
      return { sessionId: `chat-${id}`, cwd: root, managedByPiora: true, boundAt: Date.now(), status: "ready" };
    },
  });
  assert.equal(r.coordination.mode, "manual");
  assert.equal(profiles[0].roleDescription, "善于追问的写作搭档");
  for (const profile of profiles) {
    assert.equal(profile.workspacePolicy.mode, "shared");
    assert.equal(profile.systemPrompt, "");
    assert.equal(profile.toolPolicy.mode, "inherit");
  }
  const withReused = rooms.addRoomMember(r.id, { sessionId: "existing-chat", name: "已有聊天" });
  const hidden = getManagedRoomSessionIds([withReused]);
  assert.equal(hidden.size, 2);
  assert.equal(hidden.has("existing-chat"), false);
  const rebound = rooms.updateRoomMember(r.id, r.members[0].binding.sessionId, r.members[1].memberId, { sessionId: "another-existing-chat" });
  assert.equal(getManagedRoomSessionIds([rebound]).has("another-existing-chat"), false);
});

test("message API rejects non-members and malformed input without dispatching", async () => {
  const r = room();
  const post = (body) => postMessage(new Request("http://localhost/api", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: r.id }) });
  assert.equal((await post(input(r, "x", { sessionId: "outsider" }))).status, 403);
  assert.equal((await post(input(r, "x", { mentions: {} }))).status, 400);
  assert.equal((await post(input(r, "x", { attachments: [null] }))).status, 400);
  assert.equal((await post(null)).status, 400);
});

test("attached files can be downloaded only through their room message and allowed file roots", async () => {
  const r = room(); const file = join(root, "attachment.txt"); writeFileSync(file, "附件内容"); allowFileRoot(root);
  const sent = await submitRoomMessage(r.id, input(r, "查看附件", { intent: "share", attachments: [{ name: "说明.txt", path: file }] }));
  const params = Promise.resolve({ id: r.id, messageId: sent.message.id, index: "0" });
  const response = await downloadAttachment(new Request(`http://localhost/api?sessionId=${r.members[0].binding.sessionId}`), { params });
  assert.equal(response.status, 200); assert.equal(await response.text(), "附件内容");
  assert.equal((await downloadAttachment(new Request("http://localhost/api?sessionId=outsider"), { params })).status, 403);
});

test("failed stop stays durable and blocks queue advancement until restart confirms only its owned commands", async () => {
  const r = room();
  const first = await submitRoomMessage(r.id, input(r, "正在执行", { intent: "new_task" }));
  const queued = await submitRoomMessage(r.id, input(r, "下一件工作", { intent: "new_task" }));
  const runId = first.submission.teamRunId;
  const before = commands.size; const callsBefore = cancellationCalls.length;
  failCancellation = true;
  try {
    await assert.rejects(globalThis.__pioraTeamCoordinator.cancelRun(r.id, runId, "用户停止"), { code: "TEAM_INTERNAL_ERROR" });
  } finally { failCancellation = false; }
  const stopping = store.getTeamRun(r.id, runId);
  assert.equal(stopping.phase, "interrupted"); assert.ok(stopping.stopRequested.commandIds.length);
  assert.equal(listRoomSubmissions(r.id).find((item) => item.clientPromptId === queued.submission.clientPromptId).status, "queued");
  await assert.rejects(globalThis.__pioraTeamCoordinator.resumeRun(r.id, runId), { code: "TEAM_INVALID_TRANSITION" });
  await globalThis.__pioraTeamCoordinator.reconcile(r.id, runId, "manual");
  await globalThis.__pioraTeamCoordinator.onSessionCommandEvent({ type: "command_completed", commandId: stopping.stopRequested.commandIds[0], timestamp: Date.now() });
  assert.equal(store.getTeamRun(r.id, runId).revision, stopping.revision); assert.equal(commands.size, before);
  const restarted = new TeamCoordinatorService({ store, router });
  globalThis.__pioraTeamCoordinator = restarted;
  await restarted.recoverAll();
  assert.equal(store.getTeamRun(r.id, runId).phase, "cancelled");
  assert.equal(store.getTeamRun(r.id, runId).stopRequested, undefined);
  assert.ok(cancellationCalls.slice(callsBefore).every((id) => stopping.stopRequested.commandIds.includes(id)));
  const deadline = Date.now() + 5000;
  while (listRoomSubmissions(r.id).find((item) => item.clientPromptId === queued.submission.clientPromptId).status === "queued" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(listRoomSubmissions(r.id).find((item) => item.clientPromptId === queued.submission.clientPromptId).status, "delivered");
});
