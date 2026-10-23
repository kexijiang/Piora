import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "piora-room-chat-dispatch-"));
process.env.PIORA_ROOMS_ROOT = root;
const jiti = createJiti(import.meta.url);
const rooms = await jiti.import("./room-store.ts");
const chat = await jiti.import("./room-chat.ts");

class FakeRouter {
  commands = [];
  listeners = new Map();

  async dispatchSessionMessage(input) {
    const commandId = `command-${this.commands.length + 1}`;
    this.commands.push({ commandId, input });
    return { accepted: true, commandId, sessionId: input.targetSessionId, status: "queued" };
  }

  subscribeEvents(sessionId, listener) {
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => listeners.delete(listener);
  }

  async getCommand(commandId) {
    const command = this.commands.find((candidate) => candidate.commandId === commandId);
    return { commandId, status: "queued", targetSessionId: command?.input.targetSessionId };
  }
}

test.after(() => {
  delete process.env.PIORA_ROOMS_ROOT;
  rmSync(root, { recursive: true, force: true });
});

test("free group conversations apply custom identities without mandatory task intake", async () => {
  const { createRoomChatProfile } = await jiti.import("./team-agent-templates.ts");
  const room = rooms.createRoom({ name: "写作搭档", creator: {
    sessionId: "custom-member", name: "小林", role: "coordinator",
    profile: createRoomChatProfile({ role: "coordinator", name: "小林", roleDescription: "一位写作搭档",
      systemPrompt: "用中文回答", personality: ["回答简短"], constraints: ["保留用户原文"] }),
  } });
  const router = new FakeRouter();
  await chat.dispatchRoomChat(room.id, { messageId: "custom-message", content: "聊聊人物设定",
    intake: true, targetSessionIds: ["custom-member"], router });
  const prompt = router.commands[0].input.content;
  for (const text of ["一位写作搭档", "用中文回答", "回答简短", "保留用户原文"]) assert.ok(prompt.includes(text));
  assert.doesNotMatch(prompt, /delegate through piora_room action start_run|beginning with @/);
  assert.match(prompt, /Answer the message directly/);
});

test("free group handoffs reach the named peer with shared context and stop at the round limit", async () => {
  let room = rooms.createRoom({ name: "发布讨论", description: "写一份有依据的说明",
    creator: { sessionId: "owner", name: "群主" } });
  room = rooms.addRoomMember(room.id, { sessionId: "research", name: "小研", instructions: "查找资料" });
  room = rooms.addRoomMember(room.id, { sessionId: "writer", name: "小文", instructions: "撰写说明" });
  rooms.appendPrivateNote(room.id, "research", "PRIVATE_ONLY_SENTINEL");
  const original = rooms.appendRoomMessage(room.id, { authorKind: "user", authorId: "user",
    content: "请基于资料完成说明，保持简短", autoRound: 0, forwardDepth: 0, maxAutoRounds: 8 });
  const handoff = rooms.appendRoomMessage(room.id, { authorKind: "session", authorId: "research",
    authorName: "小研", content: "@小文 资料已核实，请据此写说明", replyTo: original.id,
    ...chat.deriveRoomReplyRoutingMetadata(room.id, original.id) });
  rooms.appendRoomMessage(room.id, { authorKind: "user", authorId: "user", content: "FUTURE_MESSAGE_SENTINEL" });
  const router = new FakeRouter();
  const sent = await chat.dispatchExplicitRoomMentions(room.id, handoff, router);
  assert.deepEqual(sent.dispatched.map(item => item.sessionId), ["writer"]);
  const prompt = router.commands[0].input.content;
  for (const text of ["写一份有依据的说明", "查找资料", "撰写说明", original.content, "handoff"]) assert.ok(prompt.includes(text));
  assert.doesNotMatch(prompt, /PRIVATE_ONLY_SENTINEL|FUTURE_MESSAGE_SENTINEL|Do not wake other members unless/);
  assert.match(prompt, /Automatic response round: 1\/8/);
  const lastRound = rooms.appendRoomMessage(room.id, { authorKind: "session", authorId: "writer",
    content: "@小研 核实最后一个细节", autoRound: 8, forwardDepth: 8, maxAutoRounds: 8 });
  const exhausted = rooms.appendRoomMessage(room.id, { authorKind: "session", authorId: "research",
    content: "@小文 已核实", replyTo: lastRound.id, ...chat.deriveRoomReplyRoutingMetadata(room.id, lastRound.id) });
  assert.equal(rooms.findRoomMessage(room.id, exhausted.id).autoRound, 9);
  const stopped = await chat.dispatchExplicitRoomMentions(room.id, exhausted, router);
  assert.equal(stopped.dispatched.length, 0);
  assert.equal(stopped.skipped[0].code, "ROOM_ROUTING_LIMIT");
  assert.equal(router.commands.length, 1);
});

test("broadcast replies do not start another automatic round", async () => {
  let room = rooms.createRoom({ name: "广播", creator: { sessionId: "broadcast-a", name: "甲" } });
  room = rooms.addRoomMember(room.id, { sessionId: "broadcast-b", name: "乙" });
  const message = rooms.appendRoomMessage(room.id, { authorKind: "user", authorId: "user",
    content: "@所有人 提意见", autoRound: 0, maxAutoRounds: 0 });
  const reply = rooms.appendRoomMessage(room.id, { authorKind: "session", authorId: "broadcast-a",
    content: "@乙 看一下", replyTo: message.id, ...chat.deriveRoomReplyRoutingMetadata(room.id, message.id) });
  const router = new FakeRouter();
  const stopped = await chat.dispatchExplicitRoomMentions(room.id, reply, router);
  assert.equal(stopped.dispatched.length, 0);
  assert.equal(stopped.skipped[0].code, "ROOM_ROUTING_LIMIT");
});

test("an Agent's shared @mention is delivered to the mentioned Session and preserves the scheduling chain", async () => {
  let room = rooms.createRoom({ name: "Mention routing", creator: { sessionId: "lead-session", name: "Lead", role: "coordinator" } });
  room = rooms.addRoomMember(room.id, { sessionId: "worker-session", name: "Coder", role: "worker" });
  room = rooms.addRoomMember(room.id, { sessionId: "review-session", name: "Reviewer", role: "reviewer" });
  room = rooms.configureRoomCoordination(room.id, { mode: "team", coordinatorSessionId: "lead-session" });
  const router = new FakeRouter();

  const assignment = rooms.appendRoomMessage(room.id, {
    authorKind: "session",
    authorId: "lead-session",
    authorName: "Lead",
    content: "@Coder 请先完成编码",
    forwardDepth: 1,
    autoRound: 1,
    maxAutoRounds: 6,
  });
  const assigned = await chat.dispatchExplicitRoomMentions(room.id, assignment, router);
  assert.deepEqual(assigned.dispatched.map((item) => item.sessionId), ["worker-session"]);
  assert.equal(router.commands[0].input.targetSessionId, "worker-session");
  assert.match(router.commands[0].input.content, /Shared message from: Lead/);
  assert.match(router.commands[0].input.content, /@Lead/);

  const completion = rooms.appendRoomMessage(room.id, {
    authorKind: "session",
    authorId: "worker-session",
    authorName: "Coder",
    content: "@Lead 编码已完成，可以安排审查",
    replyTo: assignment.id,
    ...chat.deriveRoomReplyRoutingMetadata(room.id, assignment.id),
  });
  const reported = await chat.dispatchExplicitRoomMentions(room.id, completion, router);
  assert.deepEqual(reported.dispatched.map((item) => item.sessionId), ["lead-session"]);
  assert.equal(router.commands[1].input.targetSessionId, "lead-session");
  assert.equal(completion.autoRound, 2);
  assert.equal(completion.forwardDepth, 2);

  const prematureReview = rooms.appendRoomMessage(room.id, {
    authorKind: "session",
    authorId: "worker-session",
    authorName: "Coder",
    content: "@Reviewer 请直接开始审查",
    replyTo: assignment.id,
    ...chat.deriveRoomReplyRoutingMetadata(room.id, assignment.id),
  });
  const rescheduled = await chat.dispatchExplicitRoomMentions(room.id, prematureReview, router);
  assert.deepEqual(rescheduled.dispatched.map((item) => item.sessionId), ["lead-session"]);
  assert.equal(rescheduled.skipped[0].code, "ROOM_COORDINATOR_SCHEDULED");

  const combinedAssignment = rooms.appendRoomMessage(room.id, {
    authorKind: "session",
    authorId: "lead-session",
    authorName: "Lead",
    content: "@Reviewer 等待，@Coder 先编码",
  });
  const serialized = await chat.dispatchExplicitRoomMentions(room.id, combinedAssignment, router);
  assert.deepEqual(serialized.dispatched, []);
  assert.deepEqual(serialized.skipped.map((item) => item.sessionId), ["review-session", "worker-session"]);
  assert.equal(serialized.skipped[0].code, "ROOM_COORDINATOR_ONE_TARGET");

  const noMention = rooms.appendRoomMessage(room.id, {
    authorKind: "session",
    authorId: "lead-session",
    authorName: "Lead",
    content: "收到，暂时不调度其他人",
  });
  assert.deepEqual(await chat.dispatchExplicitRoomMentions(room.id, noMention, router), { dispatched: [], skipped: [] });
  assert.equal(router.commands.length, 3);
});
