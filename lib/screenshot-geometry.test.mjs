import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { rectFromPoints, planCaptureSelection } = await createJiti(import.meta.url).import("../desktop/src/screenshot-geometry.ts");

test("cross-screen selection preserves physical pixels across mixed source scales and negative origins", () => {
  const displays = [
    { id: "left", physicalBounds: { x: -1920, y: 0, width: 1920, height: 1080 }, imageWidth: 1920, imageHeight: 1080 },
    { id: "right", physicalBounds: { x: 0, y: 0, width: 3840, height: 2160 }, imageWidth: 3840, imageHeight: 2160 },
  ];
  const plan = planCaptureSelection(rectFromPoints({ x: 100, y: 900 }, { x: -200, y: 100 }), displays);
  assert.deepEqual(plan.bounds, { x: -200, y: 100, width: 300, height: 800 });
  assert.deepEqual(plan.tiles.map(({ displayId, source, destination }) => ({ displayId, source, destination })), [
    { displayId: "left", source: { x: 1720, y: 100, width: 200, height: 800 }, destination: { x: 0, y: 0, width: 200, height: 800 } },
    { displayId: "right", source: { x: 0, y: 100, width: 100, height: 800 }, destination: { x: 200, y: 0, width: 100, height: 800 } },
  ]);
  assert.equal(plan.crossesDisplays, true);
});

test("selection through a gap leaves an uncovered transparent area", () => {
  const plan = planCaptureSelection({ x: 90, y: 0, width: 130, height: 50 }, [
    { id: "a", physicalBounds: { x: 0, y: 0, width: 100, height: 100 }, imageWidth: 100, imageHeight: 100 },
    { id: "b", physicalBounds: { x: 200, y: 0, width: 100, height: 100 }, imageWidth: 100, imageHeight: 100 },
  ]);
  assert.deepEqual(plan.tiles.map(({ destination }) => destination), [
    { x: 0, y: 0, width: 10, height: 50 },
    { x: 110, y: 0, width: 20, height: 50 },
  ]);
});

test("invalid and excessive selections are rejected before canvas allocation", () => {
  assert.throws(() => planCaptureSelection({ x: 0, y: 0, width: 40000, height: 50 }, [
    { id: "a", physicalBounds: { x: 0, y: 0, width: 50000, height: 500 }, imageWidth: 50000, imageHeight: 500 },
  ]), /too large/);
  assert.throws(() => rectFromPoints({ x: NaN, y: 0 }, { x: 2, y: 4 }), /Invalid/);
});
