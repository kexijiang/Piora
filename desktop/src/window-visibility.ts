import type { CommandLine } from "electron";

/** Keep native minimize/hide transitions authoritative on Windows. */
export function configureWindowVisibility(commandLine: Pick<CommandLine, "getSwitchValue" | "appendSwitch">, platform: NodeJS.Platform): void {
  if (platform !== "win32") return;
  // Electron 45 can report a restored foreground window as occluded, starving
  // its animation frames and controls. Disabling only the native occlusion
  // tracker keeps explicit hide/minimize throttling and Page Visibility intact.
  // Covered (but still shown) windows may keep drawing; do not disable all
  // background throttling or emulate document visibility in the renderer.
  const disabled = commandLine.getSwitchValue("disable-features").split(",").map(value => value.trim()).filter(Boolean);
  if (disabled.includes("CalculateNativeWinOcclusion")) return;
  commandLine.appendSwitch("disable-features", [...disabled, "CalculateNativeWinOcclusion"].join(","));
}
