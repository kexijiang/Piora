import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const {RemoteContentProjection}=await createJiti(import.meta.url).import("./remote-content.ts");
test("content projection emits only public text and bounded tool names",()=>{
  const projection=new RemoteContentProjection();projection.update({type:"agent_start"});
  projection.update({type:"message_update",message:{role:"assistant",content:[{type:"thinking",thinking:"secret"},{type:"text",text:"Hello"}]}});
  projection.update({type:"tool_execution_start",toolName:"read",args:{token:"secret"}});
  assert.equal(projection.snapshot().text,"Hello");assert.deepEqual(projection.snapshot().tools,["read"]);assert.ok(!JSON.stringify(projection.snapshot()).includes("secret"));
});
test("new runs clear old output and completed segments are not duplicated",()=>{
  const projection=new RemoteContentProjection();const message={role:"assistant",content:[{type:"text",text:"one"}]};
  projection.update({type:"message_update",message});projection.update({type:"message_end",message});assert.equal(projection.snapshot().text,"one");
  projection.update({type:"agent_start"});assert.equal(projection.snapshot().text,"");
});
