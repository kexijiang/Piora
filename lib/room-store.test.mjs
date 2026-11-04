import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "piora-room-test-"));
process.env.PIORA_ROOMS_ROOT = root;
const jiti = createJiti(import.meta.url);
const rooms = await jiti.import("./room-store.ts");
const templates = await jiti.import("./team-agent-templates.ts");
const { TeamRunStore } = await jiti.import("./team-run-store.ts");

test.after(() => {
  delete process.env.PIORA_ROOMS_ROOT;
  rmSync(root, { recursive: true, force: true });
});

test("room store creates shared and per-session private areas", () => {
  const room = rooms.createRoom({
    name: "Implementation room",
    projectRoot: root,
    creator: { sessionId: "session-a", name: "Architect", role: "coordinator" },
  });
  assert.ok(existsSync(room.paths.shared));
  assert.ok(existsSync(room.paths.privateRoot));
  assert.equal(room.members[0].sessionId, "session-a");
  assert.equal(rooms.listRooms("session-a")[0].id, room.id);
  assert.equal(rooms.listRooms("session-b").length, 0);
});

test("room messages are ordered, broadcast, and visible to joined sessions", () => {
  const room = rooms.createRoom({
    name: "Shared transcript",
    creator: { sessionId: "session-a", name: "A", role: "coordinator" },
  });
  rooms.addRoomMember(room.id, { sessionId: "session-b", name: "B", role: "worker" });
  const observed = [];
  const unsubscribe = rooms.subscribeRoom(room.id, (message) => observed.push(message));
  const sent = rooms.appendRoomMessage(room.id, { authorKind: "session", authorId: "session-a", content: "API is ready" });
  unsubscribe();
  assert.equal(observed[0].id, sent.id);
  assert.deepEqual(rooms.listRoomMessages(room.id, { afterSeq: sent.seq - 1 }).map((message) => message.content), ["API is ready"]);
  assert.equal(rooms.listRooms("session-b")[0].id, room.id);
});

test("Room messages preserve the exact 256 KiB UTF-8 boundary and blob content", () => {
  const room = rooms.createRoom({ name: "Large transcript", creator: { sessionId: "large-author", role: "coordinator" } });
  const exact = "x".repeat(256 * 1024);
  const message = rooms.appendRoomMessage(room.id, { authorKind: "session", authorId: "large-author", content: exact });
  assert.equal(message.payload.byteLength, 256 * 1024);
  assert.equal(message.payload.truncated, true);
  assert.equal(message.content.split("\n").length, 1);
  assert.equal(rooms.readRoomMessageFullContent(room.id, message.id), exact);
  assert.throws(
    () => rooms.appendRoomMessage(room.id, { authorKind: "session", authorId: "large-author", content: `${exact}x` }),
    (error) => error?.code === "TEAM_INPUT_TOO_LARGE" && error?.status === 413,
  );
});

test("private notes remain in the addressed session area", () => {
  const room = rooms.createRoom({
    name: "Private state",
    creator: { sessionId: "session-a", role: "coordinator" },
  });
  rooms.addRoomMember(room.id, { sessionId: "session-b" });
  rooms.appendPrivateNote(room.id, "session-a", "A-only scratchpad");
  rooms.appendPrivateNote(room.id, "session-b", "B-only scratchpad");
  assert.deepEqual(rooms.listPrivateNotes(room.id, "session-a").map((note) => note.content), ["A-only scratchpad"]);
  assert.deepEqual(rooms.listPrivateNotes(room.id, "session-b").map((note) => note.content), ["B-only scratchpad"]);
});

test("coordinator tasks enforce dedupe, leases, and concurrency", () => {
  const room = rooms.createRoom({
    name: "Coordinator",
    creator: { sessionId: "coordinator", role: "coordinator" },
  });
  rooms.addRoomMember(room.id, { sessionId: "worker-a", role: "worker" });
  rooms.addRoomMember(room.id, { sessionId: "worker-b", role: "worker" });
  rooms.configureRoomCoordination(room.id, { mode: "coordinator", coordinatorSessionId: "coordinator", maxConcurrency: 1 });
  const first = rooms.createRoomTask(room.id, { title: "Implement", description: "Implement API", createdBy: "coordinator", dedupeKey: "api" });
  const duplicate = rooms.createRoomTask(room.id, { title: "Duplicate", description: "Must dedupe", createdBy: "coordinator", dedupeKey: "api" });
  assert.equal(duplicate.id, first.id);
  const second = rooms.createRoomTask(room.id, { title: "Test", description: "Test API", createdBy: "coordinator", dedupeKey: "tests" });
  const leased = rooms.claimRoomTask(room.id, first.id, "worker-a");
  assert.equal(leased.status, "leased");
  assert.throws(() => rooms.claimRoomTask(room.id, second.id, "worker-b"), /最大并发数/);
  assert.throws(() => rooms.heartbeatRoomTask(room.id, first.id, "worker-a", "wrong-token"), /valid task lease/);
  const running = rooms.heartbeatRoomTask(room.id, first.id, "worker-a", leased.lease.token);
  assert.equal(running.status, "running");
  const completed = rooms.finishRoomTask(room.id, first.id, "worker-a", leased.lease.token, { status: "completed", result: "API verified" });
  assert.equal(completed.status, "completed");
  assert.equal(rooms.finishRoomTask(room.id, first.id, "worker-a", leased.lease.token, { status: "completed", result: "API verified" }).id, first.id);
  assert.equal(rooms.claimRoomTask(room.id, second.id, "worker-b").assignedTo, "worker-b");
});

test("expired task leases are recovered for retry", () => {
  const room = rooms.createRoom({
    name: "Lease recovery",
    creator: { sessionId: "coordinator-x", role: "coordinator" },
  });
  rooms.addRoomMember(room.id, { sessionId: "worker-x", role: "worker" });
  rooms.configureRoomCoordination(room.id, { mode: "coordinator", coordinatorSessionId: "coordinator-x" });
  const task = rooms.createRoomTask(room.id, { title: "Recover", description: "Recover expired work", createdBy: "coordinator-x" });
  const leased = rooms.claimRoomTask(room.id, task.id, "worker-x");
  const path = join(room.paths.shared, "tasks", `${task.id}.json`);
  const persisted = JSON.parse(readFileSync(path, "utf8"));
  persisted.lease.expiresAt = Date.now() - 1;
  writeFileSync(path, `${JSON.stringify(persisted)}\n`, "utf8");
  const recovered = rooms.listRoomTasks(room.id).find((item) => item.id === leased.id);
  assert.equal(recovered.status, "pending");
  assert.equal(recovered.lease, undefined);
});

test("parallel leases require separate worktrees", () => {
  const sharedCwd = join(root, "shared-workspace");
  mkdirSync(sharedCwd, { recursive: true });
  const room = rooms.createRoom({
    name: "Workspace locks",
    projectRoot: root,
    creator: { sessionId: "workspace-coordinator", role: "coordinator", cwd: root, projectRoot: root },
  });
  rooms.addRoomMember(room.id, { sessionId: "workspace-a", role: "worker", cwd: sharedCwd, projectRoot: root });
  rooms.addRoomMember(room.id, { sessionId: "workspace-b", role: "worker", cwd: sharedCwd, projectRoot: root });
  rooms.configureRoomCoordination(room.id, { mode: "coordinator", coordinatorSessionId: "workspace-coordinator", maxConcurrency: 2 });
  const first = rooms.createRoomTask(room.id, { title: "A", description: "First", createdBy: "workspace-coordinator", assignedTo: "workspace-a" });
  const second = rooms.createRoomTask(room.id, { title: "B", description: "Second", createdBy: "workspace-coordinator", assignedTo: "workspace-b" });
  rooms.claimRoomTask(room.id, first.id, "workspace-a");
  assert.throws(() => rooms.claimRoomTask(room.id, second.id, "workspace-b"), /separate worktree/);
  const crossProject = rooms.addRoomMember(room.id, { sessionId: "foreign", cwd: join(root, "other"), projectRoot: join(root, "other") });
  assert.equal(crossProject.members.some((member) => member.sessionId === "foreign"), true);
});

test("worktree artifacts are copied into the shared artifact area", () => {
  const workspace = join(root, "artifact-worktree");
  mkdirSync(workspace, { recursive: true });
  const source = join(workspace, "result.patch");
  writeFileSync(source, "diff --git a/a b/a\n", "utf8");
  const room = rooms.createRoom({
    name: "Artifacts",
    projectRoot: root,
    creator: { sessionId: "artifact-session", role: "coordinator", cwd: workspace, projectRoot: root, worktreeBranch: "codex/artifact" },
  });
  const artifact = rooms.publishRoomArtifact(room.id, "artifact-session", {
    kind: "patch",
    name: "result.patch",
    summary: "Verified patch",
    sourcePath: "result.patch",
  });
  assert.ok(artifact.storedPath && existsSync(artifact.storedPath));
  assert.equal(artifact.worktree.branch, "codex/artifact");
  assert.equal(rooms.listRoomArtifacts(room.id)[0].id, artifact.id);
  assert.throws(() => rooms.publishRoomArtifact(room.id, "artifact-session", {
    kind: "file",
    name: "escape",
    summary: "must fail",
    sourcePath: "../outside.txt",
  }), /stay inside/);
});

test("only a coordinator can delete a room", () => {
  const room = rooms.createRoom({
    name: "Disposable",
    creator: { sessionId: "delete-coordinator", role: "coordinator" },
  });
  rooms.addRoomMember(room.id, { sessionId: "delete-worker", role: "worker" });
  assert.throws(() => rooms.deleteRoom(room.id, "delete-worker"), /Only the room coordinator/);
  rooms.deleteRoom(room.id, "delete-coordinator");
  assert.equal(existsSync(room.paths.root), false);
});

test("managed coordinator creation transfers coordination in one authorized commit", () => {
  const room = rooms.createRoom({
    name: "Managed coordinator",
    projectRoot: root,
    creator: { sessionId: "original-coordinator", name: "Original", role: "coordinator", cwd: root, projectRoot: root },
  });
  const profile = templates.createTeamAgentProfile("coordinator", { name: "Managed Lead" });
  const saved = rooms.addManagedRoomMember(room.id, {
    memberId: "managed-lead-member",
    profile,
    binding: {
      sessionId: "managed-lead-session",
      cwd: root,
      projectRoot: root,
      managedByPiora: true,
      boundAt: Date.now(),
      status: "ready",
    },
    requestedBy: "original-coordinator",
  });
  const managed = saved.members.find((member) => member.memberId === "managed-lead-member");
  const original = saved.members.find((member) => member.sessionId === "original-coordinator");
  assert.equal(saved.coordination.coordinatorMemberId, managed.memberId);
  assert.equal(managed.profile.revision, 1);
  assert.equal(managed.binding.status, "ready");
  assert.equal(original.role, "participant");
  assert.throws(() => rooms.updateRoomProfile(room.id, "original-coordinator", { name: "Denied" }), /Only the room coordinator/);
  assert.equal(rooms.updateRoomProfile(room.id, "managed-lead-session", { name: "Transferred" }).name, "Transferred");
});

test("room identity, Agent binding, and shared workspace are independently configurable", () => {
  const room = rooms.createRoom({
    name: "Original name",
    projectRoot: root,
    creator: { sessionId: "settings-coordinator", name: "Lead", role: "coordinator", cwd: root, projectRoot: root },
  });
  rooms.addRoomMember(room.id, { sessionId: "settings-worker", name: "Builder", role: "worker", cwd: root, projectRoot: root });
  const worker = rooms.getRoom(room.id).members.find((member) => member.sessionId === "settings-worker");
  const privateBefore = rooms.getPrivateRoomDirectory(room.id, "settings-worker");
  rooms.appendPrivateNote(room.id, "settings-worker", "stable private memory");
  const pending = rooms.createRoomTask(room.id, { title: "Keep assignment", description: "Must follow the Agent", createdBy: "settings-coordinator", assignedTo: "settings-worker" });

  const renamed = rooms.updateRoomProfile(room.id, "settings-coordinator", { name: "Platform team", description: "Ship a verified platform" });
  assert.equal(renamed.name, "Platform team");
  assert.equal(renamed.description, "Ship a verified platform");

  const customWorkspace = join(root, "team-workspace");
  const configured = rooms.updateRoomWorkspace(room.id, "settings-coordinator", {
    mode: "custom",
    path: customWorkspace,
    label: "Team handoff",
    instructions: "Use one directory per Agent",
  });
  assert.equal(configured.workspace.path, customWorkspace);
  assert.equal(configured.workspace.label, "Team handoff");
  assert.ok(existsSync(customWorkspace));
  assert.throws(() => rooms.updateRoomWorkspace(room.id, "settings-coordinator", { mode: "custom", path: join(tmpdir(), "outside-room-project") }), /inside one of the room members' projects/);

  const rebound = rooms.updateRoomMember(room.id, "settings-coordinator", worker.memberId, {
    sessionId: "settings-worker-next",
    name: "Implementation Agent",
    instructions: "Implement only assigned tasks",
    role: "reviewer",
    cwd: root,
    projectRoot: root,
  });
  const updated = rebound.members.find((member) => member.memberId === worker.memberId);
  assert.equal(updated.sessionId, "settings-worker-next");
  assert.equal(updated.name, "Implementation Agent");
  assert.equal(updated.role, "reviewer");
  assert.equal(rooms.getPrivateRoomDirectory(room.id, "settings-worker-next"), privateBefore);
  assert.deepEqual(rooms.listPrivateNotes(room.id, "settings-worker-next").map((note) => note.content), ["stable private memory"]);
  assert.equal(rooms.getRoomTask(room.id, pending.id).assignedTo, "settings-worker-next");
  assert.equal(rooms.listRooms("settings-worker").length, 0);
  assert.equal(rooms.listRooms("settings-worker-next")[0].id, room.id);
  assert.throws(() => rooms.updateRoomProfile(room.id, "settings-worker-next", { name: "Unauthorized" }), /Only the room coordinator/);
  const auditActions = rooms.listRoomAudit(room.id).map((entry) => entry.action);
  assert.ok(auditActions.includes("room.updated"));
  assert.ok(auditActions.includes("workspace.updated"));
  assert.ok(auditActions.includes("member.updated"));
});

test("v1 rooms migrate without changing legacy Agent private identity", () => {
  const id = randomUUID();
  const roomRoot = join(root, id);
  const shared = join(roomRoot, "shared");
  const privateRoot = join(roomRoot, "private");
  const legacySessionId = "legacy-session";
  const legacyPrivate = join(privateRoot, Buffer.from(legacySessionId).toString("base64url"));
  mkdirSync(shared, { recursive: true });
  mkdirSync(legacyPrivate, { recursive: true });
  writeFileSync(join(legacyPrivate, "notes.jsonl"), `${JSON.stringify({ id: randomUUID(), roomId: id, sessionId: legacySessionId, content: "legacy memory", createdAt: Date.now() })}\n`, "utf8");
  writeFileSync(join(roomRoot, "room.json"), `${JSON.stringify({
    schemaVersion: 1,
    id,
    name: "Legacy room",
    projectRoot: root,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nextSeq: 1,
    members: [{ sessionId: legacySessionId, name: "Legacy Agent", role: "coordinator", joinedAt: Date.now() }],
    coordination: { mode: "manual", maxConcurrency: 2, leaseDurationMs: 300_000 },
    paths: { root: roomRoot, shared, privateRoot },
  })}\n`, "utf8");

  const migrated = rooms.getRoom(id);
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.members[0].memberId, legacySessionId);
  assert.equal(migrated.members[0].binding.sessionId, legacySessionId);
  assert.equal(migrated.members[0].profile.name, "Legacy Agent");
  assert.equal(migrated.workspace.path, join(roomRoot, "workspace"));
  assert.deepEqual(rooms.listPrivateNotes(id, legacySessionId).map((note) => note.content), ["legacy memory"]);
  assert.equal(JSON.parse(readFileSync(join(roomRoot, "room.json"), "utf8")).schemaVersion, 3);
  assert.ok(existsSync(join(roomRoot, "room.json.v2.backup")));
});

test("v2 migration preserves memberId and turns non-terminal legacy tasks into interrupted TeamRuns exactly once", async () => {
  const id = randomUUID();
  const roomRoot = join(root, id);
  const shared = join(roomRoot, "shared");
  const tasks = join(shared, "tasks");
  const privateRoot = join(roomRoot, "private");
  const memberId = randomUUID();
  mkdirSync(tasks, { recursive: true });
  mkdirSync(join(privateRoot, Buffer.from(memberId).toString("base64url")), { recursive: true });
  const legacyTaskId = randomUUID();
  writeFileSync(join(tasks, `${legacyTaskId}.json`), `${JSON.stringify({ schemaVersion: 1, id: legacyTaskId, roomId: id, title: "Unfinished legacy work", description: "Do not rerun automatically", status: "running", priority: 4, createdBy: "legacy-session", dependsOn: [], attempt: 1, maxAttempts: 3, createdAt: Date.now(), updatedAt: Date.now() })}\n`);
  writeFileSync(join(roomRoot, "room.json"), `${JSON.stringify({
    schemaVersion: 2, id, name: "Legacy v2", createdAt: Date.now(), updatedAt: Date.now(), nextSeq: 1,
    members: [{ memberId, sessionId: "legacy-session", name: "Lead", role: "coordinator", joinedAt: Date.now() }],
    coordination: { mode: "coordinator", coordinatorSessionId: "legacy-session", maxConcurrency: 2, leaseDurationMs: 300_000 },
    workspace: { mode: "managed", path: join(roomRoot, "workspace"), label: "Workspace" },
    paths: { root: roomRoot, shared, privateRoot },
  })}\n`);
  const migrated = rooms.getRoom(id);
  assert.equal(migrated.members[0].memberId, memberId);
  assert.equal(migrated.coordination.coordinatorMemberId, memberId);
  assert.ok(existsSync(join(shared, "legacy-tasks", `${legacyTaskId}.json`)));
  const store = new TeamRunStore({ roomsRoot: root });
  const first = await store.migrateLegacyRoomTasks(id, memberId);
  const second = await store.migrateLegacyRoomTasks(id, memberId);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0].id, second[0].id);
  assert.equal(first[0].phase, "interrupted");
  assert.equal(Object.values(first[0].tasks)[0].status, "interrupted");
  assert.equal(store.listTeamRuns(id).length, 1);
});


test("member profile and binding save together and reject stale revisions", () => {
  const room = rooms.createRoom({name:"Atomic member",creator:{sessionId:"atomic-owner",name:"Owner",role:"coordinator"}});
  const member = room.members[0];
  const revision = member.profile.revision;
  const saved = rooms.updateRoomAgentProfile(room.id,"atomic-owner",member.memberId,revision,{name:"Renamed"},{sessionId:"atomic-new"});
  assert.equal(saved.members[0].profile.name,"Renamed");
  assert.equal(saved.members[0].binding.sessionId,"atomic-new");
  assert.throws(()=>rooms.updateRoomAgentProfile(room.id,"atomic-new",member.memberId,revision,{name:"Stale"},{sessionId:"atomic-stale"}),/配置已发生变化/);
  const actual = rooms.getRoom(room.id).members[0];
  assert.equal(actual.profile.name,"Renamed");
  assert.equal(actual.binding.sessionId,"atomic-new");
  assert.throws(()=>rooms.updateRoomAgentProfile(room.id,"atomic-new",member.memberId,actual.profile.revision,{name:""},{sessionId:"atomic-invalid"}));
  assert.equal(rooms.getRoom(room.id).members[0].binding.sessionId,"atomic-new");
});
