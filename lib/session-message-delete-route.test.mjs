import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("./session-reader.ts");
const { persistLazySessionManager } = await jiti.import("./session-persistence.ts");
const { DELETE } = await jiti.import("../app/api/sessions/[id]/messages/[entryId]/route.ts");
const { GET } = await jiti.import("../app/api/sessions/[id]/route.ts");
const { GET: contextGET } = await jiti.import("../app/api/sessions/[id]/context/route.ts");

test("message deletion survives disk reload, updates cached history and rejects active writers", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-delete-message-"));
  const manager = SessionManager.create(directory, path.join(directory, "sessions"));
  const id = manager.getSessionId();
  try {
    const userId = manager.appendMessage({ role: "user", content: "erase this secret", clientPromptId: "delete-receipt", timestamp: 1 });
    const laterId = manager.appendMessage({ role: "user", content: "keep this message", timestamp: 2 });
    persistLazySessionManager(manager);
    const file = manager.getSessionFile();
    cacheSessionPath(id, file);
    const get = etag => GET(new Request(`http://localhost/api/sessions/${id}`, { headers: etag ? { "If-None-Match": etag } : {} }), { params: Promise.resolve({ id }) });
    const before = await get();
    assert.equal(before.status, 200);
    const del = () => DELETE(new Request(`http://localhost/api/sessions/${id}/messages/${userId}`, { method: "DELETE" }), { params: Promise.resolve({ id, entryId: userId }) });
    globalThis.__piSessions ??= new Map();
    globalThis.__piSessions.set(id, { isRunning: () => true });
    assert.equal((await del()).status, 409);
    assert.ok((await readFile(file, "utf8")).includes("erase this secret"));
    globalThis.__piSessions.delete(id);
    assert.equal((await del()).status, 200);
    const after = await get(before.headers.get("etag"));
    assert.equal(after.status, 200);
    const body = await after.json();
    assert.deepEqual(body.context.entryIds, [laterId]);
    assert.deepEqual(body.persistedPromptIds, ["delete-receipt"]);
    assert.equal((await readFile(file, "utf8")).includes("erase this secret"), false);
    const branch = await (await contextGET(new Request(`http://localhost/api/sessions/${id}/context?leafId=${laterId}`), { params: Promise.resolve({ id }) })).json();
    assert.deepEqual(branch.context.entryIds, [laterId]);
    assert.deepEqual(branch.persistedPromptIds, ["delete-receipt"]);
    assert.equal((await del()).status, 200, "retrying a completed deletion is harmless");
  } finally {
    globalThis.__piSessions?.delete(id);
    invalidateSessionPathCache(id);
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith("piora-delete-message-"));
    await rm(directory, { recursive: true, force: true });
  }
});
