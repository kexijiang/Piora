import assert from "node:assert/strict";
import test from "node:test";
import { allShards, findReusableTests, inspectTestJobs, selectMainPushRun, verifyTestPlan } from "../scripts/reuse-main-ci-tests.mjs";

const sha = "a".repeat(40);
const run = { id: 42, head_sha: sha, head_branch: "main", event: "push", path: ".github/workflows/ci.yml", status: "in_progress" };
const jobs = () => allShards.map(({ os, shard }) => ({
  run_id: run.id, head_sha: sha, name: `tests / Tests (${os}, shard ${shard}/6)`, status: "completed", conclusion: "success",
}));
test("reuse selects only a main push from the CI workflow for the exact commit", () => {
  for (const changed of [{ head_sha: "b".repeat(40) }, { head_branch: "other" }, { event: "pull_request" }, { path: ".github/workflows/other.yml" }]) {
    assert.equal(selectMainPushRun([{ ...run, ...changed }], sha), null);
  }
  assert.equal(selectMainPushRun([{ ...run, head_sha: "b".repeat(40) }, run], sha), run);
});
test("one failed shard reruns only that shard while preserving all five successes", () => {
  for (const conclusion of ["failure", "cancelled", "skipped", "timed_out", "neutral"]) {
    const partial = inspectTestJobs(run, jobs().map((job, i) => i === 0 ? { ...job, conclusion } : job));
    assert.equal(partial.mode, "partial");
    assert.deepEqual(partial.pending, [{ os: "windows-latest", shard: 1 }]);
    assert.equal(partial.reused.length, 5);
    assert.equal(partial.waiting, false);
  }
});
test("missing and running shards are never counted as passed", () => {
  assert.equal(inspectTestJobs(run, jobs()).mode, "reuse");
  const missing = inspectTestJobs(run, jobs().slice(1));
  assert.deepEqual(missing.pending, [allShards[0]]);
  assert.equal(missing.waiting, true);
  assert.equal(inspectTestJobs({ ...run, status: "completed" }, jobs().slice(1)).waiting, false);
  const active = inspectTestJobs(run, jobs().map((job, i) => i === 3 ? { ...job, status: "in_progress", conclusion: null } : job));
  assert.equal(active.waiting, true);
  assert.deepEqual(active.pending, [allShards[3]]);
});
test("ambiguous jobs or jobs from another run or SHA force complete verification", () => {
  for (const invalid of [
    [...jobs(), jobs()[0]],
    jobs().map((job, i) => i ? job : { ...job, head_sha: "b".repeat(40) }),
    jobs().map((job, i) => i ? job : { ...job, run_id: 43 }),
  ]) {
    const plan = inspectTestJobs(run, invalid);
    assert.equal(plan.mode, "full");
    assert.deepEqual(plan.pending, allShards);
    assert.equal(plan.reused.length, 0);
  }
});
test("waits for active shards even if another shard has already failed", async () => {
  let clock = 0, polls = 0;
  const result = await findReusableTests({ sha, now: () => clock, delay: async ms => { clock += ms; }, pollMs: 10,
    getRuns: async () => ++polls === 1 ? [] : [run],
    getJobs: async () => jobs().map((job, i) => i === 0 ? { ...job, conclusion: "failure" } : polls < 3 && i === 1 ? { ...job, status: "in_progress", conclusion: null } : job) });
  assert.equal(result.mode, "partial");
  assert.deepEqual(result.pending, [allShards[0]]);
  assert.equal(polls, 3);
});
test("timeout reuses proven successes and reruns every unresolved shard", async () => {
  let clock = 0;
  const result = await findReusableTests({ sha, now: () => clock, delay: async ms => { clock += ms; }, pollMs: 10, maxWaitMs: 20,
    getRuns: async () => [run], getJobs: async () => jobs().slice(2) });
  assert.deepEqual(result.pending, allShards.slice(0, 2));
  assert.equal(result.reused.length, 4);
});
test("invalid, absent and unreadable main CI results fall back to all six Windows shards", async () => {
  const base = { sha, getRuns: async () => [run], getJobs: async () => jobs(), delay: async () => {} };
  assert.equal((await findReusableTests({ ...base, sha: "invalid" })).mode, "full");
  assert.equal((await findReusableTests({ ...base, getRuns: async () => { throw new Error("unavailable"); } })).mode, "full");
  assert.equal((await findReusableTests({ ...base, getJobs: async () => { throw new Error("unavailable"); } })).mode, "full");
  let clock = 0;
  assert.equal((await findReusableTests({ ...base, now: () => clock, delay: async ms => { clock += ms; }, pollMs: 10,
    missingRunWaitMs: 20, getRuns: async () => [] })).mode, "full");
});
test("release gate requires a complete disjoint partition and successful fallback results", () => {
  const plans = [
    { reused: allShards, pending: [] },
    { reused: allShards.slice(1), pending: allShards.slice(0, 1) },
    { reused: [], pending: allShards },
  ];
  for (const plan of plans) for (const lookup of ["success", "failure", "cancelled", "skipped"]) for (const tests of ["success", "failure", "cancelled", "skipped"]) {
    assert.equal(verifyTestPlan(plan, lookup, tests), lookup === "success" && tests === (plan.pending.length ? "success" : "skipped"));
  }
  for (const plan of [null, {}, { reused: allShards.slice(1), pending: [] }, { reused: allShards, pending: [allShards[0]] },
    { reused: allShards.slice(1), pending: [{ os: "other", shard: 1 }] }]) {
    assert.equal(verifyTestPlan(plan, "success", "success"), false);
  }
});
