import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const launcher = await readFile(new URL("./NewSessionLauncher.tsx", import.meta.url), "utf8");
test("new chat presents its composer without introductory copy or quick-start cards", () => {
  assert.doesNotMatch(launcher, /StarterCards|onStarterSelect|newSession\.description|newSession\.projectDescription/);
  assert.match(launcher, /newSession\.title/);
  assert.match(launcher, /className=\{styles\.composer\}>{children}/);
});
