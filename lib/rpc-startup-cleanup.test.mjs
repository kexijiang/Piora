import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("rpc-manager.ts", source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "startRpcSession");
const compiled = ts.transpileModule(declaration.getText(parsed).replace(/^export /, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture(initialFailure) {
  let failure = initialFailure, allocations = 0, finished = 0;
  const services = new Map(), registry = new Map(), locks = new Map(), trace = [];
  const owners = new Set(), ownershipHandles = [], drains = [], factoryCalls = [];
  let shutdownGate;
  const fail = stage => { if (failure === stage) throw new Error(`injected ${stage}`); };
  const manager = { getEntries: () => [], getSessionId: () => "task", getCwd: () => "workspace" };
  const ownedFactory = kind => (...args) => {
    factoryCalls.push({ kind, args });
    let released = false;
    const owner = {
      manager,
      assertOwned() { assert.equal(released, false, "the runtime must retain its manager ownership"); },
      onCompromised: () => () => {},
      release() {
        if (released) return;
        released = true; owners.delete(owner); trace.push("release-owner");
      },
    };
    owners.add(owner); ownershipHandles.push(owner);
    return owner;
  };
  const inner = { sessionId: "task", sessionFile: "fixture.jsonl", sessionManager: manager, agent: {},
    getAllTools: () => [], getActiveToolNames: () => [],
    extensionRunner: { emit: async () => {
      trace.push("shutdown"); assert.equal(owners.size, 1, "shutdown hooks still own their writer");
      await shutdownGate; fail("shutdown");
    } },
    dispose: () => { assert.equal(owners.size, 1, "dispose runs before ownership release"); trace.push("dispose"); },
  };
  const env = {
    console: { error: () => trace.push("cleanup-error") },
    readDefaultToolPermission: () => "auto",
    writeToolPermission: (id, mode) => ({ mode, revision: 1 }),
    getAgentRuntimeProfile: () => "normal", getRegistry: () => registry, getLocks: () => locks,
    getServicesCache: () => services, trackStartingSession: () => () => { finished++; },
    resolveAgentToolsForRuntimeProfile: () => undefined, resolveProject: async () => ({ projectRoot: "workspace" }),
    readProjectToolSettings: () => null, getAgentDir: () => "fixture-agent",
    drainSessionFileOperations: async ids => drains.push(Array.from(ids)),
    createOwnedSessionManager: ownedFactory("create"), openOwnedSessionManager: ownedFactory("open"),
    readRemoteSessionPolicy: () => "notes", remotePolicyResources: () => ({}),
    readLatestSessionSystemPromptBinding: () => ({}), SettingsManager: { create: () => ({}) },
    createAgentSessionServices: async () => {
      allocations++;
      return { settingsManager: { reload: async () => fail("settings"), getEnabledModels: () => [], getDefaultProvider() {}, getDefaultModel() {} }, modelRuntime: {}, resourceLoader: {} };
    },
    resolveVisibleModels: async () => ({ visible: [], scopedModels: [] }), resolveDefaultModelPreference: () => undefined,
    readPendingSessionModel: () => null, readModelFallbackConfig: () => ({ enabled: false }),
    selectInitialModelScope: () => { fail("model"); return { scopedModels: [] }; },
    createAgentSessionFromServices: async () => { fail("sdk"); return { session: inner }; },
    getNativeMcpController: () => undefined,
    buildSessionCapabilityCatalog: () => [], createSessionCapabilityPolicy: () => ({}),
    bindSessionAgentRuntimeProfile: async () => { fail("profile"); if (failure === "shutdown") throw new Error("original startup failure"); },
    quarantineUnboundSessionFile: () => trace.push("quarantine"),
    listSSHSessionSummariesForAgent: () => { fail("registry"); return []; },
    subscribeSSHRegistry: () => () => trace.push("unsubscribe-ssh"),
    AgentSessionWrapper: class {
      alive = true; callbacks = [];
      constructor(session, runtimeProfile, options) {
        assert.equal(session, inner);
        this.runtimeProfile = runtimeProfile;
        this.owner = options.ownedSessionManager;
        assert.equal(this.owner.manager, manager); this.owner.assertOwned();
        fail("constructor");
      }
      initializeSessionCapabilities() { fail("capabilities"); }
      start() { fail("subscription"); }
      onDestroy(callback) { this.callbacks.push(callback); }
      beginExtensionBinding() { fail("binding"); }
      isAlive() { return this.alive; }
      destroy() {
        if (!this.alive) return;
        this.alive = false; trace.push("destroy"); this.callbacks.forEach(callback => callback());
        this.shutdown = inner.extensionRunner.emit().finally(() => {
          try { inner.dispose(); } finally { this.owner.release(); }
        });
      }
      async shutdownForFileMutation() { await this.shutdown; }
    },
    process: { env: {} },
  };
  for (const name of ["assertSessionNotMutating", "assertCurrentAgentRuntimeProfile", "readAgentProfileStore", "initTheme", "ensureWindowsBashShellPath", "installModelStallGuard", "installImageContextPolicy", "appendSessionCapabilityPolicy", "cacheSessionPath"]) env[name] = () => {};
  runInNewContext(compiled + ";globalThis.start = startRpcSession;", env);
  return { env, services, registry, locks, trace, owners, ownershipHandles, drains, factoryCalls,
    allocations: () => allocations, finished: () => finished, recover: () => { failure = undefined; },
    pauseShutdown: () => { let resume; shutdownGate = new Promise(resolve => { resume = resolve; }); return resume; },
  };
}

for (const stage of ["settings", "model", "sdk", "profile", "constructor", "capabilities", "subscription", "registry", "binding"]) {
  test(`failed ${stage} startup releases owned state and permits a clean retry`, async () => {
    const f = fixture(stage);
    await assert.rejects(f.env.start("task", "", "workspace"), new RegExp(`injected ${stage}`));
    assert.equal(f.services.size, 0); assert.equal(f.registry.size, 0); assert.equal(f.locks.size, 0); assert.equal(f.finished(), 1);
    assert.equal(f.owners.size, 0); assert.equal(f.ownershipHandles.length, 1);
    assert.equal(f.trace.filter(value => value === "release-owner").length, 1);
    assert.deepEqual(f.drains, [["task"]]);
    assert.deepEqual(f.factoryCalls, [{ kind: "create", args: ["workspace", undefined, "fixture-agent"] }]);
    const hasInner = !["settings", "model", "sdk"].includes(stage);
    assert.equal(f.trace.filter(value => value === "dispose").length, hasInner ? 1 : 0);
    if (hasInner) {
      assert.ok(f.trace.indexOf("shutdown") < f.trace.indexOf("dispose"));
      assert.ok(f.trace.indexOf("dispose") < f.trace.indexOf("release-owner"));
    }
    if (stage === "binding") assert.ok(f.trace.includes("unsubscribe-ssh"));
    f.recover();
    const result = await f.env.start("task", "", "workspace");
    assert.equal(result.realSessionId, "task"); assert.equal(f.allocations(), 2);
    assert.equal(f.services.size, 1); assert.equal(f.registry.size, 1);
    assert.equal(f.owners.size, 1); assert.equal(f.ownershipHandles.length, 2);
    f.ownershipHandles[1].assertOwned();
    result.session.destroy(); await result.session.shutdownForFileMutation();
    assert.equal(f.services.size, 0); assert.equal(f.registry.size, 0);
    assert.equal(f.owners.size, 0);
    assert.equal(f.trace.filter(value => value === "release-owner").length, 2);
  });
}

test("shutdown failures preserve the original startup error and still dispose the SDK session", async () => {
  const f = fixture("shutdown");
  await assert.rejects(f.env.start("task", "", "workspace"), /original startup failure/);
  assert.ok(f.trace.includes("dispose")); assert.ok(f.trace.includes("cleanup-error"));
  assert.equal(f.services.size, 0); assert.equal(f.locks.size, 0);
  assert.equal(f.owners.size, 0); assert.equal(f.ownershipHandles.length, 1);
  assert.ok(f.trace.indexOf("dispose") < f.trace.indexOf("release-owner"));
});

test("concurrent successful starts still share one private runtime", async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.env.start("task", "", "workspace"), f.env.start("task", "", "workspace")]);
  assert.equal(first.session, second.session); assert.equal(f.allocations(), 1);
  assert.deepEqual(f.trace, []);
  assert.equal(f.owners.size, 1); assert.equal(f.ownershipHandles.length, 1);
  assert.deepEqual(f.drains, [["task"]]);
  first.session.destroy(); await first.session.shutdownForFileMutation();
  assert.equal(f.owners.size, 0);
});

test("successful runtime retains ownership while asynchronous shutdown hooks are pending", async () => {
  const f = fixture();
  const { session } = await f.env.start("task", "", "workspace");
  const resumeShutdown = f.pauseShutdown();
  try {
    session.destroy();
    assert.equal(f.services.size, 0); assert.equal(f.registry.size, 0);
    assert.equal(f.owners.size, 1); f.ownershipHandles[0].assertOwned();
    assert.ok(f.trace.includes("shutdown"));
    assert.equal(f.trace.includes("dispose"), false);
    assert.equal(f.trace.includes("release-owner"), false);
  } finally { resumeShutdown(); await session.shutdownForFileMutation(); }
  assert.equal(f.owners.size, 0);
  assert.ok(f.trace.indexOf("dispose") < f.trace.indexOf("release-owner"));
});
