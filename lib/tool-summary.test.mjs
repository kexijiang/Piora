import assert from "node:assert/strict";
import test from "node:test";

const { summarizeToolCall, summarizeToolDisclosure } = await import("./tool-summary.ts");
const t = (key, variables = {}) => `${key}${Object.keys(variables).length ? `:${Object.values(variables).join("|")}` : ""}`;

const cases = [
  ["read", { path: "src/a.ts", offset: 4, limit: 8 }, "toolSummary.read:src/a.ts", "eye"],
  ["bash", { command: "npm test" }, "toolSummary.bash", "code"],
  ["edit", { path: "src/a.ts", edits: [] }, "toolSummary.edit:src/a.ts", "edit"],
  ["write", { path: "src/a.ts", content: "hello" }, "toolSummary.write:src/a.ts", "save"],
  ["grep", { pattern: "TODO", path: "src" }, "toolSummary.grep:TODO", "search"],
  ["find", { pattern: "*.ts", path: "src" }, "toolSummary.find:*.ts", "file-search"],
  ["ls", { path: "src" }, "toolSummary.ls:src", "folder"],
];

test("summarizes all seven built-in tools", () => {
  for (const [name, input, title, icon] of cases) {
    assert.deepEqual(
      { title: summarizeToolCall(name, input, undefined, t).title, icon: summarizeToolCall(name, input, undefined, t).icon },
      { title, icon },
    );
  }
});

test("reports edit patch counts and result status", () => {
  const result = { isError: false, content: [], details: { patch: "--- a/a\n+++ b/a\n-old\n+new\n+more" } };
  assert.deepEqual(summarizeToolCall("edit", { path: "a", edits: [] }, result, t), {
    title: "toolSummary.edit:a", detail: "+2 −1", icon: "edit", status: "ok",
  });
  assert.equal(summarizeToolCall("bash", { command: "bad" }, { isError: true, content: [] }, t).status, "error");
});

test("unknown tools fall back to their name and first string argument", () => {
  assert.deepEqual(summarizeToolCall("deploy_preview", { region: "shanghai", count: 2 }, undefined, t), {
    title: "deploy_preview", detail: "shanghai", icon: "wrench", status: "running",
  });
});

test("chat headers separate file subjects while preserving extension summaries", () => {
  const header = summarizeToolDisclosure("read", { path: "src/login.tsx", offset: 4, limit: 8 }, undefined, t);
  assert.equal(header.title, "toolSummary.action.read");
  assert.equal(header.subject, "src/login.tsx");
  assert.equal(header.subjectIsPath, true);
  assert.equal(header.detail, "toolSummary.range:4|8");
  assert.deepEqual(summarizeToolDisclosure("deploy_preview", { region: "shanghai" }, undefined, t),
    summarizeToolCall("deploy_preview", { region: "shanghai" }, undefined, t));
});

test("streaming partial tool inputs never crash the renderer", () => {
  for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", undefined]) {
    assert.doesNotThrow(() => summarizeToolCall(name, {}, undefined, t));
    assert.doesNotThrow(() => summarizeToolCall(name, { command: undefined, content: undefined }, undefined, t));
  }
  assert.equal(summarizeToolCall("bash", {}, undefined, t).detail, undefined);
  assert.match(summarizeToolCall("write", {}, undefined, t).detail, /0/);
});
