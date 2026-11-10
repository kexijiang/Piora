import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import ts from "typescript";

test("the actual desktop preload preserves validated login/confirmation purposes and unsubscribes", () => {
  const source = readFileSync(new URL("../desktop/src/preload.ts", import.meta.url), "utf8");
  const start = source.indexOf("    onAgentActivity(listener:");
  const method = source.slice(start, source.indexOf("\n  }),", start));
  const code = ts.transpileModule(`const bridge = {${method}};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const ipcRenderer = new EventEmitter();
  const bridge = new Function("ipcRenderer", `${code}; return bridge;`)(ipcRenderer);
  const received = [];
  const stop = bridge.onAgentActivity(activity => received.push(activity));
  const activity = { sessionId: "fixture", tabId: "tab-1", operating: true, paused: false, waiting: true, reason: "Sign in" };
  for (const purpose of ["login", "confirmation", "untrusted"]) ipcRenderer.emit("pi:browser-agent-activity", {}, { ...activity, purpose });
  assert.equal(received[0].purpose, "login");
  assert.equal(received[1].purpose, "confirmation");
  assert.equal("purpose" in received[2], false);
  ipcRenderer.emit("pi:browser-agent-activity", {}, { ...activity, waiting: false, purpose: "login" });
  assert.equal("purpose" in received[3], false);
  stop();
  ipcRenderer.emit("pi:browser-agent-activity", {}, activity);
  assert.equal(received.length, 4);
});
