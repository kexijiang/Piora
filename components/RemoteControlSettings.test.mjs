import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./RemoteControlSettings.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("./RemoteControlSettings.module.css", import.meta.url), "utf8");

test("remote settings organize all existing permissions into labelled groups", () => {
  const groups = source.slice(source.indexOf("const SCOPE_GROUPS"), source.indexOf("export function"));
  const scopes = [...groups.matchAll(/\["((?:capabilities|session)\.[a-z.]+)",/g)].map((match) => match[1]);
  assert.deepEqual(scopes.sort(), [
    "capabilities.read", "session.create", "session.state.read", "session.history.read",
    "session.tools.read", "session.message.send", "session.steer", "session.abort",
    "session.events.read", "session.messages.read",
  ].sort());
  assert.match(source, /<fieldset[^>]*disabled=\{isCreating\}/);
  assert.match(source, /<legend>/);
  assert.match(source, /<form[^>]*onSubmit=/);
  assert.match(source, /<input[^>]*className="ui-input"[^>]*required maxLength=\{120\}/);
});

test("remote settings provide guarded submission and truthful clipboard feedback", () => {
  assert.match(source, /name\.trim\(\)\.length > 0 && scopes\.length > 0/);
  assert.match(source, /if \(!canCreate \|\| isCreating\) return/);
  assert.match(source, /finally\s*\{\s*setIsCreating\(false\)/);
  assert.match(source, /if \(!navigator\.clipboard\) throw/);
  assert.match(source, /await navigator\.clipboard\.writeText\(value\);\s*setCopied\(target\)/);
  assert.match(source, /window\.clearTimeout\(timeout\)/);
  assert.match(source, /role="status"/);
  assert.match(source, /aria-busy=\{isLoading\}/);
});

test("remote settings adapt to panel width and preserve keyboard focus", () => {
  assert.match(css, /container-type: inline-size/);
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@container \(max-width: 550px\)[\s\S]*grid-template-columns: 1fr/);
  assert.match(css, /\.history summary:focus-visible/);
  assert.match(css, /\.scopeOption:has\(input:focus-visible\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test("all remote settings labels are available in both bundled locales", async () => {
  const jiti = createJiti(import.meta.url);
  const { enLocale } = await jiti.import("../lib/i18n/messages/en.ts");
  const { zhCNLocale } = await jiti.import("../lib/i18n/messages/zh-CN.ts");
  const keys = new Set([...source.matchAll(/"(remote\.[\w]+)"/g)].map((match) => match[1]));
  for (const key of keys) {
    assert.ok(enLocale.messages[key], key + " is missing in English");
    assert.ok(zhCNLocale.messages[key], key + " is missing in Chinese");
  }
});
