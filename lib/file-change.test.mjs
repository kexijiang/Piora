import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { countPatchLines, getFileChangeInfo } = await jiti.import("./file-change.ts");
const { default: registerFileChanges } = await jiti.import("../extensions/piora-file-changes.ts");

test("file tool guidance follows active visible capabilities and preserves shell and user choices", () => {
  const handlers = new Map();
  registerFileChanges({on:(name,handler)=>handlers.set(name,handler)});
  const before = handlers.get("before_agent_start");
  const event = tools => ({systemPrompt:"original",systemPromptOptions:{selectedTools:tools}});
  const full = before(event(["read","ls","find","grep","edit","write","bash"]));
  assert.match(full.systemPrompt,/^original/);
  for (const name of ["read","ls","find","grep","edit","write"]) assert.match(full.systemPrompt,new RegExp(`use ${name}|Use ${name}`));
  assert.match(full.systemPrompt,/builds, tests, Git/);
  assert.match(full.systemPrompt,/Follow explicit user tool choices/);
  assert.equal(before(event(["bash"])),undefined);
  assert.equal(before({...event(["read"]),systemPromptOptions:{selectedTools:["read"],hiddenTools:["read"]}}),undefined);
  const limited=before(event(["grep"])).systemPrompt;
  assert.doesNotMatch(limited,/Use read|use find|use ls/);
  assert.equal(before({...event(["read"]),systemPrompt:full.systemPrompt}),undefined,"do not duplicate the guidance");
});

test("recognizes edit results and counts unified patch lines", () => {
  const patch = [
    "--- a/components/Card.tsx",
    "+++ b/components/Card.tsx",
    "@@ -1,2 +1,3 @@",
    "-const oldValue = 1;",
    "+const nextValue = 2;",
    "+const label = 'ready';",
    " export default nextValue;",
  ].join("\n");

  assert.deepEqual(countPatchLines(patch), { added: 2, removed: 1 });
  assert.deepEqual(getFileChangeInfo({
    type: "toolCall",
    toolCallId: "edit-1",
    toolName: "edit",
    input: { path: "components/Card.tsx" },
  }, {
    role: "toolResult",
    toolCallId: "edit-1",
    content: [{ type: "text", text: "ok" }],
    details: { patch },
  }), {
    path: "components/Card.tsx",
    patch,
    added: 2,
    removed: 1,
    kind: "updated",
    status: "completed",
  });
});

test("captures a new write as an immutable per-operation patch", async () => {
  const handlers = new Map();
  registerFileChanges({ on: (name, handler) => handlers.set(name, handler) });
  const fileName = `piora-file-change-${process.pid}-${Date.now()}.txt`;
  const path = join(tmpdir(), fileName);
  const input = { path, content: "first line\nsecond line\n" };

  await handlers.get("tool_call")({
    type: "tool_call",
    toolCallId: "write-1",
    toolName: "write",
    input,
  }, { cwd: tmpdir() });
  const transformed = await handlers.get("tool_result")({
    type: "tool_result",
    toolCallId: "write-1",
    toolName: "write",
    input,
    content: [{ type: "text", text: "ok" }],
    isError: false,
    details: undefined,
  });

  assert.equal(transformed.details.path, path);
  assert.equal(transformed.details.changeKind, "created");
  assert.match(transformed.details.patch, /^--- /m);
  assert.match(transformed.details.patch, /^\+first line$/m);
  assert.match(transformed.details.patch, /^\+second line$/m);
});

test("keeps write calls visible while they are still running", () => {
  const info = getFileChangeInfo({
    type: "toolCall",
    toolCallId: "write-running",
    toolName: "write",
    input: { path: "notes.md", content: "hello" },
  });

  assert.equal(info.status, "running");
  assert.equal(info.path, "notes.md");
  assert.equal(info.patch, null);
});
