import assert from "node:assert/strict";
import test from "node:test";
import { requestSessionDeletion } from "./session-delete-client.ts";

test("failed HTTP responses reject instead of reporting a successful deletion", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Disk unavailable" }, { status: 500 }));
  await assert.rejects(requestSessionDeletion("a"), /Disk unavailable/);
});

test("successful deletion returns its actual affected subtree", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ sessionIds: ["a", "b"], trashedCount: 2 }));
  assert.deepEqual(await requestSessionDeletion("a"), { sessionIds: ["a", "b"], trashedCount: 2 });
});
