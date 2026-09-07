import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { requestGitStatus } = await createJiti(import.meta.url).import("./git-status-client.ts");

test("cancelling one Git subscriber rejects promptly without cancelling other panels", async () => {
  const originalFetch = globalThis.fetch;
  let finish;
  let calls = 0;
  let sharedSignal;
  globalThis.fetch = async (_url, options) => {
    calls++;
    sharedSignal = options.signal;
    await new Promise((resolve) => { finish = resolve; });
    return Response.json({ isGitRepository: true, files: [], additions: 0, deletions: 0 });
  };
  try {
    const controller = new AbortController();
    const cancelled = requestGitStatus("/test/cancel", { signal: controller.signal });
    const retained = requestGitStatus("/test/cancel");
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
    assert.equal(sharedSignal.aborted, false);
    assert.equal(calls, 1);
    finish();
    assert.equal((await retained).isGitRepository, true);
    assert.equal((await requestGitStatus("/test/cancel")).isGitRepository, true);
    assert.equal(calls, 1);
  } finally { finish?.(); globalThis.fetch = originalFetch; }
});
