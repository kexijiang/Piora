import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { persistLazySessionManager } = await jiti.import("./session-persistence.ts");

test("managed sessions survive a restart before their first assistant message", (t) => {
  const root = mkdtempSync(join(tmpdir(), "piora-managed-session-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendSessionInfo("Dormant reviewer");
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  assert.equal(existsSync(sessionFile), false, "the SDK starts new sessions lazily");

  assert.equal(persistLazySessionManager(manager), sessionFile);
  assert.equal(existsSync(sessionFile), true);
  manager.appendCustomEntry("post-persist-check", { ok: true });
  manager.appendMessage({ role: "user", content: "Retain before any assistant response", timestamp: Date.now(), clientPromptId: "first-send" });

  const lines = readFileSync(sessionFile, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines[0].type, "session");
  assert.equal(lines.some((entry) => entry.type === "session_info" && entry.name === "Dormant reviewer"), true);
  assert.equal(lines.some((entry) => entry.type === "custom" && entry.customType === "post-persist-check"), true);
  assert.equal(lines.some((entry) => entry.type === "message" && entry.message.clientPromptId === "first-send"), true);
  assert.equal(lines.filter((entry) => entry.type === "session").length, 1);
});
