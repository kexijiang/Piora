import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { SessionControlStore } = await jiti.import("./session-control-store.ts");
const { persistLazySessionManager } = await jiti.import("./session-persistence.ts");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("./session-reader.ts");
const { mergePendingPrompts } = await jiti.import("./prompt-recovery.ts");
const { GET } = await jiti.import("../app/api/sessions/[id]/route.ts");

test("completed slash commands reconcile from disk and invalidate cached history without losing other sends", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-command-recovery-"));
  const previous = process.env.PIORA_SESSION_CONTROL_ROOT;
  process.env.PIORA_SESSION_CONTROL_ROOT = join(root, "control");
  const manager = SessionManager.create(root, join(root, "sessions"));
  const id = manager.getSessionId();
  try {
    persistLazySessionManager(manager);
    cacheSessionPath(id, manager.getSessionFile());
    const store = new SessionControlStore();
    const base = { targetSessionId: id, source: "ui", delivery: "next_turn", content: "/example", acceptedAt: 1 };
    const states = ["running", "failed", "cancelled", "interrupted", "queued", "accepted", "dispatching", "delivered", "expired"];
    const commands = states.map((status) => ({ ...base, commandId: status, idempotencyKey: `send-${status}`, status }));
    commands.push({ ...base, commandId: "plain", idempotencyKey: "send-plain", content: "ordinary prompt", status: "completed" });
    commands.push({ ...base, commandId: "image", idempotencyKey: "send-image", images: [{ type: "image", data: "YWJj", mimeType: "image/png" }], status: "completed" });
    commands.push({ ...base, commandId: "material", idempotencyKey: "send-material", materials: [{ id: "attachment" }], status: "completed" });
    for (const command of commands) await store.appendCommand(command);
    const pending = commands.map((command) => ({ id: command.idempotencyKey, scope: id, message: { role: "user", content: command.content }, draft: { value: command.content, files: [{ name: "original.txt", text: "full contents" }], images: [] } }));
    const request = (etag) => GET(new Request(`http://localhost/api/sessions/${id}?deferThinking=1&deferMedia=1`, { headers: etag ? { "If-None-Match": etag } : {} }), { params: Promise.resolve({ id }) });
    const before = await request();
    assert.equal(before.status, 200);
    const beforeBody = await before.json();
    assert.deepEqual(beforeBody.persistedPromptIds, []);
    assert.equal((await request(before.headers.get("etag"))).status, 304);
    // Only the command journal changes; the SDK never writes a user message.
    await store.appendStatus(commands[0], "completed");
    const after = await request(before.headers.get("etag"));
    assert.equal(after.status, 200);
    const body = await after.json();
    assert.deepEqual(body.persistedPromptIds, ["send-running"]);
    assert.equal(body.context.messages.length, 0);
    for (let reload = 0; reload < 2; reload++) {
      const result = mergePendingPrompts(body.context.messages, body.context.entryIds, pending, body.persistedPromptIds);
      assert.deepEqual(result.confirmedIds, ["send-running"]);
      assert.equal(result.messages.length, commands.length - 1);
      assert.ok(result.messages.every((message) => message.sendError && message.recoveryDraft.files[0].text === "full contents"));
    }
    assert.equal(new SessionControlStore().loadCommands(id).find((command) => command.commandId === "running").content, "/example", "original command remains in the durable archive");
  } finally {
    invalidateSessionPathCache(id);
    if (previous === undefined) delete process.env.PIORA_SESSION_CONTROL_ROOT; else process.env.PIORA_SESSION_CONTROL_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
