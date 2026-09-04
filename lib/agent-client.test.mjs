import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentCommandError, createAgentSessionRequest, sendAgentCommand } = await jiti.import("./agent-client.ts");

const request = {
  cwd: "C:\\workspace",
  type: "ensure_session",
  capabilitySelection: { preset: "research" },
  provider: "provider",
  modelId: "model",
};

test("new-session startup retries one explicitly retryable failure", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return Response.json(
        { error: "Runtime busy", code: "SESSION_CREATION_RETRYABLE" },
        { status: 503 },
      );
    }
    return Response.json({
      success: true,
      sessionId: "session-1",
      model: { provider: "provider", modelId: "model" },
      thinkingLevel: "high",
    });
  };

  const result = await createAgentSessionRequest(request);
  assert.equal(calls, 2);
  assert.equal(result.sessionId, "session-1");
});

test("new-session startup preserves the server reason and does not retry model errors", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json(
      { error: "Model is not available in the enabled scope: provider/model", code: "MODEL_NOT_AVAILABLE" },
      { status: 409 },
    );
  };

  await assert.rejects(
    createAgentSessionRequest(request),
    (error) => error instanceof AgentCommandError
      && error.status === 409
      && error.code === "MODEL_NOT_AVAILABLE"
      && error.message.includes("provider/model"),
  );
  assert.equal(calls, 1);
});

test("preserves HTTP status and server error code for definitive command rejections", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: "Message content exceeds the 256 KiB limit.",
    code: "SESSION_MESSAGE_TOO_LARGE",
  }), { status: 413, headers: { "Content-Type": "application/json" } });

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "oversized" }),
    (error) => error instanceof AgentCommandError
      && error.status === 413
      && error.code === "SESSION_MESSAGE_TOO_LARGE",
  );
});

test("stop requests time out if response headers never arrive", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  await assert.rejects(sendAgentCommand("session", { type: "abort" }, { timeoutMs: 20 }),
    (error) => error.code === "COMMAND_TIMEOUT");
});

test("a stalled or aborted response body is not mistaken for a stop acknowledgement", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, { signal }) => ({
    ok: true,
    status: 200,
    json: () => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  await assert.rejects(sendAgentCommand("session", { type: "abort" }, { timeoutMs: 20 }),
    (error) => error.code === "COMMAND_TIMEOUT");
});
