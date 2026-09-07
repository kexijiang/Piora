import type { BrowserWindow } from "electron";

// User-origin !important rules win over downloaded theme packs as well as the
// shared app stylesheet. This guard is only installed in the two transparent
// native surfaces, never the main window or the pocket panel.
export const TRANSPARENT_COMPANION_CSS = `
html, body { background: transparent !important; background-image: none !important; color-scheme: light !important; isolation: auto !important; }
html::before, html::after, body::before, body::after { content: none !important; display: none !important; }
`;
export function protectTransparentCompanion(window: BrowserWindow) {
  const resetBackground = () => { if (!window.isDestroyed()) window.setBackgroundColor("#00000000"); };
  window.webContents.on("did-start-loading", resetBackground);
  window.webContents.on("did-finish-load", () => {
    resetBackground();
    void window.webContents.insertCSS(TRANSPARENT_COMPANION_CSS, { cssOrigin: "user" }).catch(() => {});
  });
  window.on("show", resetBackground);
  resetBackground();
}
