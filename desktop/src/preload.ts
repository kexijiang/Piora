import { contextBridge, ipcRenderer } from "electron";

const runtime = Object.freeze({
  platform: process.platform,
  versions: Object.freeze({
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  }),
  notifyCompletion(taskTitle?: string, sessionId?: string): Promise<boolean> {
    return ipcRenderer.invoke("pi:completion-notification", { taskTitle, sessionId }) as Promise<boolean>;
  },
  notifyAutomation(taskTitle: string, status: "succeeded" | "failed" | "interrupted", sessionId?: string): Promise<boolean> {
    return ipcRenderer.invoke("pi:completion-notification", { taskTitle, status, sessionId }) as Promise<boolean>;
  },
  notifyUserInput(taskTitle?: string, sessionId?: string): Promise<boolean> {
    return ipcRenderer.invoke("pi:completion-notification", { taskTitle, kind: "user-input", sessionId }) as Promise<boolean>;
  },
  onNotificationSession(listener: (sessionId: string) => void) {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: unknown) => {
      if (typeof sessionId !== "string" || !sessionId || sessionId.length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(sessionId)) return;
      listener(sessionId);
    };
    ipcRenderer.on("pi:notification-session", handler);
    return () => ipcRenderer.removeListener("pi:notification-session", handler);
  },
  openMenu(menu: "file" | "edit" | "view" | "help", x: number, y: number): Promise<boolean> {
    return ipcRenderer.invoke("pi:open-application-menu", menu, x, y) as Promise<boolean>;
  },
  getUpdateState() {
    return ipcRenderer.invoke("pi:update-state-get");
  },
  checkForUpdates() {
    return ipcRenderer.invoke("pi:update-check");
  },
  downloadUpdate() {
    return ipcRenderer.invoke("pi:update-download");
  },
  installUpdate() {
    return ipcRenderer.invoke("pi:update-install");
  },
  onUpdateState(listener: (state: unknown) => void) {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on("pi:update-state", handler);
    return () => ipcRenderer.removeListener("pi:update-state", handler);
  },
  revealPath(filePath: string): Promise<boolean> {
    return ipcRenderer.invoke("pi:reveal-path", filePath) as Promise<boolean>;
  },
  openPath(filePath: string): Promise<boolean> {
    return ipcRenderer.invoke("pi:open-path", filePath) as Promise<boolean>;
  },
  clipboard: Object.freeze({
    readText: (): Promise<string> => ipcRenderer.invoke("pi:clipboard-read", false),
    writeText: (text: string): Promise<void> => ipcRenderer.invoke("pi:clipboard-write", text, false),
    readImage: (): Promise<string | null> => ipcRenderer.invoke("pi:clipboard-read", true),
    writeImage: (data: string): Promise<void> => ipcRenderer.invoke("pi:clipboard-write", data, true),
  }),
  launcher: Object.freeze({
    list: (refresh = false) => ipcRenderer.invoke("pi:launcher-list", refresh),
    open: (id: string): Promise<void> => ipcRenderer.invoke("pi:launcher-open", id),
  }),
  selectDirectory(): Promise<string | null> {
    return ipcRenderer.invoke("pi:directory-picker") as Promise<string | null>;
  },
  selectSpeechPackDirectory(defaultPath?: string): Promise<string | null> {
    return ipcRenderer.invoke("pi:speech-pack-directory-picker", defaultPath) as Promise<string | null>;
  },
  getAgentDataDirectory() {
    return ipcRenderer.invoke("pi:agent-data-directory-get");
  },
  selectAgentDataDirectory(defaultPath?: string): Promise<string | null> {
    return ipcRenderer.invoke("pi:agent-data-directory-picker", defaultPath) as Promise<string | null>;
  },
  applyAgentDataDirectory(input: { directory: string; migrate: boolean }) {
    return ipcRenderer.invoke("pi:agent-data-directory-apply", input);
  },
  setCompanionWindowVisible(visible: boolean): Promise<boolean> {
    return ipcRenderer.invoke("pi:companion-window-visible", visible) as Promise<boolean>;
  },
  setCompanionWindowAlwaysOnTop(alwaysOnTop: boolean): Promise<boolean> {
    return ipcRenderer.invoke("pi:companion-window-always-on-top", alwaysOnTop) as Promise<boolean>;
  },
  setCompanionWindowExpanded(expanded: boolean): Promise<boolean> {
    return ipcRenderer.invoke("pi:companion-window-expanded", expanded) as Promise<boolean>;
  },
  moveCompanionWindow(input: {
    kind: "walk" | "stop" | "drag-start" | "drag-move" | "drag-end";
    direction?: "left" | "right";
    pattern?: "line" | "arc" | "orbit";
    angleRadians?: number;
    curvature?: number;
    clockwise?: boolean;
    distance?: number;
    durationMs?: number;
    screenX?: number;
    screenY?: number;
  }): Promise<{ ok: boolean; direction?: "left" | "right"; durationMs?: number }> {
    return ipcRenderer.invoke("pi:companion-window-motion", input) as Promise<{
      ok: boolean;
      direction?: "left" | "right";
      durationMs?: number;
    }>;
  },
  onCompanionMotion(listener: (state: { moving: boolean; direction: "left" | "right" | null }) => void) {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (!state || typeof state !== "object") return;
      const candidate = state as { moving?: unknown; direction?: unknown };
      if (typeof candidate.moving !== "boolean") return;
      if (candidate.direction !== null && candidate.direction !== "left" && candidate.direction !== "right") return;
      listener({ moving: candidate.moving, direction: candidate.direction });
    };
    ipcRenderer.on("pi:companion-motion-state", handler);
    return () => ipcRenderer.removeListener("pi:companion-motion-state", handler);
  },
  setCompanionHitTest(interactive: boolean): Promise<boolean> {
    return ipcRenderer.invoke("pi:companion-hit-test", interactive) as Promise<boolean>;
  },
  companionAction(action: "focus-main" | "open-settings" | "open-panel" | "hide"): Promise<boolean> {
    return ipcRenderer.invoke("pi:companion-window-action", action) as Promise<boolean>;
  },
  getAutoLaunchState() {
    return ipcRenderer.invoke("pi:auto-launch-get");
  },
  setAutoLaunchEnabled(enabled: boolean) {
    return ipcRenderer.invoke("pi:auto-launch-set", enabled);
  },
  setGlobalShortcut(enabled: boolean): Promise<boolean> {
    return ipcRenderer.invoke("pi:set-global-shortcut", enabled) as Promise<boolean>;
  },
  setNetworkProxy(settings: { mode: "system" | "manual" | "direct"; proxyUrl: string; bypass: string }): Promise<boolean> {
    return ipcRenderer.invoke("pi:set-network-proxy", settings) as Promise<boolean>;
  },
  selectHarmonyRuntimePath(kind: "sdk" | "hdc"): Promise<string | null> {
    return ipcRenderer.invoke("pi:harmony-runtime-picker", kind) as Promise<string | null>;
  },
  browser: Object.freeze({
    getState() {
      return ipcRenderer.invoke("pi:browser-get-state");
    },
    action(input: unknown) {
      return ipcRenderer.invoke("pi:browser-action", input);
    },
    setViewport(bounds: { x: number; y: number; width: number; height: number }, visible: boolean) {
      return ipcRenderer.invoke("pi:browser-viewport", bounds, visible) as Promise<boolean>;
    },
    importChromeBookmarks() {
      return ipcRenderer.invoke("pi:browser-import-chrome-bookmarks");
    },
    onState(listener: (state: unknown) => void) {
      const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
      ipcRenderer.on("pi:browser-state", handler);
      return () => ipcRenderer.removeListener("pi:browser-state", handler);
    },
    onDownload(listener: (download: unknown) => void) {
      const handler = (_event: Electron.IpcRendererEvent, download: unknown) => listener(download);
      ipcRenderer.on("pi:browser-download", handler);
      return () => ipcRenderer.removeListener("pi:browser-download", handler);
    },
  }),
  onMenuAction(listener: (action: string) => void) {
    const handler = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action === "string") listener(action);
    };
    ipcRenderer.on("pi:menu-action", handler);
    return () => ipcRenderer.removeListener("pi:menu-action", handler);
  },
  setKeyboardShortcuts(bindings: Record<string, string | null>): Promise<boolean> {
    return ipcRenderer.invoke("pi:set-keyboard-shortcuts", bindings) as Promise<boolean>;
  },
});

// Keep the bridge intentionally small. Pi, filesystem, process execution, and
// credentials remain exclusively in the standalone server process.
contextBridge.exposeInMainWorld("piDesktop", runtime);
