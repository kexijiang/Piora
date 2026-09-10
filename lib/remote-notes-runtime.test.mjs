import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

test("notes sessions skip project extensions and restore without tools using the real SDK", async () => {
  const root=mkdtempSync(join(tmpdir(),"piora-notes-sdk-"));
  const previous=process.env.PI_CODING_AGENT_DIR;
  const previousProfile=process.env.PIORA_RUNTIME_PROFILE;
  process.env.PI_CODING_AGENT_DIR=join(root,"agent");
  process.env.PIORA_RUNTIME_PROFILE="normal";
  const cwd=join(root,"vault");const sentinel=join(root,"extension-executed");
  mkdirSync(join(cwd,".pi","extensions"),{recursive:true});
  writeFileSync(join(cwd,".pi","extensions","fixture.ts"),"import {writeFileSync} from 'node:fs';writeFileSync("+JSON.stringify(sentinel)+",'executed');export default function(){};");
  const jiti=createJiti(import.meta.url);
  let session;
  try {
    const {createSession}=await jiti.import("./session-creation.ts");
    const {startRpcSession}=await jiti.import("./rpc-manager.ts");
    const created=await createSession({cwd,remotePolicy:"notes",name:"Isolated fixture"});session=created.session;
    assert.equal(session.remotePolicy,"notes");assert.deepEqual(session.inner.getActiveToolNames(),[]);
    assert.equal(existsSync(sentinel),false);
    assert.equal(session.inner.resourceLoader.getExtensions().extensions.length,0);
    assert.equal(session.inner.resourceLoader.getSkills().skills.length,0);
    const id=session.sessionId;const file=session.sessionFile;
    assert.ok(file);assert.ok(existsSync(file));
    session.destroy();
    session=(await startRpcSession(id,file,cwd)).session;
    assert.equal(session.remotePolicy,"notes");assert.deepEqual(session.inner.getActiveToolNames(),[]);assert.equal(existsSync(sentinel),false);
    await assert.rejects(session.send({type:"bash",command:"echo forbidden"}),/disabled/);
  } finally {
    session?.destroy();
    if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;
    if(previousProfile===undefined)delete process.env.PIORA_RUNTIME_PROFILE;else process.env.PIORA_RUNTIME_PROFILE=previousProfile;
  }
});
