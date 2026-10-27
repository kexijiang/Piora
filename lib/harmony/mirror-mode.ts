/** The complete workbench is available by default; deployments may explicitly restrict tools. */
export function harmonyWorkbenchEnabled(): boolean {
  return process.env.PIORA_HARMONY_WORKBENCH !== "0";
}

const mirrorRoutes = new Set(["profile", "devices", "state", "events", "config", "runtime-candidates", "frame", "video", "geometry", "media", "media/preview", "manual", "action"]);
const mirrorActions = new Set(["tap", "double_tap", "long_press", "swipe", "drag", "input_text", "press_key", "key_hold", "stop_device"]);
export function mirrorRouteAllowed(pathname: string): boolean {
  const path = pathname.replace(/^\/api\/harmony\/?/, "").replace(/\/$/, "");
  return mirrorRoutes.has(path);
}
export function mirrorActionAllowed(action: unknown): boolean {
  return typeof action === "string" && mirrorActions.has(action);
}
