import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const extensionConfig = await jiti.import("./extension-config.ts");

const rpc = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
const newRoute = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");
const existingRoute = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
const eventsRoute = await readFile(new URL("../app/api/agent/[id]/events/route.ts", import.meta.url), "utf8");
const staging = await readFile(new URL("../scripts/stage-standalone.mjs", import.meta.url), "utf8");

test("device-control admits only its first-party extension allow-list", () => {
  assert.deepEqual(
    extensionConfig.firstPartyExtensionPaths("device-control").map((path) => basename(path)).sort(),
    ["piora-harmony.ts"],
  );
  assert.deepEqual(
    extensionConfig.enabledFirstPartyExtensionPaths("device-control", {
      version: 1,
      disabled: ["piora:goal", "piora:plan"],
    }).map((path) => basename(path)),
    ["piora-harmony.ts"],
  );

  // Keep a small integration boundary check here: isolation also depends on
  // the SDK loader options, while extension membership is verified above.
  assert.match(rpc, /runtimeProfile === "device-control"/);
  assert.match(rpc, /toolsOption = toolNames \?\? \[\.\.\.DEVICE_CONTROL_AGENT_TOOLS\]/);
  assert.match(rpc, /additionalExtensionPaths: extensionPlan\.enabledPaths/);
  assert.match(rpc, /noExtensions: true/);
  assert.match(rpc, /noSkills: true/);
  assert.match(rpc, /noPromptTemplates: true/);
  assert.match(rpc, /noThemes: true/);
  assert.match(rpc, /noContextFiles: true/);
  assert.match(rpc, /systemPromptOverride: \(\) => undefined/);
  assert.match(rpc, /appendSystemPromptOverride: \(\) => \[\]/);
  assert.doesNotMatch(rpc, /loadedPaths\.length !== expectedPaths\.length/);
  assert.match(rpc, /DEVICE_CONTROL_DENIED_RPC_COMMANDS/);
  assert.match(rpc, /if \(runtimeProfile === "normal"\) ensureWindowsBashShellPath/);
});

test("ordinary sessions expose every first-party extension to the load plan", () => {
  assert.deepEqual(
    extensionConfig.firstPartyExtensionPaths("normal").map((path) => basename(path)).sort(),
    ["piora-automations.ts", "piora-browser.ts", "piora-file-changes.ts", "piora-goal.ts", "piora-harmony.ts", "piora-plan.ts", "piora-room.ts", "piora-vision-agent.ts"],
  );
});

test("normal and device services cannot share a cwd cache entry", () => {
  assert.match(rpc, /const sessionServicesKey = `\$\{runtimeProfile\}:\$\{sessionId\}`/);
  assert.match(rpc, /getServicesCache\(\)\.delete\(sessionServicesKey\)/);
});

test("new, resume, GET, and event connections all resolve the cold-start profile", () => {
  assert.match(newRoute, /getAgentRuntimeProfile\(\)/);
  assert.match(newRoute, /runtimeProfile,/);
  assert.match(existingRoute, /resolveOrStartRpcSession\(id, \{ runtimeProfile \}\)/);
  assert.match(eventsRoute, /resolveOrStartRpcSession\(id, \{ runtimeProfile \}\)/);
});

test("prompt lifecycle cleanup is tied to final prompt settlement, abort, fork, and destroy", () => {
  const startHandler = rpc.slice(rpc.indexOf("start(): void"), rpc.indexOf("setForceEmptySystemPrompt"));
  assert.doesNotMatch(startHandler, /finishPromptRun/);
  assert.match(rpc, /await finishPromptRun\(promptRun, "idle"\)/);
  assert.match(rpc, /await finishPromptRun\(promptRun, "error"\)/);
  assert.match(rpc, /const cleanupTask = finishPromptRun\(promptRun, "abort"\)/);
  assert.match(rpc, /await finishPromptRun\(this\.activePromptRun, "fork"\)/);
  assert.match(rpc, /void finishPromptRun\(promptRun, "destroy"\)/);
  assert.match(rpc, /const ownsPromptRun = !streamingBehavior \|\| !this\.activePromptRun/);
});

test("fork binds its inherited profile before exposure and quarantines binding failures", () => {
  const forkHandler = rpc.slice(rpc.indexOf('case "fork"'), rpc.indexOf('case "navigate_tree"'));
  const bindIndex = forkHandler.indexOf("bindSessionAgentRuntimeProfile(newSessionId, this.runtimeProfile)");
  const cacheIndex = forkHandler.indexOf("cacheSessionPath(newSessionId, newSessionFile)");
  assert.ok(bindIndex >= 0 && bindIndex < cacheIndex);
  assert.match(forkHandler, /catch \(profileError\) \{\s*quarantineUnboundSessionFile\(newSessionFile\)/);
});

test("standalone staging includes the device extension and optional workflow extensions", () => {
  assert.match(staging, /extensions\/piora-harmony\.ts/);
  assert.match(staging, /extensions\/piora-goal\.ts/);
  assert.match(staging, /extensions\/piora-plan\.ts/);
  assert.match(staging, /extensions\/piora-vision-agent\.ts/);
  assert.match(staging, /\["Piora runtime support modules", "lib"\]/);
});
