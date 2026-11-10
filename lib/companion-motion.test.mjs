import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

function loadTypeScriptModule(relativePath) {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  const output = ts.transpileModule(fs.readFileSync(absolutePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: absolutePath,
  }).outputText;
  const loadedModule = { exports: {} };
  Function("module", "exports", "require", output)(loadedModule, loadedModule.exports, () => ({}));
  return loadedModule.exports;
}

const motion = loadTypeScriptModule("desktop/src/companion-motion.ts");

test("motion planning rejects invalid work areas and nonfinite durations", () => {
  const bounds = { x: 0, y: 0, width: 156, height: 184 };
  const area = { x: 0, y: 0, width: 1920, height: 1080 };
  const request = { distance: 100, durationMs: 1000 };
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.equal(motion.planCompanionMotion(bounds, { ...area, y: value }, request), null);
    assert.equal(motion.planCompanionMotion(bounds, area, { ...request, durationMs: value }), null);
    assert.equal(motion.planCompanionMotion(bounds, area, { ...request, distance: value }), null);
  }
});

test("companion walking chooses available space and stays inside the work area", () => {
  const area = { x: 0, y: 0, width: 1000, height: 700 };
  const middle = { x: 400, y: 400, width: 156, height: 184 };
  assert.deepEqual(motion.planCompanionWalk(middle, area, 120, 2_000, "right"), {
    direction: "right",
    startX: 400,
    targetX: 520,
    distance: 120,
    durationMs: 2_000,
  });

  const atRightEdge = { ...middle, x: 844 };
  const reversed = motion.planCompanionWalk(atRightEdge, area, 200, 2_000, "right");
  assert.equal(reversed.direction, "left");
  assert.equal(reversed.targetX, 644);
  assert.equal(motion.companionMotionX(reversed, 0), 844);
  assert.equal(motion.companionMotionX(reversed, 2_000), 644);
});

test("companion motion supports vertical and diagonal routes", () => {
  const area = { x: 0, y: 0, width: 1000, height: 700 };
  const middle = { x: 400, y: 400, width: 156, height: 184 };
  const vertical = motion.planCompanionMotion(middle, area, {
    pattern: "line",
    angleRadians: -Math.PI / 2,
    distance: 120,
    durationMs: 2_000,
  });
  assert.equal(vertical.targetX, 400);
  assert.equal(vertical.targetY, 280);
  assert.deepEqual(motion.companionMotionPoint(vertical, 1_000), { x: 400, y: 340 });

  const diagonal = motion.planCompanionMotion(middle, area, {
    pattern: "line",
    angleRadians: Math.PI / 4,
    distance: 120,
    durationMs: 2_000,
  });
  const diagonalEnd = motion.companionMotionPoint(diagonal, 2_000);
  assert.ok(diagonalEnd.x > middle.x);
  assert.ok(diagonalEnd.y > middle.y);
  assert.ok(Math.abs((diagonalEnd.x - middle.x) - (diagonalEnd.y - middle.y)) <= 1);
});

test("curved and orbiting routes stay inside the monitor and use both axes", () => {
  const area = { x: 0, y: 0, width: 1000, height: 700 };
  const middle = { x: 400, y: 360, width: 156, height: 184 };
  const arc = motion.planCompanionMotion(middle, area, {
    pattern: "arc",
    angleRadians: -Math.PI / 4,
    curvature: 0.62,
    distance: 180,
    durationMs: 2_400,
  });
  assert.equal(arc.pattern, "arc");
  assert.notEqual(arc.controlX, undefined);
  assert.notEqual(arc.controlY, undefined);

  const bottom = { ...middle, y: area.height - middle.height };
  const orbit = motion.planCompanionMotion(bottom, area, {
    pattern: "orbit",
    clockwise: true,
    distance: 180,
    durationMs: 4_000,
  });
  assert.equal(orbit.pattern, "orbit");
  assert.deepEqual(motion.companionMotionPoint(orbit, 0), { x: bottom.x, y: bottom.y });
  assert.deepEqual(motion.companionMotionPoint(orbit, 4_000), { x: bottom.x, y: bottom.y });

  const arcPoints = [];
  const orbitPoints = [];
  for (let elapsed = 0; elapsed <= 4_000; elapsed += 200) {
    if (elapsed <= arc.durationMs) arcPoints.push(motion.companionMotionPoint(arc, elapsed));
    orbitPoints.push(motion.companionMotionPoint(orbit, elapsed));
  }
  for (const point of [...arcPoints, ...orbitPoints]) {
    assert.ok(point.x >= area.x && point.x <= area.width - middle.width);
    assert.ok(point.y >= area.y && point.y <= area.height - middle.height);
  }
  assert.ok(new Set(orbitPoints.map((point) => point.x)).size > 4);
  assert.ok(new Set(orbitPoints.map((point) => point.y)).size > 4);
  assert.ok(new Set(arcPoints.map((point) => point.x)).size > 4);
  assert.ok(new Set(arcPoints.map((point) => point.y)).size > 4);

  const edgeArc = motion.planCompanionMotion(bottom, area, {
    pattern: "arc",
    angleRadians: Math.PI / 6,
    curvature: 0.62,
    distance: 180,
    durationMs: 2_400,
  });
  assert.ok(motion.companionMotionPoint(edgeArc, 1_200).y < bottom.y);
});

test("orbiting sprite changes facing direction as the route turns", () => {
  const area = { x: 0, y: 0, width: 1000, height: 700 };
  const bottom = { x: 400, y: 516, width: 156, height: 184 };
  const orbit = motion.planCompanionMotion(bottom, area, {
    pattern: "orbit",
    clockwise: true,
    distance: 180,
    durationMs: 4_000,
  });
  const directions = new Set([
    motion.companionFacingDirection(orbit, 800),
    motion.companionFacingDirection(orbit, 2_000),
    motion.companionFacingDirection(orbit, 3_200),
  ]);
  assert.deepEqual([...directions].sort(), ["left", "right"]);
});

test("companion dragging is clamped to the monitor work area", () => {
  const area = { x: -1000, y: 0, width: 1000, height: 800 };
  const start = { x: -300, y: 500, width: 156, height: 184 };
  assert.deepEqual(
    motion.dragCompanionBounds(start, { x: 10, y: 10 }, { x: 2000, y: 2000 }, area),
    { x: -156, y: 616, width: 156, height: 184 },
  );
  assert.deepEqual(
    motion.dragCompanionBounds(start, { x: 10, y: 10 }, { x: -2000, y: -2000 }, area),
    { x: -1000, y: 0, width: 156, height: 184 },
  );
});

test("walking progress eases deterministically without overshooting", () => {
  assert.equal(motion.companionMotionProgress(-10, 1_000), 0);
  assert.equal(motion.companionMotionProgress(500, 1_000), 0.5);
  assert.equal(motion.companionMotionProgress(2_000, 1_000), 1);
});
