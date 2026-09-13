import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const {RemoteContentProjection}=await createJiti(import.meta.url).import("./remote-content.ts");
test("tool cards track concurrent calls, replace progress and keep terminal outcomes",()=>{
  const projection=new RemoteContentProjection();projection.resetForRun("run");
  for(const [toolCallId,toolName] of [["first","read"],["second","bash"]])projection.update({type:"tool_execution_start",toolCallId,toolName,args:{password:"private-args"}});
  projection.update({type:"tool_execution_update",toolCallId:"first",partialResult:{content:[{type:"text",text:"reading"}],details:{secret:"private-details"}}});
  assert.deepEqual(projection.snapshot().toolCalls,[{toolCallId:"first",toolName:"read",status:"running",output:"reading",truncated:false},{toolCallId:"second",toolName:"bash",status:"running",output:"",truncated:false}]);
  projection.update({type:"tool_execution_end",toolCallId:"first",isError:false,result:{content:[{type:"text",text:"done"},{type:"image",data:"private-image"}],details:{secret:"private-details"}}});
  projection.update({type:"tool_execution_end",toolCallId:"second",isError:true,result:{content:[{type:"text",text:"failed"}]}});
  projection.update({type:"tool_execution_update",toolCallId:"first",partialResult:{content:[{type:"text",text:"late"}]}});
  assert.deepEqual(projection.snapshot().toolCalls.map(call=>[call.toolCallId,call.status,call.output]),[["first","succeeded","done"],["second","failed","failed"]]);
  assert.ok(!JSON.stringify(projection.snapshot()).includes("private-"));
  projection.resetForRun("next");assert.deepEqual(projection.snapshot().toolCalls,[]);
});
test("tool snapshots are bounded, immutable and report omitted calls",()=>{
  const projection=new RemoteContentProjection();projection.resetForRun("run");
  for(let index=0;index<25;index++){projection.update({type:"tool_execution_start",toolCallId:"call-"+index,toolName:"read"});projection.update({type:"tool_execution_end",toolCallId:"call-"+index,isError:false,result:{content:[{type:"text",text:"x".repeat(4000)}]}});}
  const snapshot=projection.snapshot();assert.equal(snapshot.toolCalls.length,20);assert.equal(snapshot.omittedToolCalls,5);
  assert.equal(snapshot.toolCalls[0].output.length,2000);assert.equal(snapshot.toolCalls[0].truncated,true);
  snapshot.toolCalls[0].output="mutated";assert.notEqual(projection.snapshot().toolCalls[0].output,"mutated");
  const sequence=projection.snapshot().sequence;projection.update({type:"tool_execution_end",toolCallId:"call-0",isError:true,result:{content:[]}});assert.equal(projection.snapshot().sequence,sequence);
});
test("content projection emits only public text and bounded tool names",()=>{
  const projection=new RemoteContentProjection();projection.resetForRun("first");projection.update({type:"agent_start"});
  projection.update({type:"message_update",message:{role:"assistant",content:[{type:"thinking",thinking:"secret"},{type:"text",text:"Hello"}]}});
  projection.update({type:"tool_execution_start",toolName:"read",args:{token:"secret"}});
  assert.equal(projection.snapshot().text,"Hello");assert.deepEqual(projection.snapshot().tools,["read"]);assert.ok(!JSON.stringify(projection.snapshot()).includes("secret"));
});
test("new runs clear old output and completed segments are not duplicated",()=>{
  const projection=new RemoteContentProjection();projection.resetForRun("first");const message={role:"assistant",content:[{type:"text",text:"one"}]};
  projection.update({type:"message_update",message});projection.update({type:"message_end",message});assert.equal(projection.snapshot().text,"one");
  projection.resetForRun("second");assert.equal(projection.snapshot().text,"");
});

test("logical prompt admission resets text before SDK start and retries retain completed segments",()=>{
  const projection=new RemoteContentProjection();projection.resetForRun("first");
  projection.update({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"first segment"}]}});
  projection.update({type:"agent_start"});assert.equal(projection.snapshot().text,"first segment");
  const sequence=projection.snapshot().sequence;projection.resetForRun("second");assert.equal(projection.snapshot().text,"");assert.ok(projection.snapshot().sequence>sequence);
});

test("wrapper identities distinguish restarted sequence counters and idle frames discard old tools",()=>{
  const first=new RemoteContentProjection();const second=new RemoteContentProjection();
  assert.equal(typeof first.snapshot().streamId,"string");assert.notEqual(first.snapshot().streamId,second.snapshot().streamId);
  first.resetForRun("run");first.update({type:"tool_execution_start",toolName:"read"});const sequence=first.snapshot().sequence;
  first.resetForRun(null);assert.deepEqual(first.snapshot().tools,[]);assert.ok(first.snapshot().sequence>sequence);
});
