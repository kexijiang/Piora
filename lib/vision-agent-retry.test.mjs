import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url);
const vision = await jiti.import("./vision-agent.ts");
const status = await jiti.import("./vision-agent-status.ts");
const compiled = ts.transpileModule(readFileSync(new URL("../extensions/piora-vision-agent.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

test("the real extension suppresses repeat failures across context events and permits a newly attached retry", async () => {
  const config = { enabled: true, provider: "fixture", modelId: "vision" };
  const exports = {};
  runInNewContext(compiled, { exports, require: name => name.includes("vision-agent-status") ? status : { ...vision, readVisionAgentConfig: () => config } });
  const handlers = new Map(), statuses = [];
  exports.default({ on: (event, fn) => handlers.set(event, fn), appendEntry: () => assert.fail("failed observations must not become successful cache entries") });
  let calls = 0;
  const ctx = {
    model: { input: ["text"] }, signal: new AbortController().signal,
    ui: { setStatus: (_key, value) => statuses.push(value) }, sessionManager: { getBranch: () => [] },
    modelRegistry: {
      getError: () => undefined, find: () => ({ input: ["image"] }), hasConfiguredAuth: () => true,
      complete: async () => { calls++; return { stopReason: "error", errorMessage: "Request was aborted" }; },
    },
  };
  const imageMessage = { role: "user", content: [{ type: "text", text: "inspect" }, { type: "image", mimeType: "image/png", data: "YWJj" }], timestamp: 1 };
  const run = messages => handlers.get("context")({ messages }, ctx);
  handlers.get("before_agent_start")({}, ctx);
  await run([imageMessage]);
  await run([imageMessage, { role: "toolResult", content: [{ type: "text", text: "result" }] }]);
  assert.equal(calls, 1);
  handlers.get("agent_settled")({}, ctx);
  handlers.get("before_agent_start")({}, ctx);
  assert.equal(statuses.at(-1), undefined, "old failure is cleared at the new prompt");
  await run([imageMessage, { role: "user", content: "为什么图片识别失败？", timestamp: 2 }]);
  assert.equal(calls, 1);
  assert.equal(statuses.at(-1), undefined, "a text-only follow-up does not raise another vision failure");
  handlers.get("before_agent_start")({}, ctx);
  await run([imageMessage, { ...imageMessage, timestamp: 3 }]);
  assert.equal(calls, 2, "reattaching the same image retries even with the same question");
});
