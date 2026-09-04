import type { SessionInfo } from "@/lib/types";
import type { CollaborationRoom } from "@/lib/room-types";
import type { SettingsKey } from "@/lib/settings-search";

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
      selectSpeechPackDirectory?: (defaultPath?: string) => Promise<string | null>;
      getAgentDataDirectory?: () => Promise<{
        currentDirectory: string;
        defaultDirectory: string;
        configuredBy: "default" | "settings" | "environment";
        environmentOverride: boolean;
        portableRuntimeDirectory?: string;
      } | null>;
      selectAgentDataDirectory?: (defaultPath?: string) => Promise<string | null>;
      applyAgentDataDirectory?: (input: { directory: string; migrate: boolean }) => Promise<{
        ok: boolean;
        code?: "busy" | "environment-override" | "invalid-path" | "migration-required" | "same-path" | "overlapping-path" | "target-not-empty" | "migration-failed" | "persist-failed";
        error?: string;
        sourceDirectory?: string;
        currentDirectory?: string;
      }>;
      platform?: string;
      notifyCompletion?: (taskTitle?: string, sessionId?: string) => Promise<boolean>;
      notifyAutomation?: (taskTitle: string, status: "succeeded" | "failed" | "interrupted", sessionId?: string) => Promise<boolean>;
      notifyUserInput?: (taskTitle?: string, sessionId?: string) => Promise<boolean>;
      onNotificationSession?: (listener: (sessionId: string) => void) => () => void;
      openMenu?: (menu: "file" | "edit" | "view" | "help", x: number, y: number) => Promise<boolean>;
      getUpdateState?: () => Promise<DesktopUpdateState | null>;
      checkForUpdates?: () => Promise<DesktopUpdateState | null>;
      downloadUpdate?: () => Promise<DesktopUpdateState | null>;
      installUpdate?: () => Promise<boolean>;
      onUpdateState?: (listener: (state: DesktopUpdateState) => void) => () => void;
      revealPath?: (filePath: string) => Promise<boolean>;
      openPath?: (filePath: string) => Promise<boolean>;
      setCompanionWindowVisible?: (visible: boolean) => Promise<boolean>;
      setCompanionWindowAlwaysOnTop?: (alwaysOnTop: boolean) => Promise<boolean>;
      setCompanionWindowExpanded?: (expanded: boolean) => Promise<boolean>;
      moveCompanionWindow?: (input: {
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
      }) => Promise<{ ok: boolean; direction?: "left" | "right"; durationMs?: number }>;
      onCompanionMotion?: (listener: (state: {
        moving: boolean;
        direction: "left" | "right" | null;
      }) => void) => () => void;
      setCompanionHitTest?: (interactive: boolean) => Promise<boolean>;
      companionAction?: (action: "focus-main" | "open-settings" | "open-panel" | "hide") => Promise<boolean>;
      getAutoLaunchState?: () => Promise<{
        supported: boolean;
        enabled: boolean;
        error?: "read-failed" | "update-failed" | "approval-required";
      }>;
      setAutoLaunchEnabled?: (enabled: boolean) => Promise<{
        supported: boolean;
        enabled: boolean;
        error?: "read-failed" | "update-failed" | "approval-required";
      }>;
      setGlobalShortcut?: (enabled: boolean) => Promise<boolean>;
      setKeyboardShortcuts?: (bindings: Record<string, string | null>) => Promise<boolean>;
      setNetworkProxy?: (settings: {
        mode: "system" | "manual" | "direct";
        proxyUrl: string;
        bypass: string;
      }) => Promise<boolean>;
      selectHarmonyRuntimePath?: (kind: "sdk" | "hdc") => Promise<string | null>;
      onMenuAction?: (listener: (action: string) => void) => () => void;
      browser?: {
        getState: () => Promise<DesktopBrowserState | null>;
        action: (input: DesktopBrowserAction) => Promise<DesktopBrowserState | null>;
        setViewport: (bounds: { x: number; y: number; width: number; height: number }, visible: boolean) => Promise<boolean>;
        importChromeBookmarks: () => Promise<ChromeBookmarkImportResult | null>;
        onState: (listener: (state: DesktopBrowserState) => void) => () => void;
        onDownload: (listener: (download: DesktopBrowserDownload) => void) => () => void;
      };
    };
  }
}

export interface DesktopUpdateState {
  status: "unsupported" | "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "error";
  currentVersion: string;
  audience: "stable" | "preview";
  availableVersion?: string;
  releaseNotes?: string;
  progressPercent?: number;
  bytesPerSecond?: number;
  transferredBytes?: number;
  totalBytes?: number;
  error?: string;
}

export interface DesktopBrowserState {
  sessionId: string;
  activeTabId: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  tabs: Array<{ id: string; title: string; url: string }>;
  title: string;
  url: string;
}

export interface DesktopBrowserAction {
  action: "back" | "close_tab" | "forward" | "navigate" | "new_tab" | "reload" | "set_session" | "switch_tab";
  sessionId?: string;
  tabId?: string;
  url?: string;
}

export interface ImportedChromeBookmark {
  id: string;
  type: "bookmark";
  title: string;
  url: string;
}

export interface ImportedChromeBookmarkFolder {
  children: ImportedChromeBookmarkNode[];
  id: string;
  title: string;
  type: "folder";
}

export type ImportedChromeBookmarkNode = ImportedChromeBookmark | ImportedChromeBookmarkFolder;

export interface ImportedChromeBookmarkProfile {
  children: ImportedChromeBookmarkNode[];
  id: string;
  title: string;
}

export interface ChromeBookmarkImportResult {
  bookmarkCount: number;
  profiles: ImportedChromeBookmarkProfile[];
}

export interface DesktopBrowserDownload {
  filename: string;
  path: string;
  percent: number;
  state: "cancelled" | "completed" | "interrupted" | "progressing";
}

export interface SessionSidebarProps {
  selectedSessionId: string | null;
  selectedRoomId?: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onSelectSearchResult?: (session: SessionInfo, entryId: string) => void;
  onSelectRoom?: (room: CollaborationRoom, isRestore?: boolean) => void;
  initialRoomId?: string | null;
  onInitialRoomRestoreDone?: () => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  onRequestNewSession?: () => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (session: SessionInfo) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null, projectRoot?: string | null) => void;
  onOpenSettings?: (key?: SettingsKey) => void;
  activeProjectRoot?: string | null;
}

export interface SessionSidebarHandle {
  openProjectPicker: () => void;
  openConversationSearch: () => void;
  focusPrimaryNavigation: () => void;
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

export interface WorktreeState {
  forCwd: string;
  projectRoot: string;
  isGit: boolean;
  isTopLevel: boolean;
  worktrees: WorktreeEntry[];
}
