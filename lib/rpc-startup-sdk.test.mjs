import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createJiti } from "jiti";

function ownerRegistryKeys() { return [...(globalThis.__pioraSessionFileOwners?.keys() ?? [])].sort(); }

test("repeated real SDK model-selection failures retain no service bundles and a valid session still starts", { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-startup-cleanup-"));
  const previousDirectory = process.env.PI_CODING_AGENT_DIR, previousProfile = process.env.PIORA_RUNTIME_PROFILE;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.PIORA_RUNTIME_PROFILE = "normal";
  const cwd = join(root, "workspace"); await mkdir(cwd);
  let session, releaseShutdown, baselineOwners;
  try {
    const { startRpcSession } = await createJiti(import.meta.url).import("./rpc-manager.ts");
    const baseline = globalThis.__piServicesCache?.size ?? 0;
    baselineOwners = ownerRegistryKeys();
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = `failed-start-${attempt}`;
      await assert.rejects(startRpcSession(id, "", cwd, {
        remotePolicy: "notes", initialModel: { provider: "piora-test-unavailable", modelId: "missing" }, allowModelFallback: false,
      }), /not available|not found/i);
      assert.equal(globalThis.__piServicesCache.size, baseline);
      assert.equal(globalThis.__piStartLocks.size, 0);
      assert.equal(globalThis.__piStartingSessionCwds.size, 0);
      assert.deepEqual(ownerRegistryKeys(), baselineOwners, `failed attempt ${attempt} must release every manager owner`);
    }
    session = (await startRpcSession("valid-start", "", cwd, { remotePolicy: "notes" })).session;
    assert.equal(session.isAlive(), true); assert.deepEqual(session.inner.getActiveToolNames(), []);
    assert.equal(session.nativeMcp, undefined);
    assert.equal(session.inner.getAllTools().some(tool => ["codemode", "tool_search"].includes(tool.name) || tool.name.startsWith("mcp__")), false);
    assert.equal(globalThis.__piServicesCache.size, baseline + 1);
    assert.equal(ownerRegistryKeys().length, baselineOwners.length + 1);
    const activeOwners = ownerRegistryKeys();
    const runner = session.inner.extensionRunner, emit = runner.emit.bind(runner);
    const shutdownGate = new Promise(resolve => { releaseShutdown = resolve; });
    let markShutdownStarted;
    const shutdownStarted = new Promise(resolve => { markShutdownStarted = resolve; });
    runner.emit = async event => {
      if (event.type === "session_shutdown") { markShutdownStarted(); await shutdownGate; }
      return emit(event);
    };
    session.destroy();
    await shutdownStarted;
    assert.deepEqual(ownerRegistryKeys(), activeOwners, "the real runtime must retain ownership through shutdown hooks");
    releaseShutdown();
    await session.shutdownForFileMutation();
    assert.equal(globalThis.__piServicesCache.size, baseline);
    assert.deepEqual(ownerRegistryKeys(), baselineOwners);
  } finally {
    releaseShutdown?.();
    session?.destroy(); await session?.shutdownForFileMutation();
    if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousDirectory;
    if (previousProfile === undefined) delete process.env.PIORA_RUNTIME_PROFILE; else process.env.PIORA_RUNTIME_PROFILE = previousProfile;
    assert.equal(dirname(root), resolve(tmpdir())); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (baselineOwners) assert.deepEqual(ownerRegistryKeys(), baselineOwners, "test cleanup must leave no session owners behind");
  }
});
