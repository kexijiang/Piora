import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const source = await readFile(new URL("./workspace/HarmonyPanel.tsx", import.meta.url), "utf8");
const mirror = await readFile(new URL("./workspace/harmony/MirrorWindow.tsx", import.meta.url), "utf8");
const media = await readFile(new URL("../hooks/useHarmonyMedia.ts", import.meta.url), "utf8");
test("workbench preserves fenced tool actions without a hidden viewer", () => {
  assert.match(source, /await ensureControl\(\)/);
  assert.match(source, /onGuideAgent/);
  assert.match(source, /WorkbenchTools/);
  assert.doesNotMatch(source, /useHarmonyLiveFrame|<canvas|frameZoom/);
  assert.match(source, /onMaximizedChange\(!maximized\)/);
});
test("only the independent mirror consumes frames and has no input handlers or bottom controls", () => {
  assert.match(mirror, /useHarmonyLiveFrame/);
  assert.match(mirror, /!state.minimized/);
  assert.match(mirror, /<canvas/);
  assert.doesNotMatch(mirror, /onPointer|onMouse|<footer|action: "(?:tap|swipe|input_text|press_key)"/);
  assert.match(mirror, /setScale/);
});
test("media results use shared dialogs and stable recording identities independently of input leases", () => {
  assert.match(media, /showPioraMessage/);
  assert.match(media, /recordingId: recoveryId \?\? recording!/);
  assert.doesNotMatch(media, /ensureControl|leaseToken/);
  assert.match(source, /mirror\?\.ownerId \?\? ownerId/);
  assert.doesNotMatch(source, /captureNotice|frameFooter|toolDrawer/);
});
