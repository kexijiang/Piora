import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const { HarmonyTransferJobs } = await createJiti(import.meta.url).import("./harmony/transfer-jobs.ts");
const scope = { kind: "shared" };
const items = [
  { direction: "upload", sourcePath: "/local/a", path: "/data/local/tmp/a", overwrite: false },
  { direction: "download", path: "/data/local/tmp/b", destinationPath: "/local/b" },
];
const settled = async (jobs, id) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = jobs.list()[0];
    if (value?.id === id && !["queued", "running"].includes(value.status)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Transfer did not settle");
};

test("batch transfer runs in order and persists confirmed item progress without its lease token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-transfer-jobs-"));
  try {
    const path = join(directory, "jobs.json"), calls = [];
    const jobs = new HarmonyTransferJobs(path, async (_job, item, token) => { calls.push([item.direction, token]); return { size: item.direction === "upload" ? 3 : 4 }; });
    const initial = jobs.create("phone", scope, items, "secret-lease-token");
    assert.equal(initial.status, "queued");
    const final = await settled(jobs, initial.id);
    assert.equal(final.status, "completed");
    assert.equal(final.completedItems, 2);
    assert.equal(final.completedBytes, 7);
    assert.deepEqual(calls, [["upload", "secret-lease-token"], ["download", "secret-lease-token"]]);
    assert.equal((await readFile(path, "utf8")).includes("secret-lease-token"), false);
    jobs.remove(initial.id);
    assert.deepEqual(jobs.list(), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("cancel aborts an in-flight item and never starts later batch entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-transfer-cancel-"));
  try {
    let started = 0;
    const jobs = new HarmonyTransferJobs(join(directory, "jobs.json"), async (_job, _item, _token, signal) => {
      started++;
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return { size: 0 };
    });
    const job = jobs.create("phone", scope, items, "lease");
    while (!started) await new Promise(resolve => setTimeout(resolve, 5));
    jobs.cancel(job.id);
    const final = await settled(jobs, job.id);
    assert.equal(final.status, "cancelled");
    assert.equal(final.items[0].status, "interrupted");
    assert.equal(final.items[0].effect, "unknown");
    assert.equal(final.items[1].status, "cancelled");
    assert.equal(started, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("restart marks unfinished tasks interrupted rather than replaying writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-transfer-restart-"));
  try {
    const path = join(directory, "jobs.json");
    await writeFile(path, JSON.stringify([{ id: "job", serial: "phone", scope, status: "running", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      completedItems: 0, totalItems: 1, completedBytes: 0, items: [{ ...items[0], status: "running" }] }]));
    const jobs = new HarmonyTransferJobs(path, async () => { throw new Error("must not replay"); });
    assert.equal(jobs.list()[0].status, "interrupted");
    assert.equal(jobs.list()[0].items[0].effect, "unknown");
    assert.equal(JSON.parse(await readFile(path, "utf8"))[0].status, "interrupted");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("task-owned device control is released before completion becomes visible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-transfer-lease-"));
  try {
    const released = [];
    const jobs = new HarmonyTransferJobs(join(directory, "jobs.json"), async () => ({ size: 1 }),
      { renew: () => undefined, release: token => { released.push(token); } });
    const job = jobs.create("phone", scope, [items[0]], "task-token");
    assert.equal((await settled(jobs, job.id)).status, "completed");
    assert.deepEqual(released, ["task-token"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
