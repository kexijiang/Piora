import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { Type } from "typebox";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { streamSimple as openaiStream } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { createSdkTestFixture } from "./pi-sdk-test-fixture.mjs";

async function providerServer(t, respond) {
  const requests = [], errors = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const part of request) body += part;
      const parsed = JSON.parse(body);
      requests.push(parsed);
      respond(response, parsed, requests.length);
    })().catch(error => { errors.push(error); response.destroy(error); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

const probeTool = {
  name: "wire_probe", label: "Wire probe", description: "Local compatibility fixture",
  parameters: Type.Object({ value: Type.String() }),
  execute: async (_id, args) => ({ content: [{ type: "text", text: `PROBE_RESULT:${args.value}` }] }),
};

test("Pi 1.5.2 retains tool history while omitting disabled tools, and honors legacy gateway compatibility", async t => {
  const server = await providerServer(t, (response, _body, index) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const delta = index === 1
      ? { tool_calls: [{ index: 0, id: "wire-call", type: "function", function: { name: "wire_probe", arguments: JSON.stringify({ value: "payload" }) } }] }
      : { content: "WIRE_OK" };
    response.write(`data: ${JSON.stringify({ id: `chat-${index}`, object: "chat.completion.chunk", model: "model", choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: `chat-${index}`, choices: [{ index: 0, delta: {}, finish_reason: index === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  let legacyGateway = false;
  const f = await createSdkTestFixture(t, {
    toolNames: [probeTool.name], extension: pi => pi.registerTool(probeTool),
    streamProvider: (model, input, options) => openaiStream({ ...model, api: "openai-completions", baseUrl: server.baseUrl, compat: { ...model.compat, requiresToolsWithToolHistory: legacyGateway } }, input, { ...options, apiKey: "local-fixture", maxRetries: 0 }),
  });
  const session = await f.create();
  await session.prompt("RUN_WIRE_PROBE");
  assert.equal(server.requests.length, 2);
  assert.deepEqual(server.requests[0].tools.map(tool => tool.function.name), [probeTool.name]);
  session.setActiveToolsByName([]);
  await session.prompt("TOOLS_DISABLED");
  assert.equal(server.requests.length, 3);
  const withoutTools = server.requests[2];
  assert.equal(Object.hasOwn(withoutTools, "tools"), false);
  assert.ok(withoutTools.messages.some(message => message.role === "tool" && message.content.includes("PROBE_RESULT:payload")), "disabling tools must preserve prior results");
  legacyGateway = true;
  await session.prompt("LEGACY_GATEWAY");
  assert.equal(server.requests.length, 4);
  assert.deepEqual(server.requests[3].tools, []);
  assert.match(JSON.stringify(session.messages.at(-1)), /WIRE_OK/);
  const restored = await f.create(SessionManager.open(session.sessionFile));
  assert.match(JSON.stringify(restored.messages), /PROBE_RESULT:payload/);
});

for (const failure of ["expired", "unsupported"]) test(`Pi 1.5.2 Anthropic ${failure} threads fall back with full history and respect tool changes`, async t => {
  const server = await providerServer(t, (response, _body, index) => {
    if (index === 2) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `Fixture thread ${failure}`, details: { error_code: failure === "expired" ? "thread_not_found" : "thread_unsupported_request" } } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: "message_start", message: { id: `msg-${index}`, type: "message", role: "assistant", model: "model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `THREAD_REPLY_${index}` } });
    send({ type: "content_block_stop", index: 0 });
    send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
    send({ type: "message_stop" }); response.end();
  });
  const f = await createSdkTestFixture(t, {
    toolNames: [probeTool.name],
    extension: pi => pi.registerTool(probeTool),
    streamProvider: (model, input, options) => anthropicStream({ ...model, api: "anthropic-messages", baseUrl: server.baseUrl, compat: { ...model.compat, supportsMessageThreads: true } }, input, { ...options, apiKey: "local-fixture", maxRetries: 0, cacheRetention: "short" }),
  });
  const session = await f.create();
  session.setActiveToolsByName([]);
  await session.prompt("THREAD_FIRST");
  assert.deepEqual(server.requests[0].thread, { type: "create" });
  await session.prompt("THREAD_SECOND");
  assert.equal(server.requests.length, 3, "a rejected continuation is resent exactly once");
  assert.deepEqual(server.requests[1].thread, { type: "continue", previous_message_id: "msg-1" });
  assert.doesNotMatch(JSON.stringify(server.requests[1].messages), /THREAD_FIRST/);
  assert.equal(Object.hasOwn(server.requests[1], "system"), false);
  assert.equal(Object.hasOwn(server.requests[1], "tools"), false);
  assert.match(JSON.stringify(server.requests[2].messages), /THREAD_FIRST/);
  assert.match(JSON.stringify(server.requests[2].messages), /THREAD_SECOND/);
  assert.deepEqual(server.requests[2].thread, failure === "expired" ? { type: "create" } : undefined);
  assert.match(JSON.stringify(session.messages.at(-1)), /anthropic_thread_fallback/);
  await session.prompt("THREAD_THIRD");
  assert.deepEqual(server.requests[3].thread, failure === "expired" ? { type: "continue", previous_message_id: "msg-3" } : undefined);
  session.setActiveToolsByName([probeTool.name]);
  assert.ok(session.getActiveToolNames().includes(probeTool.name));
  await session.prompt("THREAD_NEW_TOOLS");
  assert.equal(server.requests.length, 5);
  assert.deepEqual(server.requests[4].thread, failure === "expired" ? { type: "create" } : undefined);
  assert.ok(server.requests[4].tools.some(tool => tool.name === probeTool.name));
  assert.match(JSON.stringify(server.requests[4].messages), /THREAD_FIRST/);
  assert.match(JSON.stringify(session.messages.at(-1)), /THREAD_REPLY_5/);
});

test("reviewed Shell patch preserves the reported exit code when background output outlives a timed-out command", { timeout: 10000 }, async t => {
  // Run the installed, patched SDK code and its real stdio settlement helper.
  // Inject only spawn/kill: Windows closes inherited handles differently, so
  // a controlled child boundary supplies a shell exit followed by active output.
  const sourceUrl = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js", import.meta.url);
  const require = createRequire(sourceUrl);
  const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough(), signalCode: null });
  let outputTimer, exitTimer, killed = false;
  t.after(() => { clearInterval(outputTimer); clearTimeout(exitTimer); child.stdout.destroy(); child.stderr.destroy(); });
  const sdkModule = { exports: {} };
  const source = ts.transpileModule(await readFile(sourceUrl, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, {
    module: sdkModule, exports: sdkModule.exports,
    require: id => id === "child_process" ? { ...require(id), spawn: () => {
      outputTimer = setInterval(() => child.stdout.write("BACKGROUND\n"), 10);
      exitTimer = setTimeout(() => child.emit("exit", 7, null), 10);
      return child;
    } } : id === "../../utils/shell.js" ? { ...require(id),
      getShellEnv: () => ({}), trackDetachedChildPid() {}, untrackDetachedChildPid() {},
      killProcessTree: pid => {
        assert.equal(pid, child.pid); killed = true; clearInterval(outputTimer);
        queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit("close", 7, null); });
      },
    } : require(id),
    process, Buffer, console, performance, setTimeout, clearTimeout,
  });
  const operations = sdkModule.exports.createLocalShellOperations("controlled-shell", () => ({ shell: "fixture", args: [] }));
  const tool = sdkModule.exports.createBashTool(process.cwd(), { operations });
  await assert.rejects(tool.execute("pipe-timeout", { command: "controlled child", timeout: 0.25 }), error => {
    assert.match(error.message, /Command timed out after 0.25 seconds/);
    assert.match(error.message, /The shell exited with code 7 after [\d.]+ seconds/);
    assert.match(error.message, /background processes it started kept writing output/);
    return true;
  });
  assert.equal(killed, true);
});
