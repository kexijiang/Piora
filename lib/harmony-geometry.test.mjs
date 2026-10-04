import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { controlledBackend } from "./harmony/fixtures/controlled-backend.mjs";
const { transformFramePoint, framePointFromClient, parseDisplayGeometry } = await createJiti(import.meta.url).import("./harmony/observation/geometry.ts");
const base = { geometryId: "one", deviceEpoch: 1, nativeWidth: 1440, nativeHeight: 3200, frameWidth: 1080, frameHeight: 2400, rotation: 0, displayRotation: 0, displayId: "0", crop: { left: 0, top: 0, width: 1440, height: 3200 } };

test("manager transforms server-observed frames and rejects stale rotation before dispatch", async () => {
  const { createHarmonyDeviceManager } = await createJiti(import.meta.url).import("./harmony/index.ts");
  const { backend, calls, state } = controlledBackend();
  let rotation = 0;
  backend.displayGeometry = async () => ({ nativeWidth: 1440, nativeHeight: 3200, displayId: "0", displayRotation: rotation });
  state.observation.screenshot = { mimeType: "image/png", width: 1080, height: 2400, data: Buffer.from("fixture") };
  const manager = createHarmonyDeviceManager({ backend });
  try {
    const lease = await manager.acquireLease({ serial: "phone-1", owner: { kind: "manual", id: "test" } });
    await manager.captureLiveFrame({ serial: "phone-1" });
    const geometry = await manager.getFrameGeometry("phone-1", "screenshot");
    const action = { serial: "phone-1", leaseToken: lease.token, coordinateSpace: "frame", geometryId: geometry.geometryId, x: 540, y: 1200 };
    await manager.tap(action);
    assert.deepEqual(calls.filter(call => call.action === "tap").map(({ x, y }) => ({ x, y })), [{ x: 720, y: 1600 }]);
    rotation = 180;
    await assert.rejects(manager.tap(action), error => error.code === "STALE_SNAPSHOT");
    assert.equal(calls.filter(call => call.action === "tap").length, 1);
  } finally { await manager.dispose(); }
});
test("1440 native pixels map independently from 1080 video pixels", () => {
  assert.deepEqual(transformFramePoint(base, 540, 1200), { x: 720, y: 1600 });
});
test("nonuniform cropped video maps through its native crop", () => {
  assert.deepEqual(transformFramePoint({ ...base, crop: { left: 100, top: 200, width: 800, height: 1000 } }, 270, 1200), { x: 300, y: 700 });
});
for (const [rotation, expected] of [[90, { x: 720, y: 2400 }], [180, { x: 1080, y: 1600 }], [270, { x: 720, y: 800 }]]) {
  test(`frame rotation ${rotation} has an explicit inverse mapping`, () => {
    assert.deepEqual(transformFramePoint({ ...base, rotation }, 270, 1200), expected);
  });
}
test("CSS scaling, DPI and letterboxing are removed before frame-space dispatch", () => {
  const rect = { left: 10, top: 20, width: 400, height: 400 };
  assert.deepEqual(framePointFromClient(210, 220, rect, 1080, 2400), { x: 540, y: 1200 });
  assert.equal(framePointFromClient(20, 220, rect, 1080, 2400), null);
});
test("out-of-bounds and non-finite coordinates are rejected, not silently clamped", () => {
  for (const [x, y] of [[-1, 1], [1080, 1], [1, 2400], [NaN, 1]]) assert.throws(() => transformFramePoint(base, x, y));
});
test("parses the upstream DisplayDumper display table without guessing from video", () => {
  const dump = "DisplayId ScreenId RefreshRate VPR Rotation Orientation DisplayOrientation FreezeFlag [ x y w h ]\n0 0 60 3 0 0 0 0 [ 0 0 1440 3200 ]\n";
  assert.deepEqual(parseDisplayGeometry(dump), { nativeWidth: 1440, nativeHeight: 3200, displayId: "0", displayRotation: 0 });
  assert.equal(parseDisplayGeometry("permission denied"), undefined);
  assert.equal(parseDisplayGeometry(dump + "1 1 60 1 0 0 0 0 [ 0 0 1920 1080 ]"), undefined);
});

test("modern screen sections ignore duplicate display IDs in concurrent-user diagnostics", () => {
  // Format from OpenHarmony ScreenSessionDumper, including its separate relation dump.
  const dump = `---------------- Screen ID: 0 ----------------
[SCREEN SESSION]
Name: Internal
DisplayId: 0
Rotation: 1
[SCREEN INFO]
VirtualWidth: 3200
VirtualHeight: 1440
[SCREEN PROPERTY]
Rotation: 1
ScreenRotation: 1
Bounds<L,T,W,H>: 0, 0, 3200.000, 1440.000,
PhyBounds<L,T,W,H>: 0, 0, 1440, 3200,
[DISPLAY INFO]
DisplayId: 0
------- ConcurrentUser-Screen Relation --------
DisplayId: 0
User: 100
`;
  assert.deepEqual(parseDisplayGeometry(dump), { nativeWidth: 3200, nativeHeight: 1440, displayId: "0", displayRotation: 90 });
  assert.equal(parseDisplayGeometry(dump + dump.replace(/DisplayId: 0/g, "DisplayId: 1")), undefined);
  assert.equal(parseDisplayGeometry(dump.replace("ScreenRotation: 1", "ScreenRotation: unknown")), undefined);
  assert.equal(parseDisplayGeometry(dump.replace("3200.000", "3200.500")), undefined);
  assert.equal(parseDisplayGeometry(dump.replace("Bounds<L,T,W,H>: 0,", "Bounds<L,T,W,H>: 100,")), undefined);
});

const captureDisplay = (id, type, rotation, width, height) => `---------------- Screen ID: ${id} ----------------
[SCREEN SESSION]
Name: ${type === 2 ? "screen_capture" : "UNKNOWN"}
DisplayId: ${id}
[SCREEN INFO]
ScreenType: ${type}
[SCREEN PROPERTY]
ScreenRotation: ${rotation}
GetScreenType: ${type}
Bounds<L,T,W,H>: 0, 0, ${width}, ${height},
`;

test("one real display remains usable during capture with an explicitly classified virtual display", () => {
  const phone = captureDisplay(0, 1, 270, 2688, 1216);
  const virtual = captureDisplay(1011, 2, 0, 1080, 2386);
  const expected = { nativeWidth: 2688, nativeHeight: 1216, displayId: "0", displayRotation: 270 };
  assert.deepEqual(parseDisplayGeometry(phone + virtual), expected);
  assert.deepEqual(parseDisplayGeometry(virtual + phone), expected);
  assert.deepEqual(parseDisplayGeometry(phone + virtual + "---------------- Display ID: 0 ----------------\n[DISPLAY INFO]\nDisplayId: 0\n------------- Client Screen Infos -------------\n[SCREEN PROPERTY]\nScreenRotation: 0\nBounds<L,T,W,H>: 0, 0, 999, 999,\n"), expected);
  assert.equal(parseDisplayGeometry(virtual), undefined, "a virtual screen is never an input target");
  assert.equal(parseDisplayGeometry(phone + captureDisplay(1, 1, 0, 1920, 1080)), undefined, "two real displays remain ambiguous");
});

test("capture display classification must be explicit, consistent and uniquely identified", () => {
  const phone = captureDisplay(0, 1, 0, 1216, 2688);
  const virtual = captureDisplay(1011, 2, 0, 1080, 2386);
  for (const invalid of [
    virtual.replace("GetScreenType: 2", "GetScreenType: 1"),
    virtual.replace(/(?:Get)?ScreenType: 2\n/g, ""),
    captureDisplay(1011, 0, 0, 1080, 2386),
    virtual.replace("DisplayId: 1011", "DisplayId: 0"),
    virtual.replace("DisplayId: 1011", "DisplayId: invalid\nDisplayId: 1011"),
  ]) assert.equal(parseDisplayGeometry(phone + invalid), undefined);
});

test("modern rotation accepts degree and legacy index formats without accepting ambiguous fields", () => {
  for (const [raw, degrees] of [[0, 0], [1, 90], [2, 180], [3, 270], [90, 90], [180, 180], [270, 270]]) {
    assert.equal(parseDisplayGeometry(captureDisplay(0, 1, raw, 1216, 2688)).displayRotation, degrees);
  }
  for (const invalid of [45, -90, 360, "unknown"]) assert.equal(parseDisplayGeometry(captureDisplay(0, 1, invalid, 1216, 2688)), undefined);
  const phone = captureDisplay(0, 1, 0, 1216, 2688);
  assert.equal(parseDisplayGeometry(phone.replace("ScreenRotation: 0", "ScreenRotation: unknown\nScreenRotation: 0")), undefined);
  assert.equal(parseDisplayGeometry(phone.replace("Bounds<L,T,W,H>: 0, 0, 1216, 2688,", "Bounds<L,T,W,H>: 1, 0, 1216, 2688,\nBounds<L,T,W,H>: 0, 0, 1216, 2688,")), undefined);
});
