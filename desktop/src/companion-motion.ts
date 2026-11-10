export type CompanionMotionDirection = "left" | "right";
export type CompanionMotionPattern = "line" | "arc" | "orbit";

export interface CompanionMotionRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompanionWalkPlan {
  direction: CompanionMotionDirection;
  startX: number;
  targetX: number;
  distance: number;
  durationMs: number;
}

export interface CompanionMotionPoint {
  x: number;
  y: number;
}

/** Electron's native window/screen bindings require signed 32-bit integers. */
export function nativeCompanionPoint(point: CompanionMotionPoint): CompanionMotionPoint | null {
  const { x, y } = point;
  if (![x, y].every(value => Number.isFinite(value) && value >= -2147483648 && value <= 2147483647)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

export function validCompanionRectangle(rect: CompanionMotionRectangle): boolean {
  return nativeCompanionPoint(rect) !== null
    && [rect.width, rect.height].every(value => Number.isFinite(value) && value >= 1 && value <= 2147483647)
    && nativeCompanionPoint({ x: rect.x + rect.width, y: rect.y + rect.height }) !== null;
}

export interface CompanionMotionPlan {
  pattern: CompanionMotionPattern;
  direction: CompanionMotionDirection;
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  distance: number;
  durationMs: number;
  controlX?: number;
  controlY?: number;
  centerX?: number;
  centerY?: number;
  radiusX?: number;
  radiusY?: number;
  startAngle?: number;
  sweep?: number;
}

export interface CompanionMotionRequest {
  distance: number;
  durationMs: number;
  pattern?: CompanionMotionPattern;
  angleRadians?: number;
  curvature?: number;
  clockwise?: boolean;
  direction?: CompanionMotionDirection;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function allowedPositionRange(
  bounds: CompanionMotionRectangle,
  workArea: CompanionMotionRectangle,
): { minimumX: number; maximumX: number; minimumY: number; maximumY: number } {
  return {
    minimumX: workArea.x,
    maximumX: workArea.x + Math.max(0, workArea.width - bounds.width),
    minimumY: workArea.y,
    maximumY: workArea.y + Math.max(0, workArea.height - bounds.height),
  };
}

export function clampCompanionBounds(
  bounds: CompanionMotionRectangle,
  workArea: CompanionMotionRectangle,
): CompanionMotionRectangle {
  const maximumX = workArea.x + Math.max(0, workArea.width - bounds.width);
  const maximumY = workArea.y + Math.max(0, workArea.height - bounds.height);
  return {
    ...bounds,
    x: Math.round(clamp(bounds.x, workArea.x, maximumX)),
    y: Math.round(clamp(bounds.y, workArea.y, maximumY)),
  };
}

function lineTarget(
  start: CompanionMotionPoint,
  angleRadians: number,
  distance: number,
  range: ReturnType<typeof allowedPositionRange>,
): CompanionMotionPoint {
  return {
    x: clamp(start.x + Math.cos(angleRadians) * distance, range.minimumX, range.maximumX),
    y: clamp(start.y + Math.sin(angleRadians) * distance, range.minimumY, range.maximumY),
  };
}

function pointDistance(first: CompanionMotionPoint, second: CompanionMotionPoint): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function bestAvailableTarget(
  start: CompanionMotionPoint,
  angleRadians: number,
  distance: number,
  range: ReturnType<typeof allowedPositionRange>,
): { target: CompanionMotionPoint; angleRadians: number } | null {
  const angles = [
    angleRadians,
    angleRadians + Math.PI,
    0,
    Math.PI / 2,
    Math.PI,
    Math.PI * 1.5,
  ];
  let best: { target: CompanionMotionPoint; angleRadians: number; distance: number } | null = null;
  for (const angle of angles) {
    const target = lineTarget(start, angle, distance, range);
    const travelled = pointDistance(start, target);
    if (!best || travelled > best.distance) best = { target, angleRadians: angle, distance: travelled };
    if (travelled >= Math.min(distance * 0.72, 36)) return { target, angleRadians: angle };
  }
  return best && best.distance >= 12
    ? { target: best.target, angleRadians: best.angleRadians }
    : null;
}

function planCompanionOrbit(
  start: CompanionMotionPoint,
  range: ReturnType<typeof allowedPositionRange>,
  requestedDistance: number,
  durationMs: number,
  clockwise: boolean,
  fallbackDirection: CompanionMotionDirection,
): CompanionMotionPlan | null {
  const verticalRatio = 0.72;
  const horizontalSpace = Math.min(start.x - range.minimumX, range.maximumX - start.x);
  const verticalSpace = Math.min(start.y - range.minimumY, range.maximumY - start.y);
  const candidates = [
    {
      startAngle: Math.PI,
      maximumRadius: Math.min((range.maximumX - start.x) / 2, verticalSpace / verticalRatio),
    },
    {
      startAngle: 0,
      maximumRadius: Math.min((start.x - range.minimumX) / 2, verticalSpace / verticalRatio),
    },
    {
      startAngle: -Math.PI / 2,
      maximumRadius: Math.min(horizontalSpace, (range.maximumY - start.y) / (2 * verticalRatio)),
    },
    {
      startAngle: Math.PI / 2,
      maximumRadius: Math.min(horizontalSpace, (start.y - range.minimumY) / (2 * verticalRatio)),
    },
  ].sort((first, second) => second.maximumRadius - first.maximumRadius);
  const candidate = candidates[0]!;
  const radiusX = Math.min(clamp(requestedDistance * 0.32, 24, 92), candidate.maximumRadius);
  if (!Number.isFinite(radiusX) || radiusX < 14) return null;
  const radiusY = radiusX * verticalRatio;
  const startAngle = candidate.startAngle;
  const centerX = start.x - Math.cos(startAngle) * radiusX;
  const centerY = start.y - Math.sin(startAngle) * radiusY;
  const sweep = (clockwise ? 1 : -1) * Math.PI * 2;
  const initialHorizontalVelocity = -Math.sin(startAngle) * sweep * radiusX;
  const direction = Math.abs(initialHorizontalVelocity) > 0.01
    ? initialHorizontalVelocity < 0 ? "left" : "right"
    : fallbackDirection;
  return {
    pattern: "orbit",
    direction,
    startX: start.x,
    startY: start.y,
    targetX: start.x,
    targetY: start.y,
    distance: Math.round(requestedDistance),
    durationMs,
    centerX,
    centerY,
    radiusX,
    radiusY,
    startAngle,
    sweep,
  };
}

export function planCompanionMotion(
  bounds: CompanionMotionRectangle,
  workArea: CompanionMotionRectangle,
  request: CompanionMotionRequest,
): CompanionMotionPlan | null {
  if (!validCompanionRectangle(bounds) || !validCompanionRectangle(workArea)
    || !Number.isFinite(request.distance) || !Number.isFinite(request.durationMs)) return null;
  const clampedBounds = clampCompanionBounds(bounds, workArea);
  const range = allowedPositionRange(clampedBounds, workArea);
  const start = { x: clampedBounds.x, y: clampedBounds.y };
  const distance = clamp(request.distance, 24, 360);
  const durationMs = Math.round(clamp(request.durationMs, 500, 8_000));
  const preferredAngle = Number.isFinite(request.angleRadians)
    ? Number(request.angleRadians)
    : request.direction === "left"
      ? Math.PI
      : 0;
  const fallbackDirection = request.direction
    ?? (Math.cos(preferredAngle) < 0 ? "left" : "right");
  const requestedPattern = request.pattern ?? "line";

  if (requestedPattern === "orbit") {
    const orbit = planCompanionOrbit(
      start,
      range,
      distance,
      durationMs,
      request.clockwise !== false,
      fallbackDirection,
    );
    if (orbit) return orbit;
  }

  const available = bestAvailableTarget(start, preferredAngle, distance, range);
  if (!available) return null;
  const target = available.target;
  const deltaX = target.x - start.x;
  const direction = Math.abs(deltaX) >= 1
    ? deltaX < 0 ? "left" : "right"
    : fallbackDirection;
  const pattern: CompanionMotionPattern = requestedPattern === "line" ? "line" : "arc";
  const plan: CompanionMotionPlan = {
    pattern,
    direction,
    startX: start.x,
    startY: start.y,
    targetX: target.x,
    targetY: target.y,
    distance: Math.round(pointDistance(start, target)),
    durationMs,
  };
  if (pattern === "arc") {
    const curvature = clamp(Number.isFinite(request.curvature) ? Number(request.curvature) : 0.42, -0.8, 0.8);
    const travelled = pointDistance(start, target);
    const perpendicularX = travelled > 0 ? -(target.y - start.y) / travelled : 0;
    const perpendicularY = travelled > 0 ? (target.x - start.x) / travelled : 0;
    const midpointX = (start.x + target.x) / 2;
    const midpointY = (start.y + target.y) / 2;
    const controlPoint = (bend: number) => ({
      x: clamp(midpointX + perpendicularX * travelled * bend, range.minimumX, range.maximumX),
      y: clamp(midpointY + perpendicularY * travelled * bend, range.minimumY, range.maximumY),
    });
    const preferredControl = controlPoint(curvature);
    const alternateControl = controlPoint(-curvature);
    const bendDistance = (point: CompanionMotionPoint) => Math.abs(
      (point.x - midpointX) * perpendicularX + (point.y - midpointY) * perpendicularY,
    );
    const control = bendDistance(alternateControl) > bendDistance(preferredControl)
      ? alternateControl
      : preferredControl;
    plan.controlX = control.x;
    plan.controlY = control.y;
  }
  return plan;
}

export function planCompanionWalk(
  bounds: CompanionMotionRectangle,
  workArea: CompanionMotionRectangle,
  requestedDistance: number,
  requestedDurationMs: number,
  preferredDirection?: CompanionMotionDirection,
): CompanionWalkPlan | null {
  const availableLeft = Math.max(0, bounds.x - workArea.x);
  const availableRight = Math.max(0, workArea.x + workArea.width - (bounds.x + bounds.width));
  const direction = preferredDirection === "left" && availableLeft >= 12
    ? "left"
    : preferredDirection === "right" && availableRight >= 12
      ? "right"
      : availableRight >= availableLeft
        ? "right"
        : "left";
  const available = direction === "right" ? availableRight : availableLeft;
  const distance = Math.round(Math.min(clamp(requestedDistance, 24, 360), available));
  if (distance < 12) return null;
  const targetX = bounds.x + (direction === "right" ? distance : -distance);
  return {
    direction,
    startX: bounds.x,
    targetX,
    distance,
    durationMs: Math.round(clamp(requestedDurationMs, 500, 8_000)),
  };
}

export function companionMotionProgress(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1;
  const progress = clamp(elapsedMs / durationMs, 0, 1);
  // A short ease-in/out keeps the OS window from snapping at either end while
  // retaining an almost constant walking speed through the middle.
  return progress * progress * (3 - 2 * progress);
}

export function companionMotionX(plan: CompanionWalkPlan, elapsedMs: number): number {
  const progress = companionMotionProgress(elapsedMs, plan.durationMs);
  return Math.round(plan.startX + (plan.targetX - plan.startX) * progress);
}

function companionMotionPointAtProgress(plan: CompanionMotionPlan, progress: number): CompanionMotionPoint {
  if (
    plan.pattern === "orbit"
    && plan.centerX !== undefined
    && plan.centerY !== undefined
    && plan.radiusX !== undefined
    && plan.radiusY !== undefined
    && plan.startAngle !== undefined
    && plan.sweep !== undefined
  ) {
    const angle = plan.startAngle + plan.sweep * progress;
    return {
      x: plan.centerX + Math.cos(angle) * plan.radiusX,
      y: plan.centerY + Math.sin(angle) * plan.radiusY,
    };
  }
  if (plan.pattern === "arc" && plan.controlX !== undefined && plan.controlY !== undefined) {
    const remaining = 1 - progress;
    return {
      x: remaining * remaining * plan.startX + 2 * remaining * progress * plan.controlX + progress * progress * plan.targetX,
      y: remaining * remaining * plan.startY + 2 * remaining * progress * plan.controlY + progress * progress * plan.targetY,
    };
  }
  return {
    x: plan.startX + (plan.targetX - plan.startX) * progress,
    y: plan.startY + (plan.targetY - plan.startY) * progress,
  };
}

export function companionMotionPoint(plan: CompanionMotionPlan, elapsedMs: number): CompanionMotionPoint {
  const progress = companionMotionProgress(elapsedMs, plan.durationMs);
  const point = companionMotionPointAtProgress(plan, progress);
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

export function companionFacingDirection(
  plan: CompanionMotionPlan,
  elapsedMs: number,
  previousDirection: CompanionMotionDirection = plan.direction,
): CompanionMotionDirection {
  const beforeProgress = companionMotionProgress(Math.max(0, elapsedMs - 20), plan.durationMs);
  const afterProgress = companionMotionProgress(Math.min(plan.durationMs, elapsedMs + 20), plan.durationMs);
  const before = companionMotionPointAtProgress(plan, beforeProgress);
  const after = companionMotionPointAtProgress(plan, afterProgress);
  const deltaX = after.x - before.x;
  if (Math.abs(deltaX) < 0.05) return previousDirection;
  return deltaX < 0 ? "left" : "right";
}

export function dragCompanionBounds(
  startingBounds: CompanionMotionRectangle,
  pointerStart: { x: number; y: number },
  pointerCurrent: { x: number; y: number },
  workArea: CompanionMotionRectangle,
): CompanionMotionRectangle {
  return clampCompanionBounds({
    ...startingBounds,
    x: startingBounds.x + pointerCurrent.x - pointerStart.x,
    y: startingBounds.y + pointerCurrent.y - pointerStart.y,
  }, workArea);
}
