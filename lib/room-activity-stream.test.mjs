import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { projectRoomActivity } from "./room-activity.ts";

const source = ts.transpileModule(readFileSync(new URL("./room-activity-stream.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function fixture() {
  const sessions = new Map(), prompts = new Map(), intervals = new Set(), timeouts = new Set();
  let members = ["a", "b"];
  const makeSession = (text) => {
    const listeners = new Set();
    return { listeners, isAlive: () => true,
      onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      inner: { agent: { state: { messages: [{ role: "user", timestamp: 2 }, { role: "assistant", content: [{ type: "text", text }] }], pendingToolCalls: new Set() } } },
    };
  };
  sessions.set("a", makeSession("private")); sessions.set("b", makeSession("room output"));
  prompts.set("a", { runId: "private-run" }); prompts.set("b", { runId: "room-run", roomContext: { roomId: "room" } });
  const modules = {
    "./rpc-manager": { getRpcSession: (id) => sessions.get(id) },
    "./prompt-run-registry": { getActivePromptRun: (id) => prompts.get(id), getActivePromptRunStartedAt: () => 1 },
    "./team-prompt-context": { getActiveTeamPromptContext: () => undefined },
    "./room-store": { getRoom: () => ({ members: members.map((sessionId) => ({ binding: { sessionId } })) }) },
    "./room-activity": { projectRoomActivity },
  };
  const exports = {};
  runInNewContext(source, { exports, require: (name) => { assert.ok(modules[name], `unexpected dependency ${name}`); return modules[name]; },
    setInterval: (fn) => { intervals.add(fn); return fn; }, clearInterval: (fn) => intervals.delete(fn),
    setTimeout: (fn) => { timeouts.add(fn); return fn; }, clearTimeout: (fn) => timeouts.delete(fn),
  });
  const snapshots = [];
  const stop = exports.subscribeRoomActivity("room", (items) => snapshots.push(items));
  return { sessions, prompts, intervals, timeouts, snapshots, stop, makeSession, setMembers: (next) => { members = next; }, tick: () => [...intervals].forEach((fn) => fn()) };
}
test("room reconnect snapshots only its current turns without starting sessions", () => {
  const f = fixture();
  assert.equal(f.snapshots.at(-1).length, 1);
  assert.equal(f.snapshots.at(-1)[0].text, "room output");
  assert.equal(f.snapshots.at(-1)[0].sessionId, "b");
  f.sessions.get("b").inner.agent.state.streamingMessage = { role: "assistant", content: [{ type: "thinking", thinking: "live thinking" }] };
  f.tick();
  assert.equal(f.snapshots.at(-1)[0].thinking, "live thinking");
  f.prompts.delete("b"); f.tick();
  assert.equal(f.snapshots.at(-1)[0].status, "ended");
  f.stop();
});
test("removed members and replaced wrappers release their subscriptions", () => {
  const f = fixture();
  const old = f.sessions.get("b");
  f.sessions.set("b", f.makeSession("replacement")); f.tick();
  assert.equal(old.listeners.size, 0);
  assert.equal(f.snapshots.at(-1)[0].text, "replacement");
  f.setMembers(["a"]); f.tick();
  assert.equal(f.snapshots.at(-1).length, 0);
  assert.equal(f.sessions.get("b").listeners.size, 0);
  for (const listener of f.sessions.get("a").listeners) listener({ type: "message_update" });
  assert.ok(f.timeouts.size > 0);
  f.stop(); f.stop();
  assert.equal(f.intervals.size, 0);
  assert.equal(f.timeouts.size, 0);
  assert.equal(f.sessions.get("a").listeners.size, 0);
});
