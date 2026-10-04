import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { summarizeHarmonyTasks } = await createJiti(import.meta.url).import("./harmony/task-overview.ts");

test("task overview sorts existing work and separates active, completed and uncertain outcomes", () => {
  const result = summarizeHarmonyTasks({
    transfers: [{ id: "transfer", serial: "phone", status: "running", totalItems: 2, completedItems: 1, completedBytes: 12,
      createdAt: "2026-09-30T03:00:00Z", items: [] }],
    databases: [{ id: "database", serial: "phone", source: "Notes / sample.db", status: "failed", format: "csv", error: "snapshot expired",
      createdAt: "2026-09-30T05:00:00Z" }],
    scenarios: [{ id: "scenario-id", serial: "phone", status: "interrupted", startedAt: "2026-09-30T02:00:00Z",
      steps: [{ status: "passed" }, { status: "failed", message: "effect unknown" }] }],
    media: [{ kind: "screenshot", serial: "phone", filename: "screen.png", createdAt: "2026-09-30T04:00:00Z", size: 64 }],
  });
  assert.deepEqual(result.tasks.map(item => item.kind), ["database", "media", "transfer", "scenario"]);
  assert.deepEqual(result.counts, { all: 4, active: 1, completed: 1, attention: 2 });
  assert.equal(result.tasks.find(item => item.kind === "transfer").completedItems, 1);
  assert.equal(result.tasks.find(item => item.kind === "media").mediaKind, "screenshot");
  assert.match(result.tasks.find(item => item.kind === "scenario").error, /unknown/);
  assert.equal(result.truncated, false);
  assert.equal(summarizeHarmonyTasks({ transfers: [], databases: [], scenarios: [], media: [] }).counts.all, 0);
  assert.equal(summarizeHarmonyTasks({ transfers: [], databases: [], scenarios: [], media: result.tasks.map((_, index) => ({
    kind: "screenshot", filename: `screen-${index}.png`, createdAt: "2026-09-30T04:00:00Z", size: 64,
  })) }, 2).truncated, true);
  const olderAttention = summarizeHarmonyTasks({ transfers: [], databases: [], scenarios: [{ id: "old", status: "failed",
    startedAt: "2026-09-29T01:00:00Z", steps: [] }], media: result.tasks.map((_, index) => ({
    kind: "screenshot", filename: `screen-${index}.png`, createdAt: "2026-09-30T04:00:00Z", size: 64,
  })) }, 2, "attention");
  assert.deepEqual(olderAttention.tasks.map(item => item.id), ["old"], "filter before limiting recent tasks");
  assert.equal(olderAttention.counts.all, 5);
  assert.equal(olderAttention.truncated, false);
});

test("installation and capture outcomes join task filters without exposing live snapshot identifiers", () => {
  const input = { transfers: [], databases: [], scenarios: [], media: [], operations: [
    { id: "install", kind: "installation", serial: "phone", title: "app.hap", target: "C:/app.hap", status: "interrupted", createdAt: "2026-09-30T04:00:00Z" },
    { id: "capture", kind: "snapshot", serial: "phone", title: "Notes / notes.db", target: "Notes / notes.db", status: "completed",
      bytes: 8192, capturedAt: "2026-09-30T03:00:00Z", verification: "double-copy-sha256", createdAt: "2026-09-30T03:00:00Z" },
  ] };
  assert.deepEqual(summarizeHarmonyTasks(input).counts, { all: 2, active: 0, completed: 1, attention: 1 });
  assert.equal(summarizeHarmonyTasks(input, 100, "attention").tasks[0].kind, "installation");
  const capture = summarizeHarmonyTasks(input, 100, "completed").tasks[0];
  assert.equal(capture.bytes, 8192); assert.equal(capture.operation.capturedAt, "2026-09-30T03:00:00Z");
});

test("media task phases and failures are indexed once alongside legacy saved artifacts", () => {
  const input = { transfers: [], databases: [], scenarios: [], operations: [
    { id: "record", serial: "phone", kind: "recording", status: "running", phase: "recording", title: "Screen recording", target: "phone", createdAt: "2026-10-01T05:00:00Z" },
    { id: "shot", serial: "phone", kind: "screenshot", status: "completed", title: "Screenshot", target: "phone", mediaFilename: "screen.png", bytes: 16, createdAt: "2026-10-01T04:00:00Z" },
    { id: "failed", serial: "phone", kind: "recording", status: "interrupted", title: "Screen recording", target: "phone", error: "Release unknown", createdAt: "2026-10-01T03:00:00Z" },
  ], media: [
    { serial: "phone", kind: "screenshot", filename: "screen.png", size: 16, createdAt: "2026-10-01T04:00:00Z" },
    { serial: "phone", kind: "recording", filename: "legacy.mp4", size: 24, createdAt: "2026-10-01T02:00:00Z" },
  ] };
  const result = summarizeHarmonyTasks(input);
  assert.deepEqual(result.counts, { all: 4, active: 1, completed: 2, attention: 1 });
  assert.equal(result.tasks.filter(task => task.id === "screen.png").length, 0, "journal evidence replaces the same saved artifact row");
  assert.equal(result.tasks[0].mediaKind, "recording");
  assert.equal(result.tasks[0].operation.phase, "recording");
  assert.equal(summarizeHarmonyTasks(input, 100, "attention").tasks[0].id, "failed");
});
