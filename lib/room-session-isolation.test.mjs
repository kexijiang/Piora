import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "piora-room-isolation-"));
process.env.PIORA_ROOMS_ROOT = join(root, "rooms");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const jiti = createJiti(import.meta.url);
const rooms = await jiti.import("./room-store.ts");
const { ensureRoomSessionIsolation } = await jiti.import("./room-session-isolation.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { persistLazySessionManager } = await jiti.import("./session-persistence.ts");
const { resolveSessionPath } = await jiti.import("./session-reader.ts");

test.after(() => {
  delete process.env.PIORA_ROOMS_ROOT;
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(root, { recursive: true, force: true });
});

test("two reused bindings get durable independent histories without copying private or other-room messages", async () => {
  const source = SessionManager.create(root);
  source.appendMessage({ role: "user", content: "PRIVATE_AND_ROOM_A_SECRET", timestamp: Date.now() });
  const sourceFile = persistLazySessionManager(source);
  const original = readFileSync(sourceFile, "utf8");
  const make = name => rooms.createRoom({ name, creator: { sessionId: source.getSessionId(), name: "Assistant", cwd: root,
    profile: { systemPrompt: "Keep this role configuration" } } });
  const a = make("Room A");
  const b = make("Room B");
  // Also cover historical managed bindings accidentally shared by two rooms.
  rooms.updateRoomAgentBinding(a.id, source.getSessionId(), a.members[0].memberId, { managedByPiora: true });
  rooms.updateRoomAgentBinding(b.id, source.getSessionId(), b.members[0].memberId, { managedByPiora: true });
  const isolatedA = ensureRoomSessionIsolation(a.id);
  assert.throws(() => rooms.assertRoomSessionIsolated(b.id, source.getSessionId()), /尚未隔离/);
  const isolatedB = ensureRoomSessionIsolation(b.id);
  const aId = isolatedA.members[0].sessionId;
  const bId = isolatedB.members[0].sessionId;
  assert.equal(new Set([source.getSessionId(), aId, bId]).size, 3);
  for (const room of [isolatedA, isolatedB]) {
    const member = room.members[0];
    assert.equal(member.profile.systemPrompt, "Keep this role configuration");
    assert.doesNotThrow(() => rooms.assertRoomSessionIsolated(room.id, member.sessionId));
    const file = await resolveSessionPath(member.sessionId);
    const reopened = SessionManager.open(file);
    assert.equal(reopened.getSessionId(), member.sessionId);
    assert.deepEqual(reopened.buildSessionContext().messages, []);
    assert.doesNotMatch(readFileSync(file, "utf8"), /PRIVATE_AND_ROOM_A_SECRET/);
    assert.equal(ensureRoomSessionIsolation(room.id).members[0].sessionId, member.sessionId);
  }
  assert.equal(readFileSync(sourceFile, "utf8"), original);
});

test("busy legacy bindings defer migration and reject room admission until idle", () => {
  const room = rooms.createRoom({ name: "Busy", creator: { sessionId: "busy-original", cwd: root } });
  let created = 0;
  const create = (_room, member) => { created++; return { ...member.binding, sessionId: "fresh-id", managedByPiora: true }; };
  rooms.isolateRoomMemberSessions(room.id, { isBusy: () => true, create });
  assert.equal(created, 0);
  assert.throws(() => rooms.assertRoomSessionIsolated(room.id, "busy-original"), /尚未隔离/);
  const isolated = rooms.isolateRoomMemberSessions(room.id, { isBusy: () => false, create });
  assert.equal(created, 1);
  assert.equal(isolated.members[0].memberId, room.members[0].memberId);
  assert.doesNotThrow(() => rooms.assertRoomSessionIsolated(room.id, "fresh-id"));
  assert.throws(() => rooms.assertRoomSessionIsolated(room.id, "busy-original"), /尚未隔离/);
});

test("failed persistence leaves the original binding available for retry", () => {
  const room = rooms.createRoom({ name: "Retry", creator: { sessionId: "retry-original", cwd: root } });
  assert.throws(() => rooms.isolateRoomMemberSessions(room.id, { isBusy: () => false, create: () => { throw new Error("disk full"); } }), /disk full/);
  assert.equal(rooms.getRoom(room.id).members[0].sessionId, "retry-original");
  const fresh = ensureRoomSessionIsolation(room.id);
  assert.notEqual(fresh.members[0].sessionId, "retry-original");
});

test("interrupted binding migration reuses its durable receipt and retains private worktree ownership", () => {
  const room = rooms.createRoom({ name: "Interrupted", creator: { sessionId: "private-worktree", cwd: root, worktreeBranch: "private/branch" } });
  const task = rooms.createRoomTask(room.id, { title: "Pending", description: "Continue this assignment", createdBy: "private-worktree", assignedTo: "private-worktree" });
  const metadata = join(room.paths.root, "room.json");
  const original = readFileSync(metadata, "utf8");
  const first = ensureRoomSessionIsolation(room.id);
  const freshId = first.members[0].sessionId;
  assert.equal(first.members[0].binding.worktreeBranch, undefined);
  assert.equal(rooms.listRoomTasks(room.id).find(item => item.id === task.id).assignedTo, freshId);
  // Simulate a crash after task persistence but before the room metadata rename.
  writeFileSync(metadata, original);
  const recovered = ensureRoomSessionIsolation(room.id);
  assert.equal(recovered.members[0].sessionId, freshId);
  assert.equal(rooms.listRoomTasks(room.id).find(item => item.id === task.id).assignedTo, freshId);
});
