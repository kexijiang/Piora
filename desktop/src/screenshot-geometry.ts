/** Geometry for a Windows virtual desktop. All rectangles here use physical pixels. */
export interface CapturePoint { x: number; y: number }
export interface CaptureRect extends CapturePoint { width: number; height: number }

export interface CaptureDisplay {
  id: string;
  physicalBounds: CaptureRect;
  imageWidth: number;
  imageHeight: number;
}

export interface CaptureTile {
  displayId: string;
  /** Source rectangle in the display's captured bitmap. */
  source: CaptureRect;
  /** Destination rectangle relative to the requested output bitmap. */
  destination: CaptureRect;
}

export interface CapturePlan {
  bounds: CaptureRect;
  tiles: CaptureTile[];
  crossesDisplays: boolean;
}

const MAX_CAPTURE_PIXELS = 100_000_000;
const MAX_CAPTURE_SIDE = 32_768;

function isFiniteRect(rect: CaptureRect): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0;
}

export function rectFromPoints(first: CapturePoint, second: CapturePoint): CaptureRect {
  if (![first.x, first.y, second.x, second.y].every(Number.isFinite)) {
    throw new Error("Invalid screenshot coordinates");
  }
  const x = Math.floor(Math.min(first.x, second.x));
  const y = Math.floor(Math.min(first.y, second.y));
  return {
    x,
    y,
    width: Math.ceil(Math.max(first.x, second.x)) - x,
    height: Math.ceil(Math.max(first.y, second.y)) - y,
  };
}

export function intersectCaptureRects(a: CaptureRect, b: CaptureRect): CaptureRect | null {
  if (!isFiniteRect(a) || !isFiniteRect(b)) return null;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

function bitmapRect(intersection: CaptureRect, display: CaptureDisplay): CaptureRect {
  const { physicalBounds, imageWidth, imageHeight } = display;
  const scaleX = imageWidth / physicalBounds.width;
  const scaleY = imageHeight / physicalBounds.height;
  const left = Math.max(0, Math.floor((intersection.x - physicalBounds.x) * scaleX));
  const top = Math.max(0, Math.floor((intersection.y - physicalBounds.y) * scaleY));
  const right = Math.min(imageWidth, Math.ceil((intersection.x + intersection.width - physicalBounds.x) * scaleX));
  const bottom = Math.min(imageHeight, Math.ceil((intersection.y + intersection.height - physicalBounds.y) * scaleY));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function planCaptureSelection(bounds: CaptureRect, displays: readonly CaptureDisplay[]): CapturePlan {
  if (!isFiniteRect(bounds) || !displays.length) throw new Error("Empty screenshot selection");
  if (bounds.width > MAX_CAPTURE_SIDE || bounds.height > MAX_CAPTURE_SIDE
    || bounds.width * bounds.height > MAX_CAPTURE_PIXELS) {
    throw new Error("Screenshot selection is too large");
  }
  const tiles: CaptureTile[] = [];
  for (const display of displays) {
    if (!isFiniteRect(display.physicalBounds)
      || !Number.isSafeInteger(display.imageWidth) || !Number.isSafeInteger(display.imageHeight)
      || display.imageWidth < 1 || display.imageHeight < 1) {
      throw new Error("Invalid screenshot display geometry");
    }
    const intersection = intersectCaptureRects(bounds, display.physicalBounds);
    if (!intersection) continue;
    const source = bitmapRect(intersection, display);
    if (source.width < 1 || source.height < 1) throw new Error("Display image is too small for the selection");
    tiles.push({
      displayId: display.id,
      source,
      destination: {
        x: intersection.x - bounds.x,
        y: intersection.y - bounds.y,
        width: intersection.width,
        height: intersection.height,
      },
    });
  }
  if (!tiles.length) throw new Error("Screenshot selection is outside the displays");
  return { bounds, tiles, crossesDisplays: tiles.length > 1 };
}
