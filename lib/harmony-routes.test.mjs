import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const shared = read("../app/api/harmony/_shared.ts");
const action = read("../app/api/harmony/action/route.ts");
const files = read("../app/api/harmony/files/route.ts");
const fileText = read("../app/api/harmony/files/text/route.ts");
const fileSearch = read("../app/api/harmony/files/search/route.ts");
const sqlite = read("../app/api/harmony/sqlite/route.ts");
const dispatcher = read("./harmony/action-dispatcher.ts");
const frame = read("../app/api/harmony/frame/route.ts");
const events = read("../app/api/harmony/events/route.ts");
const manual = read("../app/api/harmony/manual/route.ts");
const config = read("../app/api/harmony/config/route.ts");
const profile = read("../app/api/harmony/profile/route.ts");
const logs = read("../app/api/harmony/logs/route.ts");
const media = read("../app/api/harmony/media/route.ts");
const video = read("../app/api/harmony/video/route.ts");
const scenario = read("../app/api/harmony/scenario/route.ts");

test("Harmony routes require the per-launch desktop token without a separate runtime profile", () => {
  assert.match(shared, /isValidDesktopToken\(request\.headers\.get\(PI_DESKTOP_TOKEN_HEADER\)\)/);
  assert.doesNotMatch(shared, /DEVICE_CONTROL_PROFILE_REQUIRED|PIORA_RUNTIME_PROFILE !== "device-control"/);
  assert.match(shared, /publicManagerState/);
  assert.match(shared, /leases\.map\(\(\{ token, \.\.\.lease \}\)/);
  assert.match(shared, /void token;/);
  for (const source of [action, files, fileText, fileSearch, sqlite, frame, video, events, manual, config, logs, media, scenario]) {
    assert.match(source, /requireHarmonyAccess\(request\)/);
  }
});

test("Harmony file browsing and bounded download are authenticated and scoped by the manager", () => {
  assert.match(files, /getHarmonyDeviceManager\(\)\.listFiles/);
  assert.match(files, /getHarmonyDeviceManager\(\)\.pullFile/);
  assert.match(files, /assertNewHarmonyLocalFileAllowed\(body\.destinationPath\)/);
  assert.match(files, /kind === "sandbox"/);
  assert.match(fileText, /getHarmonyDeviceManager\(\)\.readTextFile/);
  assert.match(fileText, /getHarmonyDeviceManager\(\)\.saveTextFile/);
  assert.match(fileSearch, /getHarmonyDeviceManager\(\)\.searchFiles/);
  assert.match(sqlite, /inspectHarmonySqlite/);
  assert.doesNotMatch(files, /exec\(|spawn\(/);
});

test("Harmony scenarios accept only bounded JSON and return screenshot bytes as base64", () => {
  assert.match(scenario, /parseJsonWithinLimit\(request, 128 \* 1024\)/);
  assert.match(scenario, /manager\)\.runScenario|getHarmonyDeviceManager\(\)\.runScenario/);
  assert.match(scenario, /steps: body\.steps as HarmonyScenarioStep\[\]/);
  assert.match(scenario, /policy must be a JSON object when provided/);
  assert.match(scenario, /assertScenarioHapsAllowed\(body\.steps\)/);
  assert.match(scenario, /data\.toString\("base64"\)/);
  assert.doesNotMatch(scenario, /exec\(|spawn\(|shell_command|raw_hdc/);
});

test("Harmony logs expose bounded read-only process and hilog queries", () => {
  assert.match(logs, /manager\.listProcesses/);
  assert.match(logs, /manager\.readLogs/);
  assert.match(logs, /2_000/);
  assert.doesNotMatch(logs, /spawn\(|exec\(|raw_hdc|shell_command/);
});

test("profile bootstrap reveals no device data and still requires desktop authentication", () => {
  assert.match(profile, /requireHarmonyDesktopAccess\(request\)/);
  assert.match(profile, /PIORA_RUNTIME_PROFILE/);
  assert.doesNotMatch(profile, /getHarmonyDeviceManager|devices|leases|snapshot/);
});

test("Harmony action surface is bounded and never exposes raw HDC or shell execution", () => {
  assert.match(action, /dispatchHarmonyAction\(getHarmonyDeviceManager\(\), body, request.signal\)/);
  for (const operation of ["tap", "tap_ref", "double_tap", "long_press", "swipe", "fling", "drag", "input_text", "press_key", "launch_app", "emergency_stop"]) {
    assert.match(dispatcher, new RegExp(`"${operation}"`));
  }
  assert.match(dispatcher, /leaseToken/);
  assert.match(dispatcher, /coordinate between 0 and 100000/);
  assert.match(dispatcher, /text", 8_192/);
  assert.doesNotMatch(action + dispatcher, /exec\(|spawn\(|shell_command|raw_hdc/);
  for (const operation of ["stop_app", "clear_app_data", "uninstall_app", "install_app"]) assert.match(dispatcher, new RegExp(`"${operation}"`));
  assert.match(action, /isExistingFilePathAllowed\(body\.hapPath, await getAllowedFileRoots\(\)\)/);
  assert.match(action, /assertHarmonyLocalSourceAllowed\(body\.sourcePath\)/);
});

test("device frames are separate no-store responses while SSE carries metadata only", () => {
  assert.match(frame, /captureLiveFrame/);
  assert.match(frame, /Cache-Control": "private, no-store"/);
  assert.match(events, /publicManagerEvent/);
  assert.match(events, /text\/event-stream/);
  assert.match(shared, /SSE deliberately excludes screenshots, UI trees, input text, and bearer tokens/);
});

test("Harmony live view uses a no-transform streaming response instead of screenshot polling", () => {
  assert.match(video, /manager\.openVideoStream/);
  assert.match(video, /application\/vnd\.piora\.harmony-stream/);
  assert.match(video, /no-store, no-transform/);
  assert.match(video, /X-Accel-Buffering/);
  assert.doesNotMatch(video, /captureLiveFrame|screenCap|image\/png/);
});

test("Harmony media routes save screenshots and control bounded screen recordings", () => {
  assert.match(media, /captureScreenshotArtifact/);
  assert.match(media, /startRecording/);
  assert.match(media, /stopRecording/);
  assert.match(media, /optionalString\(body, "leaseToken"/);
  assert.match(media, /captureScreenshotArtifact\(\{ serial, signal:/);
  assert.match(media, /ownerId/);
  assert.match(config, /resolveHarmonyStorage/);
  assert.match(config, /storage/);
  assert.doesNotMatch(media, /raw_hdc|shell_command|exec\(|spawn\(/);
});

test("manual ownership, configuration, and emergency stop are explicit", () => {
  assert.match(manual, /kind: "manual"/);
  assert.match(manual, /5 \* 60_000/);
  assert.match(manual, /signal: request\.signal/);
  assert.match(manual, /released: manager\.releaseLease/);
  assert.match(config, /manager\.updateConfig/);
  assert.match(config, /manager\.getDiagnostics/);
  assert.match(dispatcher, /manager\.emergencyStop/);
});

test("Harmony storage updates do not reject an omitted hdcPath field", () => {
  assert.match(config, /body\.hdcPath !== undefined && body\.hdcPath !== null/);
});
