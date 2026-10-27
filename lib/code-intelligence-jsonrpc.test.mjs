import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
import * as jsonrpc from "vscode-jsonrpc/node";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("./code-intelligence.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(t, configureServer) {
  const root = mkdtempSync(join(tmpdir(), "piora-jsonrpc-"));
  const entry = join(root, "plugins", "openharmony", "ace-server", "out", "standardIndex");
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, "index.js"), "// LSP availability fixture\n");
  const filePath = join(root, "Main.ets");
  const content = "const answer = 42;\nanswer\n";
  writeFileSync(filePath, content);
  const processes = [], clients = [], timers = new Map();
  const state = {};
  // Keep real production serialization, framing, handlers and session lifecycle.
  // Only the external DevEco process/environment are replaced: no sockets or
  // device SDK are needed for the installed JSON-RPC Node transport.
  function spawn(command, args, options) {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, ["fixture-deveco", "serve", "lsp", "--arkts", "--project-path", root]);
    assert.equal(options.cwd, root);
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kills = 0;
    child.kill = () => { child.kills++; queueMicrotask(() => child.emit("exit", 0)); return true; };
    const server = jsonrpc.createMessageConnection(child.stdin, child.stdout);
    configureServer(server);
    server.listen();
    processes.push({ child, server });
    return child;
  }
  const exports = {};
  const load = name => {
    if (name === "node:child_process") return { ...require(name), spawn };
    if (name === "./harmony/check-runtime") return {
      DEVECO_CLI_PATH: "fixture-deveco", findHarmonyProjectRoot: () => root,
      inspectHarmonyCheckEnvironment: () => ({ studioPath: root }),
    };
    if (name === "vscode-jsonrpc/node") return {
      ...jsonrpc,
      createMessageConnection(...args) {
        const connection = jsonrpc.createMessageConnection(...args);
        const record = { connection, disposed: false };
        connection.onDispose(() => { record.disposed = true; });
        clients.push(record);
        return connection;
      },
    };
    return require(name);
  };
  // Preserve production timeout values, but let a test fire the exact timer
  // after the peer has received a request rather than waiting 8 or 20 seconds.
  const schedule = (callback, ms) => {
    const timer = setTimeout(callback, ms);
    timers.set(timer, { callback, ms });
    return timer;
  };
  const clear = timer => { timers.delete(timer); clearTimeout(timer); };
  new Function("require", "exports", "globalThis", "setTimeout", "clearTimeout", compiled)(load, exports, state, schedule, clear);
  t.after(() => {
    for (const { connection } of clients) connection.dispose();
    for (const { child, server } of processes) {
      server.dispose();
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.destroy();
    }
    for (const timer of timers.keys()) clearTimeout(timer);
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, filePath, content, processes, clients, state, timers,
    query: input => exports.runCodeQuery({ cwd: root, filePath, ...input }),
    fireTimeout(ms) {
      const matches = [...timers].filter(([, value]) => value.ms === ms);
      assert.equal(matches.length, 1, `one active ${ms}ms production timeout`);
      const [timer, { callback }] = matches[0];
      clear(timer); callback();
    },
  };
}

test("JSON-RPC 10 Node streams initialize bidirectionally, synchronize documents, hover and close", { timeout: 10000 }, async t => {
  const events = [], opened = deferred(), changed = deferred(), closed = deferred();
  let initialize, configuration;
  const f = fixture(t, server => {
    server.onRequest("initialize", async params => {
      initialize = params;
      // The peer requests configuration before replying to initialize. This
      // requires the production client to listen and route both directions.
      configuration = await server.sendRequest("workspace/configuration", { items: [{ section: "arkts" }, { section: "editor" }] });
      return { capabilities: { hoverProvider: true, textDocumentSync: 1 } };
    });
    server.onNotification("initialized", () => events.push("initialized"));
    server.onNotification("textDocument/didOpen", params => { events.push("open"); opened.resolve(params); });
    server.onNotification("textDocument/didChange", params => { events.push("change"); changed.resolve(params); });
    server.onNotification("textDocument/didClose", closed.resolve);
    server.onRequest("textDocument/hover", params => {
      events.push("hover");
      assert.equal(params.textDocument.uri, pathToFileURL(f.filePath).href);
      assert.deepEqual(params.position, { line: 1, character: 2 });
      return { contents: { kind: "markdown", value: "**answer**: number" } };
    });
  });
  assert.match(source, /from "vscode-jsonrpc\/node"/);
  const result = await f.query({ action: "hover", content: f.content, version: 1, offset: f.content.indexOf("\n") + 3 });
  assert.deepEqual(result, { mode: "arkts-lsp", hover: "**answer**: number" });
  assert.equal(initialize.rootUri, pathToFileURL(f.root).href);
  assert.equal(initialize.rootPath, f.root);
  assert.equal(initialize.capabilities.textDocument.completion.completionItem.snippetSupport, false);
  assert.deepEqual(configuration, [null, null]);
  assert.deepEqual((await opened.promise).textDocument, { uri: pathToFileURL(f.filePath).href, languageId: "arkts", version: 1, text: f.content });
  assert.deepEqual(events, ["initialized", "open", "hover"]);
  await f.query({ action: "sync", content: f.content + "// unsaved\n", version: 2 });
  assert.deepEqual((await changed.promise).contentChanges, [{ text: f.content + "// unsaved\n" }]);
  await f.query({ action: "close" });
  assert.deepEqual(await closed.promise, { textDocument: { uri: pathToFileURL(f.filePath).href } });
  assert.equal(f.processes.length, 1);
  assert.equal(f.processes[0].child.kills, 1);
  assert.equal(f.clients[0].disposed, true);
  assert.equal(f.state.__pioraCodeSessions.size, 0);
  assert.equal(f.timers.size, 0);
});

for (const failure of ["error", "timeout"]) {
  test(`JSON-RPC initialize ${failure} disposes transport and falls back without a leaked pending request`, { timeout: 10000 }, async t => {
    const received = deferred();
    const f = fixture(t, server => {
      server.onRequest("initialize", () => {
        received.resolve();
        return failure === "error" ? new jsonrpc.ResponseError(-32001, "initialization rejected") : new Promise(() => {});
      });
    });
    const request = f.query({ action: "sync", content: f.content, version: 1 });
    await received.promise;
    if (failure === "timeout") f.fireTimeout(20000);
    const result = await request;
    assert.equal(result.mode, "arkts-basic");
    assert.match(result.message, failure === "error" ? /initialization rejected/ : /Language service timed out/);
    assert.equal(f.clients[0].disposed, true);
    assert.equal(f.processes[0].child.kills, 1);
    const session = [...f.state.__pioraCodeSessions.values()][0];
    assert.equal(session.lsp, undefined);
    assert.equal(session.lspStart, undefined);
    assert.ok(session.lspRetryAt > Date.now());
    assert.equal([...f.timers.values()].some(({ ms }) => ms === 20000), false);
    await f.query({ action: "close" });
    assert.equal(f.state.__pioraCodeSessions.size, 0);
    assert.equal(f.timers.size, 0);
  });

  test(`JSON-RPC hover ${failure} falls back and cleans up the active connection`, { timeout: 10000 }, async t => {
    const received = deferred();
    const f = fixture(t, server => {
      server.onRequest("initialize", () => ({ capabilities: { hoverProvider: true } }));
      server.onRequest("textDocument/hover", () => {
        received.resolve();
        return failure === "error" ? new jsonrpc.ResponseError(-32002, "hover rejected") : new Promise(() => {});
      });
    });
    const request = f.query({ action: "hover", content: f.content, version: 1, offset: 7 });
    await received.promise;
    if (failure === "timeout") f.fireTimeout(8000);
    const result = await request;
    assert.equal(result.mode, "arkts-basic");
    assert.match(result.message, failure === "error" ? /hover rejected/ : /Language service timed out/);
    assert.match(result.hover, /answer/);
    assert.equal(f.clients[0].disposed, true);
    assert.equal(f.processes[0].child.kills, 1);
    assert.equal([...f.state.__pioraCodeSessions.values()][0].lsp, undefined);
    assert.equal([...f.timers.values()].some(({ ms }) => ms === 8000), false);
    await f.query({ action: "close" });
    assert.equal(f.state.__pioraCodeSessions.size, 0);
    assert.equal(f.timers.size, 0);
  });
}
