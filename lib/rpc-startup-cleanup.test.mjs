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
  const fail = stage => { if (failure === stage) throw new Error(`injected ${stage}`); };
  const manager = { getEntries: () => [], getSessionId: () => "task", getCwd: () => "workspace" };
  const inner = { sessionId: "task", sessionFile: "fixture.jsonl", sessionManager: manager, agent: {},
    getAllTools: () => [], getActiveToolNames: () => [],
    extensionRunner: { emit: async () => { trace.push("shutdown"); fail("shutdown"); } },
    dispose: () => trace.push("dispose"),
  };
  const env = {
    console: { error: () => trace.push("cleanup-error") },
    getAgentRuntimeProfile: () => "normal", getRegistry: () => registry, getLocks: () => locks,
    getServicesCache: () => services, trackStartingSession: () => () => { finished++; },
    resolveAgentToolsForRuntimeProfile: () => undefined, resolveProject: async () => ({ projectRoot: "workspace" }),
    readProjectToolSettings: () => null, getAgentDir: () => "fixture-agent", SessionManager: { create: () => manager },
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
      constructor() { fail("constructor"); }
      initializeSessionCapabilities() { fail("capabilities"); }
      start() { fail("subscription"); }
      onDestroy(callback) { this.callbacks.push(callback); }
      beginExtensionBinding() { fail("binding"); }
      isAlive() { return this.alive; }
      destroy() {
        if (!this.alive) return;
        this.alive = false; trace.push("destroy"); this.callbacks.forEach(callback => callback());
        this.shutdown = inner.extensionRunner.emit().finally(() => inner.dispose());
      }
      async shutdownForFileMutation() { await this.shutdown; }
    },
    process: { env: {} },
  };
  for (const name of ["assertSessionNotMutating", "assertCurrentAgentRuntimeProfile", "readAgentProfileStore", "initTheme", "ensureWindowsBashShellPath", "installModelStallGuard", "installImageContextPolicy", "appendSessionCapabilityPolicy", "cacheSessionPath"]) env[name] = () => {};
  runInNewContext(compiled + ";globalThis.start = startRpcSession;", env);
  return { env, services, registry, locks, trace, allocations: () => allocations, finished: () => finished, recover: () => { failure = undefined; } };
}

for (const stage of ["settings", "model", "sdk", "profile", "constructor", "capabilities", "subscription", "registry", "binding"]) {
  test(`failed ${stage} startup releases owned state and permits a clean retry`, async () => {
    const f = fixture(stage);
    await assert.rejects(f.env.start("task", "", "workspace"), new RegExp(`injected ${stage}`));
    assert.equal(f.services.size, 0); assert.equal(f.registry.size, 0); assert.equal(f.locks.size, 0); assert.equal(f.finished(), 1);
    const hasInner = !["settings", "model", "sdk"].includes(stage);
    assert.equal(f.trace.filter(value => value === "dispose").length, hasInner ? 1 : 0);
    if (hasInner) assert.ok(f.trace.indexOf("shutdown") < f.trace.indexOf("dispose"));
    if (stage === "binding") assert.ok(f.trace.includes("unsubscribe-ssh"));
    f.recover();
    const result = await f.env.start("task", "", "workspace");
    assert.equal(result.realSessionId, "task"); assert.equal(f.allocations(), 2);
    assert.equal(f.services.size, 1); assert.equal(f.registry.size, 1);
    result.session.destroy(); await result.session.shutdownForFileMutation();
    assert.equal(f.services.size, 0); assert.equal(f.registry.size, 0);
  });
}

test("shutdown failures preserve the original startup error and still dispose the SDK session", async () => {
  const f = fixture("shutdown");
  await assert.rejects(f.env.start("task", "", "workspace"), /original startup failure/);
  assert.ok(f.trace.includes("dispose")); assert.ok(f.trace.includes("cleanup-error"));
  assert.equal(f.services.size, 0); assert.equal(f.locks.size, 0);
});

test("concurrent successful starts still share one private runtime", async () => {
  const f = fixture();
  const [first, second] = await Promise.all([f.env.start("task", "", "workspace"), f.env.start("task", "", "workspace")]);
  assert.equal(first.session, second.session); assert.equal(f.allocations(), 1);
  assert.deepEqual(f.trace, []);
  first.session.destroy(); await first.session.shutdownForFileMutation();
});
