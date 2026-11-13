export type DesktopAutoLaunchError = "read-failed" | "update-failed" | "approval-required";

export interface DesktopAutoLaunchState {
  supported: boolean;
  enabled: boolean;
  error?: DesktopAutoLaunchError;
}

export interface DesktopAutoLaunchEnvironment {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  isSmokeTest: boolean;
  executablePath: string;
  portableExecutablePath?: string;
}

export interface DesktopLoginItemOptions {
  path?: string;
  args?: string[];
}

interface DesktopLoginItemSettings extends DesktopLoginItemOptions {
  openAtLogin?: boolean;
  enabled?: boolean;
}

interface DesktopLoginItemStatus {
  openAtLogin: boolean;
  executableWillLaunchAtLogin?: boolean;
  status?: "not-registered" | "enabled" | "requires-approval" | "not-found";
}

export interface DesktopLoginItemController {
  getLoginItemSettings: (options?: DesktopLoginItemOptions) => DesktopLoginItemStatus;
  setLoginItemSettings: (settings: DesktopLoginItemSettings) => void;
}

export function resolveDesktopLoginItemOptions(
  environment: DesktopAutoLaunchEnvironment,
): DesktopLoginItemOptions | null {
  if (!environment.isPackaged || environment.isSmokeTest) return null;
  if (environment.platform === "darwin") return {};
  if (environment.platform !== "win32") return null;

  return {
    path: environment.portableExecutablePath?.trim() || environment.executablePath,
    args: ["--piora-autostart"],
  };
}

export function readDesktopAutoLaunchState(
  controller: DesktopLoginItemController,
  platform: NodeJS.Platform,
  options: DesktopLoginItemOptions | null,
): DesktopAutoLaunchState {
  if (!options) return { supported: false, enabled: false };

  try {
    let current = controller.getLoginItemSettings(options);
    if (platform === "win32" && !current.openAtLogin && options.args?.includes("--piora-autostart")) {
      const legacy = controller.getLoginItemSettings({ ...options, args: [] });
      if (legacy.openAtLogin) current = legacy;
    }
    if (platform === "darwin" && current.status === "requires-approval") {
      return { supported: true, enabled: false, error: "approval-required" };
    }
    const enabled = platform === "win32"
      ? current.openAtLogin && current.executableWillLaunchAtLogin !== false
      : current.status ? current.status === "enabled" : current.openAtLogin;
    return { supported: true, enabled };
  } catch {
    return { supported: true, enabled: false, error: "read-failed" };
  }
}

export function updateDesktopAutoLaunchState(
  controller: DesktopLoginItemController,
  platform: NodeJS.Platform,
  options: DesktopLoginItemOptions | null,
  enabled: boolean,
): DesktopAutoLaunchState {
  if (!options) return { supported: false, enabled: false };

  try {
    controller.setLoginItemSettings({
      ...options,
      openAtLogin: enabled,
      ...(platform === "win32" ? { enabled } : {}),
    });
  } catch {
    return { supported: true, enabled: !enabled, error: "update-failed" };
  }

  return readDesktopAutoLaunchState(controller, platform, options);
}
