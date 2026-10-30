import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(import.meta.dirname, "..") } });
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("./session-reader.ts");
const { GET } = await jiti.import("../app/api/sessions/[id]/export/route.ts");
const { UiGenerationPrototype, generationJournalPath } = await jiti.import("./intelligent-ui/generation-journal.ts");
const { compileUiPlan } = await jiti.import("./intelligent-ui/plan.ts");

for (const version of [2, 3]) test(`real export route reads version ${version} without appending LF or persisting migration`, async t => {
  const root = mkdtempSync(join(tmpdir(), "piora-export-readonly-")), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const manager = SessionManager.create(root, join(root, "sessions")), id = manager.getSessionId();
  manager.appendMessage({ role: "user", content: "Export a read-only conversation", timestamp: 1 });
  const path = manager.getSessionFile(), rows = readFileSync(path, "utf8").trimEnd().split("\n").map(JSON.parse);
  rows[0].version = version; writeFileSync(path, rows.map(JSON.stringify).join("\n")); cacheSessionPath(id, path);
  t.after(() => {
    invalidateSessionPathCache(id); globalThis.__piSessions?.delete(id);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const before = readFileSync(path), mtime = statSync(path).mtimeMs;
  const response = await GET(new Request(`http://localhost/api/sessions/${id}/export`), { params: Promise.resolve({ id }) });
  const html = await response.text(); assert.equal(response.status, 200, html);
  assert.match(response.headers.get("Content-Type"), /text\/html/); assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /function sortChildren\(root\)/, "the existing deep-session export fix is preserved");
  assert.deepEqual(readFileSync(path), before); assert.equal(statSync(path).mtimeMs, mtime);
  assert.equal(globalThis.__piSessions?.has(id) ?? false, false);
});

test("full export reports a damaged generation journal instead of silently claiming saved output", async t => {
  const root = mkdtempSync(join(tmpdir(), "piora-export-bad-journal-")), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const manager = SessionManager.create(root, join(root, "sessions")), id = manager.getSessionId();
  manager.appendMessage({ role: "user", content: "A simple UI", timestamp: 1 });
  const host = new UiGenerationPrototype({ manager, root }); await host.startRun();
  const context = await host.captureContext("bill"), plan = { planVersion: 1, id: "bill", title: "Bill", inputs: [], derived: [], views: [{ id: "text", kind: "text", text: "Saved text" }] };
  manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "ui", name: "piora_render_ui_plan", arguments: plan }], timestamp: 2 });
  const candidate = await host.createCandidate(context.contextId, "ui", compileUiPlan(plan, { revision: 1 }));
  await host.persistCandidate(candidate.operationId); await host.commitCandidate(candidate.operationId);
  const path = manager.getSessionFile(), journal = generationJournalPath(id, root); cacheSessionPath(id, path); writeFileSync(journal, "{");
  t.after(() => {
    invalidateSessionPathCache(id); globalThis.__piSessions?.delete(id);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const bytes = readFileSync(path), response = await GET(new Request(`http://localhost/api/sessions/${id}/export`), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 500); assert.match((await response.json()).error, /journal cannot be read/);
  assert.deepEqual(readFileSync(path), bytes); assert.equal(readFileSync(journal, "utf8"), "{");
});
