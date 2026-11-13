import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createJiti } from "jiti";
import { createPatch } from "diff";
import {
  AnalyticsStore,
  DEFAULT_ANALYTICS_POLICY,
  validateAnalyticsPolicy,
  analyticsLaunchReason,
} from "../desktop/src/analytics-store.mts";
import * as telemetry from "./analytics-telemetry.ts";
const { AnalyticsUploader, jitterSeconds, retryDelay } = await createJiti(
  import.meta.url,
).import("../desktop/src/analytics-uploader.mts");
const originalLocal = process.env.LOCALAPPDATA;
const originalGlobal = globalThis.__pioraAnalytics;
let root, store;
test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "piora-analytics-test-"));
  const directory = join(root, "Piora", "telemetry");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "config.json"),
    JSON.stringify({
      enabled: true,
      backend_url: "https://analytics.example.test",
      enrollment_key: "enroll.fixture.secret",
    }),
  );
  process.env.LOCALAPPDATA = root;
  store = new AnalyticsStore(directory);
  store.set("enabled_at", Date.now() - 60000);
  store.set("app_launch_id", randomUUID());
  store.set("app_version", "test");
  globalThis.__pioraAnalytics = {
    store,
    session: new Map(),
    context: new AsyncLocalStorage(),
    locks: new Map(),
    lastScan: 0,
  };
});
test.afterEach(() => {
  clearInterval(globalThis.__pioraAnalytics?.timer);
  store.close();
  globalThis.__pioraAnalytics = originalGlobal;
  if (originalLocal === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocal;
  assert.match(
    relative(resolve(tmpdir()), resolve(root)),
    /^piora-analytics-test-[\w-]+$/,
  );
  rmSync(root, { recursive: true, force: true });
});
const events = () => store.batch(DEFAULT_ANALYTICS_POLICY);
const record = (key = "launch") =>
  store.record("desktop.started", key, { reason: "manual" });
const windows = {
  skip: process.platform !== "win32" ? "Windows collector integration" : false,
};

test("Windows autostart flags distinguish manual launch without guessing legacy login items", () => {
  assert.equal(
    analyticsLaunchReason(["Piora.exe", "--piora-autostart"], false),
    "autostart",
  );
  assert.equal(analyticsLaunchReason(["Piora.exe"], false), "manual");
  assert.equal(analyticsLaunchReason(["Piora.exe"], true), "unknown");
  assert.equal(analyticsLaunchReason(["Piora.exe"], undefined), "unknown");
});

test("SQLite survives reopening, replays exactly once and preserves int64 sequence", () => {
  store.set("next_seq", "9007199254740992");
  const id = record();
  assert.equal(record(), id);
  const other = new AnalyticsStore(store.directory);
  try {
    assert.equal(other.installationId, store.installationId);
    assert.equal(
      other.batch(DEFAULT_ANALYTICS_POLICY)[0].event_seq,
      "9007199254740993",
    );
  } finally {
    other.close();
  }
  store.acknowledge([id], {
    accepted_event_ids: [id],
    duplicate_event_ids: [],
    rejected_events: [],
  });
  assert.equal(record(), id);
  assert.equal(events().length, 0);
});
test("partial or foreign ACK never deletes pending events; permanent rejects quarantine", () => {
  const a = record("a"),
    b = record("b");
  assert.throws(
    () =>
      store.acknowledge([a, b], {
        accepted_event_ids: [a],
        duplicate_event_ids: [],
        rejected_events: [],
      }),
    /INVALID_TELEMETRY_ACK/,
  );
  assert.throws(
    () =>
      store.acknowledge([a], {
        accepted_event_ids: [b],
        duplicate_event_ids: [],
        rejected_events: [],
      }),
    /INVALID_TELEMETRY_ACK/,
  );
  assert.equal(events().length, 2);
  store.acknowledge([a, b], {
    accepted_event_ids: [a],
    duplicate_event_ids: [],
    rejected_events: [{ event_id: b, code: "INVALID_EVENT" }],
  });
  assert.equal(events().length, 0);
  assert.equal(store.get("quarantined_total"), 1);
});
test("payload allow-list excludes content and queue pruning reports loss", () => {
  assert.throws(
    () =>
      store.record("desktop.started", "secret", {
        reason: "manual",
        prompt: "secret",
      }),
    /FIELDS_REJECTED/,
  );
  record();
  store.db
    .prepare("UPDATE outbox SET created_at=?")
    .run(Date.now() - 31 * 86400000);
  store.prune(DEFAULT_ANALYTICS_POLICY);
  assert.equal(events().length, 0);
  assert.equal(store.get("dropped_total"), 1);
});
test("oversized event does not permanently block subsequent uploads", () => {
  store.record("client.health", "large", {
    queue_events: "0",
    queue_bytes: "0",
    dropped_events: "0",
    quarantined_events: "0",
    clock_offset_ms: 0,
    clock_sync_at: null,
    codes: ["x".repeat(5000)],
  });
  const next = record("next");
  const batch = store.batch({
    ...DEFAULT_ANALYTICS_POLICY,
    max_batch_bytes: 4096,
  });
  assert.deepEqual(
    batch.map((x) => x.event_id),
    [next],
  );
  assert.equal(store.get("quarantined_total"), 1);
});
test("paused collection does not backfill a suppressed journal event when resumed", () => {
  store.set("policy", { ...DEFAULT_ANALYTICS_POLICY, enabled: false });
  assert.equal(record("paused"), undefined);
  store.set("policy", DEFAULT_ANALYTICS_POLICY);
  record("paused");
  assert.equal(events().length, 0);
  record("resumed");
  assert.equal(events().length, 1);
});
test("jitter spreads uploads and bounds retry pressure", () => {
  const samples = new Set(
    Array.from({ length: 100 }, () => jitterSeconds(1500, 2100)),
  );
  assert(samples.size > 1);
  assert([...samples].every((x) => x >= 1500 && x <= 2100));
  for (let i = 0; i < 12; i++) {
    const wait = retryDelay(i, 600);
    assert(wait >= 600 && wait <= 1830);
  }
  assert.throws(
    () =>
      validateAnalyticsPolicy({
        ...DEFAULT_ANALYTICS_POLICY,
        interval_min_seconds: 20,
      }),
    /INVALID/,
  );
});
test("failed upload retains stable events and pending health until exact ACK", async () => {
  record();
  let fail = true,
    registrations = 0;
  const batches = [];
  const secure = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (s) => Buffer.from(s),
    decryptStringAsync: async (b) => ({
      result: b.toString(),
      shouldReEncrypt: false,
    }),
  };
  const fetcher = async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith("/register")) {
      registrations++;
      return Response.json({
        data: {
          credential_expires_at: new Date(
            Date.now() + 90 * 86400000,
          ).toISOString(),
          organization_name: "Fixture",
          policy: DEFAULT_ANALYTICS_POLICY,
        },
        meta: { server_time: new Date().toISOString() },
      });
    }
    batches.push(body.events);
    if (fail) return new Response("", { status: 503 });
    return Response.json({
      data: {
        accepted_event_ids: body.events.map((x) => x.event_id),
        duplicate_event_ids: [],
        rejected_events: [],
        policy: DEFAULT_ANALYTICS_POLICY,
      },
      meta: { server_time: new Date().toISOString() },
    });
  };
  const uploader = await AnalyticsUploader.create(
    store,
    {
      enabled: true,
      backend_url: "https://analytics.example.test",
      enrollment_key: "fixture",
    },
    secure,
    fetcher,
  );
  try {
    store.set("dropped_total", 2);
    await uploader.flush();
    assert.equal(events().length, 2);
    assert.equal(store.get("reported_dropped"), undefined);
    fail = false;
    await uploader.flush();
    assert.equal(registrations, 1);
    assert.deepEqual(
      batches[0].map((x) => x.event_id),
      batches[1].map((x) => x.event_id),
    );
    assert.equal(events().length, 0);
    assert.equal(store.get("reported_dropped"), 2);
    assert(store.get("next_due_at") >= Date.now() + 1490000);
  } finally {
    uploader.stop();
  }
});
test("DPAPI unavailable fails closed without persisting a plaintext credential", async () => {
  await assert.rejects(
    AnalyticsUploader.create(
      store,
      { enabled: true, backend_url: "https://example.test" },
      { isAsyncEncryptionAvailable: async () => false },
    ),
    /DPAPI_UNAVAILABLE/,
  );
});
test("token buckets do not double count cache or fabricate unknown zero", () => {
  assert.equal(
    telemetry.normalizeAnalyticsUsage({
      input: 100,
      output: 20,
      cacheRead: 30,
      cacheWrite: 10,
    }).total_tokens,
    "160",
  );
  assert.equal(
    telemetry.normalizeAnalyticsUsage({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }).total_tokens,
    null,
  );
  assert.equal(
    telemetry.normalizeAnalyticsUsage({ input: Number.MAX_SAFE_INTEGER + 1 })
      .usage_status,
    "unavailable",
  );
});
test(
  "human Query admission is deduplicated; room fanout remains one human query",
  windows,
  () => {
    const at = Date.now(),
      message = { id: randomUUID(), createdAt: at, author: { kind: "user" } };
    telemetry.recordAnalyticsRoomMessage("room", message);
    telemetry.recordAnalyticsRoomMessage("room", message);
    for (let i = 0; i < 2; i++)
      telemetry.recordAnalyticsCommand({
        commandId: "child-" + i,
        targetSessionId: "s" + i,
        source: "room",
        roomContext: { roomId: "room", messageId: message.id },
        acceptedAt: at,
        status: "dispatching",
        revision: 2,
        delivery: "next_turn",
      });
    assert.equal(
      events().filter(
        (e) =>
          e.event_type === "query.submitted" && e.payload.trigger === "human",
      ).length,
      1,
    );
    const roots = [...globalThis.__pioraAnalytics.session.values()].map(
      (x) => x.query_id,
    );
    assert.equal(roots[0], roots[1]);
  },
);
test(
  "model observer preserves stream identity and counts retries at actual provider boundary",
  windows,
  async () => {
    let called = 0;
    const stream = {
      result: async () => ({
        stopReason: "stop",
        usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0 },
      }),
    };
    const runtime = {
      prepareRequest: async () => ({
        provider: {
          streamSimple: () => {
            called++;
            return stream;
          },
        },
        model: { provider: "fixture", id: "model" },
      }),
    };
    telemetry.installAnalyticsModelObserver(runtime);
    telemetry.installAnalyticsModelObserver(runtime, "model_test");
    for (let i = 0; i < 2; i++) {
      const prepared = await runtime.prepareRequest();
      assert.equal(prepared.provider.streamSimple(), stream);
    }
    await new Promise((r) => setImmediate(r));
    const finished = events().filter((e) => e.event_type === "model.finished");
    assert.equal(called, 2);
    assert.equal(finished.length, 2);
    assert(
      finished.every(
        (e) =>
          e.payload.source === "model_test" && e.payload.total_tokens === "60",
      ),
    );
    assert.equal(store.db.prepare("SELECT count(*) n FROM pending").get().n, 0);
  },
);
test(
  "file tool measures actual write/edit output and rejects concurrent changes",
  windows,
  async () => {
    const file = join(root, "private-project-secret.ts");
    writeFileSync(file, "one\ntwo\n");
    const definition = {
      execute: async (_id, input) => {
        writeFileSync(file, input.content);
        return { content: [], details: {} };
      },
    };
    telemetry.installAnalyticsFileObserver(
      {
        getAllTools: () => [
          {
            name: "write",
            sourceInfo: { source: "builtin", path: "builtin:write" },
          },
        ],
        getToolDefinition: () => definition,
      },
      root,
      "s",
    );
    await definition.execute("tool-a", {
      path: file,
      content: "one\nthree\nfour\n",
    });
    const changed = events().find((e) => e.event_type === "file.changed");
    assert.equal(changed.payload.added_lines, "2");
    assert.equal(changed.payload.deleted_lines, "1");
    assert(!JSON.stringify(changed).includes("private-project"));
    assert(!JSON.stringify(changed).includes("three"));
    const edit = {
      execute: async () => {
        const before = readFileSync(file, "utf8"),
          after = "edited\n";
        writeFileSync(file, after);
        return { details: { patch: createPatch("file", before, after) } };
      },
    };
    telemetry.installAnalyticsFileObserver(
      {
        getAllTools: () => [
          {
            name: "edit",
            sourceInfo: { source: "builtin", path: "builtin:edit" },
          },
        ],
        getToolDefinition: () => edit,
      },
      root,
      "s",
    );
    await edit.execute("tool-b", { path: file });
    assert.equal(
      events()
        .filter((e) => e.event_type === "file.changed")
        .at(-1).payload.measurement_status,
      "measured",
    );
    const racing = {
      execute: async () => {
        writeFileSync(file, "another writer\n");
        return { content: [] };
      },
    };
    telemetry.installAnalyticsFileObserver(
      {
        getAllTools: () => [
          {
            name: "write",
            sourceInfo: { source: "builtin", path: "builtin:write" },
          },
        ],
        getToolDefinition: () => racing,
      },
      root,
      "s",
    );
    await racing.execute("tool-c", { path: file, content: "intended\n" });
    assert.equal(
      events()
        .filter((e) => e.event_type === "file.changed")
        .at(-1).payload.measurement_status,
      "concurrent_change",
    );
    assert.equal(
      events()
        .filter((e) => e.event_type === "file.changed")
        .at(-1).payload.added_lines,
      null,
    );
    const largeBefore = Array.from({ length: 20000 }, (_, i) => "old-" + i).join("\n");
    const largeAfter = Array.from({ length: 20000 }, (_, i) => "new-" + i).join("\n");
    writeFileSync(file, largeBefore);
    assert.deepEqual(await definition.execute("tool-large-rewrite", { path: file, content: largeAfter }), { content: [], details: {} });
    const bounded = events().filter(e => e.event_type === "file.changed").at(-1).payload;
    assert.equal(bounded.measurement_status, "too_large");
    assert.equal(bounded.added_lines, null);
    assert.equal(bounded.deleted_lines, null);
    assert.equal(bounded.kind, "unknown");
    assert.equal(readFileSync(file, "utf8"), largeAfter, "measurement limits preserve the successful tool write");
    await definition.execute("tool-after-budget", { path: file, content: largeAfter });
    const following = events().filter(e => e.event_type === "file.changed").at(-1).payload;
    assert.equal(following.measurement_status, "measured");
    assert.equal(following.added_lines, "0");
    assert.equal(following.deleted_lines, "0");
  },
);
test("restart marks unfinished calls and runs unknown without inventing tokens or duration", () => {
  const id = randomUUID(),
    run = randomUUID();
  store.db.prepare("INSERT INTO pending VALUES(?,?,?,?)").run(
    id,
    "model",
    JSON.stringify({
      query_id: null,
      run_id: run,
      provider: "fixture",
      model: "model",
      source: "chat",
      started_at: new Date().toISOString(),
    }),
    Date.now(),
  );
  store.db
    .prepare("INSERT INTO pending VALUES(?,?,?,?)")
    .run(run, "run", "{}", Date.now());
  telemetry.recoverAnalyticsPending(store);
  telemetry.recoverAnalyticsPending(store);
  const batch = events();
  assert.equal(batch.length, 2);
  assert.equal(
    batch.find((e) => e.event_type === "model.finished").payload.total_tokens,
    null,
  );
  assert.equal(
    batch.find((e) => e.event_type === "run.finished").payload.duration_ms,
    null,
  );
  assert.equal(store.db.prepare("SELECT count(*) n FROM pending").get().n, 0);
});
