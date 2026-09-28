import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { enLocale } = await jiti.import("./i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("./i18n/messages/zh-CN.ts");

const REQUIRED_EDITOR_MESSAGES = [
  "fileEditor.externalChangeTitle",
  "fileEditor.externalChangeBody",
  "fileEditor.reloadConfirmTitle",
  "fileEditor.reloadConfirmBody",
  "fileEditor.overwriteConfirmTitle",
  "fileEditor.overwriteConfirmBody",
  "fileEditor.confirmReload",
  "fileEditor.confirmOverwrite",
  "fileEditor.saveFailed",
  "fileEditor.unsaved",
  "fileEditor.cursorPosition",
  "fileEditor.editModeTitle",
  "fileEditor.changeNavigation",
  "fileEditor.previousChange",
  "fileEditor.nextChange",
  "fileEditor.changePosition",
  "fileEditor.changeTotal",
  "fileEditor.noChanges",
  "fileEditor.readOnlyTitle",
  "fileEditor.readOnlyTypeBody",
  "files.openInEditor",
  "files.openPreview",
  "i18n.edit",
];

test("file editor conflict flow has complete English and Chinese messages", () => {
  for (const locale of [enLocale, zhCNLocale]) {
    for (const key of REQUIRED_EDITOR_MESSAGES) {
      assert.equal(typeof locale.messages[key], "string", `${locale.id} is missing ${key}`);
      assert.notEqual(locale.messages[key].trim(), "", `${locale.id} has an empty ${key}`);
    }
  }
});

test("text files open in the editor while preview modes remain available", async () => {
  const source = await readFile(new URL("../components/FileViewer.tsx", import.meta.url), "utf8");
  assert.match(source, /useState<DisplayMode>\("edit"\)/);
  assert.match(source, /setDisplayMode\("edit"\)/);
  assert.doesNotMatch(source, /data\?\.language === "markdown"[\s\S]{0,160}setDisplayMode\("preview"\)/);
  assert.match(source, /"edit",\s*"source",/);
  assert.match(source, /editorStyles\.editModeButton/);
  assert.match(source, /<ReadOnlyNotice \/>/);
});

test("file editor conflict decisions stay inside the application UI", async () => {
  const source = await readFile(new URL("../components/FileViewer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /window\.confirm\s*\(/);
  assert.match(source, /setConflictDecision\("reload"\)/);
  assert.match(source, /setConflictDecision\("overwrite"\)/);
});
