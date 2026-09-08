import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";
const jiti = createJiti(import.meta.url, { alias: { "@": fileURLToPath(new URL("../", import.meta.url)) } });
const { SessionControlStore } = await jiti.import("./session-control-store.ts");
const { GET } = await jiti.import("../app/api/sessions/[id]/submissions/route.ts");

test("cancelled submissions remain recoverable without a live runtime or session history", async () => {
  const root = await mkdtemp(join(tmpdir(), "piora-submissions-"));
  const previous = process.env.PIORA_SESSION_CONTROL_ROOT;
  process.env.PIORA_SESSION_CONTROL_ROOT = root;
  try {
    const store = new SessionControlStore({ root });
    const command = { commandId: "lost-send", idempotencyKey: "original-send", targetSessionId: "orphan", source: "ui", content: "完整原文\n".repeat(20000), images: [{ type: "image", data: "YWJj", mimeType: "image/png" }], delivery: "next_turn", acceptedAt: 1, status: "cancelled" };
    await store.appendCommand(command);
    await store.compact("orphan");
    const params = { params: Promise.resolve({ id: "orphan" }) };
    const listing = await GET(new Request("http://localhost/api/sessions/orphan/submissions"), params);
    const summary = await listing.json();
    assert.equal(summary.items[0].id, "lost-send");
    assert.ok(summary.items[0].preview.length <= 180);
    const detail = await GET(new Request("http://localhost/api/sessions/orphan/submissions?commandId=lost-send"), params);
    assert.deepEqual(await detail.json(), { value: command.content, images: [{ data: "YWJj", mimeType: "image/png" }], files: [] });
  } finally {
    if (previous === undefined) delete process.env.PIORA_SESSION_CONTROL_ROOT; else process.env.PIORA_SESSION_CONTROL_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
