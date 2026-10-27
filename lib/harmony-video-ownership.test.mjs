import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createJiti } from "jiti";
const { VideoOwnership } = await createJiti(import.meta.url).import("./harmony/runtime/video-ownership.ts");
const previousName = `piora_video_${"a".repeat(32)}.so`, nextName = `piora_video_${"b".repeat(32)}.so`;
const deadPid = Number(spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim());
assert.ok(deadPid > 0);

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "piora-video-ownership-test-"));
  const records = join(directory, "records"); await mkdir(records);
  const record = { version: 1, serial: "phone", hostPid: deadPid, name: previousName, port: 45678, ...options.record };
  await writeFile(join(records, `${previousName}.json`), JSON.stringify(record));
  const calls = []; let killed = false;
  const run = async (args, operation) => {
    calls.push({ args, operation }); let text = "";
    if (operation === "debug_video_recovery_owner" && options.daemon !== false) text = `shell 1234 1 0 ? ? uitest start-daemon singleness --extension-name ${previousName}`;
    if (operation === "debug_video_recovery_stop") killed = true;
    if (operation === "debug_video_recovery_socket" && options.foreign) text = "@scrcpy_grpc_socket";
    if (operation === "debug_video_recovery_forwards") text = options.forwards ?? "phone tcp:45678 localabstract:scrcpy_grpc_socket [Forward]";
    return { stdout: Buffer.from(text), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 0 };
  };
  const ownership = new VideoOwnership("phone", nextName, 45679, run, directory);
  t.after(async () => { ownership.release(); await rm(directory, { recursive: true, force: true }); });
  return { directory, records, ownership, calls, get killed() { return killed; }, run };
}

test("positively dead host recovery kills only its random-name daemon and removes matching forward", async t => {
  const f = await fixture(t); await f.ownership.prepare();
  assert.equal(f.killed, true);
  assert.deepEqual(f.calls.filter(c => c.operation === "debug_video_recovery_stop").map(c => c.args[3]), ["kill -9 1234"]);
  assert.deepEqual(f.calls.filter(c => c.operation === "debug_video_recovery_forward_cleanup").map(c => c.args), [["-t", "phone", "fport", "rm", "tcp:45678", "localabstract:scrcpy_grpc_socket"]]);
  assert.deepEqual(await readdir(f.records), [`${nextName}.json`]);
  f.ownership.clear(); f.ownership.release();
  assert.deepEqual(await readdir(f.records), []);
});

test("viewing ownership serializes instances but does not lock another device", async t => {
  const f = await fixture(t);
  assert.throws(() => new VideoOwnership("phone", nextName, 45679, f.run, f.directory), e => e.code === "DEVICE_BUSY");
  const other = new VideoOwnership("other", nextName, 45679, f.run, f.directory); other.release();
  f.ownership.release(); const replacement = new VideoOwnership("phone", nextName, 45679, f.run, f.directory); replacement.release();
});

test("a foreign socket is never stopped and its forward is never removed", async t => {
  const f = await fixture(t, { daemon: false, foreign: true });
  await assert.rejects(f.ownership.prepare(), e => e.code === "DEVICE_BUSY");
  assert.equal(f.killed, false);
  assert.equal(f.calls.some(c => /cleanup/.test(c.operation)), false);
  assert.deepEqual(await readdir(f.records), [`${previousName}.json`], "keep the interrupted record for a later safe recovery");
});

test("reused ports, reverse forwards, other devices and remote endpoints survive recovery", async t => {
  const f = await fixture(t, { daemon: false, forwards: "other tcp:45678 localabstract:scrcpy_grpc_socket [Forward]\nphone tcp:45678 tcp:53535 [Forward]\nphone tcp:45678 localabstract:scrcpy_grpc_socket [Reverse]" });
  await f.ownership.prepare();
  assert.equal(f.calls.some(c => c.operation === "debug_video_recovery_forward_cleanup"), false);
});

test("invalid ownership records cannot inject shell commands or select a foreign process", async t => {
  const f = await fixture(t, { record: { name: previousName + "; kill -9 22" } });
  await f.ownership.prepare(); assert.equal(f.calls.length, 0);
});

test("live foreign host PID is preserved, never inferred stale from age", async t => {
  // The test parent's PID is live and different from the current test process.
  const f = await fixture(t, { record: { hostPid: process.ppid } });
  await f.ownership.prepare(); assert.equal(f.calls.length, 0);
  assert.equal((await readdir(f.records)).length, 2);
});
