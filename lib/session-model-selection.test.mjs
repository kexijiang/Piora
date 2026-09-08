import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url); const model = await jiti.import("./session-model-selection.ts"); const { modelErrorMessage } = await jiti.import("./model-error-message.ts");
test("project model selections persist for every session and a stale completion cannot clear a newer request", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-project-model-")); const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  try { const first = model.scheduleSessionModels(["one", "two", "archived"], { provider: "p", modelId: "a" }); assert.deepEqual(model.readPendingSessionModel("archived"), first); const second = model.scheduleSessionModels(["one"], { provider: "p", modelId: "b" }); model.clearPendingSessionModel("one", first.revision); assert.deepEqual(model.readPendingSessionModel("one"), second); model.clearPendingSessionModel("one", second.revision); assert.equal(model.readPendingSessionModel("one"), undefined); assert.equal(model.readPendingSessionModel("two").modelId, "a"); } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); }
});
test("model failures switch explanation language while retaining upstream detail", () => {
  for (const error of ["HTTP 401", "HTTP 402", "HTTP 403", "HTTP 429", "HTTP 500", "Fetch failed", "Model ID is required", "EACCES", "No API key found"]) { const zh = modelErrorMessage(error, "zh-CN"), en = modelErrorMessage(error, "en"); assert.match(zh.summary, /[\u3400-\u9fff]/); assert.doesNotMatch(en.summary, /[\u3400-\u9fff]/); assert.equal(zh.detail, error); assert.equal(en.detail, error); }
});
