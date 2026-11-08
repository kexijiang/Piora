import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const source = await readFile(new URL("./workspace/HarmonyPanel.tsx", import.meta.url), "utf8");
const mirror = await readFile(new URL("./workspace/harmony/MirrorWindow.tsx", import.meta.url), "utf8");
const viewControls = await readFile(new URL("./workspace/harmony/MirrorViewControls.tsx", import.meta.url), "utf8");
const media = await readFile(new URL("../hooks/useMirrorMedia.ts", import.meta.url), "utf8");
test("workbench preserves fenced tool actions without a hidden viewer", () => {
  assert.match(source, /await ensureControl\(\)/);
  assert.match(source, /onGuideAgent/);
  assert.match(source, /WorkbenchTools/);
  assert.doesNotMatch(source, /useHarmonyLiveFrame|<canvas|frameZoom/);
  assert.match(source, /onMaximizedChange\(!maximized\)/);
});
test("only the independent mirror consumes frames and control defaults on but input is dispatched explicitly", () => {
  assert.match(mirror, /useHarmonyMirror/);
  assert.doesNotMatch(mirror, /!state.minimized/);
  assert.match(mirror, /ref=\{live.surfaceRef\}/);
  assert.match(mirror, /\[controlEnabled, setControlEnabled\] = useState\(true\)/);
  assert.match(mirror, /enabled: controlEnabled && live.state === "live" && presenting/);
  assert.match(source, /<nav hidden className=\{styles.workbenchTabs\}/);
  assert.match(source, /<main hidden className=\{styles.workbenchContent\}/);
  assert.match(mirror, /useMirrorInput/);
  assert.match(mirror, /<MirrorViewControls zoom=\{zoom\} onZoom=\{setZoom\}/);
  assert.match(viewControls, /画面缩放/);
  assert.doesNotMatch(mirror, /initialize_mirror|onEnableVideo/);
});
test("media results use shared dialogs and stable recording identities independently of input leases", () => {
  assert.match(media, /showPioraMessage/);
  assert.match(media, /const id = recoveryId \?\? expected.observed\?\.recordingId/);
  assert.match(media, /recordingId: id/);
  assert.match(media, /scope.current !== expected \|\| expected.abort.signal.aborted/);
  assert.doesNotMatch(media, /ensureControl|leaseToken/);
  assert.match(source, /mirror\?\.ownerId \?\? ownerId/);
  assert.doesNotMatch(source, /captureNotice|frameFooter|toolDrawer/);
});
