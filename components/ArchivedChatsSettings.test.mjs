import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const settings = await readFile(new URL("./ArchivedChatsSettings.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("./ArchivedChatsSettings.module.css", import.meta.url), "utf8");
const sidebar = await readFile(new URL("./sidebar/TaskList.tsx", import.meta.url), "utf8");

test("archived chat management follows the Codex settings pattern", () => {
  assert.match(settings, /archive\.searchPlaceholder/);
  assert.match(settings, /archive\.allProjects/);
  assert.match(settings, /archivedGroups/);
  assert.match(settings, /archive\.unarchive/);
  assert.match(settings, /archive\.deleteAll/);
  assert.match(settings, /requestConfirmation/);
  assert.match(styles, /\.toolbar/);
  assert.match(styles, /\.groupHeading/);
});

test("archived sessions are absent from the project task tree", () => {
  assert.match(sidebar, /indexTaskTree/);
  assert.doesNotMatch(sidebar, /sidebar\.archivedTasks/);
});
