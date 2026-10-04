import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..");
const roots = [
  "app/api/harmony",
  "components/workspace/HarmonyPanel.tsx",
  "components/workspace/harmony",
  "extensions/piora-harmony.ts",
  "lib/harmony",
];

async function productionFiles(relative) {
  const absolute = path.join(repo, relative);
  const entries = await readdir(absolute, { withFileTypes: true }).catch(() => undefined);
  if (!entries) return [absolute];
  return (await Promise.all(entries.map(entry => productionFiles(path.join(relative, entry.name))))).flat();
}

test("Harmony actions use inline feedback and never invoke a native JavaScript or Electron dialog", async () => {
  const files = (await Promise.all(roots.map(productionFiles))).flat()
    .filter(file => /\.(?:ts|tsx)$/.test(file) && !/\.test\.[^.]+$/.test(file));
  assert.ok(files.length > 20, "the guard must cover the Harmony API, backend, extension and workbench UI");

  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /\b(?:window|globalThis)\s*\.\s*(?:confirm|alert|prompt)\s*\(/,
      `${path.relative(repo, file)} must render status or errors inside the workbench`);
    if (file.includes(`${path.sep}components${path.sep}`)) {
      assert.doesNotMatch(source, /(?<![\w$.])(?:confirm|alert|prompt)\s*\(/,
        `${path.relative(repo, file)} must not invoke a bare browser dialog`);
    }
    assert.doesNotMatch(source, /\bdialog\s*\.\s*showMessageBox\s*\(/,
      `${path.relative(repo, file)} must not route Harmony actions through an Electron message box`);
  }

  const desktop = await readFile(path.join(repo, "desktop/src/main.ts"), "utf8");
  const harmonyDesktopBoundary = desktop.slice(
    desktop.indexOf("async function requestHarmonyEmergencyStop"),
    desktop.indexOf("function registerCompanionWindowHandlers"),
  );
  assert.ok(harmonyDesktopBoundary.length > 500, "the guard must cover the Harmony desktop IPC boundary");
  assert.doesNotMatch(harmonyDesktopBoundary, /\bdialog\s*\.\s*showMessageBox\s*\(/,
    "Harmony desktop IPC must not open an Electron message box");
});
