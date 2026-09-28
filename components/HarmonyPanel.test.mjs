import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./workspace/HarmonyPanel.tsx", import.meta.url), "utf8");

test("device actions keep the existing Harmony video connection alive", () => {
  const actionSource = source.slice(
    source.indexOf("  const action ="),
    source.indexOf("  const mediaAction ="),
  );

  assert.match(actionSource, /jsonRequest\("\/api\/harmony\/action"/);
  assert.doesNotMatch(actionSource, /requestFrame/);
  assert.match(source, /onClick=\{requestFrame\}/);
});

test("keeps a read-only observer surface available while an Agent is running", () => {
  assert.match(source, /sessionRunning/);
  assert.match(source, /agentHasControl/);
  assert.match(source, /AI 正在操作/);
  assert.match(source, /可直接点击、滑动/);
  assert.match(source, /onGuideAgent/);
  assert.match(source, /frameMode === "frames"/);
});

test("keeps screenshots independent and tools in one optional drawer", () => {
  const mediaSource = source.slice(source.indexOf("  const mediaAction ="), source.indexOf("  const saveSettings ="));
  assert.match(source, /disabled=\{!canScreenshot \|\| busy\}/);
  assert.match(mediaSource, /if \(!selectedSerial\) return/);
  assert.doesNotMatch(mediaSource, /if \(!selectedSerial \|\| !lease\) return/);
  assert.match(source, /hidden=\{!toolsOpen\}/);
  assert.match(source, /await ensureControl\(\)/);
  assert.doesNotMatch(source, /onClick=\{acquire\}/);
  assert.match(source, /frameZoom/);
  assert.match(source, /onMaximizedChange\(!maximized\)/);
});
