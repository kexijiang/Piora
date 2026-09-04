import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const workbench = await jiti.import("./json-workbench.ts");

test("smart formatting mirrors json转 defaults", () => {
  const formatted = workbench.smartFormatJson('prefix\n{\"message\":\"\\u4f60\\u597d\",\"payload\":\"{\\\"ok\\\":true}\"}\nsuffix');
  assert.deepEqual(JSON.parse(formatted.output), { message: "你好", payload: { ok: true } });
  assert.equal(formatted.kind, "json");
});

test("keeps large JSON integers lossless", () => {
  const formatted = workbench.smartFormatJson('{"id":9223372036854775807}');
  assert.match(formatted.output, /9223372036854775807/);
});

test("formats empty and scalar standard JSON values", () => {
  assert.equal(workbench.smartFormatJson("{}").kind, "json");
  assert.equal(workbench.smartFormatJson("[]").kind, "json");
  assert.equal(workbench.smartFormatJson("42").kind, "json");
});

test("reports the original line and column for invalid JSON", () => {
  const issue = workbench.findJsonSyntaxIssue('prefix\n{\n  "ok": true,\n  "broken":\n}\nsuffix');
  assert.deepEqual({ line: issue?.line, column: issue?.column }, { line: 5, column: 1 });
  assert.equal(issue?.offset, 35);
});

test("decodes URL parameters like the uTools entry", () => {
  assert.deepEqual(
    JSON.parse(workbench.runJsonWorkbenchAction("https://example.test/?name=Piora&hello=%E4%BD%A0%E5%A5%BD+ok", "get").output),
    { name: "Piora", hello: "你好 ok" },
  );
});

test("decodes unicode and consecutive hex byte escapes", () => {
  assert.equal(workbench.decodeUnicodeText("\\u4f60\\u597d \\xE4\\xB8\\x96\\xE7\\x95\\x8C"), "你好 世界");
});

test("decodes PHP serialized arrays and objects", () => {
  const array = workbench.runJsonWorkbenchAction('a:2:{i:0;s:3:"猫";i:1;s:3:"狗";}', "serialize");
  assert.deepEqual(JSON.parse(array.output), ["猫", "狗"]);
  const object = workbench.runJsonWorkbenchAction('a:2:{s:4:"name";s:5:"Piora";s:2:"ok";b:1;}', "serialize");
  assert.deepEqual(JSON.parse(object.output), { name: "Piora", ok: true });
});

test("supports the footer copy actions", () => {
  const source = '{\n  "user": { "name": "Piora" },\n  "items": [1, 2]\n}';
  assert.equal(workbench.runJsonWorkbenchAction(source, "minify").output, '{"user":{"name":"Piora"},"items":[1,2]}');
  assert.equal(workbench.runJsonWorkbenchAction('{"a":"b"}', "escape").output, '{\\"a\\":\\"b\\"}');
  assert.equal(workbench.runJsonWorkbenchAction(source, "form-data").output, "user[name]:Piora\nitems[0]:1\nitems[1]:2\n");
});

test("converts timestamps in both directions", () => {
  assert.match(workbench.transformTimestamp("1704067200"), /^2024-01-01 /);
  assert.equal(workbench.transformTimestamp("2024-01-01 00:00:00").length, 10);
});

test("blocks prototype keys while parsing GET parameters", () => {
  const value = workbench.parseGetParameters("safe=1&__proto__=bad&constructor=bad");
  assert.deepEqual(JSON.parse(JSON.stringify(value)), { safe: "1" });
  assert.equal({}.bad, undefined);
});
