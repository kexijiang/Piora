import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { ScheduledDesktopUpdater, parseUpdateSchedule } = await jiti.import("../desktop/src/update-schedule.ts");

function fixture() {
  let schedule = { enabled: true, time: "03:00" };
  let status = "idle";
  let safe = true;
  let hold;
  let failure = false;
  const calls = [];
  const scheduler = new ScheduledDesktopUpdater({
    read: () => schedule,
    complete: (day) => { calls.push("complete"); schedule.lastCompletedDay = day; },
    canInstall: async () => safe,
    install: async () => { calls.push("install"); return true; },
    onError: () => calls.push("error"),
    controller: {
      getState: () => ({ status }),
      checkForUpdates: async () => { calls.push("check"); if (hold) await hold; if (failure) throw new Error("network unavailable"); status = "available"; },
      downloadUpdate: async () => { calls.push("download"); status = "downloaded"; },
    },
  });
  return { scheduler, calls, schedule, fail: (value) => { failure = value; }, setStatus: (value) => { status = value; }, setSafe: (value) => { safe = value; }, hold: (value) => { hold = value; } };
}
const time = (hour, minute = 0, day = 7) => new Date(2026, 8, day, hour, minute);

test("schedule validates local time and does not coerce IPC values", () => {
  for (const value of [{ enabled: "true", time: "03:00" }, { enabled: true, time: "24:00" }, { enabled: true, time: "3:00" }, null]) assert.throws(() => parseUpdateSchedule(value));
  assert.deepEqual(parseUpdateSchedule({ enabled: false, time: "23:59" }), { enabled: false, time: "23:59" });
});
test("no run before the daily time; only one successful run per local day", async () => {
  const f = fixture();
  await f.scheduler.tick(time(2, 59)); assert.deepEqual(f.calls, []);
  await f.scheduler.tick(time(3)); assert.deepEqual(f.calls, ["check", "download", "install", "complete"]);
  await f.scheduler.tick(time(4)); assert.equal(f.calls.length, 4);
});
test("busy/unsaved state defers installation, including across midnight", async () => {
  const f = fixture(); f.setSafe(false);
  await f.scheduler.tick(time(23)); assert.deepEqual(f.calls, ["check", "download"]);
  f.setSafe(true); await f.scheduler.tick(time(0, 1, 8));
  assert.deepEqual(f.calls, ["check", "download", "install", "complete"]);
});
test("turning off during a check prevents download and install", async () => {
  const f = fixture(); let resume;
  f.hold(new Promise((resolve) => { resume = resolve; }));
  const active = f.scheduler.tick(time(3));
  f.schedule.enabled = false; resume(); await active;
  assert.deepEqual(f.calls, ["check"]);
});
test("concurrent timer ticks do not duplicate checks", async () => {
  const f = fixture(); let resume;
  f.hold(new Promise((resolve) => { resume = resolve; }));
  const active = f.scheduler.tick(time(3)); await f.scheduler.tick(time(3, 1));
  assert.deepEqual(f.calls, ["check"]); resume(); await active;
});
test("changing time postpones an already downloaded pending update", async () => {
  const f = fixture(); f.setSafe(false); await f.scheduler.tick(time(3));
  f.schedule.time = "05:00"; f.setSafe(true); await f.scheduler.tick(time(4));
  assert.deepEqual(f.calls, ["check", "download"]);
  await f.scheduler.tick(time(5)); assert.ok(f.calls.includes("install"));
});

test("network errors back off for fifteen minutes and retry without marking the day complete", async () => {
  const f = fixture(); f.fail(true); await f.scheduler.tick(time(3));
  assert.deepEqual(f.calls, ["check", "error"]); assert.equal(f.schedule.lastCompletedDay, undefined);
  f.fail(false); await f.scheduler.tick(time(3, 14)); assert.equal(f.calls.length, 2);
  await f.scheduler.tick(time(3, 15)); assert.deepEqual(f.calls, ["check", "error", "check", "download", "install", "complete"]);
});
