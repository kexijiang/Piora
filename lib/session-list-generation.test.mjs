import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { listAllSessions, invalidateSessionListCache } = await jiti.import("./session-reader.ts");

test("a scan invalidated by deletion cannot return or cache deleted conversations", async () => {
  const original = SessionManager.listAll;
  let completeOld;
  let calls = 0;
  const stale = { id: "deleted-during-scan", path: "/test/deleted.jsonl", cwd: "", created: new Date(), modified: new Date(), firstMessage: "old", messageCount: 1 };
  SessionManager.listAll = async () => {
    calls++;
    if (calls === 1) { await new Promise((resolve) => { completeOld = resolve; }); return [stale]; }
    return [];
  };
  try {
    invalidateSessionListCache();
    const scan = listAllSessions();
    await new Promise((resolve) => setImmediate(resolve));
    invalidateSessionListCache();
    completeOld();
    assert.deepEqual(await scan, []);
    assert.equal(calls, 2);
    assert.equal(globalThis.__piSessionPathCache?.has(stale.id) ?? false, false);
    assert.deepEqual(await listAllSessions(), []);
    assert.equal(calls, 2);
  } finally { completeOld?.(); SessionManager.listAll = original; invalidateSessionListCache(); }
});
