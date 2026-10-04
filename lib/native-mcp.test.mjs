import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createJiti } from "jiti";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAssistantMessageEventStream, getCurrentTools, Type } from "@earendil-works/pi-ai";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createFixtureServer } from "./native-mcp-fixture.mjs";
const jiti = createJiti(import.meta.url);
const { NativeMcpController } = await jiti.import("./native-mcp.ts");
const cfg = await jiti.import("./native-mcp-config.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const caps = await jiti.import("./session-capabilities.ts");
const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const wait = async predicate => { const limit = Date.now() + 12000; while (!predicate()) { if (Date.now() > limit) throw new Error("Timed out waiting for native MCP boundary"); await new Promise(r => setTimeout(r, 15)); } };

async function httpFixture(t, state = { calls: [], cancelled: 0, withdrawn: false }) {
  const peers = new Map();
  const http = createServer(async (req, res) => {
    if (state.oauth) {
      const origin = `http://127.0.0.1:${http.address().port}`;
      const json = (value, status = 200, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value)); };
      if (req.url.startsWith("/.well-known/oauth-protected-resource")) { json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read", "write"] }); return; }
      if (req.url.startsWith("/.well-known/")) { json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post", "none"] }); return; }
      if (req.url === "/token") {
        let text = ""; for await (const chunk of req) text += chunk;
        const args = new URLSearchParams(text); state.tokenRequests.push(Object.fromEntries(args));
        if (args.get("grant_type") === "refresh_token") state.refreshes++;
        state.token = `fixture-access-${state.tokenRequests.length}`; state.expired = false;
        json({ access_token: state.token, refresh_token: `fixture-refresh-${state.tokenRequests.length}`, token_type: "Bearer", expires_in: 3600, scope: state.requestedScope ?? "read" }); return;
      }
      if (req.headers.authorization !== `Bearer ${state.token}` || state.expired || state.requireWrite) {
        const scope = state.requireWrite ? ', error="insufficient_scope", scope="write"' : "";
        json({ error: "Fixture authorization required", secret: state.token }, state.requireWrite ? 403 : 401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"${scope}` }); return;
      }
    }
    const existing = peers.get(req.headers["mcp-session-id"]);
    if (existing) {
      let body; if (req.method === "POST") { let text = ""; for await (const chunk of req) text += chunk; body = JSON.parse(text); }
      await existing.transport.handleRequest(req, res, body); return;
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let text = ""; for await (const chunk of req) text += chunk;
    const server = createFixtureServer(state);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: false,
      onsessioninitialized: id => peers.set(id, { server, transport }) });
    await server.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(text));
  });
  await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const peer of peers.values()) await peer.server.close(); http.closeAllConnections(); await new Promise(r => http.close(r)); });
  return { state, url: `http://127.0.0.1:${http.address().port}/mcp` };
}

async function fixture(t, servers, { enabled = true, extension = () => {}, controllerOptions, policy, profile = "normal", notes = false, toolNameCeiling, projectManaged = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "piora-native-mcp-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  cfg.writeNativeMcpPreferences(agentDir, { enabled, approvedRegistered: [] });
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
  const sessions = [], requests = [], calls = [], events = []; let ordinaryCalls = 0;
  const create = async (manager, suppliedPolicy = policy) => {
    const control = new NativeMcpController(cwd, agentDir, controllerOptions);
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir), resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [...control.factories, pi => {
        pi.registerProvider("mcp-fixture", { api: "mcp-fixture", baseUrl: "https://unused.invalid", apiKey: "local-fixture", models: [{ id: "model", name: "Controlled MCP fixture", reasoning: false, input: ["text", "image"], contextWindow: 128000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], streamSimple(model, context) {
          requests.push({ messages: structuredClone(context.messages), tools: getCurrentTools(context.messages) });
          const content = calls.shift() ?? [{ type: "text", text: "FIXTURE_DONE" }];
          const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, timestamp: Date.now(), usage, stopReason: content.some(c => c.type === "toolCall") ? "toolUse" : "stop" };
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); });
          return stream;
        } });
        pi.registerTool({ name: "ordinary_probe", label: "Ordinary fixture", description: "An ordinary Piora extension tool", parameters: Type.Object({}), execute: async () => { ordinaryCalls++; return { content: [{ type: "text", text: "ORDINARY_EXECUTED" }] }; } });
        extension(pi);
      }],
    } });
    manager ??= SessionManager.create(cwd, join(agentDir, "sessions"));
    if (notes) manager.appendCustomEntry("piora-remote-policy", { policy: "notes" });
    const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: services.modelRuntime.getModel("mcp-fixture", "model") });
    const wrapper = new AgentSessionWrapper(session, profile, { policy: suppliedPolicy, nativeMcp: control, toolNameCeiling, projectManaged });
    control.bind(name => wrapper.isToolAllowedByCapability(name), server => wrapper.isMcpResourceServerAllowed(server), () => wrapper.refreshNativeMcpCapabilities());
    sessions.push({ session, wrapper, control });
    session.setAutoRetryEnabled(false); session.setAutoCompactionEnabled(false);
    session.subscribe(event => events.push(event));
    wrapper.onEvent(event => { if (event.type === "extension_ui_request" || event.type === "extension_error") events.push(event); });
    wrapper.initializeSessionCapabilities(); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
    return { session, wrapper, control };
  };
  t.after(async () => { if (t.passed === false) console.error("Native MCP fixture diagnosis", JSON.stringify(sessions.map(s => ({ status: s.control.snapshot(), tools: s.session.getAllTools().map(t => t.name) }))), events.filter(e => e.type === "extension_error" || e.type === "extension_ui_request")); for (const { session, wrapper } of sessions) { wrapper.destroy(); await wrapper.shutdownForFileMutation(); await session.abort(); session.dispose(); } await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir; });
  let id = 0;
  const run = async (f, name, args = {}) => { calls.push([{ type: "toolCall", id: `fixture-${++id}`, name, arguments: args }]); await f.session.prompt("LOCAL_MCP_TEST"); return f.session.agent.state.messages.filter(m => m.role === "toolResult").at(-1); };
  const grant = (f, names, resources = []) => f.wrapper.send({ type: "set_capabilities", preset: "custom", enabledCapabilityIds: [...names.map(n => `tool:${n}`), ...resources.map(n => `mcp-resource:${n}`)] });
  return { create, run, grant, requests, calls, events, agentDir, cwd, ordinaryCalls: () => ordinaryCalls };
}
const stdio = exposure => ({ command: process.execPath, args: [resolve("lib/native-mcp-fixture.mjs")], exposure });

test("native stdio preserves structured/image/error output and blocks disabled direct and nested calls", async t => {
  const f = await fixture(t, { local: stdio("direct") }); const a = await f.create();
  await wait(() => a.control.snapshot().servers[0]?.tools.length === 5);
  assert.equal(a.control.snapshot().owner, "native");
  const echo = "mcp__local__echo", image = "mcp__local__image", fail = "mcp__local__fail";
  assert.equal(a.wrapper.isToolAllowedByCapability(echo), false);
  assert.equal((await f.run(a, echo, { value: "DENIED" })).isError, true);
  await f.grant(a, [echo, image, fail, "codemode"]);
  await f.run(a, echo, { value: "STRUCTURED" });
  const structured = f.events.filter(e => e.type === "tool_execution_end" && e.toolName === echo).at(-1).result;
  assert.deepEqual(structured.structuredContent.structuredContent, { value: "STRUCTURED" });
  const picture = await f.run(a, image); assert.ok(picture.content.some(c => c.type === "image" && c.mimeType === "image/png"));
  assert.equal((await f.run(a, fail)).isError, true);
  const nested = await f.run(a, "codemode", { code: 'text(await tools.mcp__local__echo({value:"NESTED_ALLOWED"})); try { await tools.ordinary_probe({}); } catch(e) { text("NESTED_DENIED"); } text(typeof models);' });
  assert.match(JSON.stringify(nested), /NESTED_ALLOWED/); assert.match(JSON.stringify(nested), /NESTED_DENIED/);
  assert.match(JSON.stringify(nested), /undefined/); assert.equal(f.ordinaryCalls(), 0);
  const nestedEvents = f.events.filter(e => e.type === "tool_execution_start" && e.toolName === echo);
  assert.ok(nestedEvents.some(e => typeof e.parentToolCallId === "string"), JSON.stringify(nestedEvents));
  await f.grant(a, ["codemode"]);
  const denied = await f.run(a, "codemode", { code: 'try { await tools.mcp__local__echo({value:"DENIED_AGAIN"}); } catch(e) { text("REVOKED"); }' });
  assert.match(JSON.stringify(denied), /REVOKED/);
});

test("native HTTP resources require the chosen server capability and cannot aggregate across servers", async t => {
  const http = await httpFixture(t);
  const f = await fixture(t, { allowed: { url: http.url, exposure: "direct" }, other: { url: http.url, exposure: "codemode" } }); const a = await f.create();
  await wait(() => a.control.snapshot().servers.length === 2 && a.control.snapshot().servers.every(s => s.resources && s.tools.length));
  await f.grant(a, ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "codemode"], ["allowed"]);
  assert.match(JSON.stringify(await f.run(a, "list_mcp_resources", { server: "allowed" })), /FIXTURE_PRIVATE_RESOURCE/);
  assert.match(JSON.stringify(await f.run(a, "read_mcp_resource", { server: "allowed", uri: "fixture://private" })), /FIXTURE_RESOURCE_CONTENT/);
  const count = http.state.calls.length;
  assert.equal((await f.run(a, "list_mcp_resources", {})).isError, true);
  assert.equal((await f.run(a, "list_mcp_resources", { server: "other" })).isError, true);
  const nested = await f.run(a, "codemode", { code: 'try { await tools.read_mcp_resource({server:"other",uri:"fixture://private"}); } catch(e) { text("CROSS_SERVER_DENIED"); }' });
  assert.match(JSON.stringify(nested), /CROSS_SERVER_DENIED/); assert.equal(http.state.calls.length, count);
  assert.equal(a.wrapper.getSessionCapabilities().items.filter(i => i.id.startsWith("mcp-resource:") && i.enabled).length, 1);
});

test("native exposure modes retain saved asynchronous grants, deny newly discovered tools and hide withdrawn tools", async t => {
  let release; const discoveryGate = new Promise(r => { release = r; }); t.after(() => release());
  const http = await httpFixture(t, { calls: [], cancelled: 0, withdrawn: false, discoveryGate });
  const initial = { version: 1, revision: 3, preset: "custom", enabledCapabilityIds: ["tool:mcp__late__echo", "tool:codemode", "tool:tool_search"], knownCapabilityIds: ["tool:mcp__late__echo", "tool:codemode", "tool:tool_search"], updatedAt: new Date().toISOString() };
  const f = await fixture(t, { late: { url: http.url, exposure: "codemode" }, direct: stdio("direct"), deferred: stdio("deferred"), hidden: stdio("hidden") });
  const manager = SessionManager.create(f.cwd, join(f.agentDir, "sessions")); manager.appendCustomEntry(caps.SESSION_CAPABILITY_ENTRY_TYPE, initial);
  const a = await f.create(manager);
  assert.ok(a.wrapper.getSessionCapabilities().policy.enabledCapabilityIds.includes("tool:mcp__late__echo"));
  release(); await wait(() => a.control.snapshot().servers.length === 4 && a.control.snapshot().servers.every(s => s.tools.length));
  assert.equal(a.control.isAllowed("mcp__late__echo"), true);
  assert.equal(a.control.isAllowed("mcp__late__image"), false);
  assert.equal(a.control.isAllowed("mcp__hidden__echo"), false);
  assert.equal(a.session.getActiveToolNames().includes("mcp__late__echo"), false);
  assert.match(JSON.stringify(await f.run(a, "codemode", { code: 'text(await tools.mcp__late__echo({value:"RESTORED_ASYNC"}));' })), /RESTORED_ASYNC/);
  await f.grant(a, ["mcp__direct__echo", "mcp__deferred__echo", "tool_search", "codemode", "mcp__late__image", "mcp__late__withdraw"]);
  assert.ok(a.session.getActiveToolNames().includes("mcp__direct__echo"));
  assert.equal(a.session.getActiveToolNames().includes("mcp__deferred__echo"), false);
  await f.run(a, "tool_search", { query: "echo", limit: 10 });
  assert.ok(a.session.getActiveToolNames().includes("mcp__deferred__echo"));
  assert.equal(a.wrapper.isToolAllowedByCapability("mcp__deferred__image"), false);
  await f.run(a, "codemode", { code: "text(await tools.mcp__late__withdraw({}));" });
  await wait(() => !a.control.isAvailable("mcp__late__image"));
  assert.equal(a.wrapper.getSessionCapabilities().items.find(i => i.id === "tool:mcp__late__image").available, false);
  assert.equal((await f.run(a, "mcp__late__image")).isError, true);
});

test("same-workspace sessions have independent permissions, explicit reconnect does not replay tool calls, and changed config revokes execution", async t => {
  const http = await httpFixture(t); const f = await fixture(t, { local: { url: http.url, exposure: "direct" } });
  const a = await f.create(), b = await f.create(); await wait(() => a.control.snapshot().servers[0]?.tools.length && b.control.snapshot().servers[0]?.tools.length);
  await f.grant(a, ["mcp__local__echo"]); await f.run(a, "mcp__local__echo");
  assert.equal((await f.run(b, "mcp__local__echo")).isError, true); assert.equal(http.state.calls.length, 1);
  await a.session.prompt("/mcp reconnect local"); assert.equal(http.state.calls.length, 1);
  cfg.updateNativeMcpServer(f.agentDir, f.cwd, false, { name: "local", scope: "global", enabled: false });
  assert.equal((await f.run(a, "mcp__local__echo")).isError, true); assert.equal(http.state.calls.length, 1);
});

test("native stdio progress and Stop abort a nested MCP call without a replay", async t => {
  const f = await fixture(t, { local: stdio("codemode") }); const a = await f.create();
  await wait(() => a.control.snapshot().servers[0]?.tools.length);
  await f.grant(a, ["codemode", "mcp__local__wait"]);
  f.calls.push([{ type: "toolCall", id: "stop-outer", name: "codemode", arguments: { code: 'text(await tools.mcp__local__wait({}));' } }]);
  await a.wrapper.send({ type: "prompt", message: "STOP_FIXTURE" });
  await wait(() => f.events.some(e => e.type === "tool_execution_update" && JSON.stringify(e).includes("FIXTURE_PROGRESS")));
  await a.wrapper.send({ type: "abort" }); await wait(() => a.wrapper.getRuntime() === "idle");
  const count = f.events.filter(e => e.type === "tool_execution_start" && e.toolName === "mcp__local__wait").length;
  assert.equal(count, 1);
  await a.wrapper.send({ type: "prompt", message: "AFTER_STOP" }); await wait(() => a.wrapper.getRuntime() === "idle");
  assert.equal(f.events.filter(e => e.type === "tool_execution_start" && e.toolName === "mcp__local__wait").length, 1);
});

test("native connections need explicit opt-in and registered-server identity approval", async t => {
  const http = await httpFixture(t);
  const f = await fixture(t, {}, { extension: pi => pi.registerMcpServer("registered", { url: http.url, exposure: "direct" }) }); const a = await f.create();
  assert.equal(a.control.snapshot().servers[0].state, "approval-required"); assert.equal(http.state.calls.length, 0);
  a.control.approveRegistered("registered", true);
  // Approval is persisted, and connection takes effect only on the next load.
  const b = await f.create(); await wait(() => b.control.snapshot().servers[0]?.tools.length);
  await f.grant(b, ["mcp__registered__echo"]); await f.run(b, "mcp__registered__echo");
  b.control.approveRegistered("registered", false);
  assert.equal((await f.run(b, "mcp__registered__echo")).isError, true); assert.equal(http.state.calls.length, 1);
  cfg.writeNativeMcpPreferences(f.agentDir, { enabled: false, approvedRegistered: [] });
  assert.equal((await f.run(b, "mcp__registered__echo")).isError, true);
});

test("disabled integration and enabled:false servers never create a transport", async t => {
  for (const integrationEnabled of [false, true]) await t.test(`integration ${integrationEnabled}`, async t => {
    let transports = 0;
    const f = await fixture(t, { local: { ...stdio("direct"), enabled: !integrationEnabled } }, { enabled: integrationEnabled, controllerOptions: { createTransport: () => { transports++; throw new Error("Disabled fixture must never connect"); } } });
    const a = await f.create();
    await a.session.prompt("Check disabled native configuration");
    assert.equal(transports, 0); assert.equal(a.control.snapshot().servers[0].state, "disabled");
    assert.equal(a.session.getAllTools().some(tool => tool.name.startsWith("mcp__")), false);
  });
});

test("a legacy /mcp command replaces the native factory before it connects", async t => {
  const http = await httpFixture(t);
  const f = await fixture(t, { local: { url: http.url, exposure: "direct" } }, { extension: pi => pi.registerCommand("mcp", { description: "Legacy adapter fixture", handler: async () => {} }) });
  const a = await f.create();
  assert.equal(a.control.snapshot().owner, "replacement"); assert.equal(a.control.snapshot().servers.length, 0);
  assert.equal(a.session.getAllTools().some(tool => tool.name.startsWith("mcp__")), false);
});

test("notes, device profiles and tool ceilings deny MCP execution, including codemode nesting", async t => {
  for (const restricted of [{ notes: true }, { profile: "device-control" }, { toolNameCeiling: ["codemode"] }]) await t.test(JSON.stringify(restricted), async t => {
    const f = await fixture(t, { local: stdio("codemode") }, restricted); const a = await f.create();
    await wait(() => a.control.snapshot().servers[0]?.tools.length);
    if (!restricted.notes) await f.grant(a, ["codemode", "mcp__local__echo"]);
    assert.equal(a.control.isAllowed("mcp__local__echo"), false);
    const result = await f.run(a, "codemode", { code: 'try { await tools.mcp__local__echo({value:"RESTRICTED"}); } catch(e) { text("FENCED"); }' });
    assert.doesNotMatch(JSON.stringify(result.content), /"text":"RESTRICTED"/);
  });
});

test("project capability ceiling retains a previously authorized asynchronous MCP tool", async t => {
  let release; const discoveryGate = new Promise(r => { release = r; }); t.after(() => release());
  const http = await httpFixture(t, { calls: [], cancelled: 0, withdrawn: false, discoveryGate });
  const policy = { version: 1, revision: 1, preset: "custom", enabledCapabilityIds: ["tool:codemode", "tool:mcp__late__echo"], knownCapabilityIds: ["tool:codemode", "tool:mcp__late__echo"], updatedAt: new Date().toISOString() };
  const f = await fixture(t, { late: { url: http.url, exposure: "codemode" } }, { policy, projectManaged: true }); const a = await f.create();
  release(); await wait(() => a.control.snapshot().servers[0]?.tools.length);
  assert.equal(a.control.isAllowed("mcp__late__echo"), true);
  assert.equal(a.control.isAllowed("mcp__late__image"), false);
  assert.match(JSON.stringify(await f.run(a, "codemode", { code: 'text(await tools.mcp__late__echo({value:"PROJECT_ASYNC"}));' })), /PROJECT_ASYNC/);
});

test("native helper activation does not bypass the existing tool definition budget", async t => {
  const f = await fixture(t, {}, { extension: pi => pi.registerTool({ name: "oversized_fixture", label: "Oversized fixture", description: "Oversized definition ".repeat(50000), parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "never" }] }) }) });
  const a = await f.create();
  await assert.rejects(f.grant(a, ["codemode", "tool_search", "oversized_fixture"]), /per-session limit/);
  assert.equal(a.control.isAllowed("oversized_fixture"), false);
});

test("native OAuth uses explicit RPC login, refresh and scope step-up with cancellation and redacted status", async t => {
  const state = { calls: [], cancelled: 0, withdrawn: false, oauth: true, tokenRequests: [], refreshes: 0, token: "missing", requestedScope: "read", requireWrite: false };
  const http = await httpFixture(t, state); const browserUrls = [];
  let autoCallback = true;
  const f = await fixture(t, { oauth: { url: http.url, exposure: "direct", oauth: { clientId: "fixture-client", clientSecret: "fixture-private-client-secret", scope: "read" } } }, { controllerOptions: { openUrl: url => {
    browserUrls.push(url); const parsed = new URL(url); state.requestedScope = parsed.searchParams.get("scope");
    if (autoCallback) { state.requireWrite = false; const callback = new URL(parsed.searchParams.get("redirect_uri")); callback.searchParams.set("code", "fixture-code"); callback.searchParams.set("state", parsed.searchParams.get("state")); void fetch(callback).catch(() => {}); }
  } } });
  const a = await f.create(); await wait(() => a.control.snapshot().servers[0]?.state === "needs-auth");
  assert.equal(browserUrls.length, 0); assert.equal(state.tokenRequests.length, 0);
  await a.session.prompt("/mcp login oauth"); await wait(() => a.control.snapshot().servers[0]?.tools.length);
  assert.equal(browserUrls.length, 1); assert.equal(state.tokenRequests[0].grant_type, "authorization_code");
  assert.equal(state.tokenRequests[0].client_secret, "fixture-private-client-secret");
  await f.grant(a, ["mcp__oauth__echo"]);
  assert.match(JSON.stringify(await f.run(a, "mcp__oauth__echo", { value: "OAUTH_ALLOWED" })), /OAUTH_ALLOWED/);
  state.expired = true;
  assert.match(JSON.stringify(await f.run(a, "mcp__oauth__echo", { value: "REFRESHED" })), /REFRESHED/);
  assert.equal(state.refreshes, 1); assert.equal(browserUrls.length, 1);
  state.requireWrite = true;
  assert.equal((await f.run(a, "mcp__oauth__echo")).isError, true);
  assert.equal(state.refreshes, 1); assert.equal(browserUrls.length, 1);
  autoCallback = false;
  const remove = a.wrapper.onEvent(event => { if (event.type === "extension_ui_request" && event.method === "input") void a.wrapper.send({ type: "extension_ui_response", id: event.id }); });
  await a.session.prompt("/mcp login oauth"); remove();
  assert.equal(browserUrls.length, 2); assert.match(new URL(browserUrls[1]).searchParams.get("scope"), /read/); assert.match(new URL(browserUrls[1]).searchParams.get("scope"), /write/);
  assert.equal(state.tokenRequests.length, 2);
  assert.ok(f.events.some(e => e.type === "extension_ui_request" && e.message === "Sign-in cancelled."));
  const status = JSON.stringify(a.control.snapshot());
  assert.doesNotMatch(status, /fixture-access-|fixture-refresh-|fixture-private-client-secret|headers|oauthState/);
  const errors = JSON.stringify(f.events.filter(e => e.type === "extension_error" || e.type === "extension_ui_request" && e.notifyType !== "info"));
  assert.doesNotMatch(errors, /fixture-access-|fixture-refresh-|fixture-private-client-secret/);
});
