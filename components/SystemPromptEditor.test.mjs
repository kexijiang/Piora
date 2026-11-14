import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync(new URL("./SystemPromptEditor.tsx", import.meta.url), "utf8");
const selector = readFileSync(new URL("./SystemPromptSelector.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/system-prompt/route.ts", import.meta.url), "utf8");
const sessionRoute = readFileSync(new URL("../app/api/sessions/[id]/system-prompt/route.ts", import.meta.url), "utf8");
const manager = readFileSync(new URL("../lib/rpc-manager.ts", import.meta.url), "utf8");
const chatWindow = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const projectPicker = readFileSync(new URL("./NewSessionProjectPicker.tsx", import.meta.url), "utf8");

test("system prompt settings manage a reusable template library", () => {
  assert.match(editor, /requestCatalog\("POST"/);
  assert.match(editor, /requestCatalog\("PATCH"/);
  assert.match(editor, /requestCatalog\("DELETE"/);
  assert.match(editor, /requestConfirmation\(/);
  assert.doesNotMatch(editor, /window\.confirm/);
  assert.match(editor, /piora:system-prompt-changed/);
  assert.match(editor, /selectorVisible/);
  assert.match(editor, /PI_DEFAULT_SELECTION_ID/);
  assert.match(editor, /system\.piDefaultPromptPreview/);
  assert.match(editor, /\/api\/prompts\/optimize/);
  assert.match(editor, /readPromptOptimizerModel/);
  assert.match(route, /createSystemPromptTemplate/);
  assert.match(route, /setDefaultSystemPromptTemplate/);
  assert.match(route, /setSystemPromptSelectorVisible/);
});

test("new and existing conversations can select an isolated prompt snapshot", () => {
  assert.match(selector, /SystemPromptSelection/);
  assert.match(selector, /createPortal/);
  assert.match(selector, /catalog\?\.selectorVisible === false/);
  assert.doesNotMatch(selector, /<select/);
  assert.match(projectPicker, /systemPromptSelection/);
  assert.match(chatWindow, /<SystemPromptSelector/);
  assert.match(chatWindow, /toolbarControl=\{composerToolbarControl\}/);
  assert.match(selector, /system\.searchTemplates/);
  assert.match(selector, /system\.previewTemplate/);
  assert.match(sessionRoute, /createSessionSystemPromptBinding/);
  assert.match(manager, /resolveSessionSystemPrompt/);
  assert.match(manager, /appendSessionSystemPromptBinding/);
  assert.doesNotMatch(manager, /readSystemPromptConfig\(\)\.prompt \?\? base/);
});
