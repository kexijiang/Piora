import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { createConversationFork } = await jiti.import("./session-fork.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");

test("inclusive forks preserve complete tool history and the original file, excluding later turns", t => {
  const directory = mkdtempSync(join(tmpdir(), "piora-fork-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "source.jsonl");
  const timestamp = "2026-01-01T00:00:00.000Z";
  const entries = [
    { type:"session",version:3,id:"original-session",timestamp,cwd:directory },
    { type:"message",id:"u1",parentId:null,timestamp,message:{role:"user",content:"first question",timestamp:1} },
    { type:"message",id:"call",parentId:"u1",timestamp,message:{role:"assistant",content:[{type:"thinking",thinking:"plan"},{type:"toolCall",id:"tool1",name:"read",arguments:{path:"test.txt"}}],timestamp:2} },
    { type:"message",id:"result",parentId:"call",timestamp,message:{role:"toolResult",toolCallId:"tool1",toolName:"read",content:[{type:"text",text:"evidence"}],isError:false,timestamp:3} },
    { type:"message",id:"answer",parentId:"result",timestamp,message:{role:"assistant",content:[{type:"text",text:"answer"}],stopReason:"stop",timestamp:4} },
    { type:"message",id:"u2",parentId:"answer",timestamp,message:{role:"user",content:"later question",timestamp:5} },
  ];
  const original = entries.map(entry => JSON.stringify(entry)).join("\n")+"\n";
  writeFileSync(file,original);
  const fork = createConversationFork(file,directory,"answer",true);
  const forked = SessionManager.open(fork,directory);
  assert.equal(forked.getHeader().parentSession,file);
  assert.deepEqual(forked.getBranch().filter(e=>e.type==="message").map(e=>e.message),entries.slice(1,5).map(e=>e.message));
  const first = SessionManager.open(createConversationFork(file,directory,"u1",true),directory);
  assert.equal(first.getBranch().filter(e=>e.type==="message").length,1);
  const before = SessionManager.open(createConversationFork(file,directory,"u2"),directory);
  assert.equal(before.getBranch().filter(e=>e.type==="message").length,4);
  assert.throws(()=>createConversationFork(file,directory,"call",true),/completed assistant/);
  assert.throws(()=>createConversationFork(file,directory,"result",true),/completed assistant/);
  assert.throws(()=>createConversationFork(file,directory,"missing",true),/Invalid entry/);
  assert.equal(readFileSync(file,"utf8"),original);
  assert.notEqual(forked.getSessionId(),first.getSessionId());
});
