import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { FileLogger } = await jiti.import("../desktop/src/logger.ts");
const { runOptionalStartupTask } = await jiti.import("../desktop/src/startup-tasks.ts");

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), "piora-startup-diagnostics-"));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("an unusable default log directory falls back and preserves nested filesystem errors", t => {
  const root = directory(t);
  writeFileSync(join(root, "logs"), "blocked by a file");
  const logger = new FileLogger(root, join(root, "fallback"));
  assert.equal(logger.fileLoggingAvailable, true);
  assert.equal(logger.filePath, join(root, "fallback", `piora-startup-${process.pid}.log`));
  const cause = Object.assign(new Error("Access denied"), { code: "EACCES", syscall: "mkdir" });
  logger.error("Startup failed", { stage: "preparing-agent-data", error: new Error("Cannot prepare directory", { cause }) });
  const log = readFileSync(logger.filePath, "utf8");
  assert.match(log, /preparing-agent-data/);
  assert.match(log, /Cannot prepare directory/);
  assert.match(log, /EACCES/);
  assert.match(log, /Access denied/);
});

test("unusable primary and fallback paths or a closed console never crash logging", t => {
  const root = directory(t);
  writeFileSync(join(root, "logs"), "blocked");
  writeFileSync(join(root, "fallback"), "blocked");
  for (const level of ["log", "warn", "error"]) t.mock.method(console, level, () => { throw new Error("EPIPE"); });
  const logger = new FileLogger(root, join(root, "fallback"));
  assert.equal(logger.fileLoggingAvailable, false);
  assert.doesNotThrow(() => logger.error("failure", new Error("startup")));
});

test("desktop logs retain one rotated backup at the size limit", t => {
  const root = directory(t);
  mkdirSync(join(root, "logs"));
  const file = join(root, "logs", "piora.log");
  writeFileSync(file, "x".repeat(5 * 1024 * 1024));
  const logger = new FileLogger(root);
  logger.info("new launch");
  assert.equal(readFileSync(`${file}.1`, "utf8").length, 5 * 1024 * 1024);
  assert.match(readFileSync(file, "utf8"), /new launch/);
});

test("stalled optional startup maintenance releases startup and handles late rejection", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warnings = [];
  let rejectTask;
  const task = new Promise((_resolve, reject) => { rejectTask = reject; });
  const running = runOptionalStartupTask("Cache cleanup", () => task, { warn: (...args) => warnings.push(args) });
  await Promise.resolve();
  t.mock.timers.tick(5_000);
  await running;
  assert.match(warnings[0][0], /still pending/);
  rejectTask(new Error("Late cleanup failure"));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(warnings.length, 2);
  assert.equal(warnings[1][1].message, "Late cleanup failure");
});

test("successful optional maintenance cancels its timeout warning", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const warnings = [];
  await runOptionalStartupTask("Cache cleanup", async () => {}, { warn: message => warnings.push(message) });
  t.mock.timers.tick(30_000);
  assert.deepEqual(warnings, []);
});


test("log settings apply immediately, filter output and survive restart", t => {
  const root = directory(t);
  const logger = new FileLogger(root);
  const original = logger.filePath;
  const next = { directory: join(root, "custom"), level: "warn", maxSizeMiB: 1, backups: 3 };
  const output = [];
  t.mock.method(console, "log", (...args) => output.push(args));
  logger.configure(next);
  logger.info("filtered-info"); logger.debug("filtered-debug"); logger.warn("visible-warning");
  assert.equal(output.length, 0);
  assert.doesNotMatch(readFileSync(logger.filePath, "utf8"), /filtered/);
  assert.match(readFileSync(logger.filePath, "utf8"), /visible-warning/);
  assert.equal(readFileSync(original, "utf8"), "");
  assert.deepEqual(new FileLogger(root).getState().settings, next);
  logger.configure({ ...next, level: "debug" }); logger.debug("debug-details");
  assert.match(readFileSync(logger.filePath, "utf8"), /debug-details/);
});

test("invalid, unwritable and unpersistable changes retain the effective configuration", t => {
  const root = directory(t);
  const logger = new FileLogger(root);
  const before = logger.getState();
  writeFileSync(join(root, "blocked"), "file");
  for (const change of [{ directory: "relative" }, { directory: join(root, "blocked") }, { maxSizeMiB: 0 }, { maxSizeMiB: 1.5 }, { backups: 21 }, { level: "invalid" }]) {
    assert.throws(() => logger.configure({ ...before.settings, ...change }));
    assert.deepEqual(logger.getState(), before);
  }
  mkdirSync(join(root, "runtime-log-settings.json"));
  assert.throws(() => logger.configure({ ...before.settings, level: "debug" }));
  assert.deepEqual(logger.getState(), before);
});

test("rotation keeps ordered backups and prunes excess backups only on rotation", t => {
  const root = directory(t);
  const logger = new FileLogger(root);
  logger.configure({ ...logger.getState().settings, maxSizeMiB: 1, backups: 3 });
  for (const marker of ["a", "b", "c", "d"]) {
    writeFileSync(logger.filePath, marker.repeat(1024 * 1024)); logger.info("rotate");
  }
  for (const [index, marker] of [[1,"d"],[2,"c"],[3,"b"]]) assert.equal(readFileSync(`${logger.filePath}.${index}`, "utf8")[0], marker);
  assert.equal(existsSync(`${logger.filePath}.4`), false);
  logger.configure({ ...logger.getState().settings, backups: 1 });
  assert.equal(existsSync(`${logger.filePath}.3`), true);
  writeFileSync(logger.filePath, "z".repeat(1024 * 1024)); logger.warn("rotate again");
  assert.equal(existsSync(`${logger.filePath}.2`), false);
  assert.equal(existsSync(`${logger.filePath}.3`), false);
});

test("unavailable configured directory reports the actual fallback path", t => {
  const root = directory(t);
  const logger = new FileLogger(root);
  logger.configure({ ...logger.getState().settings, directory: join(root, "custom") });
  rmSync(join(root, "custom"), { recursive: true });
  writeFileSync(join(root, "custom"), "blocked");
  const restarted = new FileLogger(root, join(root, "fallback"));
  assert.equal(restarted.getState().settings.directory, join(root, "custom"));
  assert.equal(restarted.filePath, join(root, "fallback", `piora-startup-${process.pid}.log`));
  assert.equal(restarted.fileLoggingAvailable, true);
});
