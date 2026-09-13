import assert from "node:assert/strict";
import test from "node:test";
import {createJiti} from "jiti";
const {createRemoteContentStream}=await createJiti(import.meta.url).import("./remote-content-stream.ts");
test("stream immediately synchronizes active text and closes on abort",async()=>{
  const abort=new AbortController();let checked=0;
  const reader=createRemoteContentStream({snapshot:()=>({type:"content.snapshot",text:"current"}),authorize:()=>{checked++;},signal:abort.signal,intervalMs:5}).getReader();
  const initial=await reader.read();assert.equal(initial.done,false);assert.match(new TextDecoder().decode(initial.value),/current/);assert.ok(checked>0);
  abort.abort();assert.equal((await reader.read()).done,true);
});
test("revoked capability stops a live stream before the next content write",async()=>{
  let allowed=true;let text="first";const abort=new AbortController();
  const reader=createRemoteContentStream({snapshot:()=>({type:"content.snapshot",text}),authorize:()=>{if(!allowed)throw new Error("revoked");},signal:abort.signal,intervalMs:5}).getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value),/first/);allowed=false;text="must-not-send";
  const terminal=await reader.read();assert.doesNotMatch(new TextDecoder().decode(terminal.value),/must-not-send/);assert.equal((await reader.read()).done,true);abort.abort();
});

test("wrapper teardown emits a recoverable reset rather than an authorization failure",async()=>{
  let alive=true;const abort=new AbortController();const reader=createRemoteContentStream({alive:()=>alive,snapshot:()=>({text:"first"}),authorize:()=>{},signal:abort.signal,intervalMs:5}).getReader();
  await reader.read();alive=false;
  const terminal=await Promise.race([reader.read(),new Promise(resolve=>setTimeout(()=>{abort.abort();resolve({value:new TextEncoder().encode("timeout")});},100))]);
  assert.match(new TextDecoder().decode(terminal.value),/stream.reset/);assert.equal((await reader.read()).done,true);abort.abort();
});
