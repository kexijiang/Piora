"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useApplicationShortcuts } from "@/hooks/useApplicationShortcuts";
import { SessionSidebar, type SessionSidebarHandle } from "./SessionSidebar";
import { ChatWindow, type TaskControls } from "./ChatWindow";
import { NewSessionProjectPicker } from "./NewSessionProjectPicker";
import type { NewSessionInitialPrompt, NewSessionLaunch } from "./new-session-types";
import type { Tab } from "./TabBar";
import type { RightPanelHandle, RightPanelTab } from "./workspace/RightPanel";
import type { SettingsKey } from "@/lib/settings-search";
import { isDarkTheme, useTheme, type Theme, type ThemePreset } from "@/hooks/useTheme";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import {
  NOTIFICATION_SESSION_EVENT,
  sanitizeNotificationSessionId,
  useCompletionNotification,
} from "@/hooks/useCompletionNotification";
import { useRunningTaskSnapshots } from "@/hooks/useTaskStatus";
import { useCompanionPets } from "@/hooks/useCompanionPets";
import { useCompanionPreferences } from "@/hooks/useCompanionPreferences";
import { useCompanionWorkRhythm } from "@/hooks/useCompanionWorkRhythm";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { copyText } from "@/lib/clipboard";
import { getFileName } from "@/lib/file-paths";
import { resolveWorkspaceFilePath } from "@/lib/file-links";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import { getInitialNavigation } from "@/lib/initial-navigation";
import {
  getDefaultRightPanelWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  isRightPanelOverlayViewport,
  RIGHT_PANEL_FALLBACK_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  WORKSPACE_MIN_WIDTH,
} from "@/lib/panel-layout";
import type { SessionInfo } from "@/lib/types";
import type { CollaborationRoom } from "@/lib/room-types";
import type { DesktopUpdateState } from "./sidebar/sidebar-types";
import type { GitStatusResponse } from "@/lib/git-types";
import { getTrackedGitLineStats } from "@/lib/git-line-stats";
import { readSessionTitleModel, readSessionTitlePrompt } from "@/lib/session-title-settings";
import { isProjectlessChatCwd } from "@/lib/projectless-chat-path";
import type { SessionCapabilitiesState } from "@/lib/session-capabilities";

function replaceUrlWithoutNextNavigation(url: string): void {
  // Next patches history.replaceState and treats an ordinary call as an App
  // Router navigation. Piora's query string is only desktop selection state;
  // dispatching a route restore while a newly-created session starts can feed
  // an incomplete router tree into Next and crash the whole renderer. Preserve
  // Next's current state and set its native-history marker so the patched
  // method performs only the underlying URL replacement.
  const currentState = window.history.state;
  const nextState = currentState && typeof currentState === "object"
    ? { ...currentState, __NA: true }
    : { __NA: true };
  window.history.replaceState(nextState, "", url);
}
import type { ChatInputHandle } from "./ChatInput";
import type { ContextUsage, SessionStatsInfo } from "@/lib/pi-types";
import { canSendCompanionPhrase, type CompanionActivity } from "@/lib/companion";
import { buildCompanionInteractionContext, requestCompanionSpeech } from "@/lib/companion-interaction";
import { AliIcon } from "./AliIcon";
import { ConfirmationHost, requestConfirmation } from "./ConfirmDialog";
import { useCommands } from "@/hooks/useCommands";
import {
  APPLICATION_SHORTCUTS,
  formatShortcutBinding,
  isMacPlatform,
  shortcutMatchesEvent,
  shouldPreserveApplicationShortcut,
} from "@/lib/keyboard-shortcuts";
import { filterGuiCommands, type Command, type CommandContext, type PiSlashCommand } from "@/lib/commands";
import { SETTINGS_REOPEN_STORAGE_KEY } from "@/lib/settings-portability";
import {
  findReopenableFileTab,
  moveFileTab,
  rememberClosedFileTabs,
  tabsAfter,
  tabsExcept,
} from "@/lib/file-tabs";
import {
  parseWorkspaceContinuity,
  updateWorkspaceContinuity,
  workspaceContinuityStorageKey,
} from "@/lib/workspace-continuity";

type SessionCopyField = "file" | "id";
type TopPanel = "project" | "system" | "session" | "language" | "taskControls";
type DesktopMenuId = "file" | "edit" | "view" | "help";

const TOP_BAR_ICON_BUTTON_SIZE = 36;
const LANGUAGE_MENU_WIDTH = 176;
const PROJECT_MENU_WIDTH = 360;
const TASK_CONTROLS_MENU_WIDTH = 336;
const SYSTEM_PROMPT_MENU_WIDTH = 480;

// Settings and secondary dialogs are not part of the first usable frame.
// Keeping them out of the startup chunk avoids parsing their large management
// surfaces while the desktop splash is still visible.
const SettingsDialog = dynamic(() => import("./SettingsDialog").then((module) => module.SettingsDialog), { ssr: false });
const RoomWorkspace = dynamic(() => import("./RoomWorkspace").then((module) => module.RoomWorkspace), { ssr: false });
const RightPanel = dynamic(() => import("./workspace/RightPanel").then((module) => module.RightPanel), { ssr: false });
const SystemPromptEditor = dynamic(() => import("./SystemPromptEditor").then((module) => module.SystemPromptEditor), { ssr: false });
const CompanionPet = dynamic(() => import("./CompanionPet").then((module) => module.CompanionPet), { ssr: false });
const ModelsConfig = dynamic(() => import("./ModelsConfig").then((module) => module.ModelsConfig), { ssr: false });
const SkillsConfig = dynamic(() => import("./SkillsConfig").then((module) => module.SkillsConfig), { ssr: false });
const PluginsConfig = dynamic(() => import("./PluginsConfig").then((module) => module.PluginsConfig), { ssr: false });
const ExtensionsConfig = dynamic(() => import("./ExtensionsConfig").then((module) => module.ExtensionsConfig), { ssr: false });
const CapabilityBundlesConfig = dynamic(() => import("./CapabilityBundlesConfig").then((module) => module.CapabilityBundlesConfig), { ssr: false });
const BackgroundSettings = dynamic(() => import("./BackgroundSettings").then((module) => module.BackgroundSettings), { ssr: false });
const AppearanceLooks = dynamic(() => import("./AppearanceLooks").then((module) => module.AppearanceLooks), { ssr: false });
const AppearanceResetButton = dynamic(() => import("./AppearanceResetButton").then((module) => module.AppearanceResetButton), { ssr: false });
const FontSettings = dynamic(() => import("./FontSettings").then((module) => module.FontSettings), { ssr: false });
const CompanionSettingsDialog = dynamic(() => import("./CompanionSettingsDialog").then((module) => module.CompanionSettingsDialog), { ssr: false });
const RemoteControlSettings = dynamic(() => import("./RemoteControlSettings").then((module) => module.RemoteControlSettings), { ssr: false });
const HarmonyStorageSettings = dynamic(() => import("./HarmonyStorageSettings").then((module) => module.HarmonyStorageSettings), { ssr: false });
const SpeechSettings = dynamic(() => import("./SpeechSettings").then((module) => module.SpeechSettings), { ssr: false });
const UsageStatsPanel = dynamic(() => import("./UsageStatsPanel").then((module) => module.UsageStatsPanel), { ssr: false });
const ArchivedChatsSettings = dynamic(() => import("./ArchivedChatsSettings").then((module) => module.ArchivedChatsSettings), { ssr: false });
const AutomationPanel = dynamic(() => import("./AutomationPanel").then((module) => module.AutomationPanel), { ssr: false });
const SessionHistoryDialog = dynamic(() => import("./SessionHistoryDialog").then((module) => module.SessionHistoryDialog), { ssr: false });
const CommandPalette = dynamic(() => import("./CommandPalette").then((module) => module.CommandPalette), { ssr: false });
const DesktopUpdateDialog = dynamic(() => import("./DesktopUpdateDialog").then((module) => module.DesktopUpdateDialog), { ssr: false });
const ShortcutSettings = dynamic(() => import("./ShortcutSettings").then((module) => module.ShortcutSettings), { ssr: false });
const FirstRunOnboarding = dynamic(() => import("./FirstRunOnboarding").then((module) => module.FirstRunOnboarding), { ssr: false });

export function AppShell() {
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams ?? new URLSearchParams()));
  const [appHydrated, setAppHydrated] = useState(false);
  useEffect(() => setAppHydrated(true), []);
  const { theme, themes, setTheme } = useTheme();
  const { locale, setLocale, t: translate, supportedLocales } = useI18n();
  const { bindings: shortcutBindings } = useApplicationShortcuts();
  const {
    notificationEnabled,
    notificationCapability,
    onNotificationToggle,
    notifyCompletion,
    notifyAutomation,
    notifyUserInput,
  } = useCompletionNotification();
  const runningTaskSnapshots = useRunningTaskSnapshots();
  const companionWorkRhythm = useCompanionWorkRhythm(runningTaskSnapshots);
  useEffect(() => {
    if (!notificationEnabled) return;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch("/api/automations/notifications", { cache: "no-store" });
        if (!response.ok || stopped) return;
        const payload = await response.json() as { notifications?: Array<{ id: string; title: string; status: "succeeded" | "failed" | "interrupted"; sessionId?: string }> };
        const notifications = Array.isArray(payload.notifications) ? payload.notifications : [];
        const delivered: string[] = [];
        for (const notification of notifications) {
          if (await notifyAutomation(notification.title, notification.status, notification.sessionId)) delivered.push(notification.id);
        }
        if (delivered.length > 0 && !stopped) {
          await fetch("/api/automations/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: delivered }) });
        }
      } catch { /* the scheduler may still be starting */ }
    };
    void poll();
    const timer = setInterval(() => void poll(), 10_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [notificationEnabled, notifyAutomation]);
  const isMobile = useIsMobile();
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const selectedSessionIdRef = useRef<string | null>(null);
  selectedSessionIdRef.current = selectedSession?.id ?? null;
  const [focusedEntryId, setFocusedEntryId] = useState<string | null>(() => initialNavigation.entryId);

  // A pending extension dialog (question card, select, confirm, editor) stalls
  // its session until the user answers. When a session newly enters that
  // state, raise a system notification so the user notices even while another
  // tab, window, or session has focus. Sessions the user is actively looking
  // at stay silent because the dialog is already on screen.
  const pendingInputSessionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const pendingIds = new Set(
      runningTaskSnapshots.filter((snapshot) => snapshot.pendingApproval).map((snapshot) => snapshot.id),
    );
    const previous = pendingInputSessionsRef.current;
    const appInForeground = document.visibilityState === "visible" && document.hasFocus();
    for (const snapshot of runningTaskSnapshots) {
      if (!snapshot.pendingApproval || previous.has(snapshot.id)) continue;
      if (snapshot.id === selectedSession?.id && appInForeground) continue;
      void notifyUserInput(snapshot.title ?? undefined, snapshot.id);
    }
    pendingInputSessionsRef.current = pendingIds;
  }, [runningTaskSnapshots, selectedSession?.id, notifyUserInput]);

  const lastClaimedInitialPromptRef = useRef<string | null>(null);
  const automaticTitleRequestsRef = useRef<Set<string>>(new Set());
  const [selectedRoom, setSelectedRoom] = useState<CollaborationRoom | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [newSessionInitialModel, setNewSessionInitialModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [newSessionInitialPrompt, setNewSessionInitialPrompt] = useState<NewSessionInitialPrompt | null>(null);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [onboardingRestartKey, setOnboardingRestartKey] = useState(0);
  const [onboardingProjectPickerRequestKey, setOnboardingProjectPickerRequestKey] = useState(0);
  const [onboardingProjectCwd, setOnboardingProjectCwd] = useState<string | null>(null);
  const [onboardingPromptSubmittedKey, setOnboardingPromptSubmittedKey] = useState(0);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [settingsKey, setSettingsKey] = useState<SettingsKey>("general");
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelMaximized, setRightPanelMaximized] = useState(false);
  // Keep the server and first client render identical. The persisted tab is
  // restored after hydration so React never has to replace this subtree.
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>("home");
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null);
  const [rightPanelTabRestored, setRightPanelTabRestored] = useState(false);
  const [rightPanelOverlayMode, setRightPanelOverlayMode] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [piSlashCommands, setPiSlashCommands] = useState<PiSlashCommand[]>([]);
  const [currentIsGitRepository, setCurrentIsGitRepository] = useState(false);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const [desktopChrome, setDesktopChrome] = useState(false);
  const [globalShortcutEnabled, setGlobalShortcutEnabled] = useState(false);
  const [openDesktopMenuId, setOpenDesktopMenuId] = useState<DesktopMenuId | null>(null);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [desktopUpdateDialogOpen, setDesktopUpdateDialogOpen] = useState(false);
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);
  const rightPanelWidthRef = useRef(RIGHT_PANEL_FALLBACK_WIDTH);
  const getResponsiveRightPanelWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_FALLBACK_WIDTH
      : getDefaultRightPanelWidth(window.innerWidth),
    [],
  );
  const getResponsiveSidebarMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? SIDEBAR_MAX_WIDTH
      : getSidebarMaxWidth({
        viewportWidth: window.innerWidth,
        rightPanelOpen,
        rightPanelWidth: rightPanelWidthRef.current,
      }),
    [rightPanelOpen],
  );
  const getResponsiveRightPanelMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_MAX_WIDTH
      : getRightPanelMaxWidth({
        viewportWidth: window.innerWidth,
        sidebarOpen,
        sidebarWidth: sidebarWidthRef.current,
      }),
    [sidebarOpen],
  );
  const sidebarResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeSidebar"),
    cssVariable: "--sidebar-width",
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    getMaxWidth: getResponsiveSidebarMaxWidth,
    growthDirection: "right",
    maxWidth: SIDEBAR_MAX_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    storageKey: "pi-sidebar-width",
    widthRef: sidebarWidthRef,
  });
  const rightPanelResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeFilePanel"),
    cssVariable: "--right-panel-width",
    defaultWidth: RIGHT_PANEL_FALLBACK_WIDTH,
    getDefaultWidth: getResponsiveRightPanelWidth,
    getMaxWidth: getResponsiveRightPanelMaxWidth,
    growthDirection: "left",
    maxWidth: RIGHT_PANEL_MAX_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    storageKey: "pi-right-panel-width",
    widthRef: rightPanelWidthRef,
  });
  const reclampSidebarWidth = sidebarResizer.reclampWidth;
  const reclampRightPanelWidth = rightPanelResizer.reclampWidth;
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(SETTINGS_REOPEN_STORAGE_KEY) !== "general") return;
      window.sessionStorage.removeItem(SETTINGS_REOPEN_STORAGE_KEY);
      setSettingsKey("general");
      setSettingsDialogOpen(true);
    } catch {
      // Import still applies when session storage is unavailable; only reopening is skipped.
    }
  }, []);
  useEffect(() => {
    const syncPanelMode = () => setRightPanelOverlayMode(isRightPanelOverlayViewport(window.innerWidth));
    syncPanelMode();
    window.addEventListener("resize", syncPanelMode);
    return () => window.removeEventListener("resize", syncPanelMode);
  }, []);
  useEffect(() => {
    if (rightPanelOverlayMode && rightPanelOpen && sidebarOpen) setSidebarOpen(false);
  }, [rightPanelOpen, rightPanelOverlayMode, sidebarOpen]);
  useEffect(() => {
    if (!rightPanelOpen) return;
    reclampSidebarWidth();
    reclampRightPanelWidth();
  }, [reclampRightPanelWidth, reclampSidebarWidth, rightPanelOpen]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const sessionSidebarRef = useRef<SessionSidebarHandle>(null);
  const rightPanelRef = useRef<RightPanelHandle>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem("piora-right-panel-tab");
    setRightPanelTab(stored === "automation" || stored === "review" || stored === "files" || stored === "commands" || stored === "browser" || stored === "design" || stored === "harmony" ? stored : "home");
    setRightPanelTabRestored(true);
  }, []);

  useEffect(() => {
    if (!rightPanelTabRestored) return;
    window.localStorage.setItem("piora-right-panel-tab", rightPanelTab);
  }, [rightPanelTab, rightPanelTabRestored]);

  useEffect(() => {
    if (!rightPanelOpen) setRightPanelMaximized(false);
  }, [rightPanelOpen]);

  const {
    preferences: companionPreferences,
    setPreferences: setCompanionPreferences,
    setOpen: setCompanionOpen,
  } = useCompanionPreferences();
  const companionOpen = companionPreferences.open;
  const companionAlwaysOnTop = companionPreferences.alwaysOnTop;
  const companionPets = useCompanionPets(companionOpen || (settingsDialogOpen && settingsKey === "companion"));
  const activeCompanionPet = companionPets.catalog?.installed.find(
    (pet) => pet.id === companionPreferences.selectedPetId,
  ) ?? null;
  const [moreThemesOpen, setMoreThemesOpen] = useState(false);
  const [companionActivity, setCompanionActivity] = useState<CompanionActivity>(() => ({
    status: "idle",
    cause: "",
  }));
  const topBarRef = useRef<HTMLDivElement>(null);
  const projectBtnRef = useRef<HTMLButtonElement>(null);
  const taskControlsBtnRef = useRef<HTMLButtonElement>(null);
  const topPanelFrameRef = useRef<HTMLDivElement>(null);
  const autoFocusedTopPanelRef = useRef<TopPanel | null>(null);
  const projectHoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const projectPanelOpenedByHoverRef = useRef(false);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
  }, []);

  const handleSystemPromptSaved = useCallback(() => {
    setSystemPrompt(null);
    setSessionKey((key) => key + 1);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    setSessionStats(stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [projectPathCopied, setProjectPathCopied] = useState(false);
  const projectPathCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (projectPathCopyTimerRef.current) clearTimeout(projectPathCopyTimerRef.current);
    };
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const handleContextUsageChange = useCallback((usage: ContextUsage | null) => {
    setContextUsage(usage);
  }, []);

  const handleSendCompanionPhrase = useCallback((text: string) => (
    chatInputRef.current?.sendText(text) ?? false
  ), []);

  const handleSelectCompanionPet = useCallback((petId: string) => {
    setCompanionPreferences((current) => ({ ...current, selectedPetId: petId }));
  }, [setCompanionPreferences]);

  const toggleCompanion = useCallback(() => {
    setCompanionPreferences((current) => ({ ...current, open: !current.open }));
  }, [setCompanionPreferences]);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<TopPanel | null>(null);
  useFocusTrap(topPanelFrameRef, activeTopPanel !== null, {
    onEscape: () => setActiveTopPanel(null),
  });
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [taskControls, setTaskControls] = useState<TaskControls | null>(null);
  const [sessionCapabilities, setSessionCapabilities] = useState<SessionCapabilitiesState | null>(null);

  const toggleTopPanel = useCallback((panel: TopPanel) => {
    if (isMobile) setSidebarOpen(false);
    projectPanelOpenedByHoverRef.current = false;
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, [isMobile]);

  const cancelProjectHoverClose = useCallback(() => {
    if (projectHoverCloseTimerRef.current) clearTimeout(projectHoverCloseTimerRef.current);
    projectHoverCloseTimerRef.current = null;
  }, []);

  const openProjectPanelOnHover = useCallback(() => {
    if (isMobile) return;
    cancelProjectHoverClose();
    projectPanelOpenedByHoverRef.current = true;
    setActiveTopPanel("project");
  }, [cancelProjectHoverClose, isMobile]);

  const closeProjectPanelAfterHover = useCallback(() => {
    if (isMobile) return;
    cancelProjectHoverClose();
    projectHoverCloseTimerRef.current = setTimeout(() => {
      projectHoverCloseTimerRef.current = null;
      setActiveTopPanel((current) => current === "project" ? null : current);
    }, 120);
  }, [cancelProjectHoverClose, isMobile]);

  useEffect(() => () => cancelProjectHoverClose(), [cancelProjectHoverClose]);

  const openSettings = useCallback((key: SettingsKey = "general") => {
    setActiveTopPanel(null);
    if (isMobile) setSidebarOpen(false);
    setSettingsKey(key);
    setSettingsDialogOpen(true);
  }, [isMobile]);
  const openCapabilitySettings = useCallback(() => openSettings("extensions"), [openSettings]);
  const openModelsSettings = useCallback(() => openSettings("models"), [openSettings]);

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel("session");
  }, [isMobile]);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) setActiveTopPanel(null);
    const nextOpen = !sidebarOpen;
    if (rightPanelOverlayMode && nextOpen) setRightPanelOpen(false);
    setSidebarOpen(nextOpen);
  }, [isMobile, rightPanelOverlayMode, sidebarOpen]);

  const handleOpenProjectPicker = useCallback(() => {
    setActiveTopPanel(null);
    sessionSidebarRef.current?.openProjectPicker();
  }, []);

  const openAutomation = useCallback((automationId: string) => {
    setSelectedAutomationId(automationId);
    setRightPanelTab("automation");
    setRightPanelOpen(true);
  }, []);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const topBarRect = topBarRef.current!.getBoundingClientRect();
      const compactMenuButton = activeTopPanel === "project"
        ? projectBtnRef.current
        : activeTopPanel === "taskControls"
          ? taskControlsBtnRef.current
          : activeTopPanel === "system"
            ? taskControlsBtnRef.current
            : null;
      if (compactMenuButton && !isMobile) {
        const buttonRect = compactMenuButton.getBoundingClientRect();
        const menuWidth = activeTopPanel === "project"
          ? PROJECT_MENU_WIDTH
          : activeTopPanel === "language"
            ? LANGUAGE_MENU_WIDTH
            : activeTopPanel === "system"
              ? SYSTEM_PROMPT_MENU_WIDTH
              : TASK_CONTROLS_MENU_WIDTH;
        const horizontalInset = 6;
        const width = Math.min(menuWidth, Math.max(0, topBarRect.width - horizontalInset * 2));
        const leftInViewport = Math.min(
          Math.max(buttonRect.left, topBarRect.left + horizontalInset),
          topBarRect.right - width - horizontalInset,
        );
        setTopPanelPos({
          top: topBarRect.height + 6,
          left: leftInViewport - topBarRect.left,
          width,
        });
        return;
      }
      if (activeTopPanel === "language" && !isMobile) {
        const horizontalInset = 6;
        const width = Math.min(LANGUAGE_MENU_WIDTH, Math.max(0, topBarRect.width - horizontalInset * 2));
        setTopPanelPos({
          top: topBarRect.height + 6,
          left: Math.max(horizontalInset, topBarRect.width - width - horizontalInset),
          width,
        });
        return;
      }
      setTopPanelPos({ top: topBarRect.height + 6, left: 6, width: Math.max(0, topBarRect.width - 12) });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    if (projectBtnRef.current) ro.observe(projectBtnRef.current);
    if (taskControlsBtnRef.current) ro.observe(taskControlsBtnRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel, isMobile]);

  useEffect(() => {
    if (!activeTopPanel) {
      autoFocusedTopPanelRef.current = null;
      return;
    }
    if (
      activeTopPanel !== "project"
      && activeTopPanel !== "taskControls"
      && activeTopPanel !== "language"
    ) return;
    if (activeTopPanel === "project" && projectPanelOpenedByHoverRef.current) return;
    if (!topPanelPos || autoFocusedTopPanelRef.current === activeTopPanel) return;

    const frame = window.requestAnimationFrame(() => {
      if (autoFocusedTopPanelRef.current === activeTopPanel) return;
      const firstItem = topPanelFrameRef.current?.querySelector<HTMLElement>(
        '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled]), button:not([disabled])',
      );
      if (!firstItem) return;
      // preventScroll: opening a menu must never scroll the page/scroll
      // containers — otherwise the whole window visibly jumps at the bottom.
      firstItem.focus({ preventScroll: true });
      autoFocusedTopPanelRef.current = activeTopPanel;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeTopPanel, topPanelPos]);

  useEffect(() => {
    if (!activeTopPanel) return;
    const focusItems = () => Array.from(
      topPanelFrameRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], button:not([disabled])') ?? [],
    ).filter((item) => !item.hasAttribute("disabled"));
    const restoreTriggerFocus = () => {
      if (activeTopPanel === "project") projectBtnRef.current?.focus({ preventScroll: true });
      if (activeTopPanel === "taskControls") taskControlsBtnRef.current?.focus({ preventScroll: true });
    };
    const closePanel = () => {
      setActiveTopPanel(null);
      restoreTriggerFocus();
    };
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const frame = topPanelFrameRef.current;
      if (frame?.contains(target) || topBarRef.current?.contains(target)) return;
      setActiveTopPanel(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = focusItems();
      if (items.length === 0) return;
      event.preventDefault();
      const activeIndex = items.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (activeIndex + 1 + items.length) % items.length
            : (activeIndex - 1 + items.length) % items.length;
      items[nextIndex]?.focus();
    };
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [activeTopPanel]);

  // Right panel — file tabs only
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [closedFileTabs, setClosedFileTabs] = useState<Tab[]>([]);
  const hasDirtyFileTabs = fileTabs.some((tab) => tab.isDirty);
  const reopenableClosedFileTab = useMemo(
    () => findReopenableFileTab(closedFileTabs, fileTabs),
    [closedFileTabs, fileTabs],
  );

  useEffect(() => {
    if (!hasDirtyFileTabs) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasDirtyFileTabs]);

  const handleFileDirtyChange = useCallback((tabId: string, dirty: boolean) => {
    setFileTabs((currentTabs) => {
      const target = currentTabs.find((tab) => tab.id === tabId);
      if (!target || Boolean(target.isDirty) === dirty) return currentTabs;
      return currentTabs.map((tab) => tab.id === tabId ? { ...tab, isDirty: dirty } : tab);
    });
  }, []);

  const confirmDiscardFileTabs = useCallback(async (tabs: readonly Tab[]) => {
    const dirtyTabs = tabs.filter((tab) => tab.isDirty);
    if (dirtyTabs.length === 0) return true;
    return await requestConfirmation({
      title: translate("files.discardTitle"),
      message: dirtyTabs.length === 1
        ? translate("files.discardUnsavedFile", { name: dirtyTabs[0].label })
        : translate("files.discardUnsavedFiles", { count: dirtyTabs.length }),
      confirmLabel: translate("files.discard"),
      tone: "danger",
    });
  }, [translate]);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean) => {
    chatInputRef.current?.insertText(buildAtMentionText(relativePath, isDir));
  }, []);

  const handleAtMentions = useCallback((relativePaths: string[]) => {
    const mentions = buildFileAtMentionsText(relativePaths);
    if (mentions) chatInputRef.current?.insertText(mentions);
  }, []);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(relativePath, startLine, endLine));
  }, []);

  const initialSessionId = initialNavigation.sessionId;
  const initialRoomId = searchParams?.get("room") ?? null;
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const [activeProjectRoot, setActiveProjectRoot] = useState<string | null>(null);
  const activeProjectRootRef = useRef<string | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId && !initialRoomId);
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdBumpRef.current = true;
        setNewSessionCwd(data.cwd);
        setNewSessionInitialModel(null);
        setNewSessionInitialPrompt(null);
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation]);

  const handleCwdChange = useCallback(async (cwd: string | null, projectRoot?: string | null) => {
    // Skip if cwd is null (initial mount).
    if (!cwd) { setActiveCwd(null); return; }
    const newProject = projectRoot ?? cwd;
    const currentProject = activeProjectRootRef.current
      ?? selectedRoom?.projectRoot
      ?? (selectedSession ? (selectedSession.projectRoot ?? selectedSession.cwd) : null);
    // Selecting a session in another project updates the session and sidebar
    // cwd in the same React event. The following cwd notification synchronizes
    // that selected session; it must not turn the transition into an empty chat.
    const cwdBelongsToSelectedSession = selectedSession?.cwd === cwd;
    const cwdBelongsToSelectedRoom = Boolean(
      selectedRoom?.projectRoot
      && selectedRoom.projectRoot.toLocaleLowerCase() === newProject.toLocaleLowerCase(),
    );
    const cwdBelongsToCurrentSelection = cwdBelongsToSelectedSession || cwdBelongsToSelectedRoom;
    const dirtyTabs = fileTabs.filter((tab) => tab.isDirty);
    let keepDirtyTabs = false;
    if (currentProject !== null && currentProject !== newProject && dirtyTabs.length > 0) {
      keepDirtyTabs = !await requestConfirmation({
        title: translate("files.discardTitle"),
        message: translate("files.discardBeforeSwitch", { count: dirtyTabs.length, countSuffix: dirtyTabs.length === 1 ? "" : "s" }),
        confirmLabel: translate("files.discard"),
        tone: "danger",
      });
    }
    setActiveCwd(cwd);
    activeProjectRootRef.current = newProject;
    setActiveProjectRoot(newProject);
    let restored = parseWorkspaceContinuity(null, newProject);
    try {
      restored = parseWorkspaceContinuity(
        window.localStorage.getItem(workspaceContinuityStorageKey(newProject)),
        newProject,
      );
    } catch {
      // Workspace navigation still works when browser storage is unavailable.
    }

    // Keep the project identity in sync during the initial URL restore without
    // remounting the just-created or restored chat.
    if (suppressCwdBumpRef.current) {
      suppressCwdBumpRef.current = false;
      setFileTabs(restored.tabs);
      setActiveFileTabId(restored.activeTabId);
      if (restored.tabs.length > 0) setRightPanelOpen(true);
      return;
    }
    // Worktrees of one repo share a project root. Moving the effective cwd
    // within the same project (e.g. switching worktree, or clicking a session
    // that lives in another worktree) must not close the open session.
    if (currentProject === newProject) {
      return;
    }
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    if (!cwdBelongsToCurrentSelection) {
      setSelectedSession(null);
      setSelectedRoom(null);
      setNewSessionInitialModel(null);
      setNewSessionInitialPrompt(null);
      setNewSessionCwd((prev) => {
        if (prev && prev !== cwd) return null;
        return prev;
      });
      setSessionKey((k) => k + 1);
    }
    setSystemPrompt(null);
    setActiveTopPanel(null);
    const retainedTabs = keepDirtyTabs ? dirtyTabs : [];
    const retainedIds = new Set(retainedTabs.map((tab) => tab.id));
    const restoredTabs = restored.tabs.filter((tab) => !retainedIds.has(tab.id));
    const nextTabs: Tab[] = [...retainedTabs, ...restoredTabs];
    const nextActiveId = activeFileTabId && retainedIds.has(activeFileTabId)
      ? activeFileTabId
      : restored.activeTabId && nextTabs.some((tab) => tab.id === restored.activeTabId)
        ? restored.activeTabId
        : nextTabs.at(-1)?.id ?? null;
    setFileTabs(nextTabs);
    setActiveFileTabId(nextActiveId);
    setRightPanelOpen(nextTabs.length > 0);
    if (!cwdBelongsToCurrentSelection) {
      replaceUrlWithoutNextNavigation("/");
    }
  }, [activeFileTabId, fileTabs, selectedRoom, selectedSession, translate]);

  useEffect(() => {
    if (!activeProjectRoot) return;
    try {
      const key = workspaceContinuityStorageKey(activeProjectRoot);
      const persistedTabs = fileTabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        filePath: tab.filePath,
        cwd: tab.cwd ?? activeProjectRoot,
        initialDisplayMode: tab.initialDisplayMode,
      }));
      const persistedActiveId = activeFileTabId && persistedTabs.some((tab) => tab.id === activeFileTabId)
        ? activeFileTabId
        : persistedTabs.at(-1)?.id ?? null;
      window.localStorage.setItem(
        key,
        updateWorkspaceContinuity(
          window.localStorage.getItem(key),
          activeProjectRoot,
          { tabs: persistedTabs, activeTabId: persistedActiveId },
        ),
      );
    } catch {
      // Open files remain usable even when localStorage is blocked or full.
    }
  }, [activeFileTabId, activeProjectRoot, fileTabs]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false) => {
    setSettingsDialogOpen(false);
    setSelectedRoom(null);
    if (!isRestore && selectedSessionIdRef.current === session.id) {
      setActiveTopPanel(null);
      return;
    }
    setNewSessionCwd(null);
    setNewSessionInitialModel(null);
    setNewSessionInitialPrompt(null);
    setSelectedSession(session);
    if (!isRestore) setFocusedEntryId(null);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setInitialSessionRestored(true);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick.
    if (isMobile && !isRestore) setSidebarOpen(false);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar
      suppressCwdBumpRef.current = true;
    }
    // Skip history replacement when restoring from URL — the param is already correct.
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      replaceUrlWithoutNextNavigation(`?session=${encodeURIComponent(session.id)}`);
      // Session changes remount ChatWindow. Restore focus after that mount so
      // dismissing a native dialog or leaving a streaming session can never
      // strand keyboard input on the old, detached composer.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => chatInputRef.current?.focus());
      });
    }
  }, [isMobile]);

  const handleSelectSearchResult = useCallback((session: SessionInfo, entryId: string) => {
    handleSelectSession(session);
    setFocusedEntryId(entryId);
    replaceUrlWithoutNextNavigation(`?session=${encodeURIComponent(session.id)}&entry=${encodeURIComponent(entryId)}`);
  }, [handleSelectSession]);

  const openNotificationSession = useCallback(async (rawSessionId: unknown) => {
    const sessionId = sanitizeNotificationSessionId(rawSessionId);
    if (!sessionId) return;
    try {
      const response = await fetch("/api/sessions", { cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as { sessions?: SessionInfo[]; error?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      const session = payload.sessions?.find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error(`Session ${sessionId} is no longer available.`);
      handleSelectSession(session);
      setRefreshKey((key) => key + 1);
    } catch (error) {
      console.warn("Unable to open the notification Session:", error);
    }
  }, [handleSelectSession]);

  useEffect(() => {
    const unsubscribeDesktop = window.piDesktop?.onNotificationSession?.((sessionId) => {
      void openNotificationSession(sessionId);
    });
    const handleBrowserNotification = (event: Event) => {
      void openNotificationSession((event as CustomEvent<unknown>).detail);
    };
    window.addEventListener(NOTIFICATION_SESSION_EVENT, handleBrowserNotification);
    return () => {
      unsubscribeDesktop?.();
      window.removeEventListener(NOTIFICATION_SESSION_EVENT, handleBrowserNotification);
    };
  }, [openNotificationSession]);

  const handleNewSession = useCallback((
    _sessionId: string,
    cwd: string,
    initialModel?: { provider: string; modelId: string },
    initialPrompt?: NewSessionInitialPrompt | null,
  ) => {
    setSettingsDialogOpen(false);
    setSelectedRoom(null);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setNewSessionInitialModel(initialModel ?? null);
    setNewSessionInitialPrompt(initialPrompt ?? null);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    if (isMobile) setSidebarOpen(false);
    replaceUrlWithoutNextNavigation("/");
  }, [isMobile]);

  const handleRequestNewSession = useCallback(() => {
    setSettingsDialogOpen(false);
    setSelectedRoom(null);
    setSelectedSession(null);
    setNewSessionCwd(null);
    setNewSessionInitialModel(null);
    setNewSessionInitialPrompt(null);
    setOnboardingProjectCwd(null);
    setInitialCwdError(null);
    setInitialCwdStatus("idle");
    setInitialSessionRestored(true);
    setSessionKey((key) => key + 1);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    if (isMobile) setSidebarOpen(false);
    replaceUrlWithoutNextNavigation("/");
  }, [isMobile]);

  const handleNewSessionLaunch = useCallback((request: NewSessionLaunch) => {
    if (request.projectRoot) {
      if (activeCwd !== request.cwd) suppressCwdBumpRef.current = true;
      activeProjectRootRef.current = request.projectRoot;
      setActiveProjectRoot(request.projectRoot);
      setActiveCwd(request.cwd);
    } else {
      activeProjectRootRef.current = null;
      setActiveProjectRoot(null);
      setActiveCwd(null);
    }
    handleNewSession(`project-picker-${Date.now()}`, request.cwd, request.model, request.prompt);
  }, [activeCwd, handleNewSession]);

  const claimNewSessionInitialPrompt = useCallback((promptId: string): boolean => {
    if (lastClaimedInitialPromptRef.current === promptId) return false;
    lastClaimedInitialPromptRef.current = promptId;
    setNewSessionInitialPrompt((current) => current?.id === promptId ? null : current);
    return true;
  }, []);

  const handleSelectRoom = useCallback((room: CollaborationRoom, isRestore = false) => {
    setSettingsDialogOpen(false);
    setSelectedSession(null);
    setNewSessionCwd(null);
    setNewSessionInitialModel(null);
    setNewSessionInitialPrompt(null);
    setSelectedRoom(room);
    setSessionKey((key) => key + 1);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    setInitialSessionRestored(true);
    if (isMobile && !isRestore) setSidebarOpen(false);
    if (!isRestore) replaceUrlWithoutNextNavigation(`?room=${encodeURIComponent(room.id)}`);
  }, [isMobile]);

  const handleRoomDeleted = useCallback((roomId: string) => {
    setSelectedRoom((current) => current?.id === roomId ? null : current);
    setRefreshKey((key) => key + 1);
    setSessionKey((key) => key + 1);
    setSystemPrompt(null);
    replaceUrlWithoutNextNavigation("/");
  }, []);

  const handleOpenDesktopUpdate = useCallback(() => {
    setDesktopUpdateDialogOpen(true);
    if (desktopUpdateState?.status !== "available") return;
    void window.piDesktop?.downloadUpdate?.().then((state) => {
      if (state) setDesktopUpdateState(state);
    });
  }, [desktopUpdateState?.status]);

  const handleRetryDesktopUpdate = useCallback(() => {
    void window.piDesktop?.checkForUpdates?.().then((state) => {
      if (state) setDesktopUpdateState(state);
    });
  }, []);

  const handleInstallDesktopUpdate = useCallback(() => {
    void window.piDesktop?.installUpdate?.();
  }, []);

  // Native Electron menus stay deliberately thin: the renderer owns all
  // application state and receives only a small action name from preload.
  useEffect(() => {
    const unsubscribe = window.piDesktop?.onMenuAction?.((action) => {
      switch (action) {
        case "new-session":
          handleRequestNewSession();
          break;
        case "choose-project":
          handleOpenProjectPicker();
          break;
        case "toggle-sidebar":
          handleSidebarToggle();
          break;
        case "toggle-files":
          setRightPanelOpen((open) => !open);
          break;
        case "open-commands":
          setRightPanelTab("commands");
          setRightPanelOpen(true);
          break;
        case "open-review":
          setRightPanelTab("review");
          setRightPanelOpen(true);
          break;
        case "open-browser":
          setRightPanelTab("browser");
          setRightPanelOpen(true);
          break;
        case "search-chats":
          sessionSidebarRef.current?.openConversationSearch();
          break;
        case "settings":
          openSettings();
          break;
        case "models":
          openSettings("models");
          break;
        case "skills":
          openSettings("skills");
          break;
        case "plugins":
          openSettings("plugins");
          break;
        case "appearance":
          openSettings("appearance");
          break;
        case "language":
          openSettings("language");
          break;
        case "toggle-companion":
          toggleCompanion();
          break;
        case "hide-companion":
          setCompanionOpen(false);
          break;
        case "companion-settings":
          openSettings("companion");
          break;
        case "open-update":
          handleOpenDesktopUpdate();
          break;
        default:
          break;
      }
    });
    return unsubscribe;
  }, [handleOpenDesktopUpdate, handleOpenProjectPicker, handleRequestNewSession, handleSidebarToggle, openSettings, setCompanionOpen, toggleCompanion]);

  // Electron's titleBarOverlay does not make the browser-only
  // `(display-mode: window-controls-overlay)` media query true. Use the
  // preload bridge as the authoritative desktop-runtime signal so the real
  // packaged window gets draggable regions and native-control safe areas.
  useEffect(() => {
    setDesktopChrome(Boolean(window.piDesktop));
    const enabled = window.localStorage.getItem("piora-global-shortcut-enabled") === "true";
    setGlobalShortcutEnabled(enabled);
    if (enabled) void window.piDesktop?.setGlobalShortcut?.(true);
  }, []);

  useEffect(() => {
    const bridge = window.piDesktop;
    if (!bridge?.getUpdateState || !bridge.onUpdateState) return;
    let active = true;
    void bridge.getUpdateState().then((state) => {
      if (active && state) setDesktopUpdateState(state);
    });
    const unsubscribe = bridge.onUpdateState((state) => {
      if (active) setDesktopUpdateState(state);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const toggleGlobalShortcut = useCallback(async () => {
    const next = !globalShortcutEnabled;
    const accepted = await window.piDesktop?.setGlobalShortcut?.(next);
    if (accepted === false) return;
    setGlobalShortcutEnabled(next);
    window.localStorage.setItem("piora-global-shortcut-enabled", String(next));
  }, [globalShortcutEnabled]);

  useEffect(() => {
    if (!desktopChrome) return;
    void window.piDesktop?.setCompanionWindowVisible?.(companionOpen);
  }, [companionOpen, desktopChrome]);

  useEffect(() => {
    if (!desktopChrome) return;
    void window.piDesktop?.setCompanionWindowAlwaysOnTop?.(companionAlwaysOnTop);
  }, [companionAlwaysOnTop, desktopChrome]);

  useEffect(() => {
    if (!desktopChrome || typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("pi-companion-runtime-v1");
    const publishActivity = () => channel.postMessage({
      type: "context",
      activity: companionActivity,
      rhythm: companionWorkRhythm,
      session: {
        cwd: selectedSession?.cwd ?? activeCwd ?? undefined,
        sessionId: selectedSession?.id,
        sessionTitle: selectedSession?.name || selectedSession?.firstMessage,
        status: companionActivity.status,
        stats: sessionStats,
        contextUsage,
      },
    });
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data && typeof event.data === "object" && (event.data as { type?: unknown }).type === "ready") {
        publishActivity();
      }
    };
    publishActivity();
    return () => channel.close();
  }, [activeCwd, companionActivity, companionWorkRhythm, contextUsage, desktopChrome, selectedSession, sessionStats]);

  const openDesktopMenu = useCallback(async (menu: DesktopMenuId, anchor: HTMLElement) => {
    const bridge = window.piDesktop?.openMenu;
    if (!bridge) return;
    const rect = anchor.getBoundingClientRect();
    setOpenDesktopMenuId(menu);
    try {
      await bridge(menu, rect.left, rect.bottom);
    } finally {
      setOpenDesktopMenuId(null);
    }
  }, []);

  // Esc remains a non-configurable safety shortcut for stopping an active run.
  useGlobalKeyboardShortcuts();

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectRoot, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (prev && prev.id === sessionId && !prev.projectRoot ? full : prev));
      })
      .catch(() => {});
  }, []);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo) => {
    setNewSessionCwd(null);
    setNewSessionInitialModel(null);
    setNewSessionInitialPrompt(null);
    setSelectedSession(session);
    setRefreshKey((k) => k + 1);
    hydrateSelectedSession(session.id);
    replaceUrlWithoutNextNavigation(`?session=${encodeURIComponent(session.id)}`);
  }, [hydrateSelectedSession]);

  const optimizeUnnamedSessionTitle = useCallback(async (sessionId: string) => {
    if (automaticTitleRequestsRef.current.has(sessionId)) return;
    automaticTitleRequestsRef.current.add(sessionId);
    try {
      const titleModel = readSessionTitleModel(window.localStorage);
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          onlyIfUnnamed: true,
          instructions: readSessionTitlePrompt(window.localStorage),
          ...(titleModel ?? {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title?.trim()) throw new Error(body.error || `HTTP ${response.status}`);
      const title = body.title.trim();
      setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
      setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
      setRefreshKey((current) => current + 1);
    } catch (error) {
      // A later completed turn may retry a transient provider/network failure.
      automaticTitleRequestsRef.current.delete(sessionId);
      console.warn("Automatic session title optimization failed:", error);
    }
  }, []);

  const handleAgentEnd = useCallback((sessionId: string) => {
    setExplorerRefreshKey((k) => k + 1);
    void fetch("/api/companion/task-records/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).then((response) => {
      if (!response.ok) console.warn(`Companion task capture failed: HTTP ${response.status}`);
    }).catch((error) => {
      console.warn("Companion task capture failed:", error);
    });
    if (selectedSession?.id === sessionId && !selectedSession.name?.trim()) {
      void optimizeUnnamedSessionTitle(sessionId);
    }
    const taskTitle = selectedSession?.name
      || (activeCwd ? getFileName(activeCwd) || activeCwd : undefined);
    void notifyCompletion(taskTitle, sessionId);
  }, [activeCwd, notifyCompletion, optimizeUnnamedSessionTitle, selectedSession?.id, selectedSession?.name]);

  const handleTaskControlsChange = useCallback((controls: TaskControls | null) => {
    setTaskControls(controls);
  }, []);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string) => {
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setNewSessionInitialModel(null);
    setNewSessionInitialPrompt(null);
    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
    }));
    hydrateSelectedSession(newSessionId);
    replaceUrlWithoutNextNavigation(`?session=${encodeURIComponent(newSessionId)}`);
  }, [hydrateSelectedSession]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  const handleSessionDeleted = useCallback((deleted: SessionInfo) => {
    setRefreshKey((k) => k + 1);
    if (selectedSession?.id === deleted.id) {
      const cwd = selectedSession.cwd;
      setSelectedSession(null);
      setNewSessionCwd(cwd ?? null);
      setNewSessionInitialModel(null);
      setNewSessionInitialPrompt(null);
      setSessionKey((k) => k + 1);
      setSystemPrompt(null);
      setActiveTopPanel(null);
      replaceUrlWithoutNextNavigation("/");
    }
  }, [selectedSession]);

  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff"; line?: number },
  ) => {
    const sourceSessionId = options?.sourceSessionId;
    const modeHint = options?.modeHint;
    const revealLine = options?.line;
    const tabId = `file:${filePath}`;
    setClosedFileTabs((current) => current.filter((tab) => tab.id !== tabId));
    setFileTabs((prev) => {
      const existing = prev.find((t) => t.id === tabId);
      if (!existing) {
        return [...prev, {
          id: tabId,
          label: fileName,
          filePath,
          cwd: activeCwd ?? undefined,
          sourceSessionId,
          initialDisplayMode: modeHint,
          ...(revealLine ? { revealLine, revealKey: Date.now() } : {}),
        }];
      }
      const sourceUnchanged = !sourceSessionId || existing.sourceSessionId === sourceSessionId;
      const modeUnchanged = !modeHint || existing.initialDisplayMode === modeHint;
      if (sourceUnchanged && modeUnchanged && !revealLine) return prev;
      return prev.map((t) => {
        if (t.id !== tabId) return t;
        const next: Tab = { ...t };
        if (sourceSessionId) next.sourceSessionId = sourceSessionId;
        if (modeHint) next.initialDisplayMode = modeHint;
        if (revealLine) { next.revealLine = revealLine; next.revealKey = Date.now(); }
        return next;
      });
    });
    setActiveFileTabId(tabId);
    setRightPanelTab("files");
    setRightPanelOpen(true);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [activeCwd, isMobile]);

  const handleOpenLinkedFile = useCallback((filePath: string) => {
    const resolvedPath = resolveWorkspaceFilePath(
      filePath,
      selectedSession?.cwd ?? newSessionCwd ?? activeCwd ?? undefined,
    );
    if (!resolvedPath) return;
    handleOpenFile(resolvedPath, getFileName(resolvedPath), {
      sourceSessionId: selectedSession?.id ?? null,
    });
  }, [activeCwd, handleOpenFile, newSessionCwd, selectedSession?.cwd, selectedSession?.id]);

  const handleCloseFileTab = useCallback(async (tabId: string) => {
    const closingIndex = fileTabs.findIndex((tab) => tab.id === tabId);
    if (closingIndex < 0) return;

    const closingTab = fileTabs[closingIndex];
    if (!await confirmDiscardFileTabs([closingTab])) return;

    const remaining = fileTabs.filter((tab) => tab.id !== tabId);
    setClosedFileTabs((current) => rememberClosedFileTabs(current, [closingTab]));
    setFileTabs(remaining);
    if (remaining.length === 0) setRightPanelOpen(false);
    if (activeFileTabId === tabId) {
      const nextIndex = Math.min(closingIndex, remaining.length - 1);
      setActiveFileTabId(nextIndex >= 0 ? remaining[nextIndex].id : null);
    }
  }, [activeFileTabId, confirmDiscardFileTabs, fileTabs]);

  const handleCloseOtherFileTabs = useCallback(async (tabId: string) => {
    const target = fileTabs.find((tab) => tab.id === tabId);
    if (!target) return;
    const closingTabs = tabsExcept(fileTabs, tabId);
    if (closingTabs.length === 0 || !await confirmDiscardFileTabs(closingTabs)) return;
    setClosedFileTabs((current) => rememberClosedFileTabs(current, closingTabs));
    setFileTabs([target]);
    setActiveFileTabId(tabId);
  }, [confirmDiscardFileTabs, fileTabs]);

  const handleCloseFileTabsToRight = useCallback(async (tabId: string) => {
    const targetIndex = fileTabs.findIndex((tab) => tab.id === tabId);
    if (targetIndex < 0) return;
    const closingTabs = tabsAfter(fileTabs, tabId);
    if (closingTabs.length === 0 || !await confirmDiscardFileTabs(closingTabs)) return;
    const remaining = fileTabs.slice(0, targetIndex + 1);
    setClosedFileTabs((current) => rememberClosedFileTabs(current, closingTabs));
    setFileTabs(remaining);
    if (!remaining.some((tab) => tab.id === activeFileTabId)) setActiveFileTabId(tabId);
  }, [activeFileTabId, confirmDiscardFileTabs, fileTabs]);

  const handleMoveFileTab = useCallback((tabId: string, targetIndex: number) => {
    setFileTabs((current) => moveFileTab(current, tabId, targetIndex));
  }, []);

  const handleReopenClosedFileTab = useCallback(() => {
    if (!reopenableClosedFileTab) return;
    setClosedFileTabs((current) => current.filter((tab) => tab.id !== reopenableClosedFileTab.id));
    setFileTabs((current) => current.some((tab) => tab.id === reopenableClosedFileTab.id)
      ? current
      : [...current, reopenableClosedFileTab]);
    setActiveFileTabId(reopenableClosedFileTab.id);
    setRightPanelTab("files");
    setRightPanelOpen(true);
  }, [reopenableClosedFileTab]);

  useEffect(() => {
    const handleReopenShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== "t") return;
      if (!reopenableClosedFileTab) return;
      event.preventDefault();
      handleReopenClosedFileTab();
    };
    window.addEventListener("keydown", handleReopenShortcut);
    return () => window.removeEventListener("keydown", handleReopenShortcut);
  }, [handleReopenClosedFileTab, reopenableClosedFileTab]);

  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    setActiveTopPanel(null);
    setHistoryDialogOpen(true);
  }, [selectedSession]);

  const handleTaskRename = useCallback(async (name: string) => {
    if (!selectedSession) return;
    const response = await fetch(`/api/sessions/${encodeURIComponent(selectedSession.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) return;
    setSelectedSession((current) => current?.id === selectedSession.id ? { ...current, name } : current);
    setRefreshKey((key) => key + 1);
  }, [selectedSession]);

  const handleTaskExport = useCallback(() => {
    if (!selectedSession) return;
    setHistoryDialogOpen(true);
  }, [selectedSession]);

  const handleOpenTaskChanges = useCallback(() => {
    if (rightPanelOverlayMode) setSidebarOpen(false);
    setRightPanelTab("review");
    setRightPanelOpen(true);
  }, [rightPanelOverlayMode]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd;
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const showRoom = selectedRoom !== null;
  const showConversation = showChat || showRoom;
  const isProjectlessConversation = selectedSession?.projectless === true || isProjectlessChatCwd(effectiveNewSessionCwd);
  const isProjectlessSurface = isProjectlessConversation || (
    !selectedRoom
    && !selectedSession
    && effectiveNewSessionCwd === null
    && initialNavigation.requestedCwd === null
  );
  const projectCwd = selectedRoom?.projectRoot ?? selectedSession?.cwd ?? effectiveNewSessionCwd;
  const currentProjectCwd = isProjectlessSurface
    ? null
    : selectedRoom?.projectRoot ?? selectedSession?.cwd ?? effectiveNewSessionCwd ?? activeCwd;
  const currentProjectPath = isProjectlessSurface
    ? null
    : selectedRoom?.projectRoot ?? selectedSession?.projectRoot ?? activeProjectRootRef.current ?? currentProjectCwd;
  const currentProjectName = isProjectlessSurface
    ? translate("sidebar.chats")
    : currentProjectPath ? getFileName(currentProjectPath) || currentProjectPath : null;
  const requestCompanionInteraction = useCallback(async () => {
    const model = companionPreferences.interactionModel;
    if (!model) throw new Error("companion_model_required");
    const context = buildCompanionInteractionContext({
      rhythm: companionWorkRhythm,
      session: {
        cwd: projectCwd ?? activeCwd ?? undefined,
        sessionId: selectedSession?.id,
        sessionTitle: selectedSession?.name || selectedSession?.firstMessage,
        status: companionActivity.status,
        stats: sessionStats,
        contextUsage,
      },
      runningTasks: runningTaskSnapshots,
      personalTasks: companionPreferences.todos,
      includeWorkContext: companionPreferences.shareWorkContext,
    });
    return requestCompanionSpeech({
      model,
      cwd: projectCwd ?? activeCwd ?? undefined,
      locale,
      context,
    });
  }, [activeCwd, companionActivity.status, companionPreferences.interactionModel, companionPreferences.shareWorkContext, companionPreferences.todos, companionWorkRhythm, contextUsage, locale, projectCwd, runningTaskSnapshots, selectedSession, sessionStats]);
  const [topbarGitStatus, setTopbarGitStatus] = useState<GitStatusResponse | null>(null);
  useEffect(() => {
    if (!currentProjectCwd || selectedRoom) {
      setTopbarGitStatus(null);
      return;
    }
    let disposed = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(`/api/git/status?cwd=${encodeURIComponent(currentProjectCwd)}`, { cache: "no-store", signal: controller.signal });
        if (response.ok && !disposed) setTopbarGitStatus(await response.json() as GitStatusResponse);
      } catch { /* The button remains available without counts. */ }
      if (!disposed && taskControls?.disabled && document.visibilityState === "visible") {
        timer = window.setTimeout(() => { void load(); }, 2_500);
      }
    };
    const refresh = () => { if (!disposed) void load(); };
    void load();
    window.addEventListener("piora:git-status-changed", refresh);
    return () => {
      disposed = true;
      controller?.abort();
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("piora:git-status-changed", refresh);
    };
  }, [currentProjectCwd, selectedRoom, taskControls?.disabled]);
  const topbarLineStats = useMemo(() => topbarGitStatus ? getTrackedGitLineStats(topbarGitStatus) : { additions: 0, deletions: 0 }, [topbarGitStatus]);
  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showConversation;
  const onboardingProjectPath = onboardingProjectCwd ?? currentProjectCwd;

  const handleOnboardingChooseProject = useCallback(() => {
    if (showPlaceholder) {
      setOnboardingProjectPickerRequestKey((key) => key + 1);
      return;
    }
    handleOpenProjectPicker();
  }, [handleOpenProjectPicker, showPlaceholder]);

  const handlePrepareFirstPrompt = useCallback((prompt: string) => {
    chatInputRef.current?.insertIfEmpty(prompt);
    window.requestAnimationFrame(() => chatInputRef.current?.focus());
  }, []);

  const handleNewSessionInCurrentProject = useCallback(() => {
    if (!currentProjectCwd) return;
    handleNewSession(`project-menu-${Date.now()}`, currentProjectCwd);
  }, [currentProjectCwd, handleNewSession]);

  useEffect(() => {
    if (!currentProjectCwd) { setCurrentIsGitRepository(false); return; }
    const controller = new AbortController();
    fetch(`/api/git/status?cwd=${encodeURIComponent(currentProjectCwd)}`, { signal: controller.signal, cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { isGitRepository?: boolean } | null) => setCurrentIsGitRepository(Boolean(data?.isGitRepository)))
      .catch(() => {});
    return () => controller.abort();
  }, [currentProjectCwd, explorerRefreshKey]);

  useEffect(() => {
    const cycleWorkspaceFocus = (event: KeyboardEvent) => {
      if (event.key !== "F6" || event.ctrlKey || event.metaKey || event.altKey || settingsDialogOpen) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const targets: Array<{ zone: "sidebar" | "composer" | "panel"; focus: () => void }> = [];
      if (sidebarOpen) targets.push({ zone: "sidebar", focus: () => sessionSidebarRef.current?.focusPrimaryNavigation() });
      targets.push({ zone: "composer", focus: () => chatInputRef.current?.focus() });
      if (rightPanelOpen) targets.push({ zone: "panel", focus: () => rightPanelRef.current?.focusActiveTab() });
      if (targets.length < 2) return;

      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const currentZone = activeElement?.closest(".session-sidebar-content")
        ? "sidebar"
        : activeElement?.closest("#file-panel")
          ? "panel"
          : "composer";
      const currentIndex = Math.max(0, targets.findIndex((target) => target.zone === currentZone));
      const delta = event.shiftKey ? -1 : 1;
      const nextIndex = (currentIndex + delta + targets.length) % targets.length;
      event.preventDefault();
      targets[nextIndex].focus();
    };
    window.addEventListener("keydown", cycleWorkspaceFocus);
    return () => window.removeEventListener("keydown", cycleWorkspaceFocus);
  }, [rightPanelOpen, settingsDialogOpen, sidebarOpen]);

  const commandActions = useMemo<CommandContext["actions"]>(() => ({
    "navigate.newSession": handleNewSessionInCurrentProject,
    "navigate.chooseProject": handleOpenProjectPicker,
    "navigate.searchFiles": () => { setRightPanelTab("files"); setRightPanelOpen(true); requestAnimationFrame(() => rightPanelRef.current?.focusFileSearch()); },
    "navigate.searchChats": () => sessionSidebarRef.current?.openConversationSearch(),
    "navigate.focusComposer": () => chatInputRef.current?.focus(),
    "navigate.history": handleViewFullHistory,
    "session.rename": (argument) => argument?.trim() ? void handleTaskRename(argument.trim()) : chatInputRef.current?.insertText("/name "),
    "session.export": handleTaskExport,
    "session.compact": () => chatInputRef.current?.insertText("/compact"),
    "session.stats": () => chatInputRef.current?.insertText("/session"),
    "model.select": () => openSettings("models"),
    "model.thinking": () => openSettings("conversation"),
    "panel.review": () => { setRightPanelTab("review"); setRightPanelOpen(true); requestAnimationFrame(() => rightPanelRef.current?.focusActiveTab()); },
    "panel.files": () => { setRightPanelTab("files"); setRightPanelOpen(true); requestAnimationFrame(() => rightPanelRef.current?.focusActiveTab()); },
    "panel.commands": () => { setRightPanelTab("commands"); setRightPanelOpen(true); requestAnimationFrame(() => rightPanelRef.current?.focusActiveTab()); },
    "panel.browser": () => { setRightPanelTab("browser"); setRightPanelOpen(true); requestAnimationFrame(() => rightPanelRef.current?.focusActiveTab()); },
    "panel.design": () => { setRightPanelTab("design"); setRightPanelOpen(true); requestAnimationFrame(() => rightPanelRef.current?.focusActiveTab()); },
    "companion.togglePanel": () => { void window.piDesktop?.companionAction?.("open-panel"); },
    "panel.toggleSidebar": () => setSidebarOpen((open) => !open),
    "panel.close": () => setRightPanelOpen(false),
    "settings.general": () => openSettings("general"),
    "git.commit": (argument) => {
      setRightPanelTab("review");
      setRightPanelOpen(true);
      window.setTimeout(() => {
        if (argument?.trim()) window.dispatchEvent(new CustomEvent("piora:prefill-commit-message", { detail: { cwd: currentProjectCwd, message: argument.trim() } }));
        else window.dispatchEvent(new CustomEvent("piora:focus-review-commit"));
      }, 0);
    },
    "git.refresh": handleExplorerRefresh,
  }), [currentProjectCwd, handleExplorerRefresh, handleNewSessionInCurrentProject, handleOpenProjectPicker, handleTaskExport, handleTaskRename, handleViewFullHistory, openSettings]);
  const commandContext = useMemo<CommandContext>(() => ({ hasProject: Boolean(currentProjectCwd), hasSession: Boolean(selectedSession), isRunning: Boolean(taskControls?.disabled), isGitRepository: currentIsGitRepository, actions: commandActions }), [commandActions, currentIsGitRepository, currentProjectCwd, selectedSession, taskControls?.disabled]);
  const shortcutLabels = useMemo(() => Object.fromEntries(APPLICATION_SHORTCUTS.map((item) => [
    item.id,
    formatShortcutBinding(shortcutBindings[item.id], isMacPlatform(typeof window === "undefined" ? undefined : window.piDesktop?.platform)),
  ])), [shortcutBindings]);
  const { commands: guiCommands, run: runGuiCommand } = useCommands(commandContext, translate, shortcutLabels);

  useEffect(() => {
    const handleApplicationShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || shouldPreserveApplicationShortcut(event.target)) return;
      const shortcut = APPLICATION_SHORTCUTS.find((item) => shortcutMatchesEvent(
        event,
        shortcutBindings[item.id],
        isMacPlatform(window.piDesktop?.platform),
      ));
      if (!shortcut) return;
      event.preventDefault();
      if (shortcut.id === "palette.open") setCommandPaletteOpen(true);
      else void commandActions[shortcut.id]?.();
    };
    window.addEventListener("keydown", handleApplicationShortcut);
    return () => window.removeEventListener("keydown", handleApplicationShortcut);
  }, [commandActions, shortcutBindings]);

  useEffect(() => {
    void window.piDesktop?.setKeyboardShortcuts?.(shortcutBindings);
  }, [shortcutBindings]);

  useEffect(() => {
    if (!window.piDesktop?.setNetworkProxy) return;
    const controller = new AbortController();
    void fetch("/api/network-proxy", { cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((settings: { mode: "system" | "manual" | "direct"; proxyUrl: string; bypass: string } | null) => (
        settings ? window.piDesktop?.setNetworkProxy?.(settings) : undefined
      ))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  const piPaletteCommands = useMemo<Command[]>(() => piSlashCommands.map((item) => ({
    id: `pi:${item.source}:${item.name}`,
    group: "session",
    title: `/${item.name}${item.description ? ` — ${item.description}` : ""}`,
    source: item.sourceInfo?.source ?? item.source,
    enabled: () => selectedSession ? true : { reason: "commands.needsSession" },
    run: () => { chatInputRef.current?.insertText(`/${item.name} `); chatInputRef.current?.focus(); },
  })), [piSlashCommands, selectedSession]);
  const paletteCommands = useMemo(() => [...guiCommands, ...piPaletteCommands], [guiCommands, piPaletteCommands]);
  const searchPaletteCommands = useCallback((query: string) => filterGuiCommands(paletteCommands, query, (item) => item.id.startsWith("pi:") ? item.title : translate(item.title)), [paletteCommands, translate]);
  const runPaletteCommand = useCallback(async (item: Command, argument?: string) => { if (item.id.startsWith("pi:")) await item.run(commandContext, argument); else await runGuiCommand(item, argument); }, [commandContext, runGuiCommand]);

  const handleCopyCurrentProjectPath = useCallback(() => {
    if (!currentProjectCwd) return;
    void copyText(currentProjectCwd).then(() => {
      if (projectPathCopyTimerRef.current) clearTimeout(projectPathCopyTimerRef.current);
      setProjectPathCopied(true);
      projectPathCopyTimerRef.current = setTimeout(() => setProjectPathCopied(false), 1400);
    }).catch(() => {});
  }, [currentProjectCwd]);

  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const baseWindowTitle = activeCwdName ? `${activeCwdName} - Piora` : "Piora";
  const hasPendingInput = runningTaskSnapshots.some((snapshot) => snapshot.pendingApproval);
  const windowTitle = hasPendingInput
    ? `${baseWindowTitle}${translate("app.titlePendingInput")}`
    : baseWindowTitle;
  const desktopUpdateAvailable = desktopUpdateState?.status === "available"
    || desktopUpdateState?.status === "downloading"
    || desktopUpdateState?.status === "downloaded";
  const desktopMenus: Array<{ id: DesktopMenuId; label: string }> = locale === "zh-CN"
    ? [
        { id: "file", label: "文件" },
        { id: "edit", label: "编辑" },
        { id: "view", label: "视图" },
        { id: "help", label: "帮助" },
      ]
    : [
        { id: "file", label: "File" },
        { id: "edit", label: "Edit" },
        { id: "view", label: "View" },
        { id: "help", label: "Help" },
      ];

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const sidebarContent = (
    <SessionSidebar
      ref={sessionSidebarRef}
      selectedSessionId={selectedSession?.id ?? null}
      selectedRoomId={selectedRoom?.id ?? null}
      onSelectSession={handleSelectSession}
      onSelectSearchResult={handleSelectSearchResult}
      onSelectRoom={handleSelectRoom}
      onNewSession={handleNewSession}
      onRequestNewSession={handleRequestNewSession}
      initialSessionId={initialSessionId}
      initialRoomId={initialRoomId}
      skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
      onInitialRestoreDone={handleInitialRestoreDone}
      onInitialRoomRestoreDone={handleInitialRestoreDone}
      refreshKey={refreshKey}
      onSessionDeleted={handleSessionDeleted}
      selectedCwd={isProjectlessConversation ? null : selectedRoom?.projectRoot ?? selectedSession?.cwd ?? newSessionCwd ?? null}
      activeProjectRoot={currentProjectPath}
      onCwdChange={handleCwdChange}
      onFocusFileSearch={() => {
        setRightPanelTab("files");
        setRightPanelOpen(true);
        requestAnimationFrame(() => rightPanelRef.current?.focusFileSearch());
      }}
      onOpenSettings={(key) => openSettings(key)}
    />
  );

  const settingsPage = settingsDialogOpen ? (
    <SettingsDialog
      open={settingsDialogOpen}
      onClose={() => setSettingsDialogOpen(false)}
      activeKey={settingsKey}
      onActiveKeyChange={setSettingsKey}
      onOpenOnboarding={() => {
        setSettingsDialogOpen(false);
        setOnboardingRestartKey((key) => key + 1);
      }}
      modelCwd={projectCwd ?? activeCwd ?? undefined}
      sections={{
        capabilityBundles: projectCwd ? (
          <CapabilityBundlesConfig
            cwd={projectCwd}
            sessionId={selectedSession?.id ?? null}
            onReloaded={() => setSessionKey((key) => key + 1)}
          />
        ) : undefined,
        automations: (
          <AutomationPanel
            embedded
            sessionId={selectedSession?.id ?? null}
            sessionName={selectedSession?.name}
            cwd={projectCwd ?? activeCwd}
            onAutomationChanged={() => setSessionKey((key) => key + 1)}
          />
        ),
        shortcuts: <ShortcutSettings />,
        extensions: projectCwd ? (
          <ExtensionsConfig
            cwd={projectCwd}
            sessionId={selectedSession?.id ?? null}
            onReloaded={() => setSessionKey((key) => key + 1)}
          />
        ) : undefined,
        models: (
          <ModelsConfig
            embedded
            cwd={projectCwd ?? activeCwd ?? undefined}
            onModelsChanged={() => setModelsRefreshKey((key) => key + 1)}
            onClose={() => setSettingsKey("general")}
          />
        ),
        skills: projectCwd ? (
          <SkillsConfig embedded cwd={projectCwd} onClose={() => setSettingsKey("general")} />
        ) : undefined,
        plugins: projectCwd ? (
          <PluginsConfig
            embedded
            cwd={projectCwd}
            sessionId={selectedSession?.id ?? null}
            onClose={() => setSettingsKey("general")}
            onReloaded={() => setSessionKey((key) => key + 1)}
          />
        ) : undefined,
        appearance: (
          <div className="settings-embedded-surface" style={{ height: "100%", overflowY: "auto", padding: "26px 30px 34px" }}>
            <div style={{ marginBottom: 22 }}>
              <h2 style={{ margin: 0, color: "var(--text)", fontSize: "calc(var(--text-lg) * 1.22)", fontWeight: 680 }}>{translate("appearance.title")}</h2>
              <p style={{ margin: "7px 0 0", color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{translate("appearance.description")}</p>
              <AppearanceResetButton />
            </div>
            <AppearanceLooks />
            <section aria-labelledby="settings-appearance-theme" style={{ paddingBottom: 16 }}>
              <h3 id="settings-appearance-theme" style={{ margin: "0 0 3px", fontSize: "var(--text-sm)" }}>{translate("appearance.theme")}</h3>
              <p style={{ margin: "0 0 10px", color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>{translate("appearance.themeHint")}</p>
              <div role="radiogroup" aria-label={translate("appearance.theme")} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(108px, 1fr))", gap: 8 }}>
                {themes.filter(({ id }) => id === "light" || id === "dark").map((preset) => (
                  <ThemeOption key={preset.id} preset={preset} theme={theme} onSelect={setTheme} translate={translate} />
                ))}
              </div>
              <button type="button" className="theme-menu-option" aria-expanded={moreThemesOpen} onClick={() => setMoreThemesOpen((open) => !open)} style={{ width: "100%", marginTop: 10, padding: "7px 9px", display: "flex", alignItems: "center", gap: 7, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: "var(--text-xs)" }}>
                <AliIcon name={moreThemesOpen ? "arrowdown" : "arrowright"} size={12} />
                <span style={{ flex: 1, textAlign: "left" }}>{translate("theme.more")}</span>
                <span>{themes.length - 2}</span>
              </button>
              {moreThemesOpen && (
                <div role="radiogroup" aria-label={translate("theme.more")} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(108px, 1fr))", gap: 8, marginTop: 8 }}>
                  {themes.filter(({ id }) => id !== "light" && id !== "dark").map((preset) => (
                    <ThemeOption key={preset.id} preset={preset} theme={theme} onSelect={setTheme} translate={translate} />
                  ))}
                </div>
              )}
            </section>
            <FontSettings />
            <BackgroundSettings />
          </div>
        ),
        language: (
          <div className="settings-embedded-surface" style={{ height: "100%", overflowY: "auto", padding: "26px 30px" }}>
            <h2 style={{ margin: 0, color: "var(--text)", fontSize: "calc(var(--text-lg) * 1.22)", fontWeight: 680 }}>{translate("common.language")}</h2>
            <p style={{ margin: "7px 0 22px", color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{translate("settings.languageDescription")}</p>
            <div role="radiogroup" aria-label={translate("common.language")} style={{ display: "grid", gap: 8, maxWidth: 520 }}>
              {supportedLocales.map((plugin) => (
                <button key={plugin.id} type="button" role="radio" aria-checked={locale === plugin.id} onClick={() => setLocale(plugin.id as typeof locale)} style={{ minHeight: 44, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", border: "1px solid var(--border)", borderRadius: 9, background: locale === plugin.id ? "var(--bg-selected)" : "var(--bg-panel)", color: "var(--text)", cursor: "pointer", font: "inherit" }}>
                  <span>{plugin.label}</span>
                  {locale === plugin.id ? <AliIcon name="check" size={14} style={{ color: "var(--accent)" }} /> : null}
                </button>
              ))}
            </div>
          </div>
        ),
        remote: (
          <RemoteControlSettings sessionId={selectedSession?.id ?? null} />
        ),
        harmony: (
          <HarmonyStorageSettings />
        ),
        speech: (
          <SpeechSettings />
        ),
        usage: (
          <UsageStatsPanel />
        ),
        archived: (
          <ArchivedChatsSettings
            onChanged={() => setRefreshKey((key) => key + 1)}
            onSessionDeleted={handleSessionDeleted}
          />
        ),
        companion: (
          <CompanionSettingsDialog
            embedded
            open
            onClose={() => setSettingsKey("general")}
            companionOpen={companionOpen}
            onCompanionOpenChange={setCompanionOpen}
            alwaysOnTop={companionAlwaysOnTop}
            onAlwaysOnTopChange={(alwaysOnTop) => {
              setCompanionPreferences((current) => ({ ...current, alwaysOnTop }));
            }}
            idleTricks={companionPreferences.idleTricks !== false}
            onIdleTricksChange={(idleTricks) => {
              setCompanionPreferences((current) => ({ ...current, idleTricks }));
            }}
            desktopMode={desktopChrome}
            preferences={companionPreferences}
            setPreferences={setCompanionPreferences}
            cwd={projectCwd ?? activeCwd ?? undefined}
            canSendPhrase={canSendCompanionPhrase(companionActivity.status, showChat)}
            onSendPhrase={handleSendCompanionPhrase}
            selectedPetId={companionPreferences.selectedPetId}
            onSelectPet={handleSelectCompanionPet}
            catalog={companionPets.catalog}
            loading={companionPets.loading}
            error={companionPets.error}
            importingPetKey={companionPets.importingPetKey}
            importingArchive={companionPets.importingArchive}
            onRefresh={() => { void companionPets.loadPets(); }}
            onImportPet={companionPets.importPet}
            onImportArchive={companionPets.importPetArchive}
          />
        ),
      }}
      conversation={{
        systemPrompt,
        onSystemPromptSaved: handleSystemPromptSaved,
        notificationEnabled,
        notificationCapability,
        onNotificationToggle: () => { void onNotificationToggle(); },
      }}
      desktop={{
        available: desktopChrome,
        globalShortcutEnabled,
        onGlobalShortcutToggle: toggleGlobalShortcut,
      }}
    />
  ) : null;
  const effectiveRightPanelOpen = rightPanelOpen && !settingsDialogOpen;

  return (
    <>
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: 0 18px 44px rgba(37,99,235,0.16);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(-100%);
          box-shadow: none;
        }
      }
    `}</style>
    <div
      className={`app-shell${desktopChrome ? " desktop-chrome" : ""}`}
      data-app-hydrated={appHydrated ? "" : undefined}
      data-side-panel-mode={rightPanelOverlayMode ? "overlay" : "split"}
      style={{
        "--workspace-min-width": `${WORKSPACE_MIN_WIDTH}px`,
        display: "flex",
        height: "100dvh",
        overflow: "hidden",
        background: "var(--bg)",
      } as React.CSSProperties}
    >
      <a className="skip-to-content" href="#piora-main-content">{translate("a11y.skipToContent")}</a>
      {desktopChrome ? (
        <header className="desktop-titlebar" aria-label={windowTitle}>
          <div className="desktop-titlebar-mark" aria-hidden="true" />
          <nav className="desktop-titlebar-menus" aria-label={locale === "zh-CN" ? "应用菜单" : "Application menu"}>
            {desktopMenus.map((menu) => (
              <button
                key={menu.id}
                type="button"
                className="desktop-titlebar-menu"
                aria-haspopup="menu"
                aria-expanded={openDesktopMenuId === menu.id}
                data-active={openDesktopMenuId === menu.id ? "true" : "false"}
                onClick={(event) => { void openDesktopMenu(menu.id, event.currentTarget); }}
              >
                <span>{menu.label}</span>
              </button>
            ))}
            {desktopUpdateState?.audience === "preview" ? (
              <span
                className="desktop-titlebar-preview-badge"
                title={locale === "zh-CN" ? "此设备接收正式版和内测版更新" : "This device receives stable and preview updates"}
              >
                {locale === "zh-CN" ? "内测版" : "Preview"}
              </span>
            ) : null}
            {desktopUpdateAvailable ? (
              <button
                type="button"
                className="desktop-titlebar-update-button"
                data-status={desktopUpdateState?.status}
                onClick={handleOpenDesktopUpdate}
                aria-label={locale === "zh-CN" ? "下载 Piora 更新" : "Download Piora update"}
                title={locale === "zh-CN" ? "Piora 有可用更新" : "A Piora update is available"}
              >
                <AliIcon name="download" size={15} />
                <span className="desktop-titlebar-update-dot" aria-hidden="true" />
              </button>
            ) : null}
          </nav>
          <div className="desktop-titlebar-drag" />
        </header>
      ) : null}
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        ref={sidebarResizer.panelRef}
        id="session-sidebar"
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarResizer.isResizing ? " sidebar-resizing" : ""}`}
        style={{
          "--sidebar-width": `${sidebarResizer.width}px`,
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: rightPanelMaximized ? "none" : "flex",
          flexDirection: "column",
          flexShrink: 0,
          zIndex: 200,
        } as React.CSSProperties}
      >
        {sidebarContent}
      </div>
      {sidebarOpen && !rightPanelMaximized && (
        <div
          {...sidebarResizer.separatorProps}
          aria-controls="session-sidebar"
          className={`panel-resize-handle sidebar-resize-handle${sidebarResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="sidebar"
          title={`${translate("layout.resizeSidebar")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Center: chat */}
      <div id="piora-main-content" role="main" tabIndex={-1} className="workspace-main" style={{ flex: 1, display: rightPanelMaximized ? "none" : "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
        {/* Quiet conversation chrome: identity on the left, contextual actions on the right. */}
        <div ref={topBarRef} className="app-topbar">
          <button
            className="topbar-control topbar-icon-button topbar-sidebar-toggle"
            onClick={handleSidebarToggle}
            title={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
            aria-label={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
          >
            {sidebarOpen ? (
              <AliIcon name="layout" size={16} />
            ) : (
              <AliIcon name="menu" size={18} />
            )}
           </button>
          <div className="app-topbar-identity" aria-live="polite">
            <button
              ref={projectBtnRef}
              className="app-topbar-title"
              type="button"
              onClick={() => toggleTopPanel("project")}
              onMouseEnter={openProjectPanelOnHover}
              onMouseLeave={closeProjectPanelAfterHover}
              title={currentProjectPath ?? translate("projectMenu.noProject")}
              aria-label={translate("projectMenu.title")}
              aria-haspopup="menu"
              aria-expanded={activeTopPanel === "project"}
              aria-pressed={activeTopPanel === "project"}
              data-active={activeTopPanel === "project" ? "true" : "false"}
            >
              <span className="app-topbar-title-icon" aria-hidden="true">
                <AliIcon name={isProjectlessSurface ? "message" : "folder-open"} size={16} />
              </span>
              <span className="app-topbar-title-text">
                {currentProjectName ?? translate("projectMenu.noProject")}
              </span>
            </button>
            {showConversation || settingsDialogOpen ? <span className="app-topbar-title-separator" aria-hidden="true">/</span> : null}
            {settingsDialogOpen ? (
              <span className="app-topbar-title-path">{translate("sidebar.settings")}</span>
            ) : showConversation ? (
              <span
                className={`app-topbar-title-path${selectedRoom || selectedSession?.name ? "" : " is-placeholder"}`}
                title={selectedRoom?.name ?? selectedSession?.name ?? translate("i18n.newSession")}
              >
                {selectedRoom?.name ?? selectedSession?.name ?? translate("i18n.newSession")}
              </span>
            ) : null}
          </div>
          {!settingsDialogOpen && (
            <div className="conversation-toolbar-actions">
              {showChat ? (
                <>
                  <button
                    className="topbar-control topbar-changes-button"
                    type="button"
                    onClick={handleOpenTaskChanges}
                    disabled={!topbarGitStatus?.isGitRepository}
                    title={translate("review.changesTree")}
                    aria-label={translate("review.changesTree")}
                  >
                    <AliIcon name="code" size={14} />
                    {topbarGitStatus?.isGitRepository ? <span className="topbar-changes-lines"><b>+{topbarLineStats.additions}</b><i>−{topbarLineStats.deletions}</i></span> : null}
                  </button>
                  <button
                    className="topbar-control topbar-history-button"
                    type="button"
                    onClick={handleViewFullHistory}
                    disabled={!selectedSession}
                    title={selectedSession ? translate("history.full") : translate("history.unsaved")}
                    aria-label={translate("history.full")}
                    aria-haspopup="dialog"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      height: "100%",
                      padding: "0 12px",
                      background: "none",
                      border: "none",
                      borderTop: "2px solid transparent",
                      color: selectedSession ? "var(--text-muted)" : "var(--text-dim)",
                      cursor: selectedSession ? "pointer" : "not-allowed",
                      opacity: selectedSession ? 1 : 0.45,
                      flexShrink: 0,
                      fontSize: "var(--text-xs)",
                      whiteSpace: "nowrap",
                      transition: "color 0.1s, background 0.1s, opacity 0.1s",
                    }}
                    onMouseEnter={(e) => {
                      if (!selectedSession) return;
                      e.currentTarget.style.color = "var(--text)";
                      e.currentTarget.style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = selectedSession ? "var(--text-muted)" : "var(--text-dim)";
                      e.currentTarget.style.background = "none";
                    }}
                  >
                    <AliIcon name="history" size={15} />
                    {!isMobile && <span className="topbar-action-label">{translate("history.label")}</span>}
                  </button>
                </>
              ) : null}
              <button
                className={`topbar-control topbar-icon-button right-panel-toggle ${rightPanelOpen ? "is-open" : "is-closed"}`}
                type="button"
                data-panel-open={rightPanelOpen ? "true" : "false"}
                onClick={() => setRightPanelOpen((value) => !value)}
                aria-controls="file-panel"
                aria-expanded={rightPanelOpen}
                title={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
                aria-label={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: TOP_BAR_ICON_BUTTON_SIZE,
                  height: "100%",
                  padding: 0,
                  background: rightPanelOpen ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: rightPanelOpen ? "2px solid var(--accent)" : "2px solid transparent",
                  borderRadius: 7,
                  color: rightPanelOpen ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                  transition: "color 0.1s, background 0.1s",
                }}
              >
                <AliIcon name="layout" size={16} />
              </button>
            </div>
          )}
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && (
            <div
              ref={topPanelFrameRef}
              className="app-top-panel-frame"
              onMouseEnter={activeTopPanel === "project" ? cancelProjectHoverClose : undefined}
              onMouseLeave={activeTopPanel === "project" ? closeProjectPanelAfterHover : undefined}
              style={{
              position: "absolute",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              maxHeight: "calc(100dvh - 76px)",
              overflowY: "auto",
              zIndex: 500,
            }}>
              {activeTopPanel === "project" && (
                <div
                  className="soft-top-panel"
                  role="menu"
                  aria-label={translate("projectMenu.title")}
                  data-project-menu
                >
                  <div className="soft-top-panel-header">
                    <span className="soft-top-panel-icon" aria-hidden="true">
                      <AliIcon name={isProjectlessSurface ? "message" : "folder-open"} size={15} />
                    </span>
                    <span className="soft-top-panel-heading">
                      <span className="soft-top-panel-title">
                        {currentProjectName ?? translate("projectMenu.noProject")}
                      </span>
                      <span className="soft-top-panel-description" title={currentProjectPath ?? undefined}>
                        {currentProjectPath ?? translate("projectMenu.description")}
                      </span>
                    </span>
                  </div>
                  <div className="soft-top-panel-body">
                    <button
                      className="soft-menu-item"
                      type="button"
                      role="menuitem"
                      disabled={!currentProjectCwd}
                      onClick={handleNewSessionInCurrentProject}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "18px minmax(0, 1fr)",
                        columnGap: 8,
                        cursor: currentProjectCwd ? "pointer" : "not-allowed",
                        opacity: currentProjectCwd ? 1 : 0.5,
                      }}
                    >
                      <span aria-hidden="true" style={{ paddingTop: 2, color: "var(--text-muted)" }}>
                        <AliIcon name="compose" size={14} />
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span className="soft-menu-item-title">{translate("projectMenu.newSession")}</span>
                        <span className="soft-menu-item-description">{translate("projectMenu.newSessionDescription")}</span>
                      </span>
                    </button>
                    <button
                      className="soft-menu-item"
                      type="button"
                      role="menuitem"
                      onClick={handleOpenProjectPicker}
                      style={{ display: "grid", gridTemplateColumns: "18px minmax(0, 1fr)", columnGap: 8, cursor: "pointer" }}
                    >
                      <span aria-hidden="true" style={{ paddingTop: 2, color: "var(--text-muted)" }}>
                        <AliIcon name="project" size={14} />
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span className="soft-menu-item-title">{translate("projectMenu.switchProject")}</span>
                        <span className="soft-menu-item-description">{translate("projectMenu.switchProjectDescription")}</span>
                      </span>
                    </button>
                    <button
                      className="soft-menu-item"
                      type="button"
                      role="menuitem"
                      disabled={!currentProjectCwd}
                      onClick={handleCopyCurrentProjectPath}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "18px minmax(0, 1fr)",
                        columnGap: 8,
                        cursor: currentProjectCwd ? "pointer" : "not-allowed",
                        opacity: currentProjectCwd ? 1 : 0.5,
                      }}
                    >
                      <span aria-hidden="true" style={{ paddingTop: 2, color: projectPathCopied ? "var(--accent)" : "var(--text-muted)" }}>
                        {projectPathCopied ? (
                          <AliIcon name="check" size={14} />
                        ) : (
                          <AliIcon name="copy" size={14} />
                        )}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span className="soft-menu-item-title">
                          {translate(projectPathCopied ? "projectMenu.copied" : "projectMenu.copyPath")}
                        </span>
                        <span className="soft-menu-item-description" title={currentProjectCwd ?? undefined}>
                          {currentProjectCwd ?? translate("projectMenu.copyPathDescription")}
                        </span>
                      </span>
                    </button>
                    {!sidebarOpen && (
                      <>
                        <div className="soft-top-panel-divider" />
                        <button
                          className="soft-menu-item"
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setSidebarOpen(true);
                            setActiveTopPanel(null);
                          }}
                          style={{ display: "grid", gridTemplateColumns: "18px minmax(0, 1fr)", columnGap: 8, cursor: "pointer" }}
                        >
                          <span aria-hidden="true" style={{ paddingTop: 2, color: "var(--text-muted)" }}>
                            <AliIcon name="layout" size={14} />
                          </span>
                          <span style={{ minWidth: 0 }}>
                            <span className="soft-menu-item-title">{translate("projectMenu.showSidebar")}</span>
                            <span className="soft-menu-item-description">{translate("projectMenu.showSidebarDescription")}</span>
                          </span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              )}
              {activeTopPanel === "taskControls" && (
                <div
                  className="soft-top-panel"
                  role="menu"
                  aria-label={translate("conversationMenu.title")}
                >
                  <div className="soft-top-panel-header">
                    <span className="soft-top-panel-icon" aria-hidden="true">
                      <AliIcon name="ellipsis" size={15} />
                    </span>
                    <span className="soft-top-panel-heading">
                      <span className="soft-top-panel-title">{translate("conversationMenu.title")}</span>
                      <span className="soft-top-panel-description">{translate("conversationMenu.description")}</span>
                    </span>
                  </div>
                  <div className="soft-top-panel-body">
                    <div className="soft-top-panel-section-label">{translate("conversationMenu.actions")}</div>
                    <button
                      className="soft-menu-item"
                      type="button"
                      role="menuitem"
                      onClick={() => setActiveTopPanel("system")}
                      style={{ display: "grid", gridTemplateColumns: "18px minmax(0, 1fr)", columnGap: 8, cursor: "pointer" }}
                    >
                      <span aria-hidden="true" style={{ paddingTop: 2, color: systemPrompt ? "var(--accent)" : "var(--text-muted)" }}>
                        <AliIcon name="file" size={14} />
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span className="soft-menu-item-title">{translate("system.prompt")}</span>
                        <span className="soft-menu-item-description">{translate("conversationMenu.systemPromptDescription")}</span>
                      </span>
                    </button>
                    <div className="soft-top-panel-divider" />
                    {taskControls ? (
                      <>
                        <button
                          className="soft-menu-item"
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={notificationEnabled}
                          disabled={notificationCapability === "unsupported"}
                          onClick={() => void onNotificationToggle()}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "18px minmax(0, 1fr) auto",
                            columnGap: 8,
                            alignItems: "start",
                            cursor: notificationCapability === "unsupported" ? "not-allowed" : "pointer",
                            opacity: notificationCapability === "unsupported" ? 0.5 : 1,
                          }}
                        >
                          <span aria-hidden="true" style={{ paddingTop: 2, color: notificationEnabled ? "var(--accent)" : "var(--text-dim)" }}>
                            <AliIcon name="notification" size={13} />
                          </span>
                          <span style={{ minWidth: 0 }}>
                            <span className="soft-menu-item-title">{translate("taskControls.notifications")}</span>
                            <span className="soft-menu-item-description">
                              {notificationCapability === "unsupported"
                                ? translate("taskControls.notificationsUnsupported")
                                : translate("taskControls.notificationsDescription")}
                            </span>
                          </span>
                          <span className={`soft-switch${notificationEnabled ? " is-on" : ""}`} aria-hidden="true">
                            <span />
                          </span>
                        </button>
                      </>
                    ) : (
                      <div className="soft-top-panel-empty" role="status">{translate("taskControls.loading")}</div>
                    )}
                  </div>
                </div>
              )}
              {activeTopPanel === "language" && (
                <div
                  className="soft-top-panel soft-top-panel-compact"
                  role="menu"
                  aria-label={translate("common.language")}
                >
                  {supportedLocales.map((plugin) => (
                    <button
                      className="soft-menu-item soft-menu-item-single-line"
                      key={plugin.id}
                      type="button"
                      onClick={() => {
                        setLocale(plugin.id as typeof locale);
                        setActiveTopPanel(null);
                      }}
                      role="menuitemradio"
                      aria-checked={locale === plugin.id}
                      style={{
                        display: "flex", alignItems: "center",
                        width: "100%", minHeight: 34,
                        background: locale === plugin.id ? "var(--bg-selected)" : "transparent",
                        cursor: "pointer",
                      }}
                    >
                      <span>{plugin.label}</span>
                      {locale === plugin.id ? (
                        <AliIcon name="check" size={13} style={{ color: "var(--accent)" }} />
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
              {activeTopPanel === "system" && (
                <div className="soft-top-panel">
                  <div className="soft-top-panel-header">
                    <span className="soft-top-panel-icon" aria-hidden="true">
                      <AliIcon name="file" size={15} />
                    </span>
                    <span className="soft-top-panel-heading">
                      <span className="soft-top-panel-title">{translate("system.prompt")}</span>
                      <span className="soft-top-panel-description">{translate("system.description")}</span>
                    </span>
                  </div>
                  <div className="soft-top-panel-body">
                    <SystemPromptEditor
                      compact
                      effectivePrompt={systemPrompt}
                      onSaved={handleSystemPromptSaved}
                    />
                  </div>
                </div>
              )}
              {activeTopPanel === "session" && (
                <div className="session-info-popover soft-top-panel" style={{
                  background: "var(--bg-panel)",
                  padding: "12px 16px",
                }}>
                  {sessionStats ? (() => {
                    const sessionRows = [
                       ...(sessionStats.sessionName ? [{ label: translate("session.name"), value: sessionStats.sessionName, copyField: null }] : []),
                       { label: translate("session.file"), value: sessionStats.sessionFile ?? translate("session.inMemory"), copyField: "file" as const },
                       { label: translate("session.id"), value: sessionStats.sessionId, copyField: "id" as const },
                    ];
                    const messageRows = [
                       [translate("session.user"), sessionStats.userMessages.toLocaleString(locale)],
                       [translate("session.assistant"), sessionStats.assistantMessages.toLocaleString(locale)],
                       [translate("session.toolCalls"), sessionStats.toolCalls.toLocaleString(locale)],
                       [translate("session.toolResults"), sessionStats.toolResults.toLocaleString(locale)],
                       [translate("session.total"), sessionStats.totalMessages.toLocaleString(locale)],
                    ];
                    const tokenRows = [
                       [translate("session.input"), sessionStats.tokens.input.toLocaleString(locale)],
                       [translate("session.output"), sessionStats.tokens.output.toLocaleString(locale)],
                       ...(sessionStats.tokens.cacheRead > 0 ? [[translate("session.cacheRead"), sessionStats.tokens.cacheRead.toLocaleString(locale)]] : []),
                       ...(sessionStats.tokens.cacheWrite > 0 ? [[translate("session.cacheWrite"), sessionStats.tokens.cacheWrite.toLocaleString(locale)]] : []),
                       [translate("session.total"), sessionStats.tokens.total.toLocaleString(locale)],
                    ];
                    const ctx = contextUsage ?? sessionStats.contextUsage;
                    const formatCompact = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
                    const extraTokenRows = [
                       ...(sessionStats.cost > 0 ? [[translate("session.cost"), `$${sessionStats.cost.toFixed(4)}`]] : []),
                       ...(ctx?.contextWindow ? [[translate("session.context"), `${ctx.percent !== null ? `${ctx.percent.toFixed(1)}%` : "?"} / ${formatCompact(ctx.contextWindow)}`]] : []),
                    ];
                    const section = (
                      title: string,
                      sectionRows: string[][],
                      valueAlign: "left" | "right" = "left",
                      compact = false,
                    ) => (
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: "var(--text-xs)", fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{title}</div>
                          <div style={{
                            display: "grid",
                            gridTemplateColumns: compact ? "max-content max-content" : "auto minmax(0, 1fr)",
                            columnGap: compact ? 14 : 12,
                            rowGap: 4,
                            justifyContent: compact ? "start" : undefined,
                          }}>
                            {sectionRows.map(([label, value]) => (
                              <div key={`${title}:${label}`} style={{ display: "contents" }}>
                                <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{label}</div>
                                <div style={{
                                  color: "var(--text-muted)",
                                  minWidth: 0,
                                  overflowWrap: compact ? "normal" : "anywhere",
                                  textAlign: valueAlign,
                                  whiteSpace: valueAlign === "right" ? "nowrap" : "normal",
                                }}>{value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    const copyButton = (field: SessionCopyField, value: string) => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                           title={copied ? translate("session.copied") : translate(field === "file" ? "session.copyFile" : "session.copyId")}
                          onClick={() => handleCopySessionField(field, value)}
                          style={{
                            alignSelf: "start",
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 22,
                            height: 22,
                            marginTop: -2,
                            color: copied ? "var(--accent)" : "var(--text-dim)",
                            background: "transparent",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            cursor: "pointer",
                            flex: "0 0 auto",
                            transition: "color 0.12s, border-color 0.12s, background 0.12s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.borderColor = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                            e.currentTarget.style.borderColor = "var(--border)";
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          {copied ? (
                            <AliIcon name="check" size={12} />
                          ) : (
                            <AliIcon name="copy" size={12} />
                          )}
                        </button>
                      );
                    };
                    const sessionInfoSection = (
                      <div style={{ minWidth: 0 }}>
                         <div style={{ fontSize: "var(--text-xs)", fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>{translate("session.infoSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 12, rowGap: 8, alignItems: "start" }}>
                          {sessionRows.map((row) => (
                            <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div style={{
                                color: "var(--text-muted)",
                                minWidth: 0,
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                whiteSpace: "normal",
                              }}>{row.value}</div>
                              <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );

                    return (
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: isMobile
                          ? "1fr"
                          : "minmax(360px, 1.7fr) minmax(140px, 0.55fr) minmax(190px, 0.75fr)",
                        gap: isMobile ? 16 : 24,
                        fontSize: "var(--text-sm)",
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}>
                        {sessionInfoSection}
                         {section(translate("session.messages"), messageRows)}
                         {section(translate("session.tokens"), [...tokenRows, ...extraTokenRows], "right", true)}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("session.load")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>

        <div className="workspace-body">
          <div className="workspace-layout">
            {/* Chat content */}
            <div className="workspace-chat">
            <div style={{ height: "100%", display: settingsDialogOpen ? "none" : "block" }} aria-hidden={settingsDialogOpen}>
            {selectedRoom ? (
              <RoomWorkspace
                key={`${sessionKey}:${selectedRoom.id}`}
                initialRoom={selectedRoom}
                onRoomChange={setSelectedRoom}
                onRoomDeleted={handleRoomDeleted}
              />
            ) : showChat ? (
              <ChatWindow
                key={sessionKey}
                session={selectedSession}
                focusEntryId={focusedEntryId}
                newSessionCwd={effectiveNewSessionCwd}
                newSessionInitialModel={newSessionInitialModel}
                initialPrompt={newSessionInitialPrompt}
                claimInitialPrompt={claimNewSessionInitialPrompt}
                onAgentEnd={handleAgentEnd}
                onSessionCreated={handleSessionCreated}
                onSessionForked={handleSessionForked}
                modelsRefreshKey={modelsRefreshKey}
                chatInputRef={chatInputRef}
                onSystemPromptChange={handleSystemPromptChange}
                onSessionStatsChange={handleSessionStatsChange}
                onSessionStatsPanelOpen={openSessionStatsPanel}
                onContextUsageChange={handleContextUsageChange}
                onOpenFile={handleOpenLinkedFile}
                onCompanionActivityChange={setCompanionActivity}
                onTaskControlsChange={handleTaskControlsChange}
                onOpenTaskChanges={handleOpenTaskChanges}
                onRenameTask={handleTaskRename}
                onExportTask={handleTaskExport}
                onSlashCommandsChange={setPiSlashCommands}
                onOpenAutomation={openAutomation}
                onCapabilitiesChange={setSessionCapabilities}
                onOpenCapabilitySettings={openCapabilitySettings}
                onOpenModels={openModelsSettings}
                onPromptSubmitted={() => setOnboardingPromptSubmittedKey((key) => key + 1)}
              />
            ) : initialCwdStatus === "validating" ? (
              <div
                role="status"
                style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
              >
                 <div style={{ fontSize: "var(--text-base)", color: "var(--text)" }}>{translate("workspace.opening")}</div>
                <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
                  {initialNavigation.requestedCwd}
                </div>
              </div>
            ) : initialCwdStatus === "error" ? (
              <div
                role="alert"
                style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
              >
                 <div style={{ fontSize: "var(--text-base)", color: "#dc2626" }}>{translate("workspace.unable")}</div>
                <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
                  {initialNavigation.requestedCwd}
                </div>
                <div style={{ maxWidth: 720, fontSize: "var(--text-sm)" }}>{initialCwdError}</div>
              </div>
            ) : showPlaceholder ? (
              <NewSessionProjectPicker
                activeCwd={activeCwd}
                activeProjectRoot={activeProjectRoot}
                chatInputRef={chatInputRef}
                onLaunch={handleNewSessionLaunch}
                onProjectSelected={setOnboardingProjectCwd}
                projectPickerRequestKey={onboardingProjectPickerRequestKey}
              />
            ) : null}
            </div>
            {settingsPage}
            </div>
            {companionOpen && !desktopChrome && !settingsDialogOpen ? <CompanionPet
              open
              onOpenChange={setCompanionOpen}
              activity={companionActivity}
              canSendPhrase={canSendCompanionPhrase(companionActivity.status, showChat)}
              onSendPhrase={handleSendCompanionPhrase}
              preferences={companionPreferences}
              setPreferences={setCompanionPreferences}
              activePet={activeCompanionPet}
              onRequestSpeech={companionPreferences.interactionModel ? requestCompanionInteraction : undefined}
            /> : null}
          </div>
        </div>
      </div>

      <div
        aria-hidden="true"
        className={`right-panel-overlay-backdrop${effectiveRightPanelOpen && !rightPanelMaximized ? " is-open" : ""}`}
        onClick={() => setRightPanelOpen(false)}
      />
      {effectiveRightPanelOpen && !rightPanelMaximized && (
        <div
          {...rightPanelResizer.separatorProps}
          aria-controls="file-panel"
          className={`panel-resize-handle right-panel-resize-handle${rightPanelResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="right-panel"
          title={`${translate("layout.resizeFilePanel")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Right workspace: Review and Files stay mounted so edits and scroll positions survive tab switches. */}
      <div
        ref={rightPanelResizer.panelRef}
        id="file-panel"
        aria-hidden={!effectiveRightPanelOpen}
        inert={!effectiveRightPanelOpen ? true : undefined}
        className={`right-panel-container${effectiveRightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelMaximized ? " right-panel-maximized" : ""}${rightPanelResizer.isResizing ? " right-panel-resizing" : ""}`}
        style={{
          "--right-panel-width": `${rightPanelResizer.width}px`,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
        } as React.CSSProperties}
      >
        {rightPanelOpen ? <RightPanel
          ref={rightPanelRef}
          activeTab={rightPanelTab}
          onActiveTabChange={setRightPanelTab}
          maximized={rightPanelMaximized}
          onMaximizedChange={setRightPanelMaximized}
          onClosePanel={() => setRightPanelOpen(false)}
          cwd={activeCwd}
          refreshKey={explorerRefreshKey}
          active={effectiveRightPanelOpen}
          fileTabs={fileTabs}
          activeFileTabId={activeFileTabId}
          canReopenClosedFileTab={Boolean(reopenableClosedFileTab)}
          onSelectFileTab={setActiveFileTabId}
          onCloseFileTab={handleCloseFileTab}
          onCloseOtherFileTabs={handleCloseOtherFileTabs}
          onCloseFileTabsToRight={handleCloseFileTabsToRight}
          onMoveFileTab={handleMoveFileTab}
          onReopenClosedFileTab={handleReopenClosedFileTab}
          onOpenFile={handleOpenFile}
          onDirtyChange={handleFileDirtyChange}
          onRefresh={handleExplorerRefresh}
          onMention={handleAtMention}
          onMentions={handleAtMentions}
          onMentionLines={handleFileLineMention}
          selectedAutomationId={selectedAutomationId}
          sessionId={selectedSession?.id ?? null}
          sessionName={selectedSession?.name}
          sessionRunning={Boolean(taskControls?.disabled)}
          onGuideAgent={(prompt) => {
            setRightPanelMaximized(false);
            if (prompt?.trim()) chatInputRef.current?.prependText(prompt);
            window.requestAnimationFrame(() => chatInputRef.current?.focus());
          }}
          onSelectAutomation={openAutomation}
          onAutomationChanged={() => setSessionKey((key) => key + 1)}
          capabilities={sessionCapabilities}
        /> : null}
      </div>
    {/* File panel toggle — always visible at top-right */}
    </div>
    {commandPaletteOpen ? (
      <CommandPalette
        open
        commands={paletteCommands}
        context={commandContext}
        search={searchPaletteCommands}
        onRun={runPaletteCommand}
        onClose={() => setCommandPaletteOpen(false)}
      />
    ) : null}
    {historyDialogOpen && selectedSession ? (
      <SessionHistoryDialog
        sessionId={selectedSession.id}
        sessionName={selectedSession.name}
        appearance={isDarkTheme(theme) ? "dark" : "light"}
        onClose={() => setHistoryDialogOpen(false)}
      />
    ) : null}
    {desktopUpdateState ? (
      <DesktopUpdateDialog
        locale={locale}
        open={desktopUpdateDialogOpen}
        state={desktopUpdateState}
        onClose={() => setDesktopUpdateDialogOpen(false)}
        onDownload={handleOpenDesktopUpdate}
        onInstall={handleInstallDesktopUpdate}
        onRetry={handleRetryDesktopUpdate}
      />
    ) : null}
    <FirstRunOnboarding
      modelCwd={projectCwd ?? activeCwd}
      modelsRefreshKey={modelsRefreshKey}
      projectReady={Boolean(onboardingProjectPath)}
      projectName={onboardingProjectPath ? getFileName(onboardingProjectPath) || onboardingProjectPath : null}
      promptSubmittedKey={onboardingPromptSubmittedKey}
      restartKey={onboardingRestartKey}
      settingsOpen={settingsDialogOpen}
      onOpenModels={() => openSettings("models")}
      onChooseProject={handleOnboardingChooseProject}
      onPrepareFirstPrompt={handlePrepareFirstPrompt}
    />
    <ConfirmationHost />
    </>
  );
}

interface ThemeOptionProps {
  preset: ThemePreset;
  theme: Theme;
  onSelect: (next: Theme, origin?: { x: number; y: number }) => void;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

function ThemeOption({ preset, theme, onSelect, translate }: ThemeOptionProps) {
  const selected = theme === preset.id;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className="theme-menu-option"
      data-theme-id={preset.id}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        onSelect(preset.id, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
      style={{
        minWidth: 0,
        padding: 8,
        display: "flex",
        alignItems: "center",
        gap: 8,
        border: selected ? "1px solid var(--accent)" : "1px solid var(--border)",
        borderRadius: "var(--radius-control)",
        background: selected ? "var(--bg-selected)" : "var(--bg)",
        color: "var(--text)",
        cursor: "pointer",
        textAlign: "left",
        fontSize: "var(--text-xs)",
        transition: "border-color 0.12s, background 0.12s",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "relative",
          width: 28,
          height: 28,
          flex: "0 0 28px",
          overflow: "hidden",
          borderRadius: "var(--radius-small)",
          background: preset.preview.background,
          border: "1px solid color-mix(in srgb, var(--border) 72%, var(--text-dim))",
        }}
      >
        <span style={{ position: "absolute", right: 4, bottom: 4, width: 8, height: 8, borderRadius: "50%", background: preset.preview.accent }} />
      </span>
      <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {translate(`theme.${preset.id}.name`)}
      </span>
      {selected ? (
        <AliIcon name="check" size={13} style={{ color: "var(--accent)" }} />
      ) : null}
    </button>
  );
}
