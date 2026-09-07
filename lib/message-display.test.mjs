import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./message-display.ts");
}

function assistant(content) {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    content,
  };
}

test("splits trailing final answer blocks from process blocks", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
    { type: "image", source: { type: "url", url: "https://example.com/final.png" } },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text", "image"]);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "toolCall"]);
});

test("keeps pre-tool text in process blocks", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "text", text: "I will inspect the repo first." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.equal(result.answerBlocks[0].text, "Final answer");
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["text", "toolCall"]);
});

test("does not expose text before a trailing tool call as final answer", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "text", text: "I need to call a tool." },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });

  assert.deepEqual(result.answerBlocks, []);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking", "text", "toolCall"]);
});

test("drops empty thinking blocks after completion", async () => {
  const { getDisplayableAssistantBlocks, splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["text"],
  );

  const result = splitFinalAssistantBlocks(message, { isStreaming: false });
  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.deepEqual(result.processBlocks, []);
});

test("keeps empty thinking while streaming", async () => {
  const { splitFinalAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Partial answer" },
  ]);

  const result = splitFinalAssistantBlocks(message, { isStreaming: true });

  assert.deepEqual(result.answerBlocks.map((block) => block.type), ["text"]);
  assert.deepEqual(result.processBlocks.map((block) => block.type), ["thinking"]);
});

test("keeps deferred historical thinking placeholders", async () => {
  const { getDisplayableAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "", deferred: true },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["thinking", "text"],
  );
});

test("detects file mutations that should stay visible in the main timeline", async () => {
  const { hasFileMutationBlocks } = await loadSubject();

  assert.equal(hasFileMutationBlocks([
    { type: "thinking", thinking: "prepare" },
    { type: "toolCall", toolCallId: "write-1", toolName: "write", input: { path: "demo.txt" } },
  ]), true);
  assert.equal(hasFileMutationBlocks([
    { type: "toolCall", toolCallId: "read-1", toolName: "read", input: { path: "demo.txt" } },
  ]), false);
});

test("live Pi thinking always wins over stale deferred loading state", async () => {
  const { getThinkingBlockDisplay } = await loadSubject();
  const staleLoad = { sourceKey: "session:entry:0", status: "loading" };

  assert.deepEqual(
    getThinkingBlockDisplay(
      { type: "thinking", thinking: "first streamed tokens" },
      "session:entry:0",
      staleLoad,
    ),
    { status: "content", content: "first streamed tokens" },
  );
  assert.deepEqual(
    getThinkingBlockDisplay(
      { type: "thinking", thinking: "first streamed tokens and the next delta" },
      "session:entry:0",
      staleLoad,
    ),
    { status: "content", content: "first streamed tokens and the next delta" },
  );
});

test("historical thinking uses only load state for its current source", async () => {
  const { getThinkingBlockDisplay } = await loadSubject();
  const block = { type: "thinking", thinking: "", deferred: true, deferredBlockIndex: 2 };

  assert.deepEqual(
    getThinkingBlockDisplay(block, "session:new-entry:2", {
      sourceKey: "session:old-entry:2",
      status: "loaded",
      content: "stale content",
    }),
    { status: "idle" },
  );
  assert.deepEqual(
    getThinkingBlockDisplay(block, "session:new-entry:2", {
      sourceKey: "session:new-entry:2",
      status: "loading",
    }),
    { status: "loading" },
  );
  assert.deepEqual(
    getThinkingBlockDisplay(block, "session:new-entry:2", {
      sourceKey: "session:new-entry:2",
      status: "loaded",
      content: "historical reasoning",
    }),
    { status: "content", content: "historical reasoning" },
  );
});

test("reopening while a shared thinking request is pending resubscribes to its result", async () => {
  const { shouldSubscribeToThinkingLoad, subscribeToThinkingLoad } = await loadSubject();
  let resolveRequest;
  const request = new Promise((resolve) => {
    resolveRequest = resolve;
  });
  const firstStates = [];
  const secondStates = [];

  const unsubscribeFirst = subscribeToThinkingLoad(
    "session:entry:1",
    request,
    () => true,
    (state) => firstStates.push(state),
  );
  unsubscribeFirst();

  const pending = firstStates.at(-1);
  assert.equal(pending.status, "loading");
  assert.equal(shouldSubscribeToThinkingLoad("session:entry:1", pending), true);

  subscribeToThinkingLoad(
    "session:entry:1",
    request,
    () => true,
    (state) => secondStates.push(state),
  );
  resolveRequest("finished reasoning");
  await request;
  await Promise.resolve();

  assert.deepEqual(firstStates, [
    { sourceKey: "session:entry:1", status: "loading" },
  ]);
  assert.deepEqual(secondStates, [
    { sourceKey: "session:entry:1", status: "loading" },
    { sourceKey: "session:entry:1", status: "loaded", content: "finished reasoning" },
  ]);
  assert.equal(shouldSubscribeToThinkingLoad("session:entry:1", secondStates.at(-1)), false);
});

test("returns completed provider errors even when the message has no content", async () => {
  const { getAssistantErrorMessage } = await loadSubject();
  const message = {
    ...assistant([]),
    stopReason: "error",
    errorMessage: "OpenAI API error (403): request forbidden",
  };

  assert.equal(
    getAssistantErrorMessage(message),
    "OpenAI API error (403): request forbidden",
  );
  assert.equal(getAssistantErrorMessage(message, { isStreaming: true }), null);
});

test("falls back when a provider error has no message", async () => {
  const { getAssistantErrorMessage } = await loadSubject();

  assert.equal(
    getAssistantErrorMessage({ ...assistant([]), stopReason: "error" }),
    "Unknown provider error",
  );
  assert.equal(
    getAssistantErrorMessage({ ...assistant([]), stopReason: "stop" }),
    null,
  );
});

test("completed commands remain visible alongside file edits", async () => {
  const { hasVisibleToolOutput } = await loadSubject();
  const tool = toolName => [{ type: 'toolCall', toolCallId: 't', toolName, input: {} }];
  assert.equal(hasVisibleToolOutput(tool('bash')), true);
  assert.equal(hasVisibleToolOutput(tool('bash (local)')), true);
  assert.equal(hasVisibleToolOutput(tool('edit')), true);
  assert.equal(hasVisibleToolOutput(tool('read')), false);
  assert.equal(hasVisibleToolOutput([{ type: 'thinking', thinking: 'reason' }]), false);
});
