import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createChatCommandCatalog, parseChatInput, createChatCommandOperation, templateUsesArguments, persistentChatInputOptions } = await jiti.import("./chat-command-input.ts");
const catalog = createChatCommandCatalog([
  { name: "deploy", source: "extension" },
  { name: "review", source: "prompt", usesTemplateArguments: true, argumentHint: "[focus]" },
  { name: "fixed", source: "prompt", usesTemplateArguments: false },
  { name: "skill:documents", source: "skill" },
]);

test("handoff identities never become persisted retry options", () => {
  const options = { submissionId: "initial-send", inputMode: "text", afterPrompt: "question" };
  assert.deepEqual(persistentChatInputOptions(options), { inputMode: "text", afterPrompt: "question" });
  assert.equal(options.submissionId, "initial-send");
});

test("a no-argument command creates an atomic command and query operation", () => {
  const text = "/reload 检查输入恢复\n并保留附件";
  const parsed = parseChatInput(text, catalog, { hasAttachments: true });
  assert.equal(parsed.kind, "command");
  assert.equal(parsed.invocation, "/reload");
  assert.equal(parsed.afterPrompt, "检查输入恢复\n并保留附件");
  const operation = createChatCommandOperation(text, catalog, parsed);
  assert.equal(operation.rawText, text);
  assert.equal(operation.steps.length, 2);
  assert.equal(operation.steps[1].status, "pending");
});

test("native parameters preserve quoting, internal whitespace and multiline text", () => {
  for (const name of ["deploy", "review", "compact", "skill:documents"]) {
    const parsed = parseChatInput(`  /${name}\t\"API compatibility\"  中文\n第二行`, catalog);
    assert.equal(parsed.kind, "command");
    assert.equal(parsed.arguments, '"API compatibility"  中文\n第二行');
    assert.equal(parsed.invocation, `/${name} \"API compatibility\"  中文\n第二行`);
    assert.equal(parsed.afterPrompt, undefined);
  }
});

test("invalid commands and unconsumed parameters do not silently become model prompts", () => {
  assert.equal(parseChatInput("/missing query", catalog).code, "UNKNOWN_COMMAND");
  assert.equal(parseChatInput("/name", catalog).code, "COMMAND_ARGUMENT_REQUIRED");
  assert.equal(parseChatInput("/fixed query", catalog).code, "UNUSED_TEMPLATE_ARGUMENTS");
  assert.equal(parseChatInput("/quit", catalog).code, "UNSUPPORTED_COMMAND");
  assert.equal(parseChatInput("/reload first", catalog, { afterPrompt: "second" }).code, "AMBIGUOUS_AFTER_PROMPT");
  assert.equal(parseChatInput("/deploy staging", catalog, { hasAttachments: true }).code, "COMMAND_ATTACHMENTS_UNSUPPORTED");
  assert.equal(parseChatInput("/reload", catalog, { hasAttachments: true }).code, "COMMAND_ATTACHMENTS_UNSUPPORTED");
});

test("literal and embedded slash text remains ordinary text", () => {
  assert.deepEqual(parseChatInput("Explain /reload", catalog), { kind: "message", text: "Explain /reload" });
  assert.deepEqual(parseChatInput("/home/project", catalog, { inputMode: "text" }), { kind: "message", text: "/home/project" });
});

test("slash paths, regexes and prose are sent intact while command typos remain errors", () => {
  for (const text of ["/api/agent/cashier/querySkuInfo再新增一个字段，Boolean filterOriginalSku", "/usr/bin/env", "/etc/nginx/nginx.conf", "/README.md 请检查", "/pattern/gi", "/新增字段", "  /api/model\n保留换行"]) {
    assert.deepEqual(parseChatInput(text, catalog, { hasAttachments: true }), { kind: "message", text });
  }
  for (const text of ["/missing query", "/hlp"]) assert.equal(parseChatInput(text, catalog).code, "UNKNOWN_COMMAND");
  const extensions = createChatCommandCatalog([{ name: "team/review", source: "extension" }, { name: "中文", source: "extension" }]);
  for (const text of ["/team/review patch", "/中文 参数"]) assert.equal(parseChatInput(text, extensions).kind, "command");
  assert.equal(parseChatInput("/api/changed", catalog, { commandKey: "builtin:reload" }).code, "UNKNOWN_COMMAND");
});

test("catalog resolves builtin and SDK extension precedence and tracks revisions", () => {
  const collision = createChatCommandCatalog([{ name: "reload", source: "extension" }, { name: "review", source: "prompt" }, { name: "review", source: "extension" }]);
  assert.equal(collision.commands.find(command => command.name === "reload").source, "builtin");
  assert.equal(collision.commands.find(command => command.name === "review").source, "extension");
  assert.equal(collision.diagnostics.length, 2);
  assert.notEqual(collision.revision, catalog.revision);
  assert.equal(createChatCommandCatalog([]).revision, createChatCommandCatalog([]).revision);
});

test("template parameter detection matches the SDK substitution forms", () => {
  for (const content of ["$1", "$12", "$@", "$ARGUMENTS", "${1:-default}", "${@:-default}", "${@:2:3}"]) assert.equal(templateUsesArguments(content), true, content);
  assert.equal(templateUsesArguments("Review this project without parameters"), false);
});
