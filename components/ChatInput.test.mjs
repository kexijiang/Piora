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
const {
  ChatInput,
  ModelErrorBanner,
  filterModelOptions,
  getAttachmentFileName,
  getContextRemainingPercent,
  isFolderAttachmentFileAllowed,
  joinSpeechText,
} = await jiti.import("./ChatInput.tsx");
// Import through the same tsconfig alias used by the component so Jiti reuses
// the exact context module instead of creating a second provider instance.
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const globalCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const chatInputSource = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const agentSessionSource = readFileSync(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");

test("uses an ordinary cursor for the session information hover", () => {
  assert.match(globalCss, /\.session-stats-trigger\s*\{[^}]*cursor:\s*default/s);
  assert.doesNotMatch(globalCss, /\.session-stats-trigger\s*\{[^}]*cursor:\s*help/s);
});

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(ModelErrorBanner, {
      error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
    }),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /模型错误/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(renderToStaticMarkup(React.createElement(ModelErrorBanner, { error: null })), "");
});

test("does not render enabledModels scope warnings in the main chat composer", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
        modelScopeWarnings: ['No models match pattern "ghost-gateway/*"'],
      }),
    ),
  );

  assert.doesNotMatch(html, /模型范围警告/);
  assert.doesNotMatch(html, /ghost-gateway/);
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        modelError: "Invalid models.json schema",
        modelList: [],
        modelNames: {},
      }),
    ),
  );

  assert.match(html, />没有可用模型</);
  assert.match(html, /title="没有可用模型"/);
});

test("uses one composer chip for model and reasoning without a speed setting", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        onThinkingLevelChange() {},
        isStreaming: false,
        model: { provider: "openai", modelId: "gpt-5" },
        modelList: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }],
        thinkingLevel: "high",
      }),
    ),
  );

  assert.match(html, /class="model-settings-trigger-label">GPT-5/);
  assert.match(html, /class="model-settings-trigger-reasoning">高/);
  const modelTrigger = chatInputSource.slice(chatInputSource.indexOf('className={`model-settings-trigger'), chatInputSource.indexOf('{modelDropdownOpen && modelDropdownRect'));
  assert.doesNotMatch(modelTrigger, /name="arrowdown"/);
  assert.match(chatInputSource, /createPortal\(/);
  assert.match(chatInputSource, /model-settings-row-value/);
  assert.match(chatInputSource, /desktopPanelLeft/);
  assert.match(chatInputSource, /submenuOpensRight/);
  assert.match(chatInputSource, /width: submenuWidth/);
  assert.match(chatInputSource, /className="model-settings-row-label"/);
  assert.match(chatInputSource, /className="model-settings-choice-icon"/);
  assert.match(chatInputSource, /className="model-settings-choice-label"/);
  assert.match(globalCss, /\.model-settings-row-label\s*\{[^}]*flex:\s*0 0 auto;[^}]*white-space:\s*nowrap;/s);
  assert.match(globalCss, /\.model-settings-row-value\s*\{[^}]*flex:\s*1 1 auto;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
  assert.doesNotMatch(globalCss, /\.model-settings-choice\s*>\s*span:not/);
  assert.doesNotMatch(chatInputSource, /chat\.speed|model-settings-speed/);
  const modelRoot = chatInputSource.slice(chatInputSource.indexOf('className="model-settings-root"'), chatInputSource.indexOf('{!isStreaming && onCompact'));
  assert.doesNotMatch(modelRoot, /name="arrowright"/);
});

test("filters model options by name and id", () => {
  const options = [
    { provider: "ollama", modelId: "qwen3:latest", name: "Qwen 3" },
    { provider: "anthropic", modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { provider: "openai", modelId: "gpt-5.4", name: "GPT-5.4" },
  ];

  assert.deepEqual(filterModelOptions(options, "QWEN"), [options[0]]);
  assert.deepEqual(filterModelOptions(options, "claude-sonnet"), [options[1]]);
  assert.equal(filterModelOptions(options, "OpenAI").length, 0);
  assert.equal(filterModelOptions(options, "anthropic/claude").length, 0);
  assert.equal(filterModelOptions(options, "missing").length, 0);
  assert.equal(filterModelOptions(options, "  "), options);
});

test("derives remaining context from live token counts", () => {
  assert.equal(getContextRemainingPercent({ percent: 99, contextWindow: 200_000, tokens: 50_000 }), 75);
  assert.equal(getContextRemainingPercent({ percent: 35, contextWindow: 200_000, tokens: null }), 65);
  assert.equal(getContextRemainingPercent({ percent: 130, contextWindow: 200_000, tokens: null }), 0);
  assert.equal(getContextRemainingPercent({ percent: null, contextWindow: 200_000, tokens: null }), null);
});

test("turns long clipboard text into an editable material instead of filling the textarea", () => {
  assert.match(chatInputSource, /LARGE_PASTE_CHARACTER_THRESHOLD/);
  assert.match(chatInputSource, /pastedText\.length <= LARGE_PASTE_CHARACTER_THRESHOLD/);
  assert.match(chatInputSource, /kind: "paste" as const/);
  assert.match(chatInputSource, /restorePastedFile/);
  assert.match(chatInputSource, /maxHeight: "min\(38vh, 360px\)"/);
});

test("offers a folder picker and keeps useful relative paths", () => {
  assert.equal(getAttachmentFileName({
    name: "index.ts",
    webkitRelativePath: "sample-project/src/index.ts",
  }), "sample-project/src/index.ts");
  assert.equal(getAttachmentFileName({ name: "notes.md" }), "notes.md");
  assert.equal(isFolderAttachmentFileAllowed({
    name: "package.json",
    webkitRelativePath: "sample-project/node_modules/pkg/package.json",
  }), false);
  assert.equal(isFolderAttachmentFileAllowed({
    name: "config",
    webkitRelativePath: "sample-project/.git/config",
  }), false);
  assert.equal(isFolderAttachmentFileAllowed({
    name: "settings.json",
    webkitRelativePath: ".config/settings.json",
  }), true);
  assert.match(chatInputSource, /folderInputRef\.current\.webkitdirectory = true/);
  assert.match(chatInputSource, /folderInputRef\.current\?\.click\(\)/);
  assert.match(chatInputSource, /chat\.attachFolderDescription/);
  assert.match(chatInputSource, /textFiles\.length >= remainingCount/);
});

test("inserts dictated text at the caret with locale-aware spacing", () => {
  assert.deepEqual(joinSpeechText("请帮我", " 修复这个问题 ", "谢谢", "zh-CN"), {
    value: "请帮我修复这个问题谢谢",
    selection: 9,
  });
  assert.deepEqual(joinSpeechText("Please", " fix this ", "today", "en-US"), {
    value: "Please fix this today",
    selection: 15,
  });
  assert.deepEqual(joinSpeechText("", " hello ", "", "en-US"), {
    value: "hello",
    selection: 5,
  });
});

test("keeps voice dictation user-controlled and local-only", () => {
  assert.match(chatInputSource, /useLocalDictation/);
  assert.match(chatInputSource, /voiceTranscribing/);
  assert.doesNotMatch(chatInputSource, /webkitSpeechRecognition|SpeechRecognitionConstructor/);
  assert.match(chatInputSource, /aria-pressed=\{voiceListening\}/);
  assert.match(chatInputSource, /stopVoiceInput\(true\);[\s\S]*?setValue\(""\)/);
});

test("renders an icon-only send control and dynamic context ring", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        model: { provider: "openai", modelId: "gpt-5" },
        modelList: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }],
        contextUsage: { percent: 40, contextWindow: 100_000, tokens: 40_000 },
        sessionStats: {
          sessionId: "session-1",
          sessionName: "Icon migration task",
          userMessages: 3,
          assistantMessages: 2,
          toolCalls: 4,
          toolResults: 4,
          totalMessages: 9,
          tokens: { input: 1_000, output: 500, cacheRead: 250, cacheWrite: 0, total: 1_750 },
          cost: 0.0123,
        },
      }),
    ),
  );

  assert.match(html, /aria-label="发送"/);
  assert.doesNotMatch(html, />Send<\/button>/);
  assert.match(html, /data-context-used="40\.00"/);
  assert.match(html, /stroke-dasharray="40 60"/);
  assert.match(html, /上下文窗口/);
  assert.match(html, /40% 已用/);
  assert.match(html, /已用 40k 个令牌，共 100k/);
  assert.match(html, /包含系统提示词、项目指令、工具定义和对话消息/);
  assert.match(globalCss, /\.context-usage-tooltip-note\s*\{/);
  assert.match(html, /data-model-brand="openai"/);
  assert.doesNotMatch(html, /<button[^>]*data-context-used/);
  assert.ok(html.indexOf("data-context-used") < html.indexOf('title="选择模型"'));
  assert.match(html, /class="session-stats-tooltip"/);
  assert.match(html, /class="session-stats-tooltip-title">会话信息</);
  assert.doesNotMatch(html, /class="session-stats-tooltip-title">Icon migration task</);
  assert.match(html, /width="18" height="18"[^>]*stroke-width="1\.75"[^>]*><path d="M5 21v-6"/);
  assert.match(html, /消息/);
  assert.match(html, /1,750/);
});

test("renders a reconciled context breakdown when the runtime provides one", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
        contextUsage: {
          percent: 52,
          contextWindow: 100_000,
          tokens: 52_000,
          breakdown: {
            systemPrompt: 8_000,
            projectInstructions: 12_000,
            toolDefinitions: 20_000,
            conversationMessages: 1_000,
            otherRuntime: 11_000,
          },
        },
      }),
    ),
  );

  assert.match(html, /上下文分项/);
  assert.match(html, /系统提示词/);
  assert.match(html, /项目指令/);
  assert.match(html, /工具定义/);
  assert.match(html, /对话消息/);
  assert.match(html, /其他运行时/);
  assert.match(html, /分项为本地估算，总数以模型供应商返回为准/);
});

test("uses the model family icon even when the provider is a custom gateway", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        model: { provider: "acme-gateway", modelId: "deepseek-v4-flash" },
        modelList: [{ provider: "acme-gateway", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
      }),
    ),
  );

  assert.match(html, /data-model-brand="deepseek"/);
  assert.doesNotMatch(html, /data-model-brand="custom"/);
});

test("renders an icon-only stop control", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: true,
      }),
    ),
  );

  assert.match(html, /aria-label="停止智能体"/);
  assert.doesNotMatch(html, />Steer</);
  assert.doesNotMatch(html, />Send directly</);
});

test("renders queued guidance as a compact composer tray", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onRecallQueue() {},
        isStreaming: true,
        queuedMessages: {
          steering: ["Adjust the spacing around the composer"],
          followUp: ["Run the visual check afterward"],
        },
      }),
    ),
  );

  assert.match(html, /class="composer-queue-tray"/);
  assert.match(html, /class="composer-queue-row is-steer"/);
  assert.match(html, /class="composer-queue-row is-follow-up"/);
  assert.match(html, />引导</);
  assert.match(html, />排队</);
  assert.match(html, /aria-label="移回输入框"/);
  assert.doesNotMatch(html, /class="composer-shell" title="Adjust the spacing/);
});

test("keeps an unknown context ring visible before runtime usage is available", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
      }),
    ),
  );

  assert.match(html, /data-context-used="unknown"/);
  assert.match(html, /stroke-dasharray="3 6"/);
});

test("designs prompt optimization as a preview before replacing the draft", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
        model: { provider: "openai", modelId: "gpt-5" },
      }),
    ),
  );

  assert.match(html, /aria-label="优化提示词"/);
  assert.match(html, /class="prompt-optimize-button"/);
  assert.match(chatInputSource, /fetch\("\/api\/prompts\/optimize"/);
  assert.match(chatInputSource, /prompt-optimization-review/);
  assert.match(chatInputSource, /chat\.keepOriginalPrompt/);
  assert.match(chatInputSource, /chat\.useOptimizedPrompt/);
  assert.match(
    chatInputSource,
    /className="is-primary"[\s\S]*?onClick=\{\(\) => \{[\s\S]*?setValue\(promptOptimization\.result!\)[\s\S]*?chat\.useOptimizedPrompt/,
  );
});

test("renders compact errors above the input as a wrapping alert", () => {
  const error = "Compaction failed: OpenAI API error (403): <html>request forbidden</html>";
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onCompact() {},
        isStreaming: false,
        compactError: error,
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Compaction failed: OpenAI API error/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
  assert.match(html, /white-space:pre-wrap/);
  assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
});

test("does not send text before an attached image finishes loading", () => {
  assert.match(chatInputSource, /const \[isProcessingImages, setIsProcessingImages\] = useState\(false\)/);
  assert.match(chatInputSource, /setIsProcessingImages\(true\)[\s\S]*?pendingImageCountRef\.current <= 0[\s\S]*?setIsProcessingImages\(false\)/);
  assert.match(chatInputSource, /if \(isStreaming \|\| isProcessingImages \|\| isAutoModelSelection\) return/);
  assert.match(chatInputSource, /const canSend = !isProcessingImages/);
});

test("new conversations wait only until a default or explicit model resolves", () => {
  assert.match(chatInputSource, /if \(isStreaming \|\| isProcessingImages \|\| isAutoModelSelection\) return/);
  assert.match(chatInputSource, /const canSend = !isProcessingImages[\s\S]*?&& !isAutoModelSelection/);
  assert.match(chatInputSource, /const displayModelName = model && !isAutoModelSelection/);
  assert.match(chatInputSource, /const canOptimizePrompt = hasInputText[\s\S]*?&& !isAutoModelSelection/);
  assert.match(chatInputSource, /onThinkingLevelChange && !isAutoModelSelection/);
  assert.match(agentSessionSource, /isAutoModelSelection: isNew && displayModel === null/);
  assert.doesNotMatch(agentSessionSource, /isAutoModelSelection: isNew && newSessionModel === null/);
});

test("a context gate can reject submission without clearing the real composer", () => {
  assert.match(chatInputSource, /const accepted = await onSend\(/);
  assert.match(chatInputSource, /if \(accepted === false\) return;[\s\S]*?clearInput\(\)/);
  assert.match(chatInputSource, /submit\(\) \{[\s\S]*?submitRef\.current\(\)/);
});

test("compaction uses a quiet progress row and closes the model menu when started", () => {
  assert.match(chatInputSource, /className="model-settings-compaction" role="status" aria-live="polite"/);
  assert.match(chatInputSource, /className="model-settings-compaction-spinner"/);
  assert.match(chatInputSource, /setModelDropdownOpen\(false\);[\s\S]*?onCompact\(\)/);
  assert.doesNotMatch(chatInputSource, /model-settings-row\$\{isCompacting \? " is-danger"/);
});
