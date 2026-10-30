import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") } });
const protocol = await jiti.import("./intelligent-ui/protocol.ts");
const store = await jiti.import("./intelligent-ui/store.ts");
const beta = await jiti.import("./beta-features.ts");
const register = (await jiti.import("../extensions/piora-intelligent-ui.ts")).default;
const surface = () => ({ version: 1, id: "shopping", revision: 1, title: "Shopping list", nodes: [
  { id: "people", type: "slider", label: "People", value: 4, min: 1, max: 20, step: 1 },
  { id: "bread", type: "metric", label: "Bread", value: { op: "multiply", args: [{ ref: "people" }, 2] } },
  { id: "table", type: "table", columns: ["Item", "Quantity"], rows: [["Bread", { op: "multiply", args: [{ ref: "people" }, 2] }]] },
] });
const output = (id, parentId, spec = surface(), toolCallId = "call-1") => ({ id, parentId, type: "message", message: { role: "toolResult", toolCallId, details: { answerOutput: { kind: "intelligent-ui", version: 1, snapshot: protocol.formatSnapshot(spec), payload: spec } } } });
const message = (id, parentId) => ({ id, parentId, type: "message", message: { role: "assistant" } });
function temporary(t) { const root = mkdtempSync(join(tmpdir(), "piora-ui-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
const save = (root, sessionId, branch, state, revision = 0, toolCallId = "call-1") => store.saveSurfaceState({ root, sessionId, toolCallId, leafId: branch.at(-1).id, expectedRevision: revision, state, enabled: () => true, branch: () => branch });

test("trusted UI computes quantities and readable snapshots locally", () => {
  const spec = protocol.validateSurface(surface());
  const state = protocol.validateState(spec, { people: 7 });
  assert.equal(protocol.evaluateExpression(spec.nodes[1].value, state), 14);
  assert.match(protocol.formatSnapshot(spec, state), /People: 7\nBread: 14/);
  assert.match(protocol.formatSnapshot(spec, state), /Bread \| 14/);
  assert.deepEqual(protocol.initialState(spec), { people: 4 });
});
test("schema rejects code, URLs, unknown nodes, duplicate IDs, malicious keys and references", () => {
  for (const mutate of [
    s => { s.nodes[0].onChange = "fetch('/api/files')"; },
    s => { s.nodes.push({ id: "host", type: "iframe", src: "https://bad.example" }); },
    s => { s.nodes[1].id = "people"; },
    s => { s.nodes[0].id = "__proto__"; },
    s => { s.nodes[1].value = { ref: "constructor" }; },
    s => { s.nodes[1].value = { op: "eval", args: ["1+1"] }; },
    s => { s.nodes[0].min = 9; },
    s => { s.nodes[0].step = 0; },
  ]) { const spec = surface(); mutate(spec); assert.throws(() => protocol.validateSurface(spec)); }
  assert.throws(() => protocol.validateState(surface(), JSON.parse('{"people":3,"__proto__":{"admin":true}}')));
  assert.throws(() => protocol.validateState(surface(), { people: Infinity }));
  assert.throws(() => protocol.validateState(surface(), { people: 99 }));
  assert.throws(() => protocol.validateState(surface(), { people: "3" }));
  assert.equal({}.admin, undefined);
});
test("component, expression, depth and text budgets reject resource abuse", () => {
  const spec = surface(); spec.nodes = Array.from({ length: 65 }, (_, i) => ({ id: `t${i}`, type: "text", text: "x" }));
  assert.throws(() => protocol.validateSurface(spec), /64/);
  let expr = 1; for (let i = 0; i < 14; i++) expr = { op: "round", args: [expr] };
  const deep = surface(); deep.nodes[1].value = expr; assert.throws(() => protocol.validateSurface(deep), /budget/);
  const wide = surface(); wide.nodes[1].value = { op: "add", args: Array(33).fill(1) }; assert.throws(() => protocol.validateSurface(wide));
  const big = surface(); big.nodes.push({ id: "big", type: "text", text: "x".repeat(65000) }); assert.throws(() => protocol.validateSurface(big), /large/);
  assert.throws(() => protocol.evaluateExpression({ op: "divide", args: [2, 0] }, {}), /zero/);
  assert.throws(() => protocol.evaluateExpression({ op: "add", args: ["2", 3] }, {}), /numeric/);
});
test("compatible user inputs survive revised defaults; type/range changes use valid defaults", () => {
  const spec = surface(); spec.nodes[0].value = 2;
  assert.deepEqual(protocol.mergeState(spec, { people: 8, deleted: true }), { people: 8 });
  spec.nodes[0].max = 5;
  assert.deepEqual(protocol.mergeState(spec, { people: 8 }), { people: 2 });
});
test("checkboxes and selections control safe lazy conditional calculations", () => {
  const expr = { op: "if", args: [{ ref: "vegetarian" }, { op: "if", args: [{ op: "equals", args: [{ ref: "size" }, "large"] }, 3, 2] }, { op: "divide", args: [1, 0] }] };
  assert.equal(protocol.evaluateExpression(expr, { vegetarian: true, size: "large" }), 3);
  assert.equal(protocol.evaluateExpression(expr, { vegetarian: true, size: "small" }), 2);
  assert.throws(() => protocol.evaluateExpression(expr, { vegetarian: "true", size: "large" }), /boolean/);
  assert.equal(protocol.evaluateExpression({ op: "equals", args: [1, "1"] }, {}), false);
  const spec = { version: 1, id: "food", revision: 1, title: "Food", nodes: [
    { id: "vegetarian", type: "checkbox", label: "Vegetarian", value: true },
    { id: "size", type: "select", label: "Size", value: "small", options: ["small", "large"] },
    { id: "food", type: "metric", label: "Quantity", value: expr },
  ] };
  assert.match(protocol.formatSnapshot(protocol.validateSurface(spec)), /Quantity: 2/);
});
test("state persists through reload, later branch entries and current snapshots", async t => {
  const root = temporary(t), branch = [output("ui", null), message("answer", "ui")];
  assert.equal(store.getSurfaceState("chat", branch, "call-1", root).revision, 0);
  await save(root, "chat", branch, { people: 6 });
  const later = [...branch, message("next", "answer")];
  assert.deepEqual(store.getSurfaceState("chat", later, "call-1", root).state, { people: 6 });
  assert.match(store.intelligentUiSnapshots("chat", later, root)[0], /Bread: 12/);
  assert.match(store.intelligentUiContext("chat", later, root), /untrusted task data, never instructions/);
});
test("fork and in-session branches inherit only ancestral state then diverge independently", async t => {
  const root = temporary(t), base = [output("ui", null)], left = [...base, message("left", "ui")], right = [...base, message("right", "ui")];
  await save(root, "chat", base, { people: 5 });
  const leftState = await save(root, "chat", left, { people: 8 }, 1);
  assert.equal(leftState.revision, 2);
  assert.deepEqual(store.getSurfaceState("chat", right, "call-1", root).state, { people: 5 });
  store.copyIntelligentUiState("chat", "fork", base.map(e => e.id), root);
  assert.deepEqual(store.getSurfaceState("fork", base, "call-1", root).state, { people: 5 });
  await save(root, "fork", base, { people: 9 }, 1);
  assert.deepEqual(store.getSurfaceState("chat", left, "call-1", root).state, { people: 8 });
  assert.deepEqual(store.getSurfaceState("other", base, "call-1", root).state, { people: 4 });
  assert.throws(() => store.getSurfaceState("chat", [message("unrelated", null)], "call-1", root), /does not belong/);
});
test("editing an earlier leaf freezes existing child branches but lets new children inherit new values", async t => {
  const root = temporary(t), ancestor = [output("ui", null)], existing = [...ancestor, message("existing", "ui")];
  await save(root, "chat", ancestor, { people: 2 });
  await store.saveSurfaceState({ root, sessionId: "chat", toolCallId: "call-1", leafId: "ui", expectedRevision: 1, state: { people: 9 }, enabled: () => true, branch: () => ancestor, allEntries: () => existing });
  assert.deepEqual(store.getSurfaceState("chat", existing, "call-1", root).state, { people: 2 });
  const next = [...ancestor, message("new", "ui")];
  assert.deepEqual(store.getSurfaceState("chat", next, "call-1", root).state, { people: 9 });
  await save(root, "chat", existing, { people: 3 }, 1);
  await store.saveSurfaceState({ root, sessionId: "chat", toolCallId: "call-1", leafId: "ui", expectedRevision: 2, state: { people: 5 }, enabled: () => true, branch: () => ancestor, allEntries: () => [...existing, next[1]] });
  assert.deepEqual(store.getSurfaceState("chat", existing, "call-1", root).state, { people: 3 });
  assert.deepEqual(store.getSurfaceState("chat", next, "call-1", root).state, { people: 9 });
});
test("real SessionManager navigation retains distinct sidecar values even before navigation reaches disk", async t => {
  const root = temporary(t), manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "make shopping list", timestamp: Date.now() });
  const ui = output("unused", null).message;
  const anchor = manager.appendMessage({ ...ui, toolName: "piora_render_ui", content: [{ type: "text", text: "Shopping list" }], isError: false, timestamp: Date.now() });
  const sessionId = manager.getSessionId();
  await save(root, sessionId, manager.getBranch(), { people: 2 });
  const child = manager.appendMessage({ role: "user", content: "continue A", timestamp: Date.now() });
  manager.branch(anchor);
  await store.saveSurfaceState({ root, sessionId, toolCallId: "call-1", leafId: anchor, expectedRevision: 1, state: { people: 9 }, enabled: () => true, branch: () => manager.getBranch(), allEntries: () => manager.getEntries() });
  assert.deepEqual(store.getSurfaceState(sessionId, manager.getBranch(child), "call-1", root).state, { people: 2 });
  assert.deepEqual(store.getSurfaceState(sessionId, manager.getBranch(), "call-1", root).state, { people: 9 });
  manager.appendMessage({ role: "user", content: "continue B", timestamp: Date.now() });
  assert.deepEqual(store.getSurfaceState(sessionId, manager.getBranch(), "call-1", root).state, { people: 9 });
});
test("editing a narrowed ancestor preserves raw saved choices in an existing wider descendant", async t => {
  const root = temporary(t), base = [output("ui", null)];
  await save(root, "chat", base, { people: 7 });
  const narrow = surface(); narrow.revision = 2; narrow.nodes[0] = { ...narrow.nodes[0], value: 2, max: 5 };
  const ancestor = [...base, output("ancestor", "ui", narrow, "narrow-call")];
  const wide = surface(); wide.revision = 3;
  const descendant = [...ancestor, output("descendant", "ancestor", wide, "wide-call")];
  assert.deepEqual(store.getSurfaceState("chat", ancestor, "narrow-call", root).state, { people: 2 });
  assert.deepEqual(store.getSurfaceState("chat", descendant, "wide-call", root).state, { people: 7 });
  await store.saveSurfaceState({ root, sessionId: "chat", toolCallId: "narrow-call", leafId: "ancestor", expectedRevision: 1, state: { people: 3 }, enabled: () => true, branch: () => ancestor, allEntries: () => descendant });
  assert.deepEqual(store.getSurfaceState("chat", ancestor, "narrow-call", root).state, { people: 3 });
  assert.deepEqual(store.getSurfaceState("chat", descendant, "wide-call", root).state, { people: 7 });
  const future = [...ancestor, output("future", "ancestor", wide, "future-call")];
  assert.deepEqual(store.getSurfaceState("chat", future, "future-call", root).state, { people: 3 });
});
test("a frozen untouched descendant adopts later model defaults instead of treating them as user edits", async t => {
  const root = temporary(t), ancestor = [output("ui", null)], child = message("child", "ui");
  await store.saveSurfaceState({ root, sessionId: "chat", toolCallId: "call-1", leafId: "ui", expectedRevision: 0, state: { people: 9 }, enabled: () => true, branch: () => ancestor, allEntries: () => [...ancestor, child] });
  const original = store.getSurfaceState("chat", [...ancestor, child], "call-1", root);
  assert.equal(original.revision, 0);
  assert.deepEqual(original.state, { people: 4 });
  const updated = surface(); updated.revision = 2; updated.nodes[0].value = 2;
  const later = [...ancestor, child, output("updated", "child", updated, "call-2")];
  assert.deepEqual(store.getSurfaceState("chat", later, "call-2", root).state, { people: 2 });
});
test("concurrent saves reject lost updates; unrelated surfaces do not conflict", async t => {
  const root = temporary(t), other = { ...surface(), id: "budget" }, branch = [output("ui", null), output("second", "ui", other, "call-2")];
  const results = await Promise.allSettled([save(root, "chat", branch, { people: 8 }), save(root, "chat", branch, { people: 9 })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.status, 409);
  await save(root, "chat", branch, { people: 10 }, 0, "call-2");
  assert.deepEqual(store.getSurfaceState("chat", branch, "call-2", root).state, { people: 10 });
});
test("writes reject disabled feature, stale leaf, invalid state and superseded surface", async t => {
  const root = temporary(t), branch = [output("ui", null), message("answer", "ui")];
  const opts = { root, sessionId: "chat", toolCallId: "call-1", leafId: "answer", expectedRevision: 0, state: { people: 6 }, enabled: () => true, branch: () => branch };
  await assert.rejects(store.saveSurfaceState({ ...opts, enabled: () => false }), e => e.status === 403);
  await assert.rejects(store.saveSurfaceState({ ...opts, leafId: "ui" }), e => e.status === 409);
  await assert.rejects(store.saveSurfaceState({ ...opts, state: { people: -1 } }));
  const updated = [...branch, output("updated", "answer", { ...surface(), revision: 2 }, "call-2")];
  await assert.rejects(store.saveSurfaceState({ ...opts, leafId: "updated", branch: () => updated }), e => e.status === 409);
  await store.saveSurfaceState({ ...opts, leafId: "ui", canAdvanceLeaf: () => true });
  assert.deepEqual(store.getSurfaceState("chat", branch, "call-1", root).state, { people: 6 });
});
test("legacy extension respects off snapshot, validates real SDK schema, persists readable result and updates context", async t => {
  const root = temporary(t), previous = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PIORA_UI_INPUT_PROTOCOL: process.env.PIORA_UI_INPUT_PROTOCOL };
  process.env.PI_CODING_AGENT_DIR = root; process.env.PIORA_UI_INPUT_PROTOCOL = "surface";
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const tools = [], handlers = {};
  const api = { registerTool: tool => tools.push(tool), on: (event, handler) => { handlers[event] = handler; } };
  register(api); assert.equal(tools.length, 0); assert.deepEqual(handlers, {});
  beta.writeBetaFeatures({ intelligentUi: true }, root); register(api); assert.equal(tools.length, 1);
  const tool = tools[0], spec = surface(), params = { id: spec.id, title: spec.title, nodes: spec.nodes };
  const validated = validateToolArguments(tool, { type: "toolCall", id: "call-1", name: tool.name, arguments: params });
  const branch = [], file = join(root, "surface-session.jsonl");
  const persistBranch = () => writeFileSync(file, [{ type: "session", version: 3, id: "chat", cwd: root, timestamp: new Date().toISOString() }, ...branch].map(JSON.stringify).join("\n") + "\n");
  persistBranch();
  const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => "chat", getSessionFile: () => file,
    getLeafId: () => branch.at(-1)?.id ?? null } };
  const updates = [];
  const broken = await tool.execute("invalid-ref", { ...params, nodes: [...params.nodes, { id: "broken", type: "metric", label: "Broken", value: { ref: "private-invalid-reference" } }] }, undefined, update => updates.push(update), ctx);
  assert.equal(broken.isError, true);
  assert.equal(broken.details.intelligentUiDiagnostic.code, "UI_REFERENCE");
  assert.equal(broken.details.intelligentUiDiagnostic.repairable, true);
  assert.doesNotMatch(JSON.stringify(broken), /private-invalid-reference/);
  assert.equal(updates.length, 0, "invalid candidates never emit a successful preview");
  const result = await tool.execute("call-1", validated, undefined, update => updates.push(update), ctx);
  assert.equal(updates.length, 1); assert.equal(result.details.answerOutput.kind, "intelligent-ui");
  branch.push({ id: "ui", parentId: null, type: "message", message: { role: "toolResult", toolCallId: "call-1", ...result } });
  persistBranch();
  const untouchedUpdate = await tool.execute("untouched-call", { ...params, nodes: params.nodes.map(n => n.id === "people" ? { ...n, value: 2 } : n) }, undefined, undefined, ctx);
  assert.match(untouchedUpdate.content[0].text, /People: 2/);
  assert.equal(untouchedUpdate.details.answerOutput.snapshot, protocol.formatSnapshot(untouchedUpdate.details.answerOutput.payload));
  const untouchedBranch = [...branch, { id: "untouched", parentId: "ui", type: "message", message: { role: "toolResult", toolCallId: "untouched-call", ...untouchedUpdate } }];
  assert.equal(store.getSurfaceState("chat", untouchedBranch, "untouched-call", root).snapshot, untouchedUpdate.content[0].text);
  await save(root, "chat", branch, { people: 7 });
  const context = await handlers.context({ messages: [] }, ctx);
  assert.match(context.messages[0].content, /People: 7/);
  assert.equal(context.messages[0].display, false);
  const changed = await tool.execute("call-2", { ...params, nodes: params.nodes.map(n => n.id === "people" ? { ...n, value: 2 } : n) }, undefined, undefined, ctx);
  assert.equal(changed.details.answerOutput.payload.revision, 2); assert.match(changed.content[0].text, /People: 7/);
  const narrow = await tool.execute("narrow-call", { ...params, nodes: params.nodes.map(n => n.id === "people" ? { ...n, value: 2, max: 5 } : n) }, undefined, undefined, ctx);
  assert.match(narrow.content[0].text, /People: 2/);
  branch.push({ id: "narrow", parentId: "ui", type: "message", message: { role: "toolResult", toolCallId: "narrow-call", ...narrow } });
  persistBranch();
  const widen = await tool.execute("wide-call", params, undefined, undefined, ctx);
  assert.match(widen.content[0].text, /People: 7/, "restore compatible saved input instead of carrying an older schema fallback");
  const wideBranch = [...branch, { id: "wide", parentId: "narrow", type: "message", message: { role: "toolResult", toolCallId: "wide-call", ...widen } }];
  assert.equal(store.getSurfaceState("chat", wideBranch, "wide-call", root).snapshot, widen.content[0].text);
  beta.writeBetaFeatures({ intelligentUi: false }, root);
  assert.equal((await tool.execute("call-3", params, undefined, undefined, ctx)).details.answerOutput.kind, "intelligent-ui", "existing run keeps its capability snapshot");
  await assert.rejects(tool.execute("cancelled", params, AbortSignal.abort(), undefined, ctx), /cancelled/);
  writeFileSync(store.intelligentUiStatePath("chat", root), "{corrupt");
  assert.match((await handlers.context({ messages: [] }, ctx)).messages[0].content, /unavailable/);
});
test("route rejects cross-origin mutation and wrong content type before touching sessions", async () => {
  const route = await jiti.import("../app/api/sessions/[id]/intelligent-ui/route.ts");
  const context = { params: Promise.resolve({ id: "missing" }) };
  assert.equal((await route.PUT(new Request("http://localhost/api/sessions/missing/intelligent-ui", { method: "PUT", headers: { host: "localhost", origin: "https://evil.example", "content-type": "application/json" }, body: "{}" }), context)).status, 403);
  assert.equal((await route.PUT(new Request("http://localhost/api/sessions/missing/intelligent-ui", { method: "PUT", headers: { host: "localhost", "content-type": "text/plain" }, body: "{}" }), context)).status, 415);
});
