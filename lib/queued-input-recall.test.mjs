import assert from "node:assert/strict";
import test from "node:test";
import { renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";
import { createSdkTestFixture } from "./pi-sdk-test-fixture.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": resolve(import.meta.dirname, "..") } });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { SessionMessageRouter } = await jiti.import("./session-message-router.ts");
const { SessionControlStore } = await jiti.import("./session-control-store.ts");
const { SessionCommandEventHub } = await jiti.import("./session-command-events.ts");
const { savePromptMaterials } = await jiti.import("./prompt-materials.ts");
const { snapshotQueuedInputs } = await jiti.import("./queued-input-recall.ts");
const { resetSessionInboxesForTests } = await jiti.import("./session-inbox.ts");
const waitFor = async predicate => { const end=Date.now()+5000; while(!predicate()){assert.ok(Date.now()<end,"timed out");await new Promise(r=>setTimeout(r,10));} };

test("recall preserves separate full SDK inputs, attachments, durable paused recovery, and rejects stale snapshots", { timeout: 30000 }, async t => {
  const fixture = await createSdkTestFixture(t, { step: () => new Promise(() => {}) });
  const previousAgentDir=process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR=fixture.agentDir;
  const session = await fixture.create();
  const previousSessions = globalThis.__piSessions;
  const wrapper = new AgentSessionWrapper(session); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  globalThis.__piSessions = new Map([[session.sessionId, wrapper]]);
  const store = new SessionControlStore({root:join(fixture.agentDir,"control")});
  const router = new SessionMessageRouter({store,events:new SessionCommandEventHub(store),resolver:async()=>({session:wrapper,realSessionId:session.sessionId})});
  try {
    await router.dispatchSessionMessage({targetSessionId:session.sessionId,content:"ORIGINAL",source:"ui",idempotencyKey:"original"});
    await waitFor(()=>fixture.requests.length===1);
    const image={type:"image",mimeType:"image/png",data:"eA=="};
    const file={name:"notes.txt",size:10,path:join(fixture.cwd,"notes.txt")};
    const material=savePromptMaterials([{name:"pasted.txt",content:"Full original file content"}])[0];
    const input={materials:[{id:material.id}],targetSessionId:session.sessionId,content:"same text",source:"ui",images:[image],localFiles:[file],promptSuffix:"file context"};
    await router.steerSession({...input,idempotencyKey:"first"});
    await router.followUpSession({...input,idempotencyKey:"second",images:[{...image,data:"eQ=="}]});
    assert.notEqual(store.findByIdempotencyKey("first", session.sessionId).status, "completed", "SDK queue acceptance is not consumption confirmation");
    const modes=[session.agent.steeringMode,session.agent.followUpMode];
    const before=snapshotQueuedInputs(session);
    assert.equal(before.length,2);
    assert.equal(session.getSteeringMessages().length,1);
    assert.equal(session.getFollowUpMessages().length,1);
    assert.deepEqual([session.agent.steeringMode,session.agent.followUpMode],modes);
    renameSync(material.path,material.path+".held");
    try { await assert.rejects(router.recallQueuedInputs(session.sessionId)); }
    finally { renameSync(material.path+".held",material.path); }
    assert.deepEqual(snapshotQueuedInputs(session),before,"unreadable attachments must not remove a pending message");
    const append=store.appendRecalledCommands.bind(store);
    store.appendRecalledCommands=async (_commands,commit)=>commit(()=>{throw new Error("disk full");});
    await assert.rejects(router.recallQueuedInputs(session.sessionId),/disk full/);
    assert.deepEqual(snapshotQueuedInputs(session),before,"storage failure preserves SDK queues");
    assert.equal(store.loadCommands(session.sessionId).length,3);
    store.appendRecalledCommands=async(commands,commit)=>{
      await session.followUp("arrived during persistence");
      return append(commands,commit);
    };
    await assert.rejects(router.recallQueuedInputs(session.sessionId),/pending queue changed/);
    assert.equal(snapshotQueuedInputs(session).length,3,"stale snapshot cannot clear a newly queued message");
    assert.equal(store.loadCommands(session.sessionId).length,3);
    store.appendRecalledCommands=async(commands,commit)=>append(commands,persist=>commit(()=>{
      persist();
      assert.equal(store.loadCommands(session.sessionId).filter(item=>item.queuePaused).length,3,"all independent entries are durable before SDK dequeue");
      assert.equal(snapshotQueuedInputs(session).length,3);
    }));
    const recalled=await router.recallQueuedInputs(session.sessionId);
    assert.equal(recalled.length,3);
    assert.equal(snapshotQueuedInputs(session).length,0);
    assert.deepEqual(recalled.map(item=>item.content),["same text","same text","arrived during persistence"]);
    assert.deepEqual(recalled[0].images,[image]);
    assert.equal(recalled[1].images[0].data,"eQ==");
    assert.deepEqual(recalled[0].localFiles,[file]);
    assert.equal(recalled[0].promptSuffix,"file context");
    assert.deepEqual(recalled[0].materials,[{id:material.id}]);
    assert.equal(new Set(recalled.map(item=>item.commandId)).size,3);
    assert.ok(recalled.every(item=>item.queuePaused&&item.status==="queued"&&item.inputMode==="text"));
    assert.equal(fixture.requests.length,1,"recall never sends a new prompt");
    assert.deepEqual(await router.recallQueuedInputs(session.sessionId),[],"retrying a lost response cannot duplicate recalled messages");
    const reloaded = new SessionControlStore({root:store.root}).loadCommands(session.sessionId).filter(item=>item.queuePaused);
    assert.equal(reloaded.length,3,"refresh/restart can restore every paused item from disk");
    assert.deepEqual(reloaded[0].images,[image]);
    assert.deepEqual(reloaded[0].localFiles,[file]);
    const edited=await router.queuedInputAction(session.sessionId,recalled[0].commandId,"edit","changed",recalled[0].revision);
    assert.deepEqual(edited.images,[image]);
    assert.deepEqual(edited.localFiles,[file]);
    assert.equal(edited.queuePaused,false);
  } finally {
    for (const record of store.loadCommands(session.sessionId).filter(item=>item.queuePaused || item.content==="changed")) {
      await router.queuedInputAction(session.sessionId,record.commandId,"cancel").catch(()=>{});
    }
    await router.cancelPromptSubmission({targetSessionId:session.sessionId,idempotencyKey:"original"});
    await waitFor(()=>!wrapper.isRunning());
    await new Promise(resolve=>setTimeout(resolve,100));
    wrapper.destroy(); await wrapper.shutdownForFileMutation();
    globalThis.__piSessions=previousSessions;
    resetSessionInboxesForTests();
    if(previousAgentDir===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previousAgentDir;
  }
});

for (const delayed of [false, true, "journal"]) test(`stop preserves unconsumed steering and attachments durably (delay: ${delayed})`, { timeout: 30000 }, async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let entered = false;
  const fixture = await createSdkTestFixture(t, {
    step: () => new Promise(() => {}),
    extension: pi => pi.on("input", async event => {
      if (delayed === true && event.text === "guidance") { entered = true; await gate; }
    }),
  });
  const session = await fixture.create();
  const wrapper = new AgentSessionWrapper(session); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[session.sessionId, wrapper]]);
  const store = new SessionControlStore({ root: join(fixture.agentDir, "stop-control") });
  const append = store.appendCommand.bind(store);
  store.appendCommand = async command => {
    if (delayed === "journal" && command.idempotencyKey === "guide") { entered = true; await gate; }
    return append(command);
  };
  const router = new SessionMessageRouter({ store, events: new SessionCommandEventHub(store), resolver: async () => ({ session: wrapper, realSessionId: session.sessionId }) });
  try {
    await router.dispatchSessionMessage({ targetSessionId: session.sessionId, source: "ui", content: "active", idempotencyKey: "active" });
    await waitFor(() => fixture.requests.length === 1);
    const image = { type: "image", mimeType: "image/png", data: "eA==" };
    await router.followUpSession({ targetSessionId: session.sessionId, source: "ui", content: "separate guidance", idempotencyKey: "separate", images: [image] });
    const submission = router.steerSession({ targetSessionId: session.sessionId, source: "ui", content: "guidance", idempotencyKey: "guide", images: [image] });
    if (delayed) await waitFor(() => entered); else await submission;
    await wrapper.send({ type: "abort" });
    release(); await submission;
    await waitFor(() => !wrapper.isRunning());
    await wrapper.send({ type: "abort" });
    const paused = new SessionControlStore({ root: store.root }).loadCommands(session.sessionId).filter(record => record.queuePaused);
    assert.equal(paused.length, 2);
    assert.deepEqual(paused.map(record => record.content), ["separate guidance", "guidance"]);
    assert.ok(paused.every(record => record.status === "queued"));
    for (const record of paused) assert.deepEqual(record.images, [image]);
    assert.equal(fixture.requests.length, 1, "stop must not start another model request");
    assert.equal(session.pendingMessageCount, 0);
    assert.equal((await router.listOperations(session.sessionId)).filter(record => record.queuePaused).length, 2, "refresh exposes the paused commands");
    for (const record of paused) await router.queuedInputAction(session.sessionId, record.commandId, "cancel");
  } finally {
    release(); wrapper.destroy(); await wrapper.shutdownForFileMutation();
    globalThis.__piSessions = previous; resetSessionInboxesForTests();
  }
});
test("stop does not recover steering already consumed by the real SDK", { timeout: 30000 }, async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const fixture = await createSdkTestFixture(t, { step: async request => {
    if (request.index === 0) { await gate; return [{ type: "text", text: "first" }]; }
    return new Promise(() => {});
  } });
  const session = await fixture.create();
  const wrapper = new AgentSessionWrapper(session); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[session.sessionId, wrapper]]);
  const store = new SessionControlStore({ root: join(fixture.agentDir, "consumed-control") });
  const router = new SessionMessageRouter({ store, events: new SessionCommandEventHub(store), resolver: async () => ({ session: wrapper, realSessionId: session.sessionId }) });
  try {
    await router.dispatchSessionMessage({ targetSessionId: session.sessionId, source: "ui", content: "active", idempotencyKey: "active" });
    await waitFor(() => fixture.requests.length === 1);
    const receipt = await router.steerSession({ targetSessionId: session.sessionId, source: "ui", content: "consumed guidance", idempotencyKey: "consumed" });
    assert.equal(receipt.status, "delivered");
    release();
    await waitFor(() => fixture.requests.length === 2);
    await waitFor(() => store.findByIdempotencyKey("consumed", session.sessionId).status === "completed");
    await router.steerSession({ targetSessionId: session.sessionId, source: "ui", content: "consumed guidance", idempotencyKey: "unconsumed" });
    await wrapper.send({ type: "abort" });
    await waitFor(() => !wrapper.isRunning());
    const paused = store.loadCommands(session.sessionId).filter(record => record.queuePaused);
    assert.deepEqual(paused.map(record => record.idempotencyKey), ["unconsumed"], "identical text must be distinguished by actual SDK message identity");
    assert.equal(fixture.requests.length, 2);
    assert.match(JSON.stringify(fixture.requests[1].messages), /consumed guidance/);
    await router.queuedInputAction(session.sessionId, paused[0].commandId, "cancel");
  } finally {
    release(); wrapper.destroy(); await wrapper.shutdownForFileMutation();
    globalThis.__piSessions = previous; resetSessionInboxesForTests();
  }
});

test("late SDK consumption after a drained queue wins over paused stop recovery", { timeout: 30000 }, async t => {
  let releaseModel, releaseBoundary;
  const modelGate = new Promise(resolve => { releaseModel = resolve; });
  const boundaryGate = new Promise(resolve => { releaseBoundary = resolve; });
  let firstFinished = false, boundaryEntered = false;
  const fixture = await createSdkTestFixture(t, {
    step: async request => { if (request.index === 0) { await modelGate; firstFinished = true; } return [{ type: "text", text: "done" }]; },
    extension: pi => pi.on("turn_start", async () => { if (firstFinished) { boundaryEntered = true; await boundaryGate; } }),
  });
  const session = await fixture.create();
  const wrapper = new AgentSessionWrapper(session); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[session.sessionId, wrapper]]);
  const store = new SessionControlStore({ root: join(fixture.agentDir, "boundary-control") });
  const router = new SessionMessageRouter({ store, events: new SessionCommandEventHub(store), resolver: async () => ({ session: wrapper, realSessionId: session.sessionId }) });
  try {
    await router.dispatchSessionMessage({ targetSessionId: session.sessionId, source: "ui", content: "active", idempotencyKey: "active" });
    await waitFor(() => fixture.requests.length === 1);
    await router.steerSession({ targetSessionId: session.sessionId, source: "ui", content: "late consumption", idempotencyKey: "late" });
    releaseModel(); await waitFor(() => boundaryEntered);
    await wrapper.send({ type: "abort" });
    releaseBoundary(); await waitFor(() => !wrapper.isRunning());
    await waitFor(() => store.findByIdempotencyKey("late", session.sessionId).status === "completed");
    assert.equal(store.loadCommands(session.sessionId).filter(record => record.queuePaused).length, 0);
    assert.equal((await router.getState(session.sessionId)).queueLength, 0);
    assert.equal(session.sessionManager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("late consumption")).length, 1);
  } finally {
    releaseModel(); releaseBoundary(); wrapper.destroy(); await wrapper.shutdownForFileMutation();
    globalThis.__piSessions = previous; resetSessionInboxesForTests();
  }
});