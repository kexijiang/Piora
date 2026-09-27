import { contextBridge, ipcRenderer } from "electron";
import type { ScreenshotOutputAction, ScreenshotOutputResult, ScreenshotWindowState, ScreenshotWindowUpdate } from "./screenshot-types.js";

const bridge = Object.freeze({
  state: (): Promise<ScreenshotWindowState> => ipcRenderer.invoke("pi:screenshot:state"),
  ready: (): Promise<boolean> => ipcRenderer.invoke("pi:screenshot:ready"),
  begin: (): Promise<boolean> => ipcRenderer.invoke("pi:screenshot:begin"),
  end: (): Promise<boolean> => ipcRenderer.invoke("pi:screenshot:end"),
  cancel: (): Promise<boolean> => ipcRenderer.invoke("pi:screenshot:cancel"),
  output: (captureId: string, action: ScreenshotOutputAction, bytes: Uint8Array): Promise<ScreenshotOutputResult> =>
    ipcRenderer.invoke("pi:screenshot:output", { captureId, action, bytes }),
  onUpdate(listener: (update: ScreenshotWindowUpdate) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, update: ScreenshotWindowUpdate) => listener(update);
    ipcRenderer.on("pi:screenshot:update", handler);
    return () => ipcRenderer.removeListener("pi:screenshot:update", handler);
  },
});

contextBridge.exposeInMainWorld("piScreenshot", bridge);
