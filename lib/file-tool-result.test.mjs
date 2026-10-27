import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { createReadTool, createLsTool } from "@earendil-works/pi-coding-agent";
const { fileToolResult: model } = await createJiti(import.meta.url).import("./file-tool-result.ts");
const call = (toolName, input) => ({type:"toolCall",toolCallId:"a",toolName,input});
const result = (text, extra={}) => ({role:"toolResult",toolCallId:"a",content:[{type:"text",text}],...extra});

test("real SDK read windows retain exact lines, offsets and continuation without reading the current file", async () => {
  const root=await mkdtemp(join(tmpdir(),"piora-file-view-"));
  try {
    const text=Array.from({length:20},(_,i)=>`line ${i+1}`).join("\n");
    await writeFile(join(root,"a.txt"),text);
    const input={path:"a.txt",offset:4,limit:10};
    const saved=await createReadTool(root).execute("a",input);
    await writeFile(join(root,"a.txt"),"replaced after execution");
    const card=model(call("read",input),{...saved,role:"toolResult",toolCallId:"a"},root);
    assert.equal(card.lines.length,10);
    assert.deepEqual(card.lines[0],{number:4,text:"line 4"});
    assert.deepEqual(card.lines.at(-1),{number:13,text:"line 13"});
    assert.match(card.notice,/7 more lines/);
    await mkdir(join(root,"sub"));
    const listing=await createLsTool(root).execute("ls",{path:"."});
    const directory=model(call("ls",{path:"."}),{...listing,role:"toolResult",toolCallId:"ls"},root);
    assert.ok(directory.entries.some(entry=>entry.path==="sub/" && entry.directory));
    assert.ok(directory.entries.some(entry=>entry.path==="a.txt" && !entry.directory));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("read line and byte notices stay separate; malformed, streaming, error and image outputs fall back", () => {
  const tool=call("read",{path:"a.ts",offset:10});
  const card=model(tool,result("ten\neleven\n\n[Showing lines 10-11 of 20 (50.0KB limit). Use offset=12 to continue.]",{details:{truncation:{truncated:true}}}));
  assert.deepEqual(card.lines,[{number:10,text:"ten"},{number:11,text:"eleven"}]);
  for (const bad of [result("error",{isError:true}),result("partial",{isStreaming:true}),result("bad",{details:{truncation:{firstLineExceedsLimit:true}}}),{content:[{type:"image",data:"x"}]},result("x\n\n[2 more lines in file. Use offset=99 to continue.]")]) assert.equal(model(tool,bad),null);
  assert.equal(model(call("read",{path:"a",offset:-1}),result("bad")),null);
  assert.equal(model(call("read",{path:"a"}),result("" )).lines.length,0);
  assert.equal(model(call("read",{path:"a"}),result("a\n")).lines.length,2,"a saved final blank line keeps its number");
});

test("search groups retain match and context lines including Windows paths and embedded delimiters", () => {
  const card=model(call("grep",{pattern:"match"}),result("C:/repo/a.ts-9- before\nC:/repo/a.ts:10: match:42: text\nb.ts:2: other"),"C:/repo");
  assert.equal(card.groups.length,2);
  assert.equal(card.groups[0].openPath,"C:/repo/a.ts");
  assert.deepEqual(card.groups[0].lines,[{number:9,text:"before",match:false},{number:10,text:"match:42: text",match:true}]);
  assert.equal(model(call("grep",{path:"a.ts"}),result("a.ts:1: hello"),"C:/repo").groups[0].openPath,undefined,"ambiguous file-vs-directory search roots do not generate wrong links");
  assert.equal(model(call("grep",{}),result("unrecognized old output")),null);
  assert.equal(model(call("grep",{}),result("No matches found")).groups.length,0);
});

test("file lists resolve against the search root, distinguish directories and preserve limit notices", () => {
  const card=model(call("find",{path:"src"}),result("a.ts\nb.ts\n\n[2 results limit reached]",{details:{resultLimitReached:2}}),"C:/repo");
  assert.equal(card.entries[0].openPath,"C:/repo/src/a.ts");
  assert.equal(card.notice,"[2 results limit reached]");
  assert.equal(model(call("ls",{}),result("folder/\nfile.txt"),"C:/repo").entries[0].directory,true);
  assert.equal(model(call("ls",{}),result("(empty directory)")).entries.length,0);
  assert.equal(model(call("find",{}),result("partial\n\n[50KB limit reached]",{details:{truncation:{truncated:true}}})),null);
  assert.equal(model(call("bash",{command:"cat a.ts"}),result("hello")),null);
});
