import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createJiti } from "jiti";

const { guardCompanionWindow, sanitizeCompanionHitRegion } = await createJiti(import.meta.url).import("../desktop/src/companion-window-guard.ts");
const size = { width: 156, height: 184 };
function fixture(t) {
  let time = 1000;
  let bounds = { x: 100, y: 100, ...size };
  let area = { x: 0, y: 0, width: 1920, height: 1040 };
  let cursor = { x: 120, y: 120 };
  const calls = [];
  const window = Object.assign(new EventEmitter(), {
    webContents: new EventEmitter(), isDestroyed: () => false, isVisible: () => true,
    getBounds: () => ({ ...bounds }), setBounds: (next) => { bounds = next; },
    setPosition: (x, y) => { bounds = { ...bounds, x, y }; },
    setIgnoreMouseEvents: (...args) => calls.push(args),
  });
  const guard = guardCompanionWindow(window, {
    getDisplayNearestPoint: () => ({ workArea: area }), getCursorScreenPoint: () => cursor,
  }, size, () => time);
  t.after(() => window.emit("closed"));
  return { guard, window, calls, bounds: () => bounds, move: (point) => { cursor = point; },
    advance: (ms) => { time += ms; }, nativeBounds: (next) => { bounds = next; }, display: (next) => { area = next; } };
}

test("hit testing uses bounded local coordinates and fails open after missing heartbeats", (t) => {
  const f = fixture(t);
  f.guard.updateHitRegion({ x: 10, y: 10, width: 40, height: 40 });
  assert.deepEqual(f.calls.at(-1), [false]);
  for (let n = 0; n < 1000; n++) f.guard.sync();
  assert.equal(f.calls.length, 2, "stable hit regions must not reinstall native hooks");
  f.move({ x: 190, y: 190 }); f.guard.sync();
  assert.deepEqual(f.calls.at(-1), [true]);
  f.guard.setDragging(true);
  assert.deepEqual(f.calls.at(-1), [false]);
  f.advance(1600); f.guard.updateHitRegion({ x: 10, y: 10, width: 40, height: 40 });
  assert.deepEqual(f.calls.at(-1), [true], "lost drag-end cannot retain whole-window input");
  f.move({ x: 120, y: 120 }); f.guard.sync();
  assert.deepEqual(f.calls.at(-1), [false]);
  f.advance(1600); f.guard.sync();
  assert.deepEqual(f.calls.at(-1), [true]);
  f.guard.updateHitRegion({ x: 10, y: 10, width: 40, height: 40 });
  f.window.webContents.emit("render-process-gone");
  assert.deepEqual(f.calls.at(-1), [true]);
});

test("repeated size drift and removed or negative-coordinate monitors keep the fixed pet visible", (t) => {
  const f = fixture(t);
  for (let n = 0; n < 2000; n++) {
    const area = n % 2 ? { x: -1280, y: -200, width: 1280, height: 984 } : { x: 0, y: 0, width: 1920, height: 1040 };
    f.display(area);
    f.nativeBounds({ x: 5000, y: -5000, width: 3840, height: 2160 });
    f.guard.sync();
    const b = f.bounds();
    assert.equal(b.width, size.width); assert.equal(b.height, size.height);
    assert.ok(b.x >= area.x && b.x + b.width <= area.x + area.width);
    assert.ok(b.y >= area.y && b.y + b.height <= area.y + area.height);
  }
  f.guard.place({ x: -99999, y: 99999 });
  assert.deepEqual(f.bounds(), { x: -1280, y: 600, ...size });
});

test("malformed and oversized renderer rectangles never enlarge the native input window", () => {
  for (const input of [null, true, {}, { x: NaN, y: 0, width: 50, height: 50 }, { x: 200, y: 0, width: 10, height: 10 }]) {
    assert.equal(sanitizeCompanionHitRegion(input, size), null);
  }
  assert.deepEqual(sanitizeCompanionHitRegion({ x: -1000, y: -1000, width: 10000, height: 10000 }, size), { x: 0, y: 0, ...size });
});
