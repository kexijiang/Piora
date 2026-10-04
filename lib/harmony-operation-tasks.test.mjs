import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { HarmonyOperationTasks } = await jiti.import("./harmony/operation-tasks.ts");
const { HarmonyError } = await jiti.import("./harmony/errors.ts");
const input = { serial: "phone", kind: "installation", title: "test.hap", target: "C:/workspace/test.hap" };

test("operation histories retain verified outcomes and recover unfinished installs without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "piora-operation-tasks-")), journal = join(directory, "tasks.json");
  let resume, began;
  const ready = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  try {
    const store = new HarmonyOperationTasks(journal);
    const pending = store.track(input, async started => { started(); began(); await gate; return "installed"; }, () => ({ verification: "device-confirmed" }));
    await ready;
    assert.equal(store.list("phone")[0].status, "running");
    assert.equal(new HarmonyOperationTasks(journal).list("phone")[0].status, "interrupted");
    resume(); assert.equal(await pending, "installed");
    assert.equal(store.list("phone")[0].status, "completed");
    assert.equal(new HarmonyOperationTasks(journal).list("phone")[0].verification, "device-confirmed");
    await assert.rejects(() => store.track(input, async started => { started(); throw new HarmonyError("COMMAND_FAILED", "Signature rejected", {
      details: { reason: "signature-rejected", deviceErrorCode: "9568257", dispatchState: "sent", leaseToken: "secret-lease" },
    }); }, () => ({})), error => error.code === "COMMAND_FAILED");
    const failed = new HarmonyOperationTasks(journal).list("phone")[0];
    assert.equal(failed.status, "failed"); assert.equal(failed.signatureRejected, true); assert.equal(failed.deviceErrorCode, "9568257");
    assert.equal(store.list("other-phone").length, 0);
    const serialized = await readFile(journal, "utf8");
    assert.ok(!serialized.includes("secret-lease"));
    const copy = store.list("phone"); copy[0].status = "completed";
    assert.equal(store.list("phone")[0].status, "failed");
  } finally { resume(); await rm(directory, { recursive: true, force: true }); }
});

test("cancelled installs distinguish unsent rejection from uncertain device effects", async () => {
  const store = new HarmonyOperationTasks();
  for (const [kind, sent, expected] of [["installation", false, "cancelled"], ["installation", true, "interrupted"], ["snapshot", true, "cancelled"]]) {
    await assert.rejects(() => store.track({ ...input, kind }, async started => {
      if (sent) started(); throw new HarmonyError("COMMAND_ABORTED", "Cancelled", { details: { dispatchState: sent ? "sent" : "not-sent" } });
    }, () => ({})));
    assert.equal(store.list("phone")[0].status, expected);
  }
  await assert.rejects(() => store.track(input, async started => { started(); throw new HarmonyError("INVALID_RESPONSE", "No confirmation", { details: { dispatchState: "sent" } }); }, () => ({})));
  assert.equal(store.list("phone")[0].status, "interrupted", "an absent success receipt is not proof of rejection");
});

test("durable media outcomes distinguish a confirmed close from unknown release and cannot be revived by late startup", () => {
  const store = new HarmonyOperationTasks();
  const media = { serial: "phone", kind: "recording", title: "Screen recording", target: "phone" };
  const id = store.begin(media);
  assert.equal(store.list("phone")[0].status, "queued");
  store.started(id, "recording");
  store.failed(id, new HarmonyError("COMMAND_TIMEOUT", "Release is unknown"));
  store.started(id, "recording");
  assert.equal(store.list("phone")[0].status, "interrupted", "a late ready callback cannot announce another running task");
  store.complete(id, { mediaFilename: "phone-capture.mp4", bytes: 42, verification: "media-saved" });
  store.failed(id, new HarmonyError("COMMAND_FAILED", "Old callback"));
  assert.equal(store.list("phone")[0].status, "completed");
  assert.equal(store.list("phone")[0].error, undefined);
  const closed = store.begin(media);
  store.failed(closed, new HarmonyError("COMMAND_FAILED", "Save failed", { details: { recordingStopped: true } }));
  assert.equal(store.list("phone")[0].status, "failed");
  const unconfirmed = store.begin(media);
  store.failed(unconfirmed, new HarmonyError("DEVICE_BUSY", "Forward uncertain", { details: { recordingStopped: true, cleanup: "uncertain" } }));
  assert.equal(store.list("phone")[0].status, "interrupted");
  assert.throws(() => store.complete(unconfirmed, { mediaFilename: "../private.mp4" }), error => error.code === "INVALID_ARGUMENT");
});
