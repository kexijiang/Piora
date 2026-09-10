import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { ShellStore } = await jiti.import("./shell/store.ts");
const { ManagedShellSession } = await jiti.import("./shell/session.ts");

test("abrupt server exit recovers durable receipts and honest states without replaying commands", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-shell-crash-"));
  const terminalId = randomUUID(), requestId = randomUUID();
  const command = "echo SHOULD_NEVER_REPLAY";
  const fingerprint = createHash("sha256").update(JSON.stringify({ command, runId: null })).digest("hex");
  const sessionState = { id: terminalId, title: "crash test", initialCwd: directory, cwd: directory,
    profile: { executable: path.join(directory, "MUST_NOT_START"), kind: "custom", label: "probe", integrated: false },
    createdAt: 1, updatedAt: 1, generation: 7, connected: true, integration: "ready", owner: "agent",
    activeRunId: "approval-run", activeCommandId: "pending-command", model: null, draft: "retained draft", closed: false };
  const workerFile = path.resolve("lib/shell/runtime/store-worker.cjs");
  const program = [
    'const {Worker}=require("node:worker_threads");',
    'const input=JSON.parse(process.argv[1]);',
    'const worker=new Worker(input.workerFile,{workerData:{directory:input.directory}});',
    'let sequence=0; const pending=new Map();',
    'worker.on("message",message=>{const item=pending.get(message.id);pending.delete(message.id);message.error?item.reject(new Error(message.error)):item.resolve(message.result)});',
    'const call=(op,args)=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});worker.postMessage({id,op,args})});',
    '(async()=>{',
    'await call("putEntity",{kind:"session",id:input.terminalId,data:input.sessionState});',
    'await call("accept",{terminalId:input.terminalId,requestId:input.requestId,fingerprint:input.fingerprint,kind:"command",id:"pending-command",parent:input.terminalId,data:{id:"pending-command",command:input.command,status:"running",output:"partial output",exitCode:null}});',
    'for(const status of ["accepted","completed","failed"]) await call("putEntity",{kind:"command",id:status+"-command",parent:input.terminalId,data:{id:status+"-command",command:status,status,exitCode:status==="completed"?0:null}});',
    'for(const status of ["running","awaiting_input","awaiting_approval","completed"]) await call("putEntity",{kind:"run",id:status+"-run",parent:input.terminalId,data:{id:status+"-run",status,approval:{id:"stale-approval"},question:"old question",response:"saved response"}});',
    'await call("historyUpsert",{records:[{id:"pending-command",command:input.command,status:"running",source:"human",sourceId:"probe",importedAt:1}]});',
    'process.stdout.write("DURABLE_READY\\n");',
    'setInterval(()=>{},1000);',
    '})().catch(error=>{console.error(error);process.exit(1)});',
  ].join("\n");
  let writer, store, session;
  try {
    writer = spawn(process.execPath, ["-e", program, JSON.stringify({ workerFile, directory, terminalId, requestId, fingerprint, command, sessionState })], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise(resolve => writer.once("exit", (code, signal) => resolve({ code, signal })));
    await new Promise((resolve, reject) => {
      let stdout = "", stderr = "";
      const timer = setTimeout(() => reject(new Error("Writer did not persist: " + stderr)), 10000);
      writer.stdout.on("data", bytes => { stdout += bytes; if (stdout.includes("DURABLE_READY")) { clearTimeout(timer); resolve(); } });
      writer.stderr.on("data", bytes => { stderr += bytes; });
      writer.once("error", error => { clearTimeout(timer); reject(error); });
      writer.once("exit", code => { clearTimeout(timer); reject(new Error("Writer exited before forced termination: " + code + " " + stderr)); });
    });
    writer.kill("SIGKILL"); await exited;
    store = new ShellStore(directory);
    await store.ready;
    const restored = await store.get("session", terminalId);
    assert.equal(restored.connected, false); assert.equal(restored.owner, "human");
    assert.equal(restored.activeCommandId, null); assert.equal(restored.activeRunId, null);
    assert.equal(restored.generation, 7); assert.equal(restored.draft, "retained draft");
    for (const id of ["pending-command", "accepted-command"]) assert.equal((await store.get("command", id)).status, "unknown");
    for (const status of ["completed", "failed"]) assert.equal((await store.get("command", status + "-command")).status, status);
    for (const status of ["running", "awaiting_input", "awaiting_approval"]) {
      const run = await store.get("run", status + "-run");
      assert.equal(run.status, "interrupted"); assert.equal(run.approval, null); assert.equal(run.question, null); assert.equal(run.response, "saved response");
    }
    assert.equal((await store.get("run", "completed-run")).status, "completed");
    assert.equal((await store.history({ query: "SHOULD_NEVER_REPLAY" })).records[0].status, "unknown");
    session = new ManagedShellSession(restored, store, directory); await session.hydrate();
    const receipt = await session.execute(command, requestId);
    assert.equal(receipt.id, "pending-command"); assert.equal(receipt.status, "unknown");
    assert.equal(receipt.output, "partial output");
    assert.equal(session.state.connected, false); assert.equal(session.state.generation, 7);
    assert.equal((await store.list("command", terminalId)).length, 4, "retry returns the durable receipt instead of adding a new execution");
  } finally {
    if (writer && writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
    await session?.dispose(); await store?.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(directory).startsWith("piora-shell-crash-"));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
