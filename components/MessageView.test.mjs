import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MessageView, getAutomationToolCardDetails, getUserMessagePreview } = await jiti.import("./MessageView.tsx");
// Import through the same tsconfig alias used by the component so Jiti reuses
// the exact context module instead of creating a second provider instance.
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { VirtualRowStateContext } = await jiti.import("./VirtualRowState");
const { createVirtualRowState } = await jiti.import("@/lib/virtual-row-state");
const messageImageSource = readFileSync(new URL("./MessageImage.tsx", import.meta.url), "utf8");
const messageViewSource = readFileSync(new URL("./MessageView.tsx", import.meta.url), "utf8");
const userMessageTextSource = readFileSync(new URL("./UserMessageText.tsx", import.meta.url), "utf8");
const commandViewSource = readFileSync(new URL("./CommandExecutionView.tsx", import.meta.url), "utf8");
const commandLogSource = readFileSync(new URL("./CommandLogViewer.tsx", import.meta.url), "utf8");
const globalCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

test("a running browser wait card shows the reason and resolve buttons", () => {
  const message = { role: "assistant", content: [{ type: "toolCall", toolCallId: "wait-1", toolName: "browser", input: { action: "wait_for_user", reason: "请完成登录" } }] };
  const running = renderMessage(message, { sessionId: "550e8400-e29b-41d4-a716-446655440000" });
  assert.match(running, /请完成登录/);
  assert.match(running, /我已完成，继续/);
  assert.match(running, /取消/);
  assert.doesNotMatch(running, /打开浏览器/);
  const finished = renderMessage(message, { toolResults: new Map([["wait-1", {
    role: "toolResult",
    toolCallId: "wait-1",
    content: [{ type: "text", text: "User reported done. Take a new snapshot before continuing." }],
    details: { status: "continued", backend: "desktop" },
  }]]) });
  assert.match(finished, /你已完成/);
  assert.doesNotMatch(finished, /我已完成，继续/);
  const card = readFileSync(new URL("./BrowserUserWaitCard.tsx", import.meta.url), "utf8");
  assert.match(card, /backend === "desktop"/);
  assert.match(card, /piora:open-agent-browser/);
});

test("nested tool history restores bounded summaries without inventing child output or success", () => {
  const message = { role: "assistant", content: [{ type: "toolCall", toolCallId: "parent", toolName: "codemode", input: {} }] };
  const row = createVirtualRowState(); row.set("tool:parent", true);
  const result = { role: "toolResult", toolCallId: "parent", content: [{ type: "text", text: "script partial output" }], isError: true,
    nestedCalls: { complete: false, calls: [
      { id: "parent/0", name: "search", status: "ok", durationMs: 120 },
      { id: "parent/0/0", name: "read", status: "unfinished", argumentsBytes: 9000 },
      { id: "parent/1", name: "inspect", status: "error", error: "safe fixture failure" },
    ] } };
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(VirtualRowStateContext.Provider, { value: row }, React.createElement(MessageView, { message, mode: "history", toolResults: new Map([["parent", result]]) }))));
  assert.match(html, /已完成 2\/3 个子调用/);
  assert.match(html, /调用记录不完整/);
  assert.match(html, /未确认完成/);
  assert.match(html, /参数因大小限制已省略/);
  assert.match(html, /不含子调用的完整输出/);
  assert.match(html, /safe fixture failure/);
  assert.doesNotMatch(html, /is-running/);
});

test("mounting a live message immediately displays the server rate without restarting a timer", () => {
  const message = { role: "assistant", model: "model", content: [{ type: "text", text: "already generated ".repeat(1000) }], streamingMetrics: { generation: 3, tokensPerSecond: 42.5 } };
  for (let view = 0; view < 3; view++) assert.match(renderMessage(message, { isStreaming: true }), /≈42\.5/);
  assert.doesNotMatch(renderMessage({ ...message, streamingMetrics: undefined }, { isStreaming: true }), /t\/s/);
  assert.doesNotMatch(renderMessage(message), /t\/s/);
});

test("history rendering keeps disclosure and copy while suppressing conversation mutations", () => {
  const html = renderMessage({ role: "user", content: "保留历史问题" }, {
    mode: "history", entryId: "question", prevAssistantEntryId: "answer",
    onFork() {}, onNavigate() {}, onEditContent() {}, onRetry: async () => {},
  });
  assert.match(html, /保留历史问题/);
  assert.doesNotMatch(html, /从这里编辑|重新发送|分叉/);
  const command = renderMessage({ role: "assistant", content: [{ type: "toolCall", toolCallId: "shell", toolName: "bash", input: { command: "echo hello" } }] }, { mode: "history" });
  assert.match(command, /尚无已保存的结果/);
  assert.match(command, /复制完整命令/);
  assert.match(command, /aria-expanded="false"/);
  assert.doesNotMatch(command, /is-running/);
});

test("shell output stays collapsed by default, including live chunks", () => {
  const message = { role: "assistant", content: [{ type: "toolCall", toolCallId: "shell", toolName: "bash", input: { command: "echo hello" } }] };
  for (const isStreaming of [true, false]) {
    const html = renderMessage(message, { toolResults: new Map([["shell", {
      role: "toolResult", toolCallId: "shell", isStreaming,
      content: [{ type: "text", text: "hello from shell" }],
    }]]) });
    assert.doesNotMatch(html, /hello from shell/);
    assert.match(html, /aria-expanded="false"/);
  }
  const local = renderMessage({ role: "bashExecution", command: "echo hello", output: "local live output", excludeFromContext: true });
  assert.doesNotMatch(local, /local live output/);
});

test("shell cards reveal commands and errors only after expanding", () => {
  const command = "npm run check -- --project ./packages/a/tsconfig.json\nnode ./scripts/verify.mjs --all";
  const message = { role: "assistant", content: [{ type: "toolCall", toolCallId: "shell", toolName: "powershell", input: { command } }] };
  const result = { role: "toolResult", toolCallId: "shell", toolName: "powershell", isError: true,
    content: [{ type: "text", text: "src/a.ts(4): error TS2322: wrong type\nCommand exited with code 2" }],
    details: { truncation: { truncated: true }, fullOutputPath: "C:\\Temp\\pi-powershell-a.log" } };
  const collapsed = renderMessage(message, { sessionId: "550e8400-e29b-41d4-a716-446655440000", cwd: "F:\\Piora", toolResults: new Map([["shell", result]]) });
  assert.match(collapsed, /PowerShell/);
  assert.match(collapsed, /失败/);
  assert.doesNotMatch(collapsed, /退出码 2|错误摘录|TS2322|npm run check|command-preview/);
  assert.match(collapsed, /复制完整命令/);

  const rowState = createVirtualRowState();
  rowState.set("command:shell", true);
  const expanded = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(VirtualRowStateContext.Provider, { value: rowState }, React.createElement(MessageView, { message, cwd: "F:\\Piora", toolResults: new Map([["shell", result]]) }))));
  assert.match(expanded, /退出码 2/);
  assert.match(expanded, /错误摘录/);
  assert.match(expanded, /完整命令/);
  assert.match(expanded, /npm run check/);
  assert.match(expanded, /当前仅显示部分输出/);
  assert.match(expanded, /这条历史记录没有保存完整日志位置/);
  assert.match(expanded, /诊断信息/);
  assert.match(commandViewSource, /createPortal/);
  assert.match(commandLogSource, /lineNumbers\(\)/);
  assert.match(commandLogSource, /setSearchQuery/);
  assert.match(commandLogSource, /followingRef/);
});

test("collapses long user queries to an eight-line preview", () => {
  const content = Array.from({ length: 20 }, (_, index) => `log line ${index + 1}`).join("\n");
  const preview = getUserMessagePreview(content);
  const html = renderMessage({ role: "user", content, timestamp: Date.now() });

  assert.equal(preview.collapsible, true);
  assert.equal(preview.lineCount, 20);
  assert.match(preview.preview, /log line 8$/);
  assert.doesNotMatch(preview.preview, /log line 9/);
  assert.match(html, /class="message-user-expand"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /展开完整消息 · 20 行/);
  assert.doesNotMatch(html, /log line 9/);
});

test("fresh message mounts restore the virtual row's expanded and collapsed choices", () => {
  const rowState = createVirtualRowState();
  const message = { role: "user", content: Array.from({ length: 20 }, (_, index) => `saved line ${index + 1}`).join("\n") };
  const mount = () => renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(VirtualRowStateContext.Provider, { value: rowState }, React.createElement(MessageView, { message }))));
  assert.match(mount(), /aria-expanded="false"/);
  rowState.set("user-content", true);
  assert.match(mount(), /aria-expanded="true"/);
  rowState.set("user-content", false);
  assert.match(mount(), /aria-expanded="false"/);
});

test("renders user messages as escaped plain text and keeps assistant Markdown", () => {
  const content = "a  b\n\n*not bold* _not italic_ # not a heading `not code`\n> not a quote\n- not a list\n[not](https://example.com) <b>not html</b> A & B | cell | ~not strike~\n@src/file_name.ts:1-3";
  const message = {
    role: "user",
    content: [
      { type: "text", text: content },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  };
  const html = renderMessage(message);
  const history = renderMessage(message, { mode: "history" });
  const userSource = messageViewSource.slice(
    messageViewSource.indexOf("function UserMessageView"),
    messageViewSource.indexOf("function AssistantMessageView"),
  );
  const textBlockSource = messageViewSource.slice(
    messageViewSource.indexOf("function TextBlock"),
    messageViewSource.indexOf("function ThinkingBlock"),
  );

  for (const rendered of [html, history]) {
    assert.match(rendered, /class="user-message-text"/);
    assert.match(rendered, /a {2}b\n\n\*not bold\* _not italic_ # not a heading `not code`/);
    assert.match(rendered, /- not a list\n\[not\]\(<a class="user-message-link" href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">https:\/\/example\.com<\/a>\) &lt;b&gt;not html&lt;\/b&gt; A &amp; B \| cell \| ~not strike~\n@src\/file_name\.ts:1-3/);
    assert.match(rendered, /class="message-image-thumbnail"/);
    assert.equal((rendered.match(/<a\b/g) ?? []).length, 1);
    assert.doesNotMatch(rendered, /<(?:strong|em|h1|h2|code|blockquote|del|table|script)\b|markdown-user-message|markdown-body|dangerouslySetInnerHTML/);
  }
  assert.match(html, /复制/);
  assert.doesNotMatch(history, /复制|从这里编辑|重新发送/);
  assert.match(userSource, /<UserMessageText text=\{displayedContent\} cwd=\{cwd\} onOpenFile=\{onOpenFile\} \/>/);
  assert.match(userSource, /copyContent/);
  assert.doesNotMatch(userSource, /MarkdownBody|dangerouslySetInnerHTML/);
  assert.doesNotMatch(userMessageTextSource, /dangerouslySetInnerHTML|MarkdownBody/);
  assert.match(textBlockSource, /<MarkdownBody className="markdown-assistant-message"[^>]*>\{block\.text\}<\/MarkdownBody>/);
  assert.match(globalCss, /\.user-message-text\s*\{[^}]*white-space:\s*pre-wrap/s);
});

test("renders short user queries without an expand control", () => {
  const html = renderMessage({ role: "user", content: "one\ntwo\nthree", timestamp: Date.now() });
  assert.doesNotMatch(html, /message-user-expand/);
});

test("renders user images as keyboard-accessible zoom controls", () => {
  const html = renderMessage({
    role: "user",
    content: [
      { type: "text", text: "inspect this" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });

  assert.match(html, /class="message-image-thumbnail"/);
  assert.match(html, /aria-label="打开第 1 张图片"/);
  assert.match(messageImageSource, /dialog\.showModal\(\)/);
  assert.match(messageImageSource, /createPortal\(viewer, document\.body\)/);
  assert.match(messageImageSource, /event\.key !== "Escape"/);
});

test("renders deferred prompt material as a collapsed preview with its full line count", () => {
  const html = renderMessage({
    role: "user",
    content: "preview only",
    deferredContent: true,
    deferredLineCount: 12_345,
    deferredByteLength: 500_000,
  }, { sessionId: "session-1", entryId: "entry-1" });
  assert.match(html, /message-user-expand/);
  assert.match(html, /展开完整消息 · 12,345 行/);
});

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /错误：OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
  assert.doesNotMatch(html, /已停止生成/);
});

test("renders the final response duration in the assistant footer", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    timestamp: 12_500,
    content: [{ type: "text", text: "Done" }],
  }, { showTimestamp: true, responseStartedAt: 10_000 });

  assert.match(html, /响应耗时 2\.5s/);
  assert.match(html, /message-response-meta/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /错误：Connection closed/);
  assert.ok(html.indexOf("Partial response") < html.indexOf("错误：Connection closed"));
});

test("cancelled responses show a Chinese status and retain partial content", () => {
  for (const [stopReason, errorMessage] of [
    ["aborted", "This operation was aborted"],
    ["error", "Error: this operation was abourted"],
  ]) {
    for (const content of [[], [{ type: "text", text: "Partial response" }]]) {
      const html = renderMessage({ role: "assistant", content, stopReason, errorMessage });
      assert.match(html, /role="status"/);
      assert.match(html, /已停止生成/);
      assert.doesNotMatch(html, /role="alert"|operation was ab/);
      if (content.length) assert.match(html, /Partial response/);
    }
  }
});

test("renders thinking as an accessible disclosure whose content uses Markdown", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "thinking", thinking: "## Plan\n\n- inspect\n- fix" }],
  });
  const thinkingBlockSource = messageViewSource.slice(
    messageViewSource.indexOf("function ThinkingBlock"),
    messageViewSource.indexOf("function ToolCallBlock"),
  );

  assert.match(html, /class="[^"]*\bthinking-block\b[^"]*"/);
  assert.match(html, /class="[^"]*\bthinking-block-trigger\b[^"]*"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="[^"]+"/);
  assert.match(thinkingBlockSource, /<MarkdownBody className="markdown-thinking"[^>]*>\{display\.content\}<\/MarkdownBody>/);
  assert.doesNotMatch(thinkingBlockSource, /whiteSpace:\s*"pre-wrap"/);
});

test("renders file edits as a collapsed change card with line stats", () => {
  const toolCallId = "edit-card-1";
  const patch = [
    "--- a/components/Card.tsx",
    "+++ b/components/Card.tsx",
    "@@ -1 +1,2 @@",
    "-export const value = 1;",
    "+export const value = 2;",
    "+export const ready = true;",
  ].join("\n");
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{
      type: "toolCall",
      toolCallId,
      toolName: "edit",
      input: { path: "components/Card.tsx" },
    }],
  }, {
    toolResults: new Map([[toolCallId, {
      role: "toolResult",
      toolCallId,
      content: [{ type: "text", text: "ok" }],
      details: { patch },
    }]]),
  });

  assert.match(html, /class="[^"]*\bfile-change-card is-complete"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /已编辑/);
  assert.match(html, /components\/Card\.tsx/);
  assert.match(html, /\+2/);
  assert.match(html, /−1/);
  assert.doesNotMatch(html, /export const ready/);
});

test("derives a persistent scheduled-task card from a successful create tool result", () => {
  const details = getAutomationToolCardDetails({
    toolName: "piora_automation",
    input: { action: "create" },
  }, {
    role: "toolResult",
    toolCallId: "automation-create-1",
    content: [{ type: "text", text: "created" }],
    details: {
      automation: {
        id: "automation-1",
        name: "Monitor release",
        rrule: "RRULE:FREQ=MINUTELY;INTERVAL=5",
      },
    },
  });

  assert.deepEqual(details, {
    id: "automation-1",
    name: "Monitor release",
    rrule: "RRULE:FREQ=MINUTELY;INTERVAL=5",
  });
  assert.equal(getAutomationToolCardDetails({ toolName: "piora_automation", input: { action: "list" } }, undefined), null);
});
