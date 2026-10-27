import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(import.meta.dirname, "..") } });
const { resolveExtensionLoadPlan, applyExtensionLoadPlan, installExtensionLoadPlanReload } = await jiti.import("./extension-config.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { executeChatCommandOperation } = await jiti.import("./chat-command-runtime.ts");

test("/reload refreshes discovery and executes new and edited Pi commands without a model turn", { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-extension-reload-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent");
  let wrapper;
  try {
    await mkdir(cwd);
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const preferences = { version: 1, disabled: [] };
    const discover = async () => {
      await settingsManager.reload();
      const plan = await resolveExtensionLoadPlan({ cwd, agentDir, settingsManager, profile: "normal", preferences });
      // Keep the production discovery/filtering; bundled desktop tools are unrelated to this fixture.
      plan.enabledPaths = plan.candidates.filter(candidate => !candidate.builtIn && candidate.enabled).map(candidate => candidate.path);
      return plan;
    };
    const plan = await discover();
    const starts = [];
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions: {
      additionalExtensionPaths: plan.enabledPaths, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionsOverride: result => applyExtensionLoadPlan(result, plan),
      extensionFactories: [pi => {
        pi.registerProvider("reload-test", { api: "reload-test-api", apiKey: "test", baseUrl: "https://unused.invalid",
          models: [{ id: "test", name: "test", reasoning: false, input: ["text"], contextWindow: 10000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          streamSimple() { throw new Error("Slash commands must not invoke the model"); },
        });
        pi.on("session_start", event => { starts.push(event.reason); });
      }],
    } });
    installExtensionLoadPlanReload(services.resourceLoader, plan, discover);
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(cwd, join(agentDir, "sessions")), model: services.modelRuntime.getModel("reload-test", "test"), tools: [] });
    wrapper = new AgentSessionWrapper(session);
    wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
    const context = { session: wrapper, assertActive() {}, phase() {}, prompt() { throw new Error("Unexpected model prompt"); }, copy() {} };
    let serial = 0;
    const execute = (name, source = "builtin") => executeChatCommandOperation({ commandId: `reload-test-${++serial}`, targetSessionId: session.sessionId, operation: { command: { name, source }, arguments: "" } }, context);
    const commands = async () => (await wrapper.send({ type: "get_commands" })).catalog.commands.map(command => command.name);
    assert.ok(!(await commands()).includes("reload-probe"));
    const extensionPath = join(agentDir, "extensions", "probe.ts"), loads = join(root, "loads.txt");
    const source = version => `import {appendFileSync} from "node:fs";
      appendFileSync(${JSON.stringify(loads)}, ${JSON.stringify(version + "\n")});
      export default function(pi) { pi.registerCommand("reload-probe", {handler: async () => { pi.appendEntry("reload-probe", {version:${JSON.stringify(version)}}); }}); }`;
    await writeFile(extensionPath, source("v1"));
    const result = await execute("reload");
    assert.equal(result.title, "chatCommands.reloadCompleted");
    assert.ok(starts.includes("reload"), "the real SDK emits its reload lifecycle");
    assert.ok((await commands()).includes("reload-probe"), "new files are discovered by /reload");
    assert.equal(session.resourceLoader.getExtensions().extensions.find(extension => extension.resolvedPath === extensionPath).sourceInfo.source, "auto");
    await execute("reload-probe", "extension");
    assert.equal(session.sessionManager.getEntries().findLast(entry => entry.customType === "reload-probe").data.version, "v1");
    await writeFile(extensionPath, source("v2"));
    await execute("reload");
    await execute("reload-probe", "extension");
    assert.equal(session.sessionManager.getEntries().findLast(entry => entry.customType === "reload-probe").data.version, "v2", "SDK module-cache invalidation remains intact");
    const id = plan.candidates.find(candidate => candidate.path === extensionPath).id;
    preferences.disabled.push(id);
    await execute("reload");
    assert.ok(!(await commands()).includes("reload-probe"));
    assert.equal(await readFile(loads, "utf8"), "v1\nv2\n", "disabled modules are excluded before evaluation");
    preferences.disabled.length = 0;
    await execute("reload");
    assert.ok((await commands()).includes("reload-probe"));
    await unlink(extensionPath);
    const deleted = await execute("reload");
    assert.ok(!(await commands()).includes("reload-probe"));
    assert.equal(deleted.warnings, undefined, "deleted paths are dropped instead of reloaded from a stale list");
  } finally {
    if (wrapper) await wrapper.shutdownForFileMutation();
    assert.ok(root.startsWith(join(tmpdir(), "piora-extension-reload-")));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
