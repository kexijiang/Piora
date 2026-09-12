import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { parseReplyResult, latestReplySource, replySourceText, validateReplySettings, defaultReplySettings } = await jiti.import("./reply-suggestions.ts");
const { chooseReply, editReplyDraft, clearReplySelections } = await jiti.import("./reply-draft.ts");
const source = "可以选择浅色或深色，我推荐深色。还可以增加搜索和导出。";
const option = (label, insertText = `我选择${label}。`, evidence = label) => ({ label, insertText, evidence, recommended: false });
const group = (options, selectionMode = "multiple") => ({ title: "选择", selectionMode, options });
const raw = (groups) => JSON.stringify({ groups });
const valid = parseReplyResult(raw([group([option("浅色"), option("深色")], "single"), group([option("搜索"), option("导出")])]), source);
test("accepts supported choices with content-stable app-owned IDs even after model reordering", () => { const reordered = parseReplyResult(raw([group([option("深色"),option("浅色")],"single")]),source); assert.equal(valid.groups[0].options[1].id,reordered.groups[0].options[0].id); assert.equal(valid.groups[1].selectionMode, "multiple"); });
test("accepts an empty extraction", () => assert.deepEqual(parseReplyResult('{"groups":[]}', source), { groups: [] }));
for (const [name, content] of [
  ["markdown wrapper", '```json\n{"groups":[]}\n```'], ["invalid JSON", "yes"], ["array root", "[]"], ["null root", "null"], ["missing groups", "{}"], ["unknown root", '{"groups":[],"send":true}'],
  ["too many groups", raw(Array.from({length:4},()=>group([option("浅色")])) )], ["single without alternative", raw([group([option("浅色")], "single")])], ["empty group", raw([group([])])], ["unknown selection mode", raw([group([option("浅色")], "auto")])],
  ["blank title", raw([{...group([option("浅色")]),title:" "}])], ["long title", raw([{...group([option("浅色")]),title:"a".repeat(65)}])], ["blank label", raw([group([option(" ")])])], ["long label", raw([group([option("a".repeat(49))])])],
  ["long insertion", raw([group([option("浅色","a".repeat(161))])])], ["blank insertion", raw([group([option("浅色"," ")])])], ["unsupported evidence", raw([group([option("蓝色")])])], ["empty evidence", raw([group([option("浅色","选择浅色","")])])],
  ["nonboolean recommendation", raw([group([{...option("浅色"),recommended:"true"}])])], ["duplicate insertion", raw([group([option("浅色"),option("深色","我选择浅色。")])])], ["duplicate labels", raw([group([option("浅色"),option("浅色","不同文字")])])], ["control characters", raw([group([option("浅色","a\u0000b")])])],
]) test(`rejects ${name}`, () => assert.throws(() => parseReplyResult(content,source), /invalid_output/));
test("does not silently truncate a 9-option group", () => assert.throws(()=>parseReplyResult(raw([group(Array.from({length:9},(_,i)=>option(String(i))))]),"0123456789")));
test("Unicode limits count code points", () => assert.equal(parseReplyResult(raw([group([option("😀".repeat(48),"浅色","浅色")])]),source).groups[0].options[0].label.length,96));
test("removes fenced, quoted and indented examples from evidence", () => assert.equal(replySourceText("建议搜索\n```js\n选择深色\n```\n> 请导出\n    浅色\n正常正文"),"建议搜索\n正常正文"));
test("an unclosed fence does not expose example content", () => assert.equal(replySourceText("正文\n~~~\n隐藏"),"正文"));
test("oversized source keeps complete trailing paragraphs", () => assert.equal(replySourceText("a".repeat(25_000)+"\n\n选择深色"),"选择深色"));
test("oversized uninterrupted paragraph is not cut into a new meaning", () => assert.equal(replySourceText("a".repeat(25_000)),""));
const assistant = (stopReason="stop", content=[{type:"text",text:source}]) => ({role:"assistant",stopReason,content});
test("only selects completed final assistant text with a durable entry ID", () => assert.equal(latestReplySource([assistant()],["a"]).sourceEntryId,"a"));
for(const reason of ["error","aborted","length","toolUse",undefined]) test(`ignores ${String(reason)} completion`,()=>assert.equal(latestReplySource([{...assistant(),stopReason:reason}],["a"]),null));
test("ignores an old answer after a new user or tool message",()=> { for(const role of ["user","toolResult"]) assert.equal(latestReplySource([assistant(),{role,content:"new"}],["a","b"]),null); });
test("ignores transient and thinking-only answers",()=> { assert.equal(latestReplySource([assistant()],[null]),null); assert.equal(latestReplySource([assistant("stop",[{type:"thinking",thinking:source}])],["a"]),null); });
test("default settings are off with a dedicated unselected model",()=>assert.deepEqual([defaultReplySettings().enabled,defaultReplySettings().model],[false,null]));
test("settings reject missing model and overlong prompts without truncation",()=> { assert.throws(()=>validateReplySettings({...defaultReplySettings(),enabled:true})); assert.throws(()=>validateReplySettings({...defaultReplySettings(),systemPrompt:"a".repeat(8001)})); });
const initial = () => ({value:"手写内容",spans:[]});
const pick = (draft, gi=0, oi=0, key="s", force=false) => chooseReply(draft,key,valid.groups[gi],valid.groups[gi].options[oi],force);
test("single choice replacement preserves position and other multiple choices",()=> { let d=pick(initial()).draft;d=pick(d,1).draft;d=pick(d,0,1).draft;assert.equal(d.value,"手写内容\n我选择深色。\n我选择搜索。");assert.equal(d.spans.length,2); });
test("repeated click removes only its own occurrence and separator",()=> { const d=pick({value:"我选择浅色。",spans:[]}).draft;assert.equal(pick(d).draft.value,"我选择浅色。"); });
test("manual edits require an explicit conflict decision",()=> { let d=pick(initial()).draft;d=editReplyDraft(d,d.value.replace("浅色","暖色"));assert.ok(pick(d,0,1).conflict);assert.equal(pick(d,0,1).draft.value,d.value);assert.equal(pick(d,0,1,"s",true).draft.value,"手写内容\n我选择深色。"); });
test("edits before a chip shift UTF16 offsets and survive deselection",()=> { let d=pick(initial()).draft;d=editReplyDraft(d,"😀"+d.value);assert.equal(d.spans[0].start,7);assert.equal(pick(d).draft.value,"😀手写内容"); });
test("deleting the entire span detaches the choice",()=> { const d=pick(initial()).draft;assert.equal(editReplyDraft(d,"手写内容").spans.length,0); });
test("clear retains edited text while removing unedited choices",()=> { let d=pick(initial()).draft;d=pick(d,1).draft;d=editReplyDraft(d,d.value.replace("浅色","暖色"));const cleared=clearReplySelections(d);assert.equal(cleared.retained,1);assert.equal(cleared.draft.value,"手写内容\n我选择暖色。");assert.equal(cleared.draft.spans.length,0); });
test("choices from different sources never replace each other",()=> { let d=pick(initial()).draft;d=pick(d,0,1,"other").draft;d=clearReplySelections(d,"s").draft;assert.equal(d.value,"手写内容\n我选择深色。");assert.equal(d.spans[0].source,"other");assert.equal(d.spans[0].start,5); });
test("manual replacements across two chip boundaries detach ownership instead of overlapping spans",()=> { let d=pick(initial()).draft;d=pick(d,1).draft;const value=d.value.slice(0,d.spans[0].end-2)+"手写替换"+d.value.slice(d.spans[1].start+2);d=editReplyDraft(d,value);assert.equal(d.spans.length,0);assert.equal(clearReplySelections(d).draft.value,value); });
test("removing the first choice does not leave an app-owned empty line",()=> { let d=pick({value:"",spans:[]}).draft;d=pick(d,1).draft;d=pick(d).draft;assert.equal(d.value,"我选择搜索。");assert.equal(d.spans[0].start,0);assert.equal(pick(d,1).draft.value,""); });
