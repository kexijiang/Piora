import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { requestSessionDeletion } = await jiti.import("./session-delete-client.ts");
const { registerAnswerStateWriter } = await jiti.import("./answer-output-client.ts");

test("failed HTTP responses reject instead of reporting a successful deletion", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Disk unavailable" }, { status: 500 }));
  await assert.rejects(requestSessionDeletion("a"), /Disk unavailable/);
});

test("successful deletion returns its actual affected subtree", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ sessionIds: ["a", "b"], trashedCount: 2 }));
  assert.deepEqual(await requestSessionDeletion("a"), { sessionIds: ["a", "b"], trashedCount: 2 });
});

test("trash waits for every confirmed subtree member while unrelated drafts do not block it", async t => {
  let acknowledge; const saved = [];
  t.after(registerAnswerStateWriter("trash-root", "root", async () => { saved.push("root"); }));
  t.after(registerAnswerStateWriter("trash-child", "child", () => new Promise(resolve => { acknowledge = () => { saved.push("child"); resolve(); }; })));
  t.after(registerAnswerStateWriter("trash-other", "other", async () => { throw new Error("Unrelated draft"); }));
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    requests++; assert.deepEqual(saved, ["root", "child"]);
    assert.deepEqual(JSON.parse(init.body).expectedSessionIds, ["root", "child"]);
    return Response.json({ sessionIds: ["root", "child"], trashedCount: 2 });
  });
  const pending = requestSessionDeletion("root", ["root", "child"]);
  await Promise.resolve(); assert.equal(requests, 0); acknowledge(); await pending;
  assert.equal(requests, 1);
});

test("an unresolved descendant checkpoint prevents moving the whole subtree to trash", async t => {
  t.after(registerAnswerStateWriter("trash-failed-child", "child", async () => { throw new Error("Resolve this checkpoint"); }));
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({}); });
  await assert.rejects(requestSessionDeletion("root", ["root", "child"]), /Resolve this checkpoint/);
  assert.equal(requests, 0);
});
