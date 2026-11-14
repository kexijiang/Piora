import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { AnalyticsStore, DEFAULT_ANALYTICS_POLICY, validateAnalyticsPolicy } from "../desktop/src/analytics-store.mts";
const { AnalyticsUploader } = await createJiti(import.meta.url).import("../desktop/src/analytics-uploader.mts");
const secure = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async text => Buffer.from(text),
  decryptStringAsync: async bytes => ({ result: bytes.toString(), shouldReEncrypt: false }),
};
let root, store;
test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "piora-sync-policy-"));
  store = new AnalyticsStore(root);
  store.set("app_launch_id", randomUUID());
  store.set("app_version", "test");
});
test.afterEach(() => {
  store.close();
  assert.match(relative(resolve(tmpdir()), resolve(root)), /^piora-sync-policy-[\w-]+$/);
  rmSync(root, { recursive: true, force: true });
});

test("sync intervals allow custom minutes below 25 or above 120", () => {
  for (const [min, max] of [[60,60],[300,900],[10800,86400],[60*86400,90*86400]]) {
    const policy = { ...DEFAULT_ANALYTICS_POLICY, interval_min_seconds: min, interval_max_seconds: max };
    assert.equal(validateAnalyticsPolicy(policy), policy);
  }
  for (const [min, max] of [[0,900],[-60,900],[900,300],[1.5,900],[60,Number.MAX_SAFE_INTEGER]])
    assert.throws(() => validateAnalyticsPolicy({ ...DEFAULT_ANALYTICS_POLICY, interval_min_seconds: min, interval_max_seconds: max }), /INVALID_ANALYTICS_POLICY/);
});

test("uploader advertises configurable intervals and applies a received 5–15 minute policy", async () => {
  store.record("desktop.started", "launch", { reason: "manual" });
  const policy = { ...DEFAULT_ANALYTICS_POLICY, version: 2, interval_min_seconds: 300, interval_max_seconds: 900 };
  const requested = [];
  const uploader = await AnalyticsUploader.create(store, { enabled: true, backend_url: "https://analytics.example.test", enrollment_key: "fixture" }, secure, async (url, options) => {
    assert.equal(options.headers["X-Piora-Capabilities"], "configurable-sync-interval");
    requested.push(url);
    const body = JSON.parse(options.body);
    return Response.json({ data: url.endsWith("/register") ? {
      credential_expires_at: new Date(Date.now() + 90 * 86400000).toISOString(), organization_name: "Fixture", policy,
    } : {
      accepted_event_ids: body.events.map(event => event.event_id), duplicate_event_ids: [], rejected_events: [], policy,
    }, meta: { server_time: new Date().toISOString() } });
  });
  const before = Date.now();
  try {
    await uploader.flush();
    assert.equal(requested.length, 2);
    assert.equal(store.health().events, 0);
    assert.equal(store.get("last_error"), null);
    assert.deepEqual(store.get("policy"), policy);
    assert.ok(store.get("next_due_at") >= before + 300000);
    assert.ok(store.get("next_due_at") <= Date.now() + 900000);
  } finally { uploader.stop(); }
});

test("long persisted intervals wait in safe timer chunks without early upload", async () => {
  let networkRequests = 0;
  const uploader = await AnalyticsUploader.create(store, { enabled: true, backend_url: "https://analytics.example.test" }, secure, async () => { networkRequests++; throw new Error("unexpected early upload"); });
  let now = Date.now();
  const due = now + 60 * 86400000;
  store.set("next_due_at", due);
  const timers = [], originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout, originalNow = Date.now;
  try {
    Date.now = () => now;
    globalThis.setTimeout = (callback, milliseconds) => {
      const timer = { callback, milliseconds, unref() {} };
      timers.push(timer);
      return timer;
    };
    globalThis.clearTimeout = () => {};
    uploader.start();
    assert.equal(timers[0].milliseconds, 2_147_483_647);
    now += timers[0].milliseconds;
    timers[0].callback();
    assert.equal(timers[1].milliseconds, 2_147_483_647);
    now += timers[1].milliseconds;
    timers[1].callback();
    assert.equal(timers[2].milliseconds, due - now);
    assert.equal(store.get("next_due_at"), due);
    assert.equal(networkRequests, 0);
  } finally {
    uploader.stop();
    globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; Date.now = originalNow;
  }
});
