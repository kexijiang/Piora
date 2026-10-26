import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";

const main = readFileSync(new URL("../desktop/src/main.ts", import.meta.url), "utf8");
const preload = readFileSync(new URL("../desktop/src/preload.ts", import.meta.url), "utf8");
const supervisor = readFileSync(new URL("../desktop/src/server-supervisor.ts", import.meta.url), "utf8");
const state = readFileSync(new URL("../desktop/src/desktop-state.ts", import.meta.url), "utf8");
const panel = readFileSync(new URL("../components/workspace/HarmonyPanel.tsx", import.meta.url), "utf8");
const mirror = readFileSync(new URL("../components/workspace/harmony/MirrorWindow.tsx", import.meta.url), "utf8");
const mirrorStyles = readFileSync(new URL("../components/workspace/harmony/MirrorWindow.module.css", import.meta.url), "utf8");
const manualControl = readFileSync(new URL("../hooks/useHarmonyManualControl.ts", import.meta.url), "utf8");
const apps = readFileSync(new URL("../components/workspace/harmony/ApplicationPicker.tsx", import.meta.url), "utf8");
const panelStyles = readFileSync(new URL("../components/workspace/HarmonyPanel.module.css", import.meta.url), "utf8");
const liveFrame = readFileSync(new URL("../hooks/useHarmonyLiveFrame.ts", import.meta.url), "utf8");
const builder = readFileSync(new URL("../desktop/electron-builder.yml", import.meta.url), "utf8");

test("desktop starts one unified runtime with native Harmony path selection", () => {
  assert.match(main, /createStandaloneForProfile\("normal"\)/);
  assert.match(main, /requestHarmonyEmergencyStop\("desktop_shutdown"\)/);
  assert.doesNotMatch(main, /RUNTIME_PROFILE_SWITCH_CHANNEL|restartRuntimeProfile/);
  assert.doesNotMatch(preload, /requestRuntimeProfileSwitch/);
  assert.match(main, /HARMONY_RUNTIME_PICKER_CHANNEL/);
  assert.match(main, /showOpenDialog/);
  assert.match(preload, /selectHarmonyRuntimePath/);
  assert.doesNotMatch(preload, /ipcRenderer\.invoke\("pi:[^"]*(?:hdc|shell|spawn)/i);
});

test("standalone service receives one shared data directory and migrates legacy Harmony config", () => {
  assert.match(supervisor, /PIORA_RUNTIME_PROFILE/);
  assert.match(supervisor, /PIORA_DESKTOP_DATA_DIR/);
  assert.match(state, /runtimeProfileDataDirectory/);
  assert.match(state, /join\(userDataDirectory, "runtime", "normal"\)/);
  assert.match(state, /legacyConfig/);
  assert.match(state, /copyFileSync\(legacyConfig, unifiedConfig\)/);
});

test("Windows EXE ships a complete HDC and Harmony video runtime", () => {
  assert.match(main, /harmonyToolsDirectory/);
  assert.match(supervisor, /PIORA_HARMONY_TOOLS_DIR/);
  for (const name of ["hdc.exe", "libusb_shared.dll", "OHScrcpyServer.hap"]) {
    assert.match(builder, new RegExp(name.replace(".", "\\.")));
    assert.ok(statSync(new URL(`../third_party/harmony-tools/windows-x64/${name}`, import.meta.url)).size > 100_000);
  }
});

test("Harmony panel keeps the mirror view-only while tools retain control and emergency stop", () => {
  assert.match(panel, /\/api\/harmony\/devices/);
  assert.match(manualControl, /\/api\/harmony\/manual/);
  assert.doesNotMatch(panel, /action: "tap"|action: "swipe"|action: "input_text"|action: "press_key"/);
  assert.match(mirror, /<canvas[^>]*role="img"/);
  assert.doesNotMatch(mirror, /action: "tap"|action: "swipe"|action: "input_text"|action: "press_key"/);
  assert.match(apps, /actOnSelected\("launch_app"\)/);
  assert.match(panel, /action: "emergency_stop"/);
  assert.doesNotMatch(panel, /requestRuntimeProfileSwitch|Switch to device-control mode/);
  assert.match(panel, /desktopAvailable/);
  assert.match(mirror, /HTMLCanvasElement/);
  assert.doesNotMatch(panel, /useHarmonyLiveFrame/);
  assert.match(liveFrame, /\/api\/harmony\/video/);
  assert.match(liveFrame, /VideoDecoder\.isConfigSupported/);
  assert.match(liveFrame, /EncodedVideoChunk/);
  assert.match(liveFrame, /lifecycle\.abort\(\)/);
  assert.match(liveFrame, /\/api\/harmony\/frame/);
  assert.match(liveFrame, /const pollFrames = async/);
  assert.doesNotMatch(liveFrame, /URL\.createObjectURL/);
  assert.match(panel, /source\.product/);
  assert.match(panel, /formatHarmonyDeviceLabel\(device\)/);
  assert.match(panel, /action: "initialize_mirror"/);
  assert.match(panel, /showPioraMessage/);
  assert.match(mirror, /generation: device\?\.generation/);
  assert.match(mirror, /command === "reconnect"/);
  assert.doesNotMatch(liveFrame, /setInterval/);
  assert.match(manualControl, /piora-harmony-manual-owner-v1/);
  assert.match(manualControl, /holder\.owner\.id !== ownerId/);
  assert.match(panel, /capabilities\.screenshot/);
  assert.match(panel, /\/api\/harmony\/runtime-candidates/);
  assert.match(panel, /Detected HDC installations/);
  assert.match(panel, /\/api\/harmony\/vision-models/);
});

test("Harmony panel keeps the primary surface minimal and fits the complete phone frame", () => {
  assert.match(panel, /settingsOpen/);
  assert.match(panel, /通常只需设置一次/);
  assert.match(panel, /styles.workbenchTabs/);
  assert.match(panel, /styles.workbenchContent/);
  assert.match(panel, /const bridge = window\.piDesktop\?\.harmonyMirror/);
  assert.match(panel, /bridge\.open\(selectedSerial\)/);
  assert.match(panel, /bridge\.setPresentation\("sidebar"\)/);
  assert.doesNotMatch(panel, /ApprovalDialog|\/api\/harmony\/approval/);
  assert.match(panelStyles, /\.workbenchContent \{[^}]*flex: 1/s);
  assert.match(mirrorStyles, /object-fit: contain/);
  assert.doesNotMatch(mirror, /<footer|标准画面|只读投屏/);
});
