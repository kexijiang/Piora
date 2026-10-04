import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./workspace/HarmonyPanel.tsx", import.meta.url), "utf8");

test("device actions keep the existing Harmony video connection alive", () => {
  const actionSource = source.slice(
    source.indexOf("  const action ="),
    source.indexOf("  const initializeMirror ="),
  );

  assert.match(actionSource, /jsonRequest\("\/api\/harmony\/action"/);
  assert.doesNotMatch(actionSource, /requestFrame/);
  assert.match(source, /onClick=\{requestFrame\}/);
});

test("mirroring is view-only while Agent and tool control remain available", () => {
  assert.match(source, /sessionRunning/);
  assert.match(source, /agentHasControl/);
  assert.match(source, /await ensureControl\(\)/);
  assert.match(source, /投屏只读 · 已连接/);
  assert.doesNotMatch(source, /onPointerUp=\{\(event\) => \{\s*const from/);
  assert.doesNotMatch(source, /action: "input_text"/);
  assert.match(source, /frameMode === "frames"/);
});

test("keeps screenshots independent and tools in one optional drawer", () => {
  const mediaSource = source.slice(source.indexOf("  const mediaAction ="), source.indexOf("  const saveSettings ="));
  assert.match(source, /disabled=\{!canScreenshot \|\| screenshotBusy\}/);
  assert.match(mediaSource, /if \(!selectedSerial\) return/);
  assert.doesNotMatch(mediaSource, /if \(!selectedSerial \|\| !lease\) return/);
  assert.match(source, /hidden=\{!toolsOpen\}/);
  assert.match(source, /await ensureControl\(\)/);
  assert.doesNotMatch(source, /onClick=\{acquire\}/);
  assert.match(source, /frameZoom/);
  assert.match(source, /onMaximizedChange\(!maximized\)/);
});
