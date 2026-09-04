import { randomBytes } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createConnection } from "node:net";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  screen,
  session as electronSession,
  shell,
  globalShortcut,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
  type Session,
} from "electron";
import { autoUpdater } from "electron-updater";
import {
  companionFacingDirection,
  companionMotionPoint,
  dragCompanionBounds,
  planCompanionMotion,
  type CompanionMotionDirection,
  type CompanionMotionPattern,
} from "./companion-motion.js";
import {
  readCompanionWindowPosition,
  readMainWindowState,
  readPiAgentDirectory,
  readPreferredServerPort,
  runtimeProfileDataDirectory,
  writeCompanionWindowPosition,
  writeMainWindowState,
  writePreferredServerPort,
  writePiAgentDirectory,
  type RuntimeProfile,
} from "./desktop-state.js";
import {
  AgentDataDirectoryError,
  preflightAgentDataDirectoryChange,
  prepareAgentDataDirectoryChange,
  validateAgentDataDirectory,
} from "./agent-data-directory.js";
import { DesktopBrowserManager } from "./browser-manager.js";
import { FileLogger, type Logger } from "./logger.js";
import { ensurePortableDesktopShortcut, type PortableShortcutResult } from "./portable-shortcut.js";
import { StandaloneServer, type ServerExit } from "./server-supervisor.js";
import { fitBoundsToVisibleDisplays } from "./window-bounds.js";
import {
  DesktopUpdateController,
  type DesktopUpdateState,
} from "./app-updater.js";
import { readOrCreateDesktopReleaseAudience } from "./release-audience.js";
import { preparePreviewUpdateFeed } from "./update-release-selector.js";
import {
  isDesktopApplicationTransportUrl,
  resolveDesktopDevelopmentRuntime,
} from "./development-runtime.js";
import {
  DEFAULT_DESKTOP_SHORTCUT_BINDINGS,
  parseDesktopShortcutBindings,
  toElectronAccelerator,
  type DesktopShortcutBindings,
  type DesktopShortcutId,
} from "./keyboard-shortcuts.js";
import {
  readDesktopAutoLaunchState,
  resolveDesktopLoginItemOptions,
  updateDesktopAutoLaunchState,
  type DesktopAutoLaunchState,
  type DesktopLoginItemController,
} from "./auto-launch.js";

const DESKTOP_PARTITION = "persist:piora";
const DESKTOP_TOKEN_HEADER = "X-Pi-Desktop-Token";
const COMPLETION_NOTIFICATION_CHANNEL = "pi:completion-notification";
const NOTIFICATION_SESSION_CHANNEL = "pi:notification-session";
const APPLICATION_MENU_CHANNEL = "pi:open-application-menu";
const REVEAL_PATH_CHANNEL = "pi:reveal-path";
const OPEN_PATH_CHANNEL = "pi:open-path";
const DIRECTORY_PICKER_CHANNEL = "pi:directory-picker";
const SPEECH_PACK_DIRECTORY_PICKER_CHANNEL = "pi:speech-pack-directory-picker";
const AGENT_DATA_DIRECTORY_GET_CHANNEL = "pi:agent-data-directory-get";
const AGENT_DATA_DIRECTORY_PICKER_CHANNEL = "pi:agent-data-directory-picker";
const AGENT_DATA_DIRECTORY_APPLY_CHANNEL = "pi:agent-data-directory-apply";
const COMPANION_VISIBILITY_CHANNEL = "pi:companion-window-visible";
const COMPANION_ALWAYS_ON_TOP_CHANNEL = "pi:companion-window-always-on-top";
const COMPANION_ACTION_CHANNEL = "pi:companion-window-action";
const COMPANION_LAYOUT_CHANNEL = "pi:companion-window-expanded";
const COMPANION_MOTION_CHANNEL = "pi:companion-window-motion";
const COMPANION_MOTION_STATE_CHANNEL = "pi:companion-motion-state";
const COMPANION_HIT_TEST_CHANNEL = "pi:companion-hit-test";
const GLOBAL_SHORTCUT_CHANNEL = "pi:set-global-shortcut";
const AUTO_LAUNCH_GET_CHANNEL = "pi:auto-launch-get";
const AUTO_LAUNCH_SET_CHANNEL = "pi:auto-launch-set";
const KEYBOARD_SHORTCUTS_CHANNEL = "pi:set-keyboard-shortcuts";
const NETWORK_PROXY_CHANNEL = "pi:set-network-proxy";
const HARMONY_RUNTIME_PICKER_CHANNEL = "pi:harmony-runtime-picker";
const DESKTOP_UPDATE_STATE_GET_CHANNEL = "pi:update-state-get";
const DESKTOP_UPDATE_STATE_CHANNEL = "pi:update-state";
const DESKTOP_UPDATE_CHECK_CHANNEL = "pi:update-check";
const DESKTOP_UPDATE_DOWNLOAD_CHANNEL = "pi:update-download";
const DESKTOP_UPDATE_INSTALL_CHANNEL = "pi:update-install";
const DESKTOP_TITLE_BAR_HEIGHT = 36;
const COMPANION_COMPACT_WIDTH = 156;
const COMPANION_COMPACT_HEIGHT = 184;
const COMPANION_BUBBLE_WIDTH = 300;
const COMPANION_BUBBLE_HEIGHT = 128;
const COMPANION_PANEL_WIDTH = 430;
const COMPANION_PANEL_HEIGHT = 680;
const MAX_NOTIFICATION_TASK_TITLE_LENGTH = 80;
const MAX_NOTIFICATION_SESSION_ID_LENGTH = 512;
const MAX_RENDERER_CONSOLE_MESSAGE_LENGTH = 8_192;
const PORTABLE_SMOKE_TEST = process.env.PIORA_SMOKE_TEST === "1"
  || process.argv.includes("--smoke-test");
const STARTUP_SHELL_BACKGROUND = "#080a0f";
const PI_AGENT_DIRECTORY_ENV = "PI_CODING_AGENT_DIR";
const desktopDevelopmentRuntime = resolveDesktopDevelopmentRuntime();

const requestedSmokeUserData = process.env.PIORA_SMOKE_USER_DATA?.trim();
const requestedCompanionUiTestUserData = process.env.PIORA_COMPANION_UI_TEST === "1"
  ? process.env.PIORA_COMPANION_UI_TEST_USER_DATA?.trim()
  : undefined;
if (desktopDevelopmentRuntime) {
  const requestedDevUserData = process.env.PIORA_DESKTOP_DEV_USER_DATA?.trim();
  app.setPath("userData", requestedDevUserData
    ? resolve(requestedDevUserData)
    : join(app.getPath("appData"), "Piora Dev"));
} else if (PORTABLE_SMOKE_TEST && requestedSmokeUserData) {
  app.setPath("userData", resolve(requestedSmokeUserData));
} else if (requestedCompanionUiTestUserData) {
  // Packaged companion E2E checks run beside an already-open user instance.
  // An explicit test-only profile keeps the instance lock, state, and storage
  // completely isolated from the user's real Piora data.
  app.setPath("userData", resolve(requestedCompanionUiTestUserData));
} else {
  // The on-disk profile directory follows the product name (Piora). It is set
  // explicitly so it stays stable and independent of Electron's derived app name.
  app.setPath("userData", join(app.getPath("appData"), "Piora"));
}

let mainWindow: BrowserWindow | null = null;
let companionWindow: BrowserWindow | null = null;
let companionBubbleWindow: BrowserWindow | null = null;
let companionPanelWindow: BrowserWindow | null = null;
let logger: FileLogger | undefined;
let server: StandaloneServer | undefined;
let serverUrl: URL | undefined;
let shutdownPromise: Promise<void> | undefined;
let shutdownComplete = false;
let applicationMenu: Menu | null = null;
let keyboardShortcutBindings: DesktopShortcutBindings = { ...DEFAULT_DESKTOP_SHORTCUT_BINDINGS };
let companionPanelShortcutAccelerator: string | undefined;
let companionPanelKeepVisibleUntilClose = false;
let companionMoveTimer: NodeJS.Timeout | undefined;
let companionMotionTimer: NodeJS.Timeout | undefined;
let companionMotionRevision = 0;
let companionLastAutonomousMotionAt = 0;
let companionDragState: {
  pointerStart: { x: number; y: number };
  startingBounds: Electron.Rectangle;
} | undefined;
let companionShouldBeVisible = false;
let companionAlwaysOnTop = true;
let mainWindowStateTimer: NodeJS.Timeout | undefined;
let tray: Tray | null = null;
let trayPollTimer: NodeJS.Timeout | undefined;
let applicationToken: string | undefined;
let runningTaskCount = 0;
let quitRequested = false;
let serverEntryPath: string | undefined;
let serverHostEntryPath: string | undefined;
let piAgentDirectoryPath: string | undefined;
let desktopBrowserManager: DesktopBrowserManager | undefined;
const desktopBrowserRequestControllers = new Map<string, AbortController>();
let desktopUpdateController: DesktopUpdateController | undefined;
let desktopUpdateState: DesktopUpdateState = {
  status: "unsupported",
  currentVersion: app.getVersion(),
  audience: "stable",
};
let automaticUpdateCheckTimer: NodeJS.Timeout | undefined;

function attachDesktopBrowserManager(window: BrowserWindow, log: Logger): void {
  void desktopBrowserManager?.flushStorage().catch((error) => log.warn("Unable to persist the previous browser session", error));
  desktopBrowserManager?.destroy();
  desktopBrowserManager = new DesktopBrowserManager(window, log, isTrustedMainWindowSender);
}

async function handleStandaloneMessage(message: unknown): Promise<unknown> {
  if (!message || typeof message !== "object") return undefined;
  const candidate = message as {
    type?: unknown;
    requestId?: unknown;
    sessionId?: unknown;
    params?: unknown;
  };
  if (candidate.type === "pi-desktop:browser-cancel" && typeof candidate.requestId === "string") {
    desktopBrowserRequestControllers.get(candidate.requestId)?.abort("browser_request_cancelled");
    return undefined;
  }
  if (candidate.type !== "pi-desktop:browser-request" || typeof candidate.requestId !== "string") return undefined;
  const requestId = candidate.requestId.slice(0, 160);
  const controller = new AbortController();
  desktopBrowserRequestControllers.set(requestId, controller);
  try {
    if (!desktopBrowserManager) throw new Error("The visible desktop browser is not ready.");
    if (typeof candidate.sessionId !== "string" || candidate.sessionId.length > 512) throw new Error("Invalid browser Session id.");
    if (!candidate.params || typeof candidate.params !== "object" || Array.isArray(candidate.params)) throw new Error("Invalid browser action payload.");
    const result = await desktopBrowserManager.performAgentAction(
      candidate.sessionId,
      candidate.params as Record<string, unknown>,
      controller.signal,
    );
    return { type: "pi-desktop:browser-response", requestId, ok: true, result };
  } catch (error) {
    return {
      type: "pi-desktop:browser-response",
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    desktopBrowserRequestControllers.delete(requestId);
  }
}

function installRendererDiagnostics(window: BrowserWindow, surface: "Main" | "Companion", log: Logger): void {
  window.webContents.on("console-message", (event) => {
    if (event.level !== "error") return;
    log.error(`${surface} renderer console error`, {
      message: event.message.slice(0, MAX_RENDERER_CONSOLE_MESSAGE_LENGTH),
      lineNumber: event.lineNumber,
      sourceId: event.sourceId,
    });
  });
  window.on("unresponsive", () => {
    log.error(`${surface} renderer became unresponsive`);
  });
}

async function clearObsoleteDesktopWebCaches(log: Logger): Promise<void> {
  const runtimeSession = electronSession.fromPartition(DESKTOP_PARTITION, { cache: true });
  try {
    // Piora used to register its browser PWA service worker inside Electron's
    // persistent partition. Across desktop upgrades that worker could retain
    // an older Next.js asset graph and crash hydration before the app mounted.
    // This partition is app-owned, and these two stores contain no user data.
    await runtimeSession.clearStorageData({
      storages: ["serviceworkers", "cachestorage"],
    });
    log.info("Cleared obsolete desktop service worker caches");
  } catch (error) {
    // Cache cleanup is hardening, not a startup dependency. The renderer-side
    // cleanup in PwaRegistration gets another chance after a successful mount.
    log.warn("Unable to clear obsolete desktop service worker caches", error);
  }
}

function prepareWritableDirectory(directory: string): string {
  const resolvedDirectory = resolve(directory);
  mkdirSync(resolvedDirectory, { recursive: true });
  accessSync(resolvedDirectory, fsConstants.R_OK | fsConstants.W_OK);
  return resolvedDirectory;
}

function defaultPiAgentDirectory(): string {
  return resolve(app.getPath("home"), ".pi", "agent");
}

function resolvePiAgentDirectory(log: Logger): string {
  const configuredByEnvironment = process.env[PI_AGENT_DIRECTORY_ENV]?.trim();
  if (configuredByEnvironment) return prepareWritableDirectory(configuredByEnvironment);
  const configuredBySettings = readPiAgentDirectory(app.getPath("userData"), log);
  return prepareWritableDirectory(configuredBySettings ?? defaultPiAgentDirectory());
}

function installPortableDesktopShortcut(log: Logger): PortableShortcutResult | undefined {
  try {
    const description = app.getLocale().toLowerCase().startsWith("zh")
      ? "启动 Piora"
      : "Launch Piora";
    const result = ensurePortableDesktopShortcut({
      platform: process.platform,
      isPackaged: app.isPackaged,
      isSmokeTest: PORTABLE_SMOKE_TEST,
      appVersion: app.getVersion(),
      ...(process.env.PORTABLE_EXECUTABLE_FILE
        ? { portableExecutablePath: process.env.PORTABLE_EXECUTABLE_FILE }
        : {}),
      packagedExecutablePath: process.execPath,
      desktopDirectory: app.getPath("desktop"),
      iconPath: join(process.resourcesPath, process.platform === "win32" ? "tray-icon.ico" : "tray-icon.png"),
      description,
      shell: {
        writeShortcutLink: (path, operation, details) => (
          shell.writeShortcutLink(path, operation, details)
        ),
      },
    });
    if (result.status === "created") log.info("Portable desktop shortcut created", result);
    if (result.status === "kept-existing") log.info("Portable desktop shortcut already exists", result);
    return result;
  } catch (error) {
    // A locked-down or redirected Desktop must not prevent Piora from starting.
    log.warn("Unable to create the portable desktop shortcut", error);
    return undefined;
  }
}

type ApplicationMenuId = "file" | "edit" | "view" | "help";

function sanitizeNotificationTaskTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return Array.from(normalized).slice(0, MAX_NOTIFICATION_TASK_TITLE_LENGTH).join("");
}

function sanitizeNotificationSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > MAX_NOTIFICATION_SESSION_ID_LENGTH
    || /[\u0000-\u001f\u007f-\u009f]/.test(normalized)
  ) {
    return undefined;
  }
  return normalized;
}

function isTrustedCompletionNotificationSender(event: IpcMainInvokeEvent): boolean {
  if (!serverUrl || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    return false;
  }
  return isAllowedAppUrl(event.senderFrame.url, serverUrl.origin);
}

function getCompletionNotificationCopy(taskTitle: string | undefined): {
  title: string;
  body: string;
} {
  const isChinese = app.getLocale().toLowerCase().startsWith("zh");
  return {
    title: taskTitle ? `${taskTitle} - Piora` : "Piora",
    body: isChinese
      ? "任务已完成，可以回到 Piora 查看结果。"
      : "Task completed. Open Piora to review the result.",
  };
}

function getAutomationNotificationCopy(taskTitle: string | undefined, status: "succeeded" | "failed" | "interrupted"): { title: string; body: string } {
  const isChinese = app.getLocale().toLowerCase().startsWith("zh");
  const body = isChinese
    ? status === "succeeded" ? "定时任务已完成，可以回到 Piora 查看结果。" : status === "interrupted" ? "定时任务因 Piora 重启而中断。" : "定时任务执行失败，请回到 Piora 查看详情。"
    : status === "succeeded" ? "Scheduled task completed. Open Piora to review the result." : status === "interrupted" ? "Scheduled task was interrupted when Piora restarted." : "Scheduled task failed. Open Piora to review the details.";
  return { title: taskTitle ? `${taskTitle} - Piora` : "Piora", body };
}

function getUserInputNotificationCopy(taskTitle: string | undefined): { title: string; body: string } {
  const isChinese = app.getLocale().toLowerCase().startsWith("zh");
  return {
    title: taskTitle ? `${taskTitle} - Piora` : "Piora",
    body: isChinese
      ? "模型提出了问题，正在等待你的回复。"
      : "The model asked a question and is waiting for your reply.",
  };
}

type CompletionNotificationRequest = {
  taskTitle?: unknown;
  sessionId?: unknown;
  status?: unknown;
  kind?: unknown;
};

function registerCompletionNotificationHandler(): void {
  ipcMain.removeHandler(COMPLETION_NOTIFICATION_CHANNEL);
  ipcMain.handle(
    COMPLETION_NOTIFICATION_CHANNEL,
    (event, requested: unknown): boolean => {
      if (!isTrustedCompletionNotificationSender(event)) {
        logger?.warn("Blocked completion notification from an untrusted renderer");
        return false;
      }
      if (!Notification.isSupported()) return false;

      const payload = typeof requested === "string"
        ? { taskTitle: requested as unknown }
        : requested && typeof requested === "object" ? requested as CompletionNotificationRequest : null;
      const status = payload && (payload.status === "succeeded" || payload.status === "failed" || payload.status === "interrupted") ? payload.status : null;
      const kind = payload && payload.kind === "user-input" ? "user-input" : status ? "automation" : "completion";
      const title = sanitizeNotificationTaskTitle(payload?.taskTitle);
      const sessionId = sanitizeNotificationSessionId(payload?.sessionId);
      const copy = kind === "user-input"
        ? getUserInputNotificationCopy(title)
        : status ? getAutomationNotificationCopy(title, status) : getCompletionNotificationCopy(title);
      const notification = new Notification({ ...copy, silent: false });
      notification.on("click", () => {
        if (!focusMainWindow() || !sessionId || !mainWindow || mainWindow.isDestroyed()) return;
        mainWindow.webContents.send(NOTIFICATION_SESSION_CHANNEL, sessionId);
      });
      notification.show();
      return true;
    },
  );
}

// Apply Chromium's sandbox to every renderer created by this application.
app.enableSandbox();

function sendMenuAction(action: string): void {
  mainWindow?.webContents.send("pi:menu-action", action);
}

function menuAccelerator(id: DesktopShortcutId): string | undefined {
  return toElectronAccelerator(keyboardShortcutBindings[id]);
}

function menuAcceleratorOption(id: DesktopShortcutId): { accelerator: string } | Record<string, never> {
  const accelerator = menuAccelerator(id);
  return accelerator ? { accelerator } : {};
}

function registerKeyboardShortcutHandler(): void {
  ipcMain.removeHandler(KEYBOARD_SHORTCUTS_CHANNEL);
  ipcMain.handle(KEYBOARD_SHORTCUTS_CHANNEL, (event, requested: unknown): boolean => {
    if (!isTrustedMainWindowSender(event)) return false;
    const parsed = parseDesktopShortcutBindings(requested);
    if (!parsed) {
      logger?.warn("Rejected invalid keyboard shortcut settings from renderer");
      return false;
    }
    keyboardShortcutBindings = parsed;
    const companionShortcutRegistered = syncCompanionPanelShortcut();
    installApplicationMenu();
    return companionShortcutRegistered;
  });
}

function parseDesktopNetworkProxySettings(input: unknown): {
  mode: "system" | "manual" | "direct";
  proxyUrl: string;
  bypass: string;
} | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const candidate = input as Record<string, unknown>;
  if (candidate.mode !== "system" && candidate.mode !== "manual" && candidate.mode !== "direct") return null;
  if (typeof candidate.proxyUrl !== "string" || typeof candidate.bypass !== "string") return null;
  if (candidate.proxyUrl.length > 2_048 || candidate.bypass.length > 4_096) return null;
  if (candidate.mode === "manual") {
    try {
      const url = new URL(candidate.proxyUrl);
      if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
    } catch {
      return null;
    }
  }
  return { mode: candidate.mode, proxyUrl: candidate.proxyUrl, bypass: candidate.bypass };
}

async function applyDesktopNetworkProxy(input: unknown): Promise<boolean> {
  const settings = parseDesktopNetworkProxySettings(input);
  if (!settings) return false;
  const target = electronSession.fromPartition(DESKTOP_PARTITION, { cache: true });
  try {
    if (settings.mode === "manual") {
      const bypass = ["<local>", ...settings.bypass.split(/[;,\s]+/).filter(Boolean)].join(",");
      await target.setProxy({ mode: "fixed_servers", proxyRules: settings.proxyUrl, proxyBypassRules: bypass });
    } else {
      await target.setProxy({ mode: settings.mode });
    }
    await target.closeAllConnections();
    return true;
  } catch (error) {
    logger?.warn("Unable to apply desktop network proxy", {
      mode: settings.mode,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function registerNetworkProxyHandler(): void {
  ipcMain.removeHandler(NETWORK_PROXY_CHANNEL);
  ipcMain.handle(NETWORK_PROXY_CHANNEL, (event, input: unknown) => {
    if (!isTrustedMainWindowSender(event)) return false;
    return applyDesktopNetworkProxy(input);
  });
}

function isUpdateAttentionState(state: DesktopUpdateState = desktopUpdateState): boolean {
  return state.status === "available"
    || state.status === "downloading"
    || state.status === "downloaded";
}

function updateVersionLabel(state: DesktopUpdateState): string {
  return state.availableVersion ? ` v${state.availableVersion}` : "";
}

function showDesktopMessage(options: MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
}

function notifyUpdateAvailable(state: DesktopUpdateState): void {
  if (!Notification.isSupported()) return;
  const chinese = app.getLocale().toLowerCase().startsWith("zh");
  const version = updateVersionLabel(state);
  const notification = new Notification({
    title: chinese ? `Piora${version} 可以更新` : `Piora${version} is available`,
    body: chinese
      ? "点击应用顶部的下载图标，查看本次更新内容和下载进度。"
      : "Use the download icon in the title bar to review changes and download progress.",
    silent: false,
  });
  notification.on("click", () => focusMainWindow("open-update"));
  notification.show();
}

function publishDesktopUpdateState(state: Readonly<DesktopUpdateState>): void {
  const previousStatus = desktopUpdateState.status;
  desktopUpdateState = { ...state };
  if (applicationMenu) installApplicationMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(DESKTOP_UPDATE_STATE_CHANNEL, desktopUpdateState);
  }
  if (state.status === "available" && previousStatus !== "available") {
    notifyUpdateAvailable(desktopUpdateState);
  }
}

function registerDesktopUpdateStateHandler(): void {
  ipcMain.removeHandler(DESKTOP_UPDATE_STATE_GET_CHANNEL);
  ipcMain.handle(DESKTOP_UPDATE_STATE_GET_CHANNEL, (event): DesktopUpdateState | null => {
    if (!isTrustedMainWindowSender(event)) return null;
    return { ...desktopUpdateState };
  });

  ipcMain.removeHandler(DESKTOP_UPDATE_CHECK_CHANNEL);
  ipcMain.handle(DESKTOP_UPDATE_CHECK_CHANNEL, async (event): Promise<DesktopUpdateState | null> => {
    if (!isTrustedMainWindowSender(event) || !desktopUpdateController) return null;
    await desktopUpdateController.checkForUpdates();
    return { ...desktopUpdateController.getState() };
  });

  ipcMain.removeHandler(DESKTOP_UPDATE_DOWNLOAD_CHANNEL);
  ipcMain.handle(DESKTOP_UPDATE_DOWNLOAD_CHANNEL, async (event): Promise<DesktopUpdateState | null> => {
    if (!isTrustedMainWindowSender(event) || !desktopUpdateController) return null;
    await desktopUpdateController.downloadUpdate();
    return { ...desktopUpdateController.getState() };
  });

  ipcMain.removeHandler(DESKTOP_UPDATE_INSTALL_CHANNEL);
  ipcMain.handle(DESKTOP_UPDATE_INSTALL_CHANNEL, async (event): Promise<boolean> => {
    if (!isTrustedMainWindowSender(event)) return false;
    return installDownloadedDesktopUpdate(false);
  });
}

async function installDownloadedDesktopUpdate(confirmInstallation = true): Promise<boolean> {
  if (!desktopUpdateController || desktopUpdateState.status !== "downloaded") return false;
  const chinese = app.getLocale().toLowerCase().startsWith("zh");
  if (runningTaskCount > 0) {
    await showDesktopMessage({
      type: "warning",
      title: chinese ? "暂时不能安装更新" : "Update cannot be installed yet",
      message: chinese ? "仍有任务正在运行" : "A task is still running",
      detail: chinese
        ? "请等待当前任务完成，再选择“安装并重启”。"
        : "Wait for the current task to finish, then choose Install and restart.",
      buttons: [chinese ? "知道了" : "OK"],
      defaultId: 0,
    });
    return false;
  }

  if (confirmInstallation) {
    const result = await showDesktopMessage({
      type: "question",
      title: chinese ? "安装 Piora 更新" : "Install Piora update",
      message: chinese
        ? `安装并重启 Piora${updateVersionLabel(desktopUpdateState)}？`
        : `Install Piora${updateVersionLabel(desktopUpdateState)} and restart?`,
      detail: chinese
        ? "Piora 会安全停止本地服务，安装完成后自动重新打开。会话和设置数据不会被删除。"
        : "Piora will safely stop its local service and reopen after installation. Chats and settings will not be deleted.",
      buttons: [chinese ? "安装并重启" : "Install and restart", chinese ? "稍后" : "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (result.response !== 0) return false;
  }

  quitRequested = true;
  try {
    shutdownPromise ??= stopApplication();
    await shutdownPromise;
    shutdownComplete = true;
    if (!desktopUpdateController.quitAndInstall()) {
      throw new Error("The downloaded desktop update is no longer available.");
    }
    return true;
  } catch (error) {
    logger?.error("Unable to launch the downloaded desktop update", error);
    shutdownComplete = true;
    dialog.showErrorBox(
      chinese ? "无法安装 Piora 更新" : "Unable to install Piora update",
      error instanceof Error ? error.message : String(error),
    );
    app.relaunch();
    app.quit();
    return false;
  }
}

async function handleDesktopUpdateMenuAction(): Promise<void> {
  const chinese = app.getLocale().toLowerCase().startsWith("zh");
  const controller = desktopUpdateController;
  if (!controller || desktopUpdateState.status === "unsupported") {
    await shell.openExternal("https://github.com/kexijiang/Piora/releases/latest");
    return;
  }
  if (desktopUpdateState.status === "checking") return;
  if (isUpdateAttentionState()) {
    focusMainWindow("open-update");
    return;
  }

  await controller.checkForUpdates();
  const checked = controller.getState();
  if (checked.status === "up-to-date") {
    focusMainWindow("open-update");
  } else if (checked.status === "available") {
    focusMainWindow("open-update");
  } else if (checked.status === "error") {
    await showDesktopMessage({
      type: "error",
      title: chinese ? "检查更新失败" : "Update check failed",
      message: chinese ? "暂时无法检查更新" : "Piora could not check for updates",
      ...(checked.error ? { detail: checked.error } : {}),
      buttons: [chinese ? "知道了" : "OK"],
      defaultId: 0,
    });
  }
}

function initializeDesktopUpdater(log: Logger): void {
  const supported = app.isPackaged
    && process.platform === "win32"
    && !PORTABLE_SMOKE_TEST
    && !process.env.PORTABLE_EXECUTABLE_FILE;
  const currentVersion = app.getVersion();
  const audience = readOrCreateDesktopReleaseAudience(app.getPath("userData"), currentVersion, log);
  desktopUpdateController = new DesktopUpdateController(
    supported ? autoUpdater : null,
    currentVersion,
    log,
    {
      audience,
      ...(supported && audience === "preview"
        ? {
            prepareCheck: () => preparePreviewUpdateFeed(
              autoUpdater,
              currentVersion,
              (url) => net.fetch(url, {
                headers: { Accept: "application/atom+xml, application/xml;q=0.9" },
              }),
              log,
            ),
          }
        : {}),
    },
  );
  desktopUpdateController.subscribe(publishDesktopUpdateState);
  registerDesktopUpdateStateHandler();
  if (!supported) return;

  automaticUpdateCheckTimer = setTimeout(() => {
    automaticUpdateCheckTimer = undefined;
    void desktopUpdateController?.checkForUpdates();
  }, 5_000);
  automaticUpdateCheckTimer.unref();
}

function installApplicationMenu(): void {
  const zh = app.getLocale().toLowerCase().startsWith("zh");
  const copy = zh ? {
    file: "文件", edit: "编辑", view: "视图", help: "帮助",
    newSession: "新聊天", openFolder: "打开文件夹", close: "关闭", quit: "退出 Piora",
    undo: "撤销", redo: "重做", cut: "剪切", copy: "复制", paste: "粘贴", delete: "删除", selectAll: "全选", settings: "设置",
    sidebar: "切换侧栏", files: "切换文件面板", commands: "打开命令面板", review: "打开审查面板", browser: "浏览器", companion: "显示/隐藏桌面宠物", find: "搜索聊天记录",
    actualSize: "实际大小", zoomIn: "放大", zoomOut: "缩小", fullscreen: "切换全屏",
    documentation: "文档", about: "关于 Piora", aboutDetail: "基于 Pi Agent 与 pi-web 的开源桌面应用。",
    checkUpdates: "检查更新…", checkingUpdates: "正在检查更新…", updateAvailable: "有更新",
    downloadingUpdate: "正在下载更新", restartToInstall: "安装并重启", retryUpdate: "检查更新失败，点击重试",
    installAutoUpdateEdition: "获取支持自动更新的安装版…",
  } : {
    file: "File", edit: "Edit", view: "View", help: "Help",
    newSession: "New chat", openFolder: "Open folder", close: "Close", quit: "Quit Piora",
    undo: "Undo", redo: "Redo", cut: "Cut", copy: "Copy", paste: "Paste", delete: "Delete", selectAll: "Select all", settings: "Settings",
    sidebar: "Toggle sidebar", files: "Toggle Files panel", commands: "Open Commands panel", review: "Open Review panel", browser: "Browser", companion: "Show/hide desktop pet", find: "Search conversations",
    actualSize: "Actual size", zoomIn: "Zoom in", zoomOut: "Zoom out", fullscreen: "Toggle full screen",
    documentation: "Documentation", about: "About Piora", aboutDetail: "An open-source desktop application built with Pi Agent and pi-web.",
    checkUpdates: "Check for updates…", checkingUpdates: "Checking for updates…", updateAvailable: "Update available",
    downloadingUpdate: "Downloading update", restartToInstall: "Install and restart", retryUpdate: "Update check failed — retry",
    installAutoUpdateEdition: "Get the auto-updating installer…",
  };
  const editRoles: MenuItemConstructorOptions[] = [
    { role: "undo", label: copy.undo },
    { role: "redo", label: copy.redo },
    { type: "separator" },
    { role: "cut", label: copy.cut },
    { role: "copy", label: copy.copy },
    { role: "paste", label: copy.paste },
    { role: "delete", label: copy.delete },
    { type: "separator" },
    { role: "selectAll", label: copy.selectAll },
    { type: "separator" },
    { label: copy.settings, ...menuAcceleratorOption("settings.general"), click: () => sendMenuAction("settings") },
  ];
  const updateVersion = updateVersionLabel(desktopUpdateState);
  const updateItem: MenuItemConstructorOptions = (() => {
    switch (desktopUpdateState.status) {
      case "unsupported":
        return { label: copy.installAutoUpdateEdition, click: () => { void handleDesktopUpdateMenuAction(); } };
      case "checking":
        return { label: copy.checkingUpdates, enabled: false };
      case "available":
        return {
          label: `${copy.updateAvailable}: Piora${updateVersion} — ${zh ? "点击下载" : "click to download"}`,
          click: () => { void handleDesktopUpdateMenuAction(); },
        };
      case "downloading":
        return {
          label: `${copy.downloadingUpdate}${desktopUpdateState.progressPercent === undefined ? "…" : ` ${desktopUpdateState.progressPercent}%`}`,
          enabled: false,
        };
      case "downloaded":
        return {
          label: `${copy.restartToInstall} Piora${updateVersion}`,
          click: () => { void handleDesktopUpdateMenuAction(); },
        };
      case "error":
        return { label: copy.retryUpdate, click: () => { void handleDesktopUpdateMenuAction(); } };
      default:
        return { label: copy.checkUpdates, click: () => { void handleDesktopUpdateMenuAction(); } };
    }
  })();

  const template: MenuItemConstructorOptions[] = [
    {
      id: "app-menu-file",
      label: copy.file,
      submenu: [
        { label: copy.newSession, ...menuAcceleratorOption("navigate.newSession"), click: () => sendMenuAction("new-session") },
        { label: copy.openFolder, ...menuAcceleratorOption("navigate.chooseProject"), click: () => sendMenuAction("choose-project") },
        { type: "separator" },
        { role: "close", label: copy.close, accelerator: "CmdOrCtrl+W" },
        { type: "separator" },
        { role: "quit", label: copy.quit, accelerator: "CmdOrCtrl+Q" },
      ],
    },
    { id: "app-menu-edit", label: copy.edit, submenu: editRoles },
    {
      id: "app-menu-view",
      label: copy.view,
      submenu: [
        { label: copy.sidebar, ...menuAcceleratorOption("panel.toggleSidebar"), click: () => sendMenuAction("toggle-sidebar") },
        { label: copy.files, ...menuAcceleratorOption("panel.files"), click: () => sendMenuAction("toggle-files") },
        { label: copy.commands, ...menuAcceleratorOption("panel.commands"), click: () => sendMenuAction("open-commands") },
        { label: copy.review, ...menuAcceleratorOption("panel.review"), click: () => sendMenuAction("open-review") },
        { label: copy.browser, ...menuAcceleratorOption("panel.browser"), click: () => sendMenuAction("open-browser") },
        { label: copy.companion, click: () => sendMenuAction("toggle-companion") },
        { type: "separator" },
        { label: copy.find, ...menuAcceleratorOption("navigate.searchChats"), click: () => sendMenuAction("search-chats") },
        { type: "separator" },
        { label: copy.zoomIn, role: "zoomIn" },
        { label: copy.zoomOut, role: "zoomOut" },
        { label: copy.actualSize, role: "resetZoom" },
        { type: "separator" },
        { label: copy.fullscreen, role: "togglefullscreen" },
      ],
    },
    {
      id: "app-menu-help",
      label: isUpdateAttentionState() ? `${copy.help} (${copy.updateAvailable})` : copy.help,
      submenu: [
        updateItem,
        { type: "separator" },
        { label: copy.documentation, click: () => shell.openExternal("https://github.com/kexijiang/piora#readme") },
        {
          label: copy.about,
          click: () => {
            const options: MessageBoxOptions = {
              type: "info",
              title: copy.about,
              message: `Piora ${app.getVersion()}`,
              detail: copy.aboutDetail,
            };
            void (mainWindow
              ? dialog.showMessageBox(mainWindow, options)
              : dialog.showMessageBox(options));
          },
        },
      ],
    },
  ];

  applicationMenu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(applicationMenu);
}

function registerApplicationMenuPopupHandler(): void {
  ipcMain.removeHandler(APPLICATION_MENU_CHANNEL);
  ipcMain.handle(
    APPLICATION_MENU_CHANNEL,
    async (event, requestedMenu: unknown, requestedX: unknown, requestedY: unknown): Promise<boolean> => {
      if (
        !serverUrl
        || !event.senderFrame
        || event.senderFrame !== event.sender.mainFrame
        || !isAllowedAppUrl(event.senderFrame.url, serverUrl.origin)
      ) {
        logger?.warn("Blocked application menu request from an untrusted renderer");
        return false;
      }

      const allowedMenus: readonly ApplicationMenuId[] = ["file", "edit", "view", "help"];
      if (typeof requestedMenu !== "string" || !allowedMenus.includes(requestedMenu as ApplicationMenuId)) {
        return false;
      }
      const window = mainWindow;
      const submenu = applicationMenu?.getMenuItemById(`app-menu-${requestedMenu}`)?.submenu;
      if (!window || window.isDestroyed() || !submenu) return false;

      const x = Number.isFinite(requestedX) ? Math.max(0, Math.round(requestedX as number)) : undefined;
      const y = Number.isFinite(requestedY) ? Math.max(0, Math.round(requestedY as number)) : DESKTOP_TITLE_BAR_HEIGHT;
      await new Promise<void>((resolvePopup) => {
        submenu.popup({ window, ...(x === undefined ? {} : { x }), y, callback: resolvePopup });
      });
      return true;
    },
  );
}

function isTrustedMainWindowSender(event: IpcMainInvokeEvent): boolean {
  return Boolean(
    serverUrl
    && mainWindow
    && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents
    && event.senderFrame
    && event.senderFrame === event.sender.mainFrame
    && isAllowedAppUrl(event.senderFrame.url, serverUrl.origin),
  );
}

function isTrustedCompanionWindowSender(event: IpcMainInvokeEvent): boolean {
  return Boolean(
    serverUrl
    && companionWindow
    && !companionWindow.isDestroyed()
    && event.sender === companionWindow.webContents
    && event.senderFrame
    && event.senderFrame === event.sender.mainFrame
    && isAllowedAppUrl(event.senderFrame.url, serverUrl.origin),
  );
}

function isTrustedCompanionSurfaceSender(event: IpcMainInvokeEvent): boolean {
  return isTrustedCompanionWindowSender(event) || Boolean(
    serverUrl
    && event.senderFrame
    && event.senderFrame === event.sender.mainFrame
    && isAllowedAppUrl(event.senderFrame.url, serverUrl.origin)
    && [companionBubbleWindow, companionPanelWindow].some((window) => (
      window && !window.isDestroyed() && event.sender === window.webContents
    )),
  );
}

function resolveExistingRendererPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || !isAbsolute(value)) return null;
  const target = resolve(value);
  return existsSync(target) ? target : null;
}

function registerFileShellHandlers(): void {
  ipcMain.removeHandler(REVEAL_PATH_CHANNEL);
  ipcMain.removeHandler(OPEN_PATH_CHANNEL);

  ipcMain.handle(REVEAL_PATH_CHANNEL, async (event, requestedPath: unknown): Promise<boolean> => {
    if (!isTrustedMainWindowSender(event)) {
      logger?.warn("Blocked reveal-path request from an untrusted renderer");
      return false;
    }
    const target = resolveExistingRendererPath(requestedPath);
    if (!target) return false;
    try {
      if (statSync(target).isDirectory()) {
        return (await shell.openPath(target)) === "";
      }
      shell.showItemInFolder(target);
      return true;
    } catch (error) {
      logger?.warn("Unable to reveal local path", error);
      return false;
    }
  });

  ipcMain.handle(OPEN_PATH_CHANNEL, async (event, requestedPath: unknown): Promise<boolean> => {
    if (!isTrustedMainWindowSender(event)) {
      logger?.warn("Blocked open-path request from an untrusted renderer");
      return false;
    }
    const target = resolveExistingRendererPath(requestedPath);
    if (!target) return false;
    try {
      return (await shell.openPath(target)) === "";
    } catch (error) {
      logger?.warn("Unable to open local path", error);
      return false;
    }
  });
}

function registerDirectoryPickerHandler(): void {
  ipcMain.removeHandler(DIRECTORY_PICKER_CHANNEL);
  ipcMain.removeHandler(SPEECH_PACK_DIRECTORY_PICKER_CHANNEL);
  ipcMain.handle(DIRECTORY_PICKER_CHANNEL, async (event): Promise<string | null> => {
    if (!isTrustedMainWindowSender(event)) {
      logger?.warn("Blocked directory picker request from an untrusted renderer");
      return null;
    }
    const ownerWindow = mainWindow;
    if (!ownerWindow || ownerWindow.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(ownerWindow, {
      title: app.getLocale().toLowerCase().startsWith("zh") ? "选择项目文件夹" : "Select project folder",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(
    SPEECH_PACK_DIRECTORY_PICKER_CHANNEL,
    async (event, requestedDefaultPath: unknown): Promise<string | null> => {
      if (!isTrustedMainWindowSender(event)) {
        logger?.warn("Blocked speech pack directory picker request from an untrusted renderer");
        return null;
      }
      const ownerWindow = mainWindow;
      if (!ownerWindow || ownerWindow.isDestroyed()) return null;
      const result = await dialog.showOpenDialog(ownerWindow, {
        title: app.getLocale().toLowerCase().startsWith("zh") ? "选择语音包文件夹" : "Select speech pack folder",
        properties: ["openDirectory", "createDirectory"],
        ...(typeof requestedDefaultPath === "string" && requestedDefaultPath.trim()
          ? { defaultPath: resolve(requestedDefaultPath) }
          : {}),
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  );
}

type AgentDataDirectoryInfo = {
  currentDirectory: string;
  defaultDirectory: string;
  configuredBy: "default" | "settings" | "environment";
  environmentOverride: boolean;
  portableRuntimeDirectory?: string;
};

type AgentDataDirectoryApplyResult = {
  ok: boolean;
  code?: "busy" | "environment-override" | "invalid-path" | "migration-required" | "same-path" | "overlapping-path" | "target-not-empty" | "migration-failed" | "persist-failed";
  error?: string;
  sourceDirectory?: string;
  currentDirectory?: string;
};

function currentAgentDataDirectoryInfo(): AgentDataDirectoryInfo {
  if (!piAgentDirectoryPath) throw new Error("Pi data directory is unavailable before desktop startup completes.");
  const environmentOverride = Boolean(process.env[PI_AGENT_DIRECTORY_ENV]?.trim());
  const configuredBySettings = readPiAgentDirectory(app.getPath("userData"), logger!);
  return {
    currentDirectory: piAgentDirectoryPath,
    defaultDirectory: defaultPiAgentDirectory(),
    configuredBy: environmentOverride ? "environment" : configuredBySettings ? "settings" : "default",
    environmentOverride,
    ...(process.env.PORTABLE_EXECUTABLE_FILE ? { portableRuntimeDirectory: dirname(process.execPath) } : {}),
  };
}

async function suspendAgentRuntimeForDataMigration(): Promise<void> {
  await requestHarmonyEmergencyStop("agent_data_directory_migration");
  const activeServer = server;
  server = undefined;
  serverUrl = undefined;
  await activeServer?.stop();
}

async function restoreAgentRuntimeAfterDataMigrationFailure(
  sourceDirectory: string,
): Promise<void> {
  if (!logger) return;
  piAgentDirectoryPath = sourceDirectory;
  const restoredRuntime = createStandaloneForProfile("normal");
  server = restoredRuntime.instance;
  try {
    const restoredUrl = await restoredRuntime.instance.start();
    serverUrl = restoredUrl;
    activateStandaloneProfile("normal", restoredRuntime.dataDirectory, restoredUrl);
    if (mainWindow && !mainWindow.isDestroyed()) {
      let rendererOrigin: string | undefined;
      try {
        rendererOrigin = new URL(mainWindow.webContents.getURL()).origin;
      } catch {
        // A startup/data URL has no reusable application origin.
      }
      if (rendererOrigin !== restoredUrl.origin) {
        await loadApplicationWindow(mainWindow, restoredUrl, logger);
      } else {
        logger.info("Kept the Settings renderer open after migration recovery", {
          origin: restoredUrl.origin,
        });
      }
    }
    logger.info("Restored the original Pi data directory after migration failure", {
      sourceDirectory,
    });
  } catch (error) {
    server = undefined;
    serverUrl = undefined;
    logger.error("Unable to restore the original Pi runtime after migration failure", error);
    // The persisted setting still points at the source directory. A clean
    // relaunch is the final recovery path if the in-process restart fails.
    setTimeout(() => {
      app.relaunch();
      app.quit();
    }, 250).unref();
    throw error;
  }
}

function registerAgentDataDirectoryHandlers(): void {
  ipcMain.removeHandler(AGENT_DATA_DIRECTORY_GET_CHANNEL);
  ipcMain.removeHandler(AGENT_DATA_DIRECTORY_PICKER_CHANNEL);
  ipcMain.removeHandler(AGENT_DATA_DIRECTORY_APPLY_CHANNEL);

  ipcMain.handle(AGENT_DATA_DIRECTORY_GET_CHANNEL, (event): AgentDataDirectoryInfo | null => {
    if (!isTrustedMainWindowSender(event)) return null;
    return currentAgentDataDirectoryInfo();
  });

  ipcMain.handle(
    AGENT_DATA_DIRECTORY_PICKER_CHANNEL,
    async (event, requestedDefaultPath: unknown): Promise<string | null> => {
      if (!isTrustedMainWindowSender(event)) return null;
      const ownerWindow = mainWindow;
      if (!ownerWindow || ownerWindow.isDestroyed()) return null;
      const result = await dialog.showOpenDialog(ownerWindow, {
        title: app.getLocale().toLowerCase().startsWith("zh") ? "选择 Pi 数据文件夹" : "Select Pi data folder",
        properties: ["openDirectory", "createDirectory"],
        ...(typeof requestedDefaultPath === "string" && requestedDefaultPath.trim()
          ? { defaultPath: resolve(requestedDefaultPath) }
          : {}),
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  );

  ipcMain.handle(
    AGENT_DATA_DIRECTORY_APPLY_CHANNEL,
    async (event, request: unknown): Promise<AgentDataDirectoryApplyResult> => {
      if (!isTrustedMainWindowSender(event) || !logger || !piAgentDirectoryPath) {
        return { ok: false, code: "invalid-path" };
      }
      if (process.env[PI_AGENT_DIRECTORY_ENV]?.trim()) {
        return { ok: false, code: "environment-override" };
      }
      if (runningTaskCount > 0) return { ok: false, code: "busy" };
      if (!request || typeof request !== "object") return { ok: false, code: "invalid-path" };
      const candidate = request as { directory?: unknown; migrate?: unknown };
      if (typeof candidate.directory !== "string" || typeof candidate.migrate !== "boolean") {
        return { ok: false, code: "invalid-path" };
      }
      if (!candidate.migrate) return { ok: false, code: "migration-required" };

      const sourceDirectory = piAgentDirectoryPath;
      let runtimeSuspended = false;
      try {
        const targetDirectory = validateAgentDataDirectory(
          candidate.directory,
          sourceDirectory,
          app.getPath("home"),
        );
        await preflightAgentDataDirectoryChange({
          targetDirectory,
          migrate: candidate.migrate,
        });
        runtimeSuspended = true;
        await suspendAgentRuntimeForDataMigration();
        await prepareAgentDataDirectoryChange({
          currentDirectory: sourceDirectory,
          targetDirectory,
          migrate: candidate.migrate,
        });
        const persisted = writePiAgentDirectory(
          app.getPath("userData"),
          targetDirectory === defaultPiAgentDirectory() ? null : targetDirectory,
          logger,
        );
        if (!persisted) {
          await restoreAgentRuntimeAfterDataMigrationFailure(sourceDirectory);
          runtimeSuspended = false;
          return { ok: false, code: "persist-failed" };
        }

        logger.info("Pi data directory change is ready; restarting Piora", {
          sourceDirectory,
          targetDirectory,
          migrated: candidate.migrate,
        });
        piAgentDirectoryPath = targetDirectory;
        setTimeout(() => {
          app.relaunch();
          app.quit();
        }, 250).unref();
        return {
          ok: true,
          currentDirectory: targetDirectory,
          ...(candidate.migrate ? { sourceDirectory } : {}),
        };
      } catch (error) {
        logger.warn("Unable to change the Pi data directory", error);
        if (runtimeSuspended) {
          try {
            await restoreAgentRuntimeAfterDataMigrationFailure(sourceDirectory);
          } catch (restoreError) {
            logger.error("Pi data migration rollback requires an application relaunch", restoreError);
          }
        }
        if (error instanceof AgentDataDirectoryError) {
          return { ok: false, code: error.code, error: error.message };
        }
        return { ok: false, code: "migration-failed", error: error instanceof Error ? error.message : String(error) };
      }
    },
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveConfiguredPath(value: string): string {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function resolveStandaloneServerEntry(): string {
  const configuredEntry = process.env.PI_DESKTOP_SERVER_ENTRY?.trim();
  if (configuredEntry) {
    const resolvedEntry = resolveConfiguredPath(configuredEntry);
    if (!isFile(resolvedEntry)) {
      throw new Error(`PI_DESKTOP_SERVER_ENTRY is not a file: ${resolvedEntry}`);
    }
    return resolvedEntry;
  }

  const appPath = app.getAppPath();
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, "web", "server.js"),
        join(process.resourcesPath, "web", "server.cjs"),
      ]
    : [
        join(appPath, "..", ".next", "standalone", "server.js"),
        join(process.cwd(), ".next", "standalone", "server.js"),
        join(appPath, ".next", "standalone", "server.js"),
      ];

  const entry = candidates.find(isFile);
  if (entry) return entry;

  throw new Error(
    [
      "Next standalone output was not found.",
      "Create it in the release pipeline, or set PI_DESKTOP_SERVER_ENTRY to server.js.",
      `Checked: ${candidates.join(", ")}`,
    ].join(" "),
  );
}

function isAllowedAppUrl(rawUrl: string, allowedOrigin: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "http:" && parsed.origin === allowedOrigin;
  } catch {
    return false;
  }
}

function openExternalUrl(rawUrl: string, log: Logger): void {
  try {
    const parsed = new URL(rawUrl);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || parsed.username
      || parsed.password
    ) {
      log.warn("Blocked unsupported external URL", { protocol: parsed.protocol });
      return;
    }

    void shell.openExternal(parsed.toString()).catch((error) => {
      log.warn("Unable to open external URL", error);
    });
  } catch (error) {
    log.warn("Blocked malformed external URL", error);
  }
}

function configureSession(runtimeSession: Session, origin: string, token: string): void {
  const applicationUrl = new URL(origin);
  const isAllowedOrigin = (rawOrigin: string | undefined): boolean => {
    if (!rawOrigin) return false;
    try {
      return new URL(rawOrigin).origin === origin;
    } catch {
      return false;
    }
  };

  runtimeSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin, details) => {
      if (!details.isMainFrame || !isAllowedOrigin(requestingOrigin)) return false;
      if (permission === "clipboard-sanitized-write") return true;
      // Voice input only needs the headset microphone. Keep camera and any
      // unknown media permission denied by default.
      return permission === "media" && details.mediaType === "audio";
    },
  );
  runtimeSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const requestingUrl = "requestingUrl" in details ? details.requestingUrl : undefined;
    const securityOrigin = "securityOrigin" in details ? details.securityOrigin : undefined;
    const rawOrigin = securityOrigin ?? requestingUrl;
    if (!details.isMainFrame || !isAllowedOrigin(rawOrigin)) {
      callback(false);
      return;
    }
    if (permission === "clipboard-sanitized-write") {
      callback(true);
      return;
    }
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
    callback(
      permission === "media"
      && Boolean(mediaTypes?.length)
      && mediaTypes?.every((mediaType) => mediaType === "audio") === true,
    );
  });

  // The token never enters renderer JavaScript. Electron injects it only for
  // requests to this exact loopback origin; the server can enforce it through
  // PI_DESKTOP_TOKEN without exposing credentials to the page.
  runtimeSession.webRequest.onBeforeSendHeaders(
    { urls: ["http://127.0.0.1/*", "ws://127.0.0.1/*"] },
    (details, callback) => {
      if (isDesktopApplicationTransportUrl(details.url, applicationUrl)) {
        details.requestHeaders[DESKTOP_TOKEN_HEADER] = token;
      }
      callback({ requestHeaders: details.requestHeaders });
    },
  );
}

async function waitForDesktopDevelopmentServer(url: URL): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolveConnection) => {
      const socket = createConnection({ host: url.hostname, port: Number(url.port) });
      const settle = (value: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolveConnection(value);
      };
      socket.setTimeout(1_000, () => settle(false));
      socket.once("connect", () => settle(true));
      socket.once("error", () => settle(false));
    });
    if (connected) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 175));
  }
  throw new Error("Desktop development server was not reachable on loopback within 60 seconds");
}

function emitCompanionMotionState(direction: CompanionMotionDirection | null): void {
  if (!companionWindow || companionWindow.isDestroyed()) return;
  companionWindow.webContents.send(COMPANION_MOTION_STATE_CHANNEL, {
    moving: direction !== null,
    direction,
  });
}

function positionCompanionBubble(petBounds?: Electron.Rectangle): void {
  if (!companionWindow || companionWindow.isDestroyed() || !companionBubbleWindow || companionBubbleWindow.isDestroyed()) return;
  const pet = petBounds ?? companionWindow.getBounds();
  const display = screen.getDisplayNearestPoint({ x: pet.x + Math.round(pet.width / 2), y: pet.y });
  const area = display.workArea;
  const x = Math.min(
    Math.max(Math.round(pet.x + pet.width / 2 - COMPANION_BUBBLE_WIDTH / 2), area.x),
    area.x + Math.max(0, area.width - COMPANION_BUBBLE_WIDTH),
  );
  const y = Math.max(area.y, pet.y - COMPANION_BUBBLE_HEIGHT + 16);
  // Keep the speech surface on the exact same planned coordinates as the pet.
  // Reading getBounds() immediately after setPosition() can return the previous
  // native-window position on Windows and makes the bubble visibly trail.
  companionBubbleWindow.setPosition(x, y, false);
}

function stopCompanionWindowMotion(): boolean {
  companionMotionRevision += 1;
  if (companionMotionTimer) clearInterval(companionMotionTimer);
  companionMotionTimer = undefined;
  emitCompanionMotionState(null);
  return true;
}

function startCompanionWindowMotion(input: {
  distance: number;
  durationMs: number;
  direction?: CompanionMotionDirection;
  pattern?: CompanionMotionPattern;
  angleRadians?: number;
  curvature?: number;
  clockwise?: boolean;
}): { ok: boolean; direction?: CompanionMotionDirection; durationMs?: number } {
  if (!companionWindow || companionWindow.isDestroyed()) return { ok: false };
  const bounds = companionWindow.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2),
  });
  const plan = planCompanionMotion(
    bounds,
    display.workArea,
    input,
  );
  if (!plan) return { ok: false };

  stopCompanionWindowMotion();
  const revision = ++companionMotionRevision;
  const startedAt = Date.now();
  let facingDirection = plan.direction;
  emitCompanionMotionState(facingDirection);
  companionMotionTimer = setInterval(() => {
    if (revision !== companionMotionRevision || !companionWindow || companionWindow.isDestroyed()) {
      if (companionMotionTimer) clearInterval(companionMotionTimer);
      companionMotionTimer = undefined;
      return;
    }
    const elapsed = Date.now() - startedAt;
    const point = companionMotionPoint(plan, elapsed);
    companionWindow.setPosition(point.x, point.y, false);
    const nextFacingDirection = companionFacingDirection(plan, elapsed, facingDirection);
    if (nextFacingDirection !== facingDirection) {
      facingDirection = nextFacingDirection;
      emitCompanionMotionState(facingDirection);
    }
    positionCompanionBubble({ ...bounds, x: point.x, y: point.y });
    if (elapsed < plan.durationMs) return;
    const finalPoint = companionMotionPoint(plan, plan.durationMs);
    companionWindow.setPosition(finalPoint.x, finalPoint.y, false);
    positionCompanionBubble({ ...bounds, x: finalPoint.x, y: finalPoint.y });
    stopCompanionWindowMotion();
  }, 16);
  companionMotionTimer.unref?.();
  return { ok: true, direction: plan.direction, durationMs: plan.durationMs };
}

function startCompanionWindowDrag(): boolean {
  if (!companionWindow || companionWindow.isDestroyed()) return false;
  stopCompanionWindowMotion();
  companionDragState = {
    pointerStart: screen.getCursorScreenPoint(),
    startingBounds: companionWindow.getBounds(),
  };
  return true;
}

function updateCompanionWindowDrag(): boolean {
  if (!companionDragState || !companionWindow || companionWindow.isDestroyed()) return false;
  const pointer = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(pointer);
  const target = dragCompanionBounds(
    companionDragState.startingBounds,
    companionDragState.pointerStart,
    pointer,
    display.workArea,
  );
  companionWindow.setPosition(target.x, target.y, false);
  positionCompanionBubble(target);
  return true;
}

function finishCompanionWindowDrag(): boolean {
  const hadDrag = Boolean(companionDragState);
  companionDragState = undefined;
  return hadDrag;
}

function getCompanionWindowPosition(): { x: number; y: number } {
  const saved = logger ? readCompanionWindowPosition(app.getPath("userData"), logger) : undefined;
  const display = saved
    ? screen.getDisplayNearestPoint(saved)
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const defaultX = area.x + area.width - COMPANION_COMPACT_WIDTH - 24;
  const defaultY = area.y + area.height - COMPANION_COMPACT_HEIGHT - 24;
  return {
    x: Math.min(Math.max(saved?.x ?? defaultX, area.x), area.x + Math.max(0, area.width - COMPANION_COMPACT_WIDTH)),
    y: Math.min(Math.max(saved?.y ?? defaultY, area.y), area.y + Math.max(0, area.height - COMPANION_COMPACT_HEIGHT)),
  };
}

function getNormalizedCompanionPosition(bounds: Electron.Rectangle): { x: number; y: number } {
  return { x: Math.round(bounds.x), y: Math.round(bounds.y) };
}

function setCompanionWindowExpanded(expanded: boolean): boolean {
  // Kept for compatibility with older renderers. Speech and task UI now live
  // in independent windows, so the pet hit box never changes size.
  void expanded;
  return Boolean(companionWindow && !companionWindow.isDestroyed());
}

function applyCompanionWindowAlwaysOnTop(window: BrowserWindow, alwaysOnTop: boolean): void {
  window.setAlwaysOnTop(alwaysOnTop, alwaysOnTop ? "screen-saver" : "normal");
  window.setVisibleOnAllWorkspaces(alwaysOnTop, { visibleOnFullScreen: alwaysOnTop });
}

function setCompanionWindowAlwaysOnTop(alwaysOnTop: boolean): boolean {
  companionAlwaysOnTop = alwaysOnTop;
  if (companionWindow && !companionWindow.isDestroyed()) {
    applyCompanionWindowAlwaysOnTop(companionWindow, alwaysOnTop);
  }
  if (companionBubbleWindow && !companionBubbleWindow.isDestroyed()) applyCompanionWindowAlwaysOnTop(companionBubbleWindow, alwaysOnTop);
  return true;
}

function createCompanionWindow(url: URL, log: Logger): BrowserWindow {
  const position = getCompanionWindowPosition();
  const window = new BrowserWindow({
    ...position,
    width: COMPANION_COMPACT_WIDTH,
    height: COMPANION_COMPACT_HEIGHT,
    minWidth: COMPANION_COMPACT_WIDTH,
    minHeight: COMPANION_COMPACT_HEIGHT,
    maxWidth: COMPANION_COMPACT_WIDTH,
    maxHeight: COMPANION_COMPACT_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: companionAlwaysOnTop,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      partition: DESKTOP_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      devTools: !app.isPackaged || process.env.PI_DESKTOP_DEVTOOLS === "1",
    },
  });

  installRendererDiagnostics(window, "Companion", log);

  applyCompanionWindowAlwaysOnTop(window, companionAlwaysOnTop);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, requestedUrl) => {
    if (!isAllowedAppUrl(requestedUrl, url.origin)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, requestedUrl) => {
    if (!isAllowedAppUrl(requestedUrl, url.origin)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("context-menu", () => {
    if (window.isDestroyed()) return;
    Menu.buildFromTemplate([
      { label: "打开 Piora", click: () => { focusMainWindow(); } },
      { label: "打开随身舱", click: () => { showCompanionPanel(); } },
      { label: "桌宠设置", click: () => { focusMainWindow("companion-settings"); } },
      { type: "separator" },
      {
        label: "隐藏桌宠",
        click: () => {
          closeCompanionWindow();
          mainWindow?.webContents.send("pi:menu-action", "hide-companion");
        },
      },
    ]).popup({ window });
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (isMainFrame) log.error("Companion page failed to load", { errorCode, errorDescription, validatedUrl });
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    log.error("Companion renderer exited", details);
    if (companionWindow === window) {
      stopCompanionWindowMotion();
      companionDragState = undefined;
      companionWindow = null;
      window.destroy();
    }
  });
  window.once("ready-to-show", () => {
    if (companionWindow === window && companionShouldBeVisible) {
      window.setIgnoreMouseEvents(true, { forward: true });
      window.showInactive();
    }
  });
  window.on("move", () => {
    // Programmatic motion and pointer dragging already position both native
    // windows from one coordinate snapshot. Do not race that update with a
    // delayed Windows `move` event carrying an older pet position.
    if (!companionMotionTimer && !companionDragState) positionCompanionBubble();
    if (companionMoveTimer) clearTimeout(companionMoveTimer);
    companionMoveTimer = setTimeout(() => {
      if (!companionWindow || companionWindow.isDestroyed() || !logger) return;
      writeCompanionWindowPosition(
        app.getPath("userData"),
        getNormalizedCompanionPosition(companionWindow.getBounds()),
        logger,
      );
    }, 180);
  });
  window.on("closed", () => {
    if (companionMoveTimer) clearTimeout(companionMoveTimer);
    companionMoveTimer = undefined;
    if (companionWindow === window) {
      stopCompanionWindowMotion();
      companionDragState = undefined;
      companionWindow = null;
    }
  });
  void window.loadURL(new URL("/desktop-pet", url).toString());
  return window;
}

function createCompanionBubbleWindow(url: URL, log: Logger): BrowserWindow {
  const window = new BrowserWindow({
    width: COMPANION_BUBBLE_WIDTH,
    height: COMPANION_BUBBLE_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    alwaysOnTop: companionAlwaysOnTop,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "preload.js"), partition: DESKTOP_PARTITION, sandbox: true,
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, webviewTag: false,
      webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, safeDialogs: true,
      devTools: !app.isPackaged,
    },
  });
  installRendererDiagnostics(window, "Companion", log);
  applyCompanionWindowAlwaysOnTop(window, companionAlwaysOnTop);
  window.setIgnoreMouseEvents(true, { forward: true });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, requestedUrl) => { if (!isAllowedAppUrl(requestedUrl, url.origin)) event.preventDefault(); });
  window.on("closed", () => { if (companionBubbleWindow === window) companionBubbleWindow = null; });
  void window.loadURL(new URL("/desktop-companion-bubble", url).toString());
  return window;
}

function createCompanionPanelWindow(url: URL, log: Logger): BrowserWindow {
  companionPanelKeepVisibleUntilClose = false;
  const display = screen.getPrimaryDisplay().workArea;
  const window = new BrowserWindow({
    width: COMPANION_PANEL_WIDTH,
    height: Math.min(COMPANION_PANEL_HEIGHT, display.height - 40),
    minWidth: 390,
    minHeight: 520,
    focusable: true,
    show: false,
    title: "Piora 随身舱",
    backgroundColor: "#f8f3ed",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.js"), partition: DESKTOP_PARTITION, sandbox: true,
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, webviewTag: false,
      webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, safeDialogs: true,
      devTools: !app.isPackaged,
    },
  });
  installRendererDiagnostics(window, "Companion", log);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, requestedUrl) => { if (!isAllowedAppUrl(requestedUrl, url.origin)) event.preventDefault(); });
  window.once("ready-to-show", () => {
    window.show();
    window.focus();
  });
  window.on("blur", () => {
    if (!companionPanelKeepVisibleUntilClose && !window.isDestroyed() && window.isVisible()) window.hide();
  });
  window.on("maximize", () => { companionPanelKeepVisibleUntilClose = true; });
  window.on("unmaximize", () => { companionPanelKeepVisibleUntilClose = false; });
  window.on("close", (event) => {
    if (quitRequested || shutdownComplete) return;
    event.preventDefault();
    companionPanelKeepVisibleUntilClose = false;
    window.hide();
  });
  window.on("closed", () => {
    companionPanelKeepVisibleUntilClose = false;
    if (companionPanelWindow === window) companionPanelWindow = null;
  });
  void window.loadURL(new URL("/desktop-companion-panel", url).toString());
  return window;
}

function showCompanionPanel(): boolean {
  if (!serverUrl || !logger) return false;
  if (!companionPanelWindow || companionPanelWindow.isDestroyed()) {
    companionPanelWindow = createCompanionPanelWindow(serverUrl, logger);
    return true;
  }
  if (companionPanelWindow.isMinimized()) companionPanelWindow.restore();
  companionPanelKeepVisibleUntilClose = companionPanelWindow.isMaximized();
  companionPanelWindow.show();
  companionPanelWindow.focus();
  return true;
}

function toggleCompanionPanel(): boolean {
  if (
    companionPanelWindow
    && !companionPanelWindow.isDestroyed()
    && companionPanelWindow.isFocused()
  ) {
    companionPanelKeepVisibleUntilClose = false;
    companionPanelWindow.hide();
    return true;
  }
  return showCompanionPanel();
}

function syncCompanionPanelShortcut(): boolean {
  const next = toElectronAccelerator(keyboardShortcutBindings["companion.togglePanel"]);
  if (companionPanelShortcutAccelerator) {
    globalShortcut.unregister(companionPanelShortcutAccelerator);
    companionPanelShortcutAccelerator = undefined;
  }
  if (!next) return true;
  if (!globalShortcut.register(next, toggleCompanionPanel)) {
    logger?.warn("Unable to register companion panel shortcut", { accelerator: next });
    return false;
  }
  companionPanelShortcutAccelerator = next;
  return true;
}

function showCompanionWindow(): boolean {
  if (!serverUrl || !logger) return false;
  companionShouldBeVisible = true;
  if (!companionWindow || companionWindow.isDestroyed()) {
    companionWindow = createCompanionWindow(serverUrl, logger);
  }
  if (!companionBubbleWindow || companionBubbleWindow.isDestroyed()) {
    companionBubbleWindow = createCompanionBubbleWindow(serverUrl, logger);
  }
  companionWindow.showInactive();
  companionBubbleWindow.showInactive();
  positionCompanionBubble();
  updateTrayMenu();
  return true;
}

function closeCompanionWindow(): void {
  companionShouldBeVisible = false;
  if (!companionWindow || companionWindow.isDestroyed()) return;
  stopCompanionWindowMotion();
  companionDragState = undefined;
  if (logger) {
    writeCompanionWindowPosition(
      app.getPath("userData"),
      getNormalizedCompanionPosition(companionWindow.getBounds()),
      logger,
    );
  }
  companionWindow.destroy();
  companionWindow = null;
  if (companionBubbleWindow && !companionBubbleWindow.isDestroyed()) companionBubbleWindow.destroy();
  companionBubbleWindow = null;
  updateTrayMenu();
}

function focusMainWindow(action?: string): boolean {
  if ((!mainWindow || mainWindow.isDestroyed()) && serverUrl && logger) {
    mainWindow = createMainWindow(serverUrl, logger);
  }
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (action) mainWindow.webContents.send("pi:menu-action", action);
  return true;
}

function persistMainWindowState(window: BrowserWindow): void {
  if (!logger || window.isDestroyed()) return;
  const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
  writeMainWindowState(app.getPath("userData"), { ...bounds, maximized: window.isMaximized() }, logger);
}

function getInitialMainWindowState(log: Logger): { x?: number; y?: number; width: number; height: number; maximized: boolean } {
  const saved = readMainWindowState(app.getPath("userData"), log);
  if (!saved) return { width: 1440, height: 920, maximized: false };
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const fitted = fitBoundsToVisibleDisplays(
    saved,
    screen.getAllDisplays().map((display) => display.workArea),
    primaryWorkArea,
    { width: 640, height: 480 },
  );
  return { ...fitted, maximized: saved.maximized };
}

function reconcileWindowToDisplays(window: BrowserWindow, minimumSize: { width: number; height: number }): void {
  if (window.isDestroyed()) return;
  const wasMaximized = window.isMaximized();
  const current = wasMaximized ? window.getNormalBounds() : window.getBounds();
  const fitted = fitBoundsToVisibleDisplays(
    current,
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea,
    minimumSize,
  );
  if (fitted === current) return;
  if (wasMaximized) window.unmaximize();
  window.setBounds(fitted);
  if (wasMaximized) window.maximize();
}

function handleDisplayConfigurationChanged(): void {
  if (mainWindow) reconcileWindowToDisplays(mainWindow, { width: 640, height: 480 });
  if (companionWindow && !companionWindow.isDestroyed()) {
    const bounds = companionWindow.getBounds();
    reconcileWindowToDisplays(companionWindow, { width: bounds.width, height: bounds.height });
  }
}

function installDisplayReconciliation(): void {
  screen.on("display-added", handleDisplayConfigurationChanged);
  screen.on("display-removed", handleDisplayConfigurationChanged);
  screen.on("display-metrics-changed", handleDisplayConfigurationChanged);
}

function removeDisplayReconciliation(): void {
  screen.removeListener("display-added", handleDisplayConfigurationChanged);
  screen.removeListener("display-removed", handleDisplayConfigurationChanged);
  screen.removeListener("display-metrics-changed", handleDisplayConfigurationChanged);
}

function installNativeContextMenu(window: BrowserWindow): void {
  window.webContents.on("context-menu", (_event, params) => {
    const template: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: "undo" }, { role: "redo" }, { type: "separator" },
          { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
        ]
      : params.selectionText ? [{ role: "copy" }, { role: "selectAll" }] : [];
    if (template.length) Menu.buildFromTemplate(template).popup({ window });
  });
}

function updateTrayMenu(): void {
  if (!tray) return;
  const isChinese = app.getLocale().toLowerCase().startsWith("zh");
  tray.setToolTip(runningTaskCount > 0 ? `Piora · ${runningTaskCount}` : "Piora");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: isChinese ? "显示 Piora" : "Show Piora", click: () => focusMainWindow() },
    { label: isChinese ? "新任务" : "New task", click: () => focusMainWindow("new-session") },
    { label: isChinese ? "打开随身舱" : "Open companion panel", click: () => showCompanionPanel() },
    {
      label: companionShouldBeVisible ? (isChinese ? "隐藏桌宠" : "Hide companion") : (isChinese ? "显示桌宠" : "Show companion"),
      click: () => mainWindow?.webContents.send("pi:menu-action", "toggle-companion"),
    },
    { label: isChinese ? `运行中任务：${runningTaskCount}` : `Running tasks: ${runningTaskCount}`, enabled: false },
    { type: "separator" },
    {
      label: isChinese ? "彻底退出 Piora" : "Quit Piora completely",
      click: () => {
        quitRequested = true;
        app.quit();
      },
    },
  ]));
}

async function refreshTrayTaskCount(): Promise<void> {
  if (!serverUrl || !applicationToken) return;
  try {
    const response = await fetch(new URL("/api/agent/running", serverUrl), { headers: { [DESKTOP_TOKEN_HEADER]: applicationToken } });
    if (!response.ok) return;
    const payload = await response.json() as { runningSessionIds?: unknown[] };
    const next = Array.isArray(payload.runningSessionIds) ? payload.runningSessionIds.length : 0;
    if (next !== runningTaskCount) { runningTaskCount = next; updateTrayMenu(); }
  } catch { /* The next poll retries after transient server errors. */ }
}

function installTray(): void {
  if (tray) return;
  const candidates = [
    join(process.resourcesPath, process.platform === "win32" ? "tray-icon.ico" : "tray-icon.png"),
    join(process.resourcesPath, "tray-icon.ico"),
    join(process.resourcesPath, "tray-icon.png"),
    join(app.getAppPath(), "build", "icon.ico"),
    join(__dirname, "..", "build", "icon.ico"),
    process.execPath,
  ];
  const image = candidates.map((candidate) => nativeImage.createFromPath(candidate)).find((candidate) => !candidate.isEmpty());
  if (!image) {
    logger?.warn("Unable to load the system tray icon", { candidates });
    return;
  }
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.on("click", () => focusMainWindow());
  tray.on("double-click", () => focusMainWindow());
  updateTrayMenu();
  trayPollTimer = setInterval(() => { void refreshTrayTaskCount(); }, 2_500);
  trayPollTimer.unref();
  void refreshTrayTaskCount();
}

function registerGlobalShortcutHandler(): void {
  ipcMain.removeHandler(GLOBAL_SHORTCUT_CHANNEL);
  ipcMain.handle(GLOBAL_SHORTCUT_CHANNEL, (event, enabled: unknown): boolean => {
    if (!isTrustedMainWindowSender(event) || typeof enabled !== "boolean") return false;
    globalShortcut.unregister("CommandOrControl+Alt+P");
    return !enabled || globalShortcut.register("CommandOrControl+Alt+P", () => focusMainWindow("new-session"));
  });
}

function registerAutoLaunchHandlers(): void {
  const options = resolveDesktopLoginItemOptions({
    platform: process.platform,
    isPackaged: app.isPackaged,
    isSmokeTest: PORTABLE_SMOKE_TEST,
    executablePath: process.execPath,
    ...(process.env.PORTABLE_EXECUTABLE_FILE
      ? { portableExecutablePath: process.env.PORTABLE_EXECUTABLE_FILE }
      : {}),
  });
  const controller: DesktopLoginItemController = {
    getLoginItemSettings: (requestedOptions) => app.getLoginItemSettings(requestedOptions),
    setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
  };

  ipcMain.removeHandler(AUTO_LAUNCH_GET_CHANNEL);
  ipcMain.removeHandler(AUTO_LAUNCH_SET_CHANNEL);
  ipcMain.handle(AUTO_LAUNCH_GET_CHANNEL, (event): DesktopAutoLaunchState => {
    if (!isTrustedMainWindowSender(event)) return { supported: false, enabled: false };
    return readDesktopAutoLaunchState(controller, process.platform, options);
  });
  ipcMain.handle(AUTO_LAUNCH_SET_CHANNEL, (event, enabled: unknown): DesktopAutoLaunchState => {
    if (!isTrustedMainWindowSender(event) || typeof enabled !== "boolean") {
      return { supported: false, enabled: false };
    }
    const state = updateDesktopAutoLaunchState(controller, process.platform, options, enabled);
    if (state.error) logger?.warn("Unable to update auto-launch setting", { error: state.error });
    return state;
  });
}

function createStandaloneForProfile(profile: RuntimeProfile): {
  instance: StandaloneServer;
  dataDirectory: string;
} {
  if (!logger || !serverEntryPath || !serverHostEntryPath || !applicationToken || !piAgentDirectoryPath) {
    throw new Error("Desktop runtime is not ready for a profile switch");
  }
  const dataDirectory = runtimeProfileDataDirectory(app.getPath("userData"), profile);
  mkdirSync(dataDirectory, { recursive: true });
  const preferredPort = readPreferredServerPort(app.getPath("userData"), logger);
  const packagedRuntimeArchive = join(dirname(serverEntryPath), "runtime.asar");
  if (app.isPackaged && !existsSync(packagedRuntimeArchive)) {
    throw new Error(`Packaged web runtime archive is missing: ${packagedRuntimeArchive}`);
  }
  const instance = new StandaloneServer({
    serverEntry: serverEntryPath,
    serverHostEntry: serverHostEntryPath,
    runtimeRoot: app.isPackaged ? packagedRuntimeArchive : dirname(serverEntryPath),
    ...(app.isPackaged ? { nodePath: join(packagedRuntimeArchive, "node_modules") } : {}),
    homeDirectory: app.getPath("home"),
    agentDirectory: piAgentDirectoryPath,
    speechPacksDirectory: join(app.getPath("userData"), "speech-packs"),
    harmonyToolsDirectory: app.isPackaged
      ? join(process.resourcesPath, "harmony-tools")
      : join(app.getAppPath(), "..", "third_party", "harmony-tools", process.platform === "win32" ? "windows-x64" : process.platform),
    token: applicationToken,
    logger,
    runtimeProfile: profile,
    desktopDataDirectory: dataDirectory,
    onMessage: handleStandaloneMessage,
    ...(preferredPort === undefined ? {} : { preferredPort }),
    onUnexpectedExit: handleUnexpectedServerExit,
  });
  return { instance, dataDirectory };
}

function activateStandaloneProfile(profile: RuntimeProfile, dataDirectory: string, nextUrl: URL): URL {
  if (!logger || !applicationToken) throw new Error("Desktop runtime is not ready to activate a profile");
  process.env.PIORA_RUNTIME_PROFILE = profile;
  process.env.PIORA_DESKTOP_DATA_DIR = dataDirectory;
  writePreferredServerPort(app.getPath("userData"), Number(nextUrl.port), logger);
  const runtimeSession = electronSession.fromPartition(DESKTOP_PARTITION, { cache: true });
  configureSession(runtimeSession, nextUrl.origin, applicationToken);
  return nextUrl;
}

async function requestHarmonyEmergencyStop(reason: string): Promise<void> {
  if (!serverUrl || !applicationToken) return;
  try {
    const response = await fetch(new URL("/api/harmony/action", serverUrl), {
      method: "POST",
      headers: {
        [DESKTOP_TOKEN_HEADER]: applicationToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "emergency_stop", reason }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) logger?.warn("Harmony emergency stop was rejected during runtime shutdown", { status: response.status });
  } catch (error) {
    logger?.warn("Unable to request Harmony emergency stop during runtime shutdown", error);
  }
}

function registerHarmonyRuntimePickerHandler(): void {
  ipcMain.removeHandler(HARMONY_RUNTIME_PICKER_CHANNEL);
  ipcMain.handle(HARMONY_RUNTIME_PICKER_CHANNEL, async (event, kind: unknown): Promise<string | null> => {
    if (!isTrustedMainWindowSender(event)) return null;
    if (kind !== "sdk" && kind !== "hdc") return null;
    const ownerWindow = mainWindow;
    if (!ownerWindow || ownerWindow.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(ownerWindow, kind === "sdk"
      ? { title: "Select HarmonyOS SDK directory", properties: ["openDirectory"] }
      : {
          title: "Select hdc executable",
          properties: ["openFile"],
          ...(process.platform === "win32"
            ? { filters: [{ name: "Harmony Device Connector", extensions: ["exe"] }] }
            : {}),
        });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
}

function registerCompanionWindowHandlers(): void {
  ipcMain.removeHandler(COMPANION_VISIBILITY_CHANNEL);
  ipcMain.removeHandler(COMPANION_ALWAYS_ON_TOP_CHANNEL);
  ipcMain.removeHandler(COMPANION_LAYOUT_CHANNEL);
  ipcMain.removeHandler(COMPANION_MOTION_CHANNEL);
  ipcMain.removeHandler(COMPANION_HIT_TEST_CHANNEL);
  ipcMain.handle(COMPANION_VISIBILITY_CHANNEL, (event, visible: unknown): boolean => {
    if (!isTrustedCompletionNotificationSender(event) || typeof visible !== "boolean") return false;
    if (visible) return showCompanionWindow();
    closeCompanionWindow();
    return true;
  });

  ipcMain.handle(COMPANION_ALWAYS_ON_TOP_CHANNEL, (event, alwaysOnTop: unknown): boolean => {
    if (!isTrustedMainWindowSender(event) || typeof alwaysOnTop !== "boolean") return false;
    return setCompanionWindowAlwaysOnTop(alwaysOnTop);
  });

  ipcMain.handle(COMPANION_LAYOUT_CHANNEL, (event, expanded: unknown): boolean => {
    if (!isTrustedCompanionWindowSender(event) || typeof expanded !== "boolean") return false;
    return setCompanionWindowExpanded(expanded);
  });

  ipcMain.handle(COMPANION_MOTION_CHANNEL, (event, input: unknown) => {
    if (!isTrustedCompanionWindowSender(event) || !input || typeof input !== "object") {
      return { ok: false };
    }
    const request = input as Record<string, unknown>;
    if (request.kind === "stop") return { ok: stopCompanionWindowMotion() };
    if (request.kind === "drag-end") return { ok: finishCompanionWindowDrag() };
    if (request.kind === "drag-start" || request.kind === "drag-move") {
      return {
        ok: request.kind === "drag-start"
          ? startCompanionWindowDrag()
          : updateCompanionWindowDrag(),
      };
    }
    if (request.kind !== "walk") return { ok: false };
    if (Date.now() - companionLastAutonomousMotionAt < 1_500) return { ok: false };
    companionLastAutonomousMotionAt = Date.now();
    const direction = request.direction === "left" || request.direction === "right"
      ? request.direction
      : undefined;
    const pattern = request.pattern === "line" || request.pattern === "arc" || request.pattern === "orbit"
      ? request.pattern
      : undefined;
    const distance = Number.isFinite(request.distance) ? Number(request.distance) : 120;
    const durationMs = Number.isFinite(request.durationMs) ? Number(request.durationMs) : 2_400;
    const angleRadians = Number.isFinite(request.angleRadians) ? Number(request.angleRadians) : undefined;
    const curvature = Number.isFinite(request.curvature) ? Number(request.curvature) : undefined;
    const clockwise = typeof request.clockwise === "boolean" ? request.clockwise : undefined;
    return startCompanionWindowMotion({
      distance,
      durationMs,
      ...(direction ? { direction } : {}),
      ...(pattern ? { pattern } : {}),
      ...(angleRadians !== undefined ? { angleRadians } : {}),
      ...(curvature !== undefined ? { curvature } : {}),
      ...(clockwise !== undefined ? { clockwise } : {}),
    });
  });

  ipcMain.handle(COMPANION_HIT_TEST_CHANNEL, (event, interactive: unknown): boolean => {
    if (!isTrustedCompanionWindowSender(event) || typeof interactive !== "boolean" || !companionWindow || companionWindow.isDestroyed()) return false;
    companionWindow.setIgnoreMouseEvents(!interactive, { forward: true });
    return true;
  });

  ipcMain.removeHandler(COMPANION_ACTION_CHANNEL);
  ipcMain.handle(COMPANION_ACTION_CHANNEL, (event, action: unknown): boolean => {
    if (!isTrustedCompletionNotificationSender(event) && !isTrustedCompanionSurfaceSender(event) || typeof action !== "string") return false;
    if (action === "focus-main") return focusMainWindow();
    if (action === "open-settings") return focusMainWindow("companion-settings");
    if (action === "open-panel") return showCompanionPanel();
    if (action === "hide") {
      companionWindow?.hide();
      setTimeout(closeCompanionWindow, 0);
      mainWindow?.webContents.send("pi:menu-action", "hide-companion");
      return true;
    }
    return false;
  });
}

interface MainWindowShell {
  window: BrowserWindow;
  initialState: ReturnType<typeof getInitialMainWindowState>;
}

function createMainWindowShell(log: Logger): MainWindowShell {
  // Windows keeps native resize/minimize/maximize/close behavior, but places
  // those controls over the renderer-owned, Codex-style title strip. The full
  // native title and menu rows stay hidden; the installed Menu still owns
  // accelerators and supplies the popup submenus opened by the renderer.
  const integratedTitleBar = process.platform === "win32"
    ? {
        titleBarStyle: "hidden" as const,
        titleBarOverlay: {
          color: "#00000000",
          symbolColor: "#737373",
          height: DESKTOP_TITLE_BAR_HEIGHT,
        },
      }
    : process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const }
      : {};

  const initialState = getInitialMainWindowState(log);
  const window = new BrowserWindow({
    ...(initialState.x === undefined ? {} : { x: initialState.x }),
    ...(initialState.y === undefined ? {} : { y: initialState.y }),
    width: initialState.width,
    height: initialState.height,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: "Piora",
    backgroundColor: STARTUP_SHELL_BACKGROUND,
    autoHideMenuBar: true,
    ...integratedTitleBar,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      partition: DESKTOP_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      devTools: !app.isPackaged || process.env.PI_DESKTOP_DEVTOOLS === "1",
    },
  });

  installRendererDiagnostics(window, "Main", log);

  const scheduleWindowStateWrite = () => {
    if (mainWindowStateTimer) clearTimeout(mainWindowStateTimer);
    mainWindowStateTimer = setTimeout(() => persistMainWindowState(window), 180);
  };
  window.on("move", scheduleWindowStateWrite);
  window.on("resize", scheduleWindowStateWrite);
  window.on("maximize", scheduleWindowStateWrite);
  window.on("unmaximize", scheduleWindowStateWrite);
  window.on("close", (event) => {
    if (quitRequested || PORTABLE_SMOKE_TEST) return;
    event.preventDefault();
    window.hide();
  });
  window.on("closed", () => {
    if (mainWindowStateTimer) clearTimeout(mainWindowStateTimer);
    mainWindowStateTimer = undefined;
    if (mainWindow === window) mainWindow = null;
  });

  return { window, initialState };
}

function loadApplicationWindow(window: BrowserWindow, url: URL, log: Logger): Promise<void> {
  const allowedOrigin = url.origin;
  window.webContents.setWindowOpenHandler(({ url: requestedUrl }) => {
    if (!isAllowedAppUrl(requestedUrl, allowedOrigin)) {
      openExternalUrl(requestedUrl, log);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, requestedUrl) => {
    if (!isAllowedAppUrl(requestedUrl, allowedOrigin)) event.preventDefault();
  });

  window.webContents.on("will-redirect", (event, requestedUrl) => {
    if (!isAllowedAppUrl(requestedUrl, allowedOrigin)) event.preventDefault();
  });

  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  installNativeContextMenu(window);
  window.webContents.on("render-process-gone", (_event, details) => {
    log.error("Renderer process exited", details);
  });
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame) {
        log.error("Application page failed to load", {
          errorCode,
          errorDescription,
          validatedUrl,
        });
      }
    },
  );

  return window.loadURL(url.toString()).then(() => undefined);
}

function warmInitialModelCatalog(url: URL, token: string, log: Logger): void {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  void fetch(new URL("/api/models", url), {
    headers: { [DESKTOP_TOKEN_HEADER]: token },
    signal: controller.signal,
  }).then(async (response) => {
    const payload = await response.json().catch(() => ({})) as {
      modelList?: unknown[];
      modelError?: unknown;
      error?: unknown;
    };
    const modelCount = Array.isArray(payload.modelList) ? payload.modelList.length : 0;
    if (!response.ok || modelCount === 0) {
      log.warn("Initial model catalog warmup did not produce models", {
        status: response.status,
        modelCount,
        ...(typeof payload.error === "string" ? { error: payload.error.slice(0, 300) } : {}),
        ...(typeof payload.modelError === "string" ? { modelError: payload.modelError.slice(0, 300) } : {}),
      });
      return;
    }
    log.info("Initial model catalog is ready", {
      modelCount,
      elapsedMs: Date.now() - startedAt,
    });
  }).catch((error) => {
    if (controller.signal.aborted) {
      log.warn("Initial model catalog warmup timed out", { elapsedMs: Date.now() - startedAt });
      return;
    }
    log.warn("Initial model catalog warmup failed", error);
  }).finally(() => clearTimeout(timeout));
}

function createMainWindow(
  url: URL,
  log: Logger,
  { showWhenReady = true }: { showWhenReady?: boolean } = {},
): BrowserWindow {
  const { window, initialState } = createMainWindowShell(log);
  if (showWhenReady) window.once("ready-to-show", () => {
    if (initialState.maximized) window.maximize();
    window.show();
  });

  void loadApplicationWindow(window, url, log).catch((error) => {
    log.error("Unable to load the application page", error);
  });
  return window;
}

function createStartupWindow(log: Logger): { window: BrowserWindow; ready: Promise<number> } {
  const { window, initialState } = createMainWindowShell(log);
  const ready = new Promise<number>((resolveReady) => {
    window.once("ready-to-show", () => {
      const readyAt = Date.now();
      if (!PORTABLE_SMOKE_TEST) {
        if (initialState.maximized) window.maximize();
        window.show();
      }
      const startupMarker = process.env.PIORA_SMOKE_STARTUP_MARKER?.trim();
      if (PORTABLE_SMOKE_TEST && startupMarker) {
        writeFileSync(resolve(startupMarker), `${JSON.stringify({ schema: "piora-startup-v1", ready: true, surface: "electron-shell" })}\n`, { encoding: "utf8", flag: "wx" });
      }
      resolveReady(readyAt);
    });
  });
  const startupChinese = app.getLocale().toLocaleLowerCase().startsWith("zh");
  const startupDocument = `<!doctype html>
<html lang="${startupChinese ? "zh-CN" : "en"}">
<head>
  <meta charset="utf-8">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#080a0f">
  <style>
    :root{color-scheme:dark;--ink:#080a0f;--panel:#111621;--line:rgba(169,184,224,.17);--text:#f4f6fb;--muted:#99a2b7;--dim:#69738a;--violet:#806bff;--blue:#4f86ff;--cyan:#55d3f2}
    *{box-sizing:border-box}
    html,body{width:100%;height:100%;margin:0}
    body{position:relative;display:grid;place-items:center;overflow:hidden;background-color:var(--ink);background-image:radial-gradient(ellipse 58% 48% at 12% 4%,rgba(116,79,240,.24),transparent 68%),radial-gradient(ellipse 48% 45% at 94% 94%,rgba(38,157,221,.17),transparent 68%),linear-gradient(145deg,#080a0f 0%,#0d111a 47%,#101522 100%);color:var(--text);font-family:Inter,"Segoe UI","Microsoft YaHei UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
    body:before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(154,177,228,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(154,177,228,.035) 1px,transparent 1px);background-size:34px 34px;mask-image:linear-gradient(to bottom,rgba(0,0,0,.82),transparent 88%)}
    body:after{content:"";position:absolute;inset:0;box-shadow:inset 0 0 140px rgba(0,0,0,.62);pointer-events:none}
    .aurora{position:absolute;border-radius:50%;filter:blur(56px);opacity:.34;will-change:transform}
    .aurora.one{width:34vw;height:28vw;min-width:360px;min-height:300px;left:-6%;top:-15%;background:rgba(118,80,255,.42);animation:drift-one 4s ease-in-out 2 alternate both}
    .aurora.two{width:32vw;height:26vw;min-width:330px;min-height:270px;right:-5%;bottom:-16%;background:rgba(49,188,234,.3);animation:drift-two 4.5s ease-in-out 2 alternate both}
    .frame{position:relative;z-index:1;width:min(430px,calc(100vw - 52px));padding:38px 42px 30px;overflow:hidden;border:1px solid var(--line);border-radius:28px;background:linear-gradient(145deg,rgba(25,31,46,.91),rgba(11,15,24,.86));box-shadow:0 38px 100px rgba(0,0,0,.5),0 10px 30px rgba(0,0,0,.34),inset 0 1px rgba(255,255,255,.055);backdrop-filter:blur(28px);text-align:center}
    .frame:before{content:"";position:absolute;left:12%;right:12%;top:-1px;height:1px;background:linear-gradient(90deg,transparent,rgba(181,193,255,.68),transparent)}
    .frame:after{content:"";position:absolute;width:190px;height:120px;left:50%;top:-82px;transform:translateX(-50%);border-radius:50%;background:rgba(120,91,255,.16);filter:blur(28px);pointer-events:none}
    .mark-wrap{position:relative;width:86px;height:86px;margin:0 auto 23px}
    .mark-orbit{position:absolute;inset:-9px;border:1px solid rgba(134,150,218,.15);border-radius:30px;transform:rotate(12deg)}
    .mark{position:relative;width:86px;height:86px;display:grid;place-items:center;border:1px solid rgba(255,255,255,.18);border-radius:26px;background:linear-gradient(145deg,var(--violet),#456ce2 62%,#2c61ce);box-shadow:0 18px 50px rgba(64,47,163,.38),inset 0 1px rgba(255,255,255,.29);color:#fff;font:56px/1 Georgia,serif;text-shadow:0 2px 10px rgba(30,18,86,.28)}
    .kicker{color:#859cff;font-size:10px;font-weight:700;letter-spacing:.2em;text-transform:uppercase}
    .title{margin-top:9px;font-size:22px;font-weight:650;letter-spacing:-.025em}
    .copy{max-width:320px;margin:8px auto 0;color:var(--muted);font-size:12px;line-height:1.65}
    .progress{position:relative;width:238px;height:4px;margin:24px auto 0;overflow:hidden;border-radius:999px;background:#262c3b;box-shadow:inset 0 1px 2px rgba(0,0,0,.42)}
    .progress:after{content:"";position:absolute;inset:0 auto 0 -52%;width:52%;border-radius:inherit;background:linear-gradient(90deg,var(--violet),var(--blue) 56%,var(--cyan));box-shadow:0 0 16px rgba(80,153,255,.48);animation:sweep 1.2s cubic-bezier(.45,0,.25,1) 3 both}
    .meta{display:flex;align-items:center;justify-content:space-between;margin-top:15px;color:var(--dim);font-size:10px;letter-spacing:.06em}
    .status{display:flex;align-items:center;gap:8px;color:#aab2c4;letter-spacing:0}
    .status:before{content:"";width:6px;height:6px;border-radius:50%;background:var(--cyan);box-shadow:0 0 0 4px rgba(85,211,242,.1),0 0 13px rgba(85,211,242,.48);animation:status-pulse 1.5s ease-in-out 3 both}
    .version{font-variant-numeric:tabular-nums}
    @keyframes sweep{0%{transform:translateX(0)}100%{transform:translateX(295%)}}
    @keyframes status-pulse{50%{opacity:.52;transform:scale(.82)}}
    @keyframes drift-one{to{transform:translate(4vw,3vh) scale(1.08)}}
    @keyframes drift-two{to{transform:translate(-3vw,-2vh) scale(1.1)}}
    @media(max-width:520px){.frame{padding:32px 28px 27px}.copy{max-width:280px}}
    @media(prefers-reduced-motion:reduce){.aurora,.status:before{animation:none}.progress:after{animation:none;left:24%;width:52%}}
  </style>
</head>
<body>
  <span class="aurora one"></span><span class="aurora two"></span>
  <main class="frame">
    <div class="mark-wrap"><span class="mark-orbit"></span><div class="mark">π</div></div>
    <div class="kicker">Piora · Local AI Workspace</div>
    <div class="title">${startupChinese ? "正在启动 Piora" : "Starting Piora"}</div>
    <div class="copy">${startupChinese ? "正在准备本地模型、会话与项目工作区" : "Preparing local models, sessions, and project workspaces"}</div>
    <div class="progress" role="progressbar" aria-label="${startupChinese ? "正在启动" : "Starting"}"></div>
    <div class="meta"><span class="status">${startupChinese ? "正在安全连接本地服务" : "Connecting local services securely"}</span><span class="version">v${app.getVersion()}</span></div>
  </main>
</body>
</html>`;
  void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(startupDocument)}`);
  return { window, ready };
}

type SmokeRendererState = {
  readyState: string;
  rendererLoaded: boolean;
  preloadBridgeReady: boolean;
  appShellReady: boolean;
};

async function waitForSmokeRenderer(
  window: BrowserWindow,
  timeoutMs = 60_000,
): Promise<SmokeRendererState> {
  const deadline = Date.now() + timeoutMs;
  let lastFailure: unknown;

  while (Date.now() < deadline) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      throw new Error("Portable smoke-test renderer exited before becoming ready.");
    }

    try {
      const state = await window.webContents.executeJavaScript(
        `(() => ({
          readyState: document.readyState,
          rendererLoaded: document.readyState === "complete",
          preloadBridgeReady: Boolean(
            window.piDesktop
            && typeof window.piDesktop.platform === "string"
            && typeof window.piDesktop.onMenuAction === "function"
          ),
          appShellReady: Boolean(document.querySelector(".app-shell")),
        }))()`,
        true,
      ) as SmokeRendererState;

      if (state.rendererLoaded && state.preloadBridgeReady && state.appShellReady) return state;
      lastFailure = new Error(
        `Renderer incomplete (readyState=${state.readyState}, preload=${state.preloadBridgeReady}, shell=${state.appShellReady}).`,
      );
    } catch (error) {
      lastFailure = error;
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }

  throw new Error("Portable smoke-test renderer did not become ready in time.", {
    cause: lastFailure,
  });
}

function handleUnexpectedServerExit(exit: ServerExit): void {
  if (shutdownPromise || shutdownComplete) return;

  logger?.error("Web server stopped unexpectedly", exit);
  const options: MessageBoxOptions = {
    type: "error" as const,
    title: "Piora",
    message: "The local Piora service stopped unexpectedly.",
    ...(logger ? { detail: `See ${logger.filePath} for details.` } : {}),
  };

  const notification = mainWindow
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
  void notification.finally(() => app.quit());
}

async function startApplication(): Promise<void> {
  const startupStartedAt = Date.now();
  await app.whenReady();
  app.setAppUserModelId("io.github.kexijiang.piora");

  logger = new FileLogger(app.getPath("userData"));
  logger.info("Starting Piora", {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
  });
  if (!desktopDevelopmentRuntime) installPortableDesktopShortcut(logger);
  await clearObsoleteDesktopWebCaches(logger);

  piAgentDirectoryPath = resolvePiAgentDirectory(logger);
  logger.info("Using Pi data directory", { directory: piAgentDirectoryPath });

  // Show an app-owned shell immediately while the bundled Next.js service
  // starts in parallel. The same BrowserWindow is then navigated to the app,
  // avoiding the process and rendering cost of creating a second window.
  const startup = createStartupWindow(logger);
  mainWindow = startup.window;
  installTray();
  void startup.ready.then((readyAt) => {
    logger?.info("Startup shell is visible", { elapsedMs: readyAt - startupStartedAt });
  });

  const token = desktopDevelopmentRuntime?.token ?? randomBytes(32).toString("base64url");
  applicationToken = token;
  if (desktopDevelopmentRuntime) {
    serverUrl = desktopDevelopmentRuntime.url;
    await waitForDesktopDevelopmentServer(serverUrl);
    configureSession(electronSession.fromPartition(DESKTOP_PARTITION, { cache: true }), serverUrl.origin, token);
    logger.info("Authenticated development service is ready", { elapsedMs: Date.now() - startupStartedAt });
  } else {
    serverEntryPath = resolveStandaloneServerEntry();
    serverHostEntryPath = join(__dirname, "server-host.js");
    if (!existsSync(serverHostEntryPath)) {
      throw new Error(`Desktop server host was not found: ${serverHostEntryPath}`);
    }
    // Harmony tools run in the same desktop service as ordinary sessions.
    const initialRuntime = createStandaloneForProfile("normal");
    server = initialRuntime.instance;
    serverUrl = await server.start();
    activateStandaloneProfile("normal", initialRuntime.dataDirectory, serverUrl);
    logger.info("Bundled service is ready", { elapsedMs: Date.now() - startupStartedAt });
  }
  warmInitialModelCatalog(serverUrl, token, logger);

  registerCompletionNotificationHandler();
  registerCompanionWindowHandlers();
  registerAutoLaunchHandlers();
  registerGlobalShortcutHandler();
  registerKeyboardShortcutHandler();
  registerNetworkProxyHandler();
  registerHarmonyRuntimePickerHandler();
  attachDesktopBrowserManager(mainWindow, logger);
  registerDirectoryPickerHandler();
  registerAgentDataDirectoryHandlers();

  if (PORTABLE_SMOKE_TEST) {
    const smokeMarker = process.env.PIORA_SMOKE_MARKER?.trim();
    if (!smokeMarker) {
      throw new Error("PIORA_SMOKE_MARKER is required in portable smoke-test mode.");
    }
    await loadApplicationWindow(mainWindow, serverUrl, logger);
    const rendererState = await waitForSmokeRenderer(mainWindow);
    await startup.ready;
    writeFileSync(
      resolve(smokeMarker),
      `${JSON.stringify({
        schema: "piora-portable-smoke-v1",
        ok: true,
        appVersion: app.getVersion(),
        rendererLoaded: rendererState.rendererLoaded,
        preloadBridgeReady: rendererState.preloadBridgeReady,
        appShellReady: rendererState.appShellReady,
      })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    logger.info("Portable smoke test reached a healthy bundled service and renderer");
    await stopApplication();
    shutdownComplete = true;
    mainWindow.destroy();
    app.exit(0);
    return;
  }

  installApplicationMenu();
  registerApplicationMenuPopupHandler();
  initializeDesktopUpdater(logger);
  registerFileShellHandlers();
  installDisplayReconciliation();

  await loadApplicationWindow(mainWindow, serverUrl, logger);
  logger.info("Application window is ready", { elapsedMs: Date.now() - startupStartedAt });
}

async function stopApplication(): Promise<void> {
  logger?.info("Stopping Piora");
  if (automaticUpdateCheckTimer) clearTimeout(automaticUpdateCheckTimer);
  automaticUpdateCheckTimer = undefined;
  await desktopBrowserManager?.flushStorage().catch((error) => logger?.warn("Unable to persist browser state during shutdown", error));
  desktopBrowserManager?.destroy();
  desktopBrowserManager = undefined;
  await requestHarmonyEmergencyStop("desktop_shutdown");
  await server?.stop();
  server = undefined;
  serverUrl = undefined;
  applicationToken = undefined;
  if (trayPollTimer) clearInterval(trayPollTimer);
  trayPollTimer = undefined;
  tray?.destroy();
  tray = null;
  globalShortcut.unregisterAll();
  removeDisplayReconciliation();
  logger?.info("Piora stopped");
}

// Smoke tests run in isolated user-data directories and may execute beside a
// user's installed Piora. They must not lose their startup marker to the
// installed app's single-instance lock.
const hasSingleInstanceLock = PORTABLE_SMOKE_TEST || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  // A newly downloaded portable version may be opened while an older Piora is
  // still resident in the tray. It cannot take over that live single-instance
  // process, but it can still create the Desktop shortcut when one is missing.
  void app.whenReady().then(async () => {
    const secondaryLogger = new FileLogger(app.getPath("userData"));
    const shortcutResult = installPortableDesktopShortcut(secondaryLogger);
    if (shortcutResult?.status === "created") {
      const chinese = app.getLocale().toLowerCase().startsWith("zh");
      await dialog.showMessageBox({
        type: "info",
        title: "Piora",
        message: chinese ? "旧版 Piora 仍在后台运行" : "An older Piora is still running",
        detail: chinese
          ? `已为 Piora ${app.getVersion()} 创建桌面快捷方式。请从系统托盘退出旧版本，然后重新打开桌面上的 Piora。`
          : `A Desktop shortcut was created for Piora ${app.getVersion()}. Quit the older version from the system tray, then open Piora from the Desktop again.`,
        buttons: [chinese ? "知道了" : "OK"],
        defaultId: 0,
      });
    }
    app.quit();
  }).catch(() => app.exit(1));
} else {
  app.on("second-instance", () => {
    focusMainWindow();
  });

  app.on("activate", () => {
    if (!mainWindow && serverUrl && logger) {
      mainWindow = createMainWindow(serverUrl, logger);
      attachDesktopBrowserManager(mainWindow, logger);
      return;
    }
    focusMainWindow();
  });

  // Closing the main window keeps the desktop process available from the tray.
  // Only an explicit quit (tray/menu/OS shutdown) tears down the local service.
  app.on("window-all-closed", () => {
    if (quitRequested) app.quit();
  });

  app.on("before-quit", (event) => {
    quitRequested = true;
    if (shutdownComplete) return;
    event.preventDefault();

    shutdownPromise ??= stopApplication()
      .catch((error) => logger?.error("Desktop shutdown failed", error))
      .finally(() => {
        shutdownComplete = true;
        app.quit();
      });
  });

  void startApplication().catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger?.error("Desktop startup failed", error);
    const detail = logger ? `${message}\n\nDiagnostic log: ${logger.filePath}` : message;
    dialog.showErrorBox("Piora could not start", detail);
    await server?.stop().catch((shutdownError) => {
      logger?.error("Unable to stop the web server after a startup failure", shutdownError);
    });
    quitRequested = true;
    shutdownComplete = true;
    app.exit(1);
  });
}
