import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { getSettingsSnapshot, readSettingsJson, rememberSettingsSnapshot } = await createJiti(import.meta.url).import("./settings-read-client.ts");

test("failed reads retain the last successful settings snapshot", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ enabled: true }));
  assert.deepEqual(await readSettingsJson("/fixture/settings"), { enabled: true });
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Unavailable" }, { status: 503 }));
  await assert.rejects(readSettingsJson("/fixture/settings"), /Unavailable/);
  assert.deepEqual(getSettingsSnapshot("/fixture/settings"), { enabled: true });
});

test("a settings read cannot wait indefinitely for the server", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(globalThis, "fetch", (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
  const failed = assert.rejects(readSettingsJson("/fixture/stalled"), /设置读取超时/);
  t.mock.timers.tick(10001);
  await failed;
  assert.equal(getSettingsSnapshot("/fixture/stalled"), null);
});

test("a late response after leaving settings cannot replace the cache", async t => {
  rememberSettingsSnapshot("/fixture/cancelled", { enabled: true });
  let finish;
  t.mock.method(globalThis, "fetch", () => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const failed = assert.rejects(readSettingsJson("/fixture/cancelled", controller.signal), /Left settings/);
  controller.abort(new Error("Left settings"));
  finish(Response.json({ enabled: false }));
  await failed;
  assert.deepEqual(getSettingsSnapshot("/fixture/cancelled"), { enabled: true });
});
