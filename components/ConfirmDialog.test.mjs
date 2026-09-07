import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("./ConfirmDialog.tsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("./ConfirmDialog.module.css", import.meta.url), "utf8");
const appShell = fs.readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");
const models = fs.readFileSync(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
const review = fs.readFileSync(new URL("./workspace/ReviewPanel.tsx", import.meta.url), "utf8");

test("confirmation requests use one accessible Codex-style dialog host", () => {
  assert.match(source, /requestConfirmation/);
  assert.match(source, /createPortal/);
  assert.match(source, /useFocusTrap/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(styles, /var\(--overlay-scrim\)/);
  assert.match(styles, /var\(--radius-panel\)/);
  assert.match(styles, /var\(--shadow-float\)/);
});

test("application confirmations no longer use browser-native dialogs", () => {
  assert.match(appShell, /<ConfirmationHost/);
  assert.doesNotMatch(`${appShell}\n${models}\n${review}`, /window\.(?:confirm|alert|prompt)/);
});
