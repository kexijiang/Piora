import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import ts from "typescript";
import {
  applyModelRetrySettings,
  parseModelRetrySettings,
  readModelRetrySettings,
  reloadModelRetrySettings,
} from "./retry-settings.ts";

function fakeManager(initial = {}) {
  const globalSettings = { ...initial };
  return {
    globalSettings,
    calls: { retryEnabled: [], idleTimeout: [], saves: 0, marks: [] },
    getRetryEnabled: () => globalSettings.retry?.enabled ?? true,
    getRetrySettings: () => ({
      enabled: globalSettings.retry?.enabled ?? true,
      maxRetries: globalSettings.retry?.maxRetries ?? 3,
      baseDelayMs: globalSettings.retry?.baseDelayMs ?? 2000,
    }),
    getProviderRetrySettings: () => ({
      timeoutMs: globalSettings.retry?.provider?.timeoutMs,
      maxRetries: globalSettings.retry?.provider?.maxRetries,
      maxRetryDelayMs: globalSettings.retry?.provider?.maxRetryDelayMs ?? 60000,
    }),
    getHttpIdleTimeoutMs: () => globalSettings.httpIdleTimeoutMs ?? 300000,
    setRetryEnabled(enabled) {
      this.calls.retryEnabled.push(enabled);
      globalSettings.retry ??= {};
      globalSettings.retry.enabled = enabled;
    },
    setHttpIdleTimeoutMs(timeoutMs) {
      this.calls.idleTimeout.push(timeoutMs);
      globalSettings.httpIdleTimeoutMs = timeoutMs;
    },
    markModified(field, nestedKey) {
      this.calls.marks.push([field, nestedKey]);
    },
    save() {
      this.calls.saves += 1;
    },
    async flush() {},
    drainErrors: () => [],
  };
}

const VALID = {
  enabled: true,
  maxRetries: 2,
  baseDelayMs: 4000,
  provider: { timeoutMs: 90000, maxRetries: 1, maxRetryDelayMs: 20000 },
  httpIdleTimeoutMs: 60000,
};

test("parseModelRetrySettings validates full submissions and nullable provider fields", () => {
  assert.deepEqual(parseModelRetrySettings(VALID), VALID);
  const sparse = parseModelRetrySettings({ ...VALID, provider: { timeoutMs: null, maxRetries: "", maxRetryDelayMs: 20000 } });
  assert.equal(sparse.provider.timeoutMs, null);
  assert.equal(sparse.provider.maxRetries, null);
  assert.throws(() => parseModelRetrySettings({ ...VALID, enabled: "yes" }), /enabled must be a boolean/);
  assert.throws(() => parseModelRetrySettings({ ...VALID, maxRetries: 99 }), /maxRetries must be between/);
  assert.throws(() => parseModelRetrySettings({ ...VALID, provider: { ...VALID.provider, timeoutMs: 10 } }), /provider\.timeoutMs must be between/);
  assert.throws(() => parseModelRetrySettings({ ...VALID, httpIdleTimeoutMs: -1 }), /httpIdleTimeoutMs must be between/);
});

function sharedSettingsStorage(project = {}) {
  const records = { global: "{}", project: JSON.stringify(project) };
  return {
    records,
    withLock(scope, update) {
      const next = update(records[scope]);
      if (next !== undefined) records[scope] = next;
    },
  };
}

test("saving through the route refreshes live and cached SDK settings before returning", async (t) => {
  const storage = sharedSettingsStorage();
  const live = SettingsManager.fromStorage(storage);
  const cached = SettingsManager.fromStorage(storage);
  const editing = SettingsManager.fromStorage(storage);
  const expected = { ...VALID, enabled: false };
  const model = { api: "openai-responses", provider: "test", id: "test", reasoning: false, input: ["text"] };
  const calls = [];
  const { session: inner } = await createAgentSession({
    cwd: process.cwd(), agentDir: process.cwd(), model, tools: [], settingsManager: live,
    sessionManager: SessionManager.inMemory(process.cwd()),
    resourceLoader: new DefaultResourceLoader({ cwd: process.cwd(), agentDir: process.cwd(), settingsManager: live }),
    modelRuntime: { streamSimple: (_model, _context, options) => { calls.push(options); return options; }, getModel: () => model },
  });
  t.after(() => inner.dispose());
  const rpcSource = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startup = rpcSource.slice(rpcSource.indexOf("const { session: inner } = await createAgentSessionFromServices"));
  const retrySetup = startup.match(/inner\.agent\.maxRetryDelayMs = undefined;/)?.[0];
  assert.ok(retrySetup, "session startup must leave provider retry settings dynamic");
  new Function("inner", retrySetup)(inner);
  const requestOptions = { maxRetryDelayMs: inner.agent.maxRetryDelayMs };
  await inner.agent.streamFunction(model, { messages: [] }, requestOptions);
  assert.equal(calls.at(-1).maxRetryDelayMs, 60000);
  const begin = rpcSource.indexOf("export async function reloadLiveModelRetrySettings");
  const functionSource = rpcSource.slice(begin, rpcSource.indexOf("export async function reloadLiveCompactionSettings", begin)).replace(/^export /, "");
  const compiled = ts.transpileModule(functionSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const reloadLive = new Function("getServicesCache", "getRegistry", "reloadModelRetrySettings", `${compiled};return reloadLiveModelRetrySettings;`)(
    () => new Map([["cached", { settingsManager: cached }]]),
    () => new Map([["live", { isAlive: () => true, inner }]]),
    reloadModelRetrySettings,
  );
  let transportTimeout;
  const modules = {
    "@/lib/retry-settings": { applyModelRetrySettings, parseModelRetrySettings, readModelRetrySettings },
    "@/lib/model-runtime-context": { resolveModelRequestCwd: async () => "workspace", createCoreModelServices: async () => ({ settingsManager: editing }), ModelRequestCwdError: class extends Error {} },
    "@/lib/rpc-manager": { reloadLiveModelRetrySettings: reloadLive },
    "@/lib/network-proxy": { readNetworkProxySettings: () => ({ mode: "system" }) },
    "@/lib/http-dispatcher": { applyNetworkProxySettings: (_proxy, timeout) => { transportTimeout = timeout; } },
  };
  const route = {};
  const routeSource = await readFile(new URL("../app/api/models-config/retry/route.ts", import.meta.url), "utf8");
  const routeJS = ts.transpileModule(routeSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "exports", routeJS)(name => { assert.ok(modules[name], name); return modules[name]; }, route);
  const response = await route.PATCH(new Request("http://localhost/api/models-config/retry", {
    method: "PATCH", body: JSON.stringify({ settings: expected }), headers: { "Content-Type": "application/json" },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  assert.deepEqual(readModelRetrySettings(live), expected);
  assert.deepEqual(readModelRetrySettings(cached), expected);
  assert.equal(transportTimeout, expected.httpIdleTimeoutMs);
  assert.deepEqual(JSON.parse(storage.records.global).retry.provider, expected.provider);
  // Reuse the same Agent-loop options to cover a later request in the same run.
  await inner.agent.streamFunction(model, { messages: [] }, requestOptions);
  assert.equal(calls.at(-1).maxRetryDelayMs, expected.provider.maxRetryDelayMs);
  assert.equal(calls.at(-1).maxRetries, expected.provider.maxRetries);
  assert.equal(calls.at(-1).timeoutMs, expected.provider.timeoutMs);
});

test("refresh preserves project overrides and tries every manager when one fails", async () => {
  const storage = sharedSettingsStorage({ retry: { maxRetries: 7 }, shellPath: "/project/bash" });
  const live = SettingsManager.fromStorage(storage, { projectTrusted: true });
  const editing = SettingsManager.fromStorage(storage, { projectTrusted: true });
  await applyModelRetrySettings(editing, VALID);
  let calls = 0;
  const failed = { reload: async () => { calls++; throw new Error("read failed"); }, drainErrors: () => [] };
  await assert.rejects(reloadModelRetrySettings([failed, failed, live]), /1 session settings reload/);
  assert.equal(calls, 1, "deduplicates cached and live references");
  assert.equal(live.getRetrySettings().maxRetries, 7);
  assert.equal(live.getShellPath(), "/project/bash");
  assert.equal(live.getProviderRetrySettings().timeoutMs, VALID.provider.timeoutMs);
});

test("readModelRetrySettings reports SDK defaults as null provider fields", () => {
  assert.deepEqual(readModelRetrySettings(fakeManager()), {
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 2000,
    provider: { timeoutMs: null, maxRetries: null, maxRetryDelayMs: 60000 },
    httpIdleTimeoutMs: 300000,
  });
});

test("applyModelRetrySettings writes through the settings manager and rounds back", async () => {
  const manager = fakeManager();
  const applied = await applyModelRetrySettings(manager, parseModelRetrySettings(VALID));
  assert.deepEqual(applied, VALID);
  assert.deepEqual(manager.calls.retryEnabled, [true]);
  assert.deepEqual(manager.calls.idleTimeout, [60000]);
  assert.ok(manager.calls.saves >= 1);
  assert.deepEqual(manager.globalSettings.retry.provider, { timeoutMs: 90000, maxRetries: 1, maxRetryDelayMs: 20000 });
});

test("applyModelRetrySettings clears provider overrides that fall back to SDK defaults", async () => {
  const manager = fakeManager({ retry: { provider: { timeoutMs: 90000, maxRetries: 1, maxRetryDelayMs: 20000 } } });
  const applied = await applyModelRetrySettings(manager, {
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 2000,
    provider: { timeoutMs: null, maxRetries: null, maxRetryDelayMs: 20000 },
    httpIdleTimeoutMs: 300000,
  });
  assert.equal(applied.provider.timeoutMs, null);
  assert.equal(applied.provider.maxRetries, null);
  assert.equal(applied.provider.maxRetryDelayMs, 20000);
  // Nullable fields drop their keys so SDK defaults stay in effect.
  assert.deepEqual(manager.globalSettings.retry.provider, { maxRetryDelayMs: 20000 });
});
