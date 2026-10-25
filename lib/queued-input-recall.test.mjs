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
