export interface MirrorPoint { x: number; y: number }
/** Contain/letterbox mapping. A click in the black border is not a phone tap. */
export function mirrorPoint(clientX: number, clientY: number, bounds: { left: number; top: number; width: number; height: number }, frame: { width: number; height: number }): MirrorPoint | undefined {
  if (bounds.width <= 0 || bounds.height <= 0 || frame.width <= 0 || frame.height <= 0) return;
  const scale = Math.min(bounds.width / frame.width, bounds.height / frame.height);
  const x = (clientX - bounds.left - (bounds.width - frame.width * scale) / 2) / scale;
  const y = (clientY - bounds.top - (bounds.height - frame.height * scale) / 2) / scale;
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return;
  return { x: Math.floor(x), y: Math.floor(y) };
}
