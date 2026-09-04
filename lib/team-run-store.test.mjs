import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "piora-team-store-"));
const jiti = createJiti(import.meta.url);
const { TeamRunStore } = await jiti.import("./team-run-store.ts");

test.after(() => rmSync(root, { recursive: true, force: true }));

function dispatch(taskId, purpose = "planning") {
  return {
    dispatchId: randomUUID(), purpose, taskId, memberId: "coordinator", sessionId: "coordinator-session",
    attempt: 1, leaseTokenHash: "hash", status: "requested", requestedAt: Date.now(), updatedAt: Date.now(),
  };
}

function task(runId) {
  const now = Date.now();
  return {
    schemaVersion: 1, id: "work", teamRunId: runId, title: "Work", description: "Do work", acceptanceCriteria: ["Done"],
    requiredCapabilities: [], dependsOn: [], priority: 0, status: "pending", assignmentMode: "auto", attempt: 0, maxAttempts: 3,
    reviewPolicy: { required: false, reviewerMemberIds: [], minimumApprovals: 0 }, reviewRound: 0, createdAt: now, updatedAt: now,
  };
}

async function createRunning(store) {
  const roomId = randomUUID();
  const runId = randomUUID();
  let state = await store.createTeamRun({ roomId, teamRunId: runId, objective: "Concurrent run", coordinatorMemberId: "coordinator", createdBy: { kind: "user", id: "user" } });
  const planning = dispatch("__planning__");
  const work = task(runId);
  const plan = { schemaVersion: 1, revision: 1, objective: "Concurrent run", assumptions: [], successCriteria: [], taskIds: [work.id], submittedByMemberId: "coordinator", createdAt: Date.now(), updatedAt: Date.now() };
  state = await store.appendTeamRunEvents(roomId, runId, state.revision, [
    { type: "planning.requested", dispatch: planning },
    { type: "plan.submitted", plan, tasks: [work] },
    { type: "run.started" },
  ]);
  return { roomId, runId, state };
}

test("TeamRun store persists, replays, snapshots, and cursor slices", async () => {
  const store = new TeamRunStore({ roomsRoot: root });
  const { roomId, runId, state } = await createRunning(store);
  assert.equal(state.phase, "running");
  assert.equal(state.revision, 4);
  assert.deepEqual(store.listTeamRunEvents(roomId, runId, 2).map((event) => event.cursor), [3, 4]);
  assert.equal(store.getTeamRun(roomId, runId).revision, 4);
  assert.ok(existsSync(store.paths(roomId, runId).snapshot));
});

test("50 concurrent writers preserve every event and strictly increasing revisions for 20 rounds", { timeout: 120_000 }, async () => {
  const store = new TeamRunStore({ roomsRoot: root });
  for (let round = 0; round < 20; round += 1) {
    const { roomId, runId } = await createRunning(store);
    async function append(index) {
      for (;;) {
        const current = store.getTeamRun(roomId, runId);
        try {
          await store.appendTeamRunEvents(roomId, runId, current.revision, [{ type: "run.progressed", summary: `round-${round}-writer-${index}` }]);
          return;
        } catch (error) {
          if (error.code !== "TEAM_REVISION_CONFLICT") throw error;
        }
      }
    }
    await Promise.all(Array.from({ length: 50 }, (_, index) => append(index)));
    const events = store.listTeamRunEvents(roomId, runId);
    assert.equal(events.length, 54);
    assert.deepEqual(events.map((event) => event.cursor), Array.from({ length: 54 }, (_, index) => index + 1));
    assert.equal(new TeamRunStore({ roomsRoot: root }).getTeamRun(roomId, runId).revision, 54);
  }
});

test("revision conflicts fail closed and do not append partial batches", async () => {
  const store = new TeamRunStore({ roomsRoot: root });
  const { roomId, runId, state } = await createRunning(store);
  await assert.rejects(store.appendTeamRunEvents(roomId, runId, state.revision - 1, [{ type: "run.progressed", summary: "stale" }]), (error) => error.code === "TEAM_REVISION_CONFLICT");
  assert.equal(store.getTeamRun(roomId, runId).revision, state.revision);
});

test("corrupt snapshots rebuild from events and an incomplete journal tail is truncated", async () => {
  const store = new TeamRunStore({ roomsRoot: root });
  const { roomId, runId, state } = await createRunning(store);
  const paths = store.paths(roomId, runId);
  writeFileSync(paths.snapshot, "{broken", "utf8");
  writeFileSync(paths.events, `${readFileSync(paths.events, "utf8")}{\"schemaVersion\":1`, "utf8");
  assert.equal(store.getTeamRun(roomId, runId).revision, state.revision);
  assert.doesNotThrow(() => JSON.parse(readFileSync(paths.snapshot, "utf8")));
  assert.ok(readFileSync(paths.events, "utf8").endsWith("\n"));
});

test("middle journal corruption fails closed", async () => {
  const store = new TeamRunStore({ roomsRoot: root });
  const { roomId, runId } = await createRunning(store);
  const paths = store.paths(roomId, runId);
  const lines = readFileSync(paths.events, "utf8").trimEnd().split("\n");
  lines.splice(2, 0, "{broken");
  writeFileSync(paths.events, `${lines.join("\n")}\n`, "utf8");
  assert.throws(() => store.getTeamRun(roomId, runId), (error) => error.code === "TEAM_EVENT_LOG_CORRUPT");
});

test("outbox is idempotent and delivery is durable", async () => {
  const store = new TeamRunStore({ roomsRoot: root });
  const { roomId, runId } = await createRunning(store);
  const first = await store.appendTeamOutbox(roomId, runId, { kind: "dispatch", idempotencyKey: "dispatch:one", payload: { sessionId: "worker" } });
  const duplicate = await store.appendTeamOutbox(roomId, runId, { kind: "dispatch", idempotencyKey: "dispatch:one", payload: { sessionId: "other" } });
  assert.equal(duplicate.id, first.id);
  const delivered = await store.markTeamOutboxDelivered(roomId, runId, first.id);
  assert.equal(delivered.status, "delivered");
  assert.equal(store.listTeamOutbox(roomId, runId, { pendingOnly: true }).length, 0);
});

test("10,000-event cold replay and verified snapshot recovery stay within runtime budgets", async () => {
  const store = new TeamRunStore({ roomsRoot: root });
  const { roomId, runId, state } = await createRunning(store);
  const progress = Array.from({ length: 10_000 - state.revision }, (_, index) => ({
    type: "run.progressed", summary: `progress-${index}`,
  }));
  await store.appendTeamRunEvents(roomId, runId, state.revision, progress);
  const paths = store.paths(roomId, runId);

  const snapshotStarted = performance.now();
  const recovered = new TeamRunStore({ roomsRoot: root }).getTeamRun(roomId, runId);
  const snapshotMs = performance.now() - snapshotStarted;
  assert.equal(recovered.revision, 10_000);
  assert.ok(snapshotMs <= 1_000, `snapshot recovery took ${snapshotMs.toFixed(1)}ms`);

  unlinkSync(paths.snapshot);
  const replayStarted = performance.now();
  const replayed = new TeamRunStore({ roomsRoot: root }).getTeamRun(roomId, runId);
  const replayMs = performance.now() - replayStarted;
  assert.equal(replayed.revision, 10_000);
  assert.ok(replayMs <= 3_000, `cold replay took ${replayMs.toFixed(1)}ms`);
});
