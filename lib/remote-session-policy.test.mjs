import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const subject = await createJiti(import.meta.url).import("./remote-session-policy.ts");
test("notes policy persists across all branches and cannot be downgraded by later entries",()=>{
  const entries=[{type:"custom",customType:"piora-remote-policy",data:{policy:"notes"}},{type:"custom",customType:"piora-remote-policy",data:{policy:"agent"}}];
  assert.equal(subject.readRemoteSessionPolicy(entries),"notes");assert.equal(subject.readRemoteSessionPolicy([]),"agent");
});
test("notes commands cannot enable tools, invoke shell, fork or execute slash commands",()=>{
  for(const type of ["bash","set_tools","set_capabilities","fork","reload","set_system_prompt"])assert.throws(()=>subject.assertRemotePolicyCommand("notes",{type}));
  assert.throws(()=>subject.assertRemotePolicyCommand("notes",{type:"prompt",message:" /some-extension"}));
  assert.doesNotThrow(()=>subject.assertRemotePolicyCommand("notes",{type:"prompt",message:"Summarize this note"}));
  assert.doesNotThrow(()=>subject.assertRemotePolicyCommand("agent",{type:"bash"}));
});
test("notes resources exclude executable extensions and all workspace context",()=>{
  const resources=subject.remotePolicyResources("notes");
  for(const field of ["noExtensions","noSkills","noPromptTemplates","noThemes","noContextFiles"])assert.equal(resources[field],true);
  assert.deepEqual(resources.additionalExtensionPaths,[]);assert.equal(subject.remotePolicyResources("agent"),undefined);
});
