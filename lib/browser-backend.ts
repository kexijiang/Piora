export type BrowserBackendKind = "desktop" | "playwright";

export function selectBrowserBackend(input: { desktopIpc: boolean; mode: "builtin" | "background" | string }): BrowserBackendKind {
  return input.desktopIpc && input.mode === "builtin" ? "desktop" : "playwright";
}
