import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { Type } from "typebox";
import { StreamingJsonParser, validateToolArguments } from "@earendil-works/pi-ai";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { createSdkTestFixture } from "./pi-sdk-test-fixture.mjs";

const { AgentSessionWrapper } = await createJiti(import.meta.url).import("./rpc-manager.ts");
const largeContent = '工具输出 😀 const text = "quoted";\\path\r\n'.repeat(15_000);
const toolArguments = { path: "large-output.txt", content: largeContent };
const rawArguments = JSON.stringify(toolArguments);

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    assert.ok(Date.now() < deadline, "SDK operation did not reach the expected boundary");
    await delay(10);
  }
}

// Real HTTP/SSE and the installed Anthropic parser; no external service or key.
async function providerServer(t, { hold = false } = {}) {
  const requests = [];
  const errors = [];
  let heldResponse;
  const send = (response, event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      const first = requests.length === 1;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      send(response, { type: "message_start", message: { id: `msg-${requests.length}`, type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      send(response, { type: "content_block_start", index: 0, content_block: first ? { type: "tool_use", id: "large-call", name: "write_fixture", input: {} } : { type: "text", text: "" } });
      if (first) {
        for (let offset = 0; offset < rawArguments.length; offset += 127) {
          send(response, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: rawArguments.slice(offset, offset + 127) } });
          if (hold) { heldResponse = response; return; }
          if (offset % (127 * 32) === 0) await nextTurn();
          if (response.destroyed) return;
        }
      } else send(response, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "DONE" } });
      send(response, { type: "content_block_stop", index: 0 });
      send(response, { type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: first ? 1000 : 1 } });
      send(response, { type: "message_stop" });
      response.end();
    })().catch(error => { errors.push(error); response.destroy(error); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  return { requests, get heldResponse() { return heldResponse; }, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function wrap(t, f) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const session = await f.create();
  const wrapper = new AgentSessionWrapper(session);
  wrapper.start();
  await wrapper.waitUntilReady();
  t.after(async () => { wrapper.destroy(); await wrapper.shutdownForFileMutation(); });
  return { wrapper, session };
}

function startPrompt(wrapper, message, id) {
  return wrapper.startTrackedPrompt({ source: "ui", commandId: `command-${id}`, clientPromptId: id, message });
}

test("Pi 1.5 streams a large tool through real HTTP, parses each delta once and restores exact disk history", { timeout: 60_000 }, async t => {
  assert.ok(Buffer.byteLength(largeContent) > 500 * 1024);
  const server = await providerServer(t);
  let parsedCharacters = 0;
  const append = StreamingJsonParser.prototype.append;
  t.mock.method(StreamingJsonParser.prototype, "append", function (text) {
    parsedCharacters += text.length;
    return append.call(this, text);
  });
  let executions = 0;
  const f = await createSdkTestFixture(t, {
    toolNames: ["write_fixture"],
    streamProvider: (model, input, options) => anthropicStream({ ...model, api: "anthropic-messages", baseUrl: server.baseUrl }, input, { ...options, apiKey: "local-fixture", maxRetries: 0 }),
    extension: pi => pi.registerTool({ name: "write_fixture", label: "Write fixture", description: "Write inside the isolated fixture", parameters: Type.Object({ path: Type.String(), content: Type.String() }), async execute(_id, args, _signal, _update, ctx) {
      executions++;
      assert.deepEqual(args, toolArguments);
      await writeFile(join(ctx.cwd, args.path), args.content);
      return { content: [{ type: "text", text: "FILE_SAVED" }] };
    } }),
  });
  const { wrapper, session } = await wrap(t, f);
  const snapshots = [];
  let deltas = 0;
  let done = false;
  const terminalEvents = [];
  wrapper.onEvent(event => {
    if (event.type === "prompt_done") done = true;
    if (["prompt_error", "prompt_done", "extension_ui_request"].includes(event.type)) terminalEvents.push(event);
    if (event.type !== "message_update") return;
    const block = event.message.content.find(part => part.type === "toolCall");
    if (!block) return;
    assert.equal("partialJson" in block, false);
    assert.equal("partialArgs" in block, false);
    if (++deltas % 500 === 0) snapshots.push([block.arguments, structuredClone(block.arguments)]);
  });
  await startPrompt(wrapper, "WRITE_LARGE_FIXTURE", "large-durable-prompt");
  // Thousands of deliberately tiny HTTP frames also exercise SDK persistence
  // and event forwarding; this is a correctness check, not a wall-clock budget.
  try { await waitFor(() => done && wrapper.getRuntime() === "idle", 30_000); }
  catch (error) {
    t.diagnostic(JSON.stringify({ done, runtime: wrapper.getRuntime(), executions, deltas, parsedCharacters, requests: server.requests.length, terminalEvents }));
    throw error;
  }
  assert.equal(executions, 1);
  assert.ok(deltas > 1000, `Expected incremental updates, got ${deltas}`);
  assert.equal(parsedCharacters, rawArguments.length, "The provider must parse only new deltas, never accumulated prefixes");
  for (const [snapshot, original] of snapshots) assert.deepEqual(snapshot, original, "Earlier argument snapshots must stay immutable");
  assert.equal(await readFile(join(f.cwd, toolArguments.path), "utf8"), largeContent);
  assert.equal(server.requests.length, 2);
  assert.match(JSON.stringify(server.requests[1]), /FILE_SAVED/);
  const restored = SessionManager.open(session.sessionFile);
  const messages = restored.buildSessionContext().messages;
  const users = messages.filter(message => message.role === "user");
  assert.equal(users.length, 1);
  assert.equal(users[0].clientPromptId, "large-durable-prompt");
  const call = messages.flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.type === "toolCall");
  assert.deepEqual(call.arguments, toolArguments);
  assert.equal(messages.filter(message => message.role === "toolResult").length, 1);
  assert.doesNotMatch(await readFile(session.sessionFile, "utf8"), /"partialJson"|"partialArgs"/);
  await f.create(restored);
  assert.equal(executions, 1, "Restoring a session must never replay a completed tool");
});

test("Pi 1.5 cancellation during partial tool input closes HTTP and preserves the user receipt without executing", { timeout: 30_000 }, async t => {
  const server = await providerServer(t, { hold: true });
  let executions = 0;
  let partialReceived = false;
  const f = await createSdkTestFixture(t, {
    toolNames: ["write_fixture"],
    streamProvider: (model, input, options) => anthropicStream({ ...model, api: "anthropic-messages", baseUrl: server.baseUrl }, input, { ...options, apiKey: "local-fixture", maxRetries: 0 }),
    extension: pi => pi.registerTool({ name: "write_fixture", label: "Write fixture", description: "Must not execute incomplete input", parameters: Type.Object({ path: Type.String(), content: Type.String() }), async execute() {
      executions++;
      return { content: [{ type: "text", text: "UNEXPECTED" }] };
    } }),
  });
  const { wrapper, session } = await wrap(t, f);
  wrapper.onEvent(event => {
    if (event.type === "message_update" && event.message.content.some(block => block.type === "toolCall" && block.arguments.content)) partialReceived = true;
  });
  await startPrompt(wrapper, "CANCEL_PARTIAL_TOOL", "cancel-durable-prompt");
  await waitFor(() => partialReceived);
  await wrapper.send({ type: "abort" });
  await waitFor(() => wrapper.getRuntime() === "idle" && server.heldResponse?.destroyed);
  assert.equal(executions, 0);
  const restored = SessionManager.open(session.sessionFile);
  assert.equal(restored.buildSessionContext().messages.filter(message => message.role === "user" && message.clientPromptId === "cancel-durable-prompt").length, 1);
  await startPrompt(wrapper, "AFTER_CANCEL", "next-durable-prompt");
  await waitFor(() => server.requests.length === 2 && wrapper.getRuntime() === "idle");
  assert.equal(executions, 0, "The cancelled tool must not leak into the next run");
  assert.match(JSON.stringify(server.requests[1]), /AFTER_CANCEL/);
});

for (const schemaKind of ["TypeBox", "JSON Schema"]) {
  test(`Pi 1.5 validates ${schemaKind} arguments before authorization and gates coerced final values`, { timeout: 30_000 }, async t => {
    const parameters = schemaKind === "TypeBox"
      ? Type.Object({ limit: Type.Integer({ minimum: 1 }), paths: Type.Array(Type.String()) })
      : { type: "object", properties: { limit: { type: "integer", minimum: 1 }, paths: { type: "array", items: { type: "string" } } }, required: ["limit", "paths"] };
    const calls = [{ limit: "invalid", paths: "file.txt" }, { limit: "3", paths: "file.txt" }];
    const executed = [];
    const f = await createSdkTestFixture(t, {
      toolNames: ["schema_probe"],
      step: request => request.index < calls.length ? [{ type: "toolCall", id: `schema-${request.index}`, name: "schema_probe", arguments: calls[request.index] }] : [{ type: "text", text: "DONE" }],
      extension: pi => pi.registerTool({ name: "schema_probe", label: "Schema probe", description: "Validate and authorize coerced arguments", parameters, async execute(_id, args) {
        executed.push(args);
        return { content: [{ type: "text", text: "OK" }] };
      } }),
    });
    const { wrapper } = await wrap(t, f);
    await wrapper.send({ type: "set_tool_permission", mode: "ask" });
    const approvals = [];
    let done = false;
    wrapper.onEvent(event => {
      if (event.type === "prompt_done") done = true;
      if (event.type === "extension_ui_request" && event.toolApproval) {
        approvals.push(event);
        void wrapper.send({ type: "extension_ui_response", id: event.id, confirmed: true });
      }
    });
    await startPrompt(wrapper, "VALIDATE_AND_AUTHORIZE", `schema-${schemaKind}`);
    await waitFor(() => done && wrapper.getRuntime() === "idle");
    assert.equal(approvals.length, 1, "Invalid arguments must not be sent for approval");
    assert.deepEqual(executed, [{ limit: 3, paths: ["file.txt"] }]);
    assert.match(JSON.stringify(approvals[0]), /file\.txt/);
    const invalidResult = f.requests[1].messages.find(message => message.role === "toolResult" && message.toolCallId === "schema-0");
    assert.equal(invalidResult.isError, true);
    assert.match(JSON.stringify(invalidResult), /limit/);
  });
}

test("Pi 1.5 still loads external extensions using legacy Type and StringEnum imports", async t => {
  const f = await createSdkTestFixture(t, { resourceFiles: { "legacy-extension.ts": `
    import { Type, StringEnum, type Static } from "@earendil-works/pi-ai";
    const parameters = Type.Object({ value: StringEnum(["keep", "test"]) });
    type Args = Static<typeof parameters>;
    export default function(pi) {
      pi.registerTool({ name: "legacy_probe", label: "Legacy", description: "Compatibility fixture", parameters,
        async execute(_id, args: Args) { return { content: [{ type: "text", text: args.value }] }; }
      });
    }
  ` } });
  const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: f.agentDir,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [join(f.cwd, "legacy-extension.ts")],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  const tool = loaded.extensions.flatMap(extension => [...extension.tools.values()]).find(tool => tool.definition.name === "legacy_probe").definition;
  const call = value => ({ type: "toolCall", id: "legacy-call", name: tool.name, arguments: { value } });
  assert.deepEqual(validateToolArguments(tool, call("keep")), { value: "keep" });
  assert.throws(() => validateToolArguments(tool, call("invalid")));
  assert.deepEqual((await tool.execute("legacy-call", { value: "keep" })).content, [{ type: "text", text: "keep" }]);
});
