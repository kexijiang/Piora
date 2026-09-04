"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { useI18n } from "@/hooks/useI18n";
import { useSendShortcut } from "@/hooks/useSendShortcut";
import { useStreamingSendPreference } from "@/hooks/useStreamingSendPreference";
import { useLiveOutputAutoScrollPreference } from "@/hooks/useLiveOutputAutoScrollPreference";
import { AliIcon } from "./AliIcon";
import { DesktopAutoLaunchSetting } from "./DesktopAutoLaunchSetting";
import { SettingsPortabilityCard } from "./SettingsPortabilityCard";
import { NetworkProxySettings } from "./NetworkProxySettings";
import { SystemPromptEditor } from "./SystemPromptEditor";
import { PROMPT_OPTIMIZER_MAX_SYSTEM_PROMPT_LENGTH, PROMPT_OPTIMIZER_SYSTEM_PROMPT } from "@/lib/prompt-optimizer";
import {
  readPromptOptimizerSystemPrompt,
  readPromptOptimizerModel,
  resetPromptOptimizerSystemPrompt,
  writePromptOptimizerModel,
  writePromptOptimizerSystemPrompt,
} from "@/lib/prompt-optimizer-settings";
import { SESSION_TITLE_PROMPT_MAX_LENGTH } from "@/lib/session-title-prompt";
import type { SettingsKey } from "@/lib/settings-search";
import {
  SESSION_TITLE_PROMPT,
  readSessionTitleModel,
  readSessionTitlePrompt,
  resetSessionTitleModel,
  resetSessionTitlePrompt,
  writeSessionTitleModel,
  writeSessionTitlePrompt,
  type SessionTitleModelPreference,
} from "@/lib/session-title-settings";
import styles from "./SettingsDialog.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
  activeKey: SettingsKey;
  onActiveKeyChange: (key: SettingsKey) => void;
  onOpenOnboarding?: () => void;
  modelCwd?: string;
  sections?: Partial<Record<SettingsKey, ReactNode>>;
  conversation: {
    systemPrompt: string | null;
    onSystemPromptSaved: () => void;
    notificationEnabled: boolean;
    notificationCapability: "desktop" | "browser" | "unsupported";
    onNotificationToggle: () => void | Promise<void>;
  };
  desktop: {
    available: boolean;
    globalShortcutEnabled: boolean;
    onGlobalShortcutToggle: () => void | Promise<void>;
  };
}

interface TitleModelOption {
  id: string;
  name: string;
  provider: string;
}

interface AgentDataDirectoryInfo {
  currentDirectory: string;
  defaultDirectory: string;
  configuredBy: "default" | "settings" | "environment";
  environmentOverride: boolean;
  portableRuntimeDirectory?: string;
}

function titleModelValue(model: SessionTitleModelPreference): string {
  return JSON.stringify(model);
}

export type { SettingsKey } from "@/lib/settings-search";

interface SettingsEntry {
  key: SettingsKey;
  labelKey: string;
  descriptionKey: string;
  icon: ReactNode;
}

export function SettingsDialog({
  open,
  onClose,
  activeKey,
  onActiveKeyChange,
  onOpenOnboarding,
  modelCwd,
  sections = {},
  conversation,
  desktop,
}: Props) {
  const { t } = useI18n();
  const { shortcut: sendShortcut, setShortcut: setSendShortcut } = useSendShortcut();
  const {
    preference: streamingSendPreference,
    setEnabled: setStreamingSendDefaultEnabled,
    setBehavior: setStreamingSendDefaultBehavior,
  } = useStreamingSendPreference();
  const {
    enabled: liveOutputAutoScrollEnabled,
    setEnabled: setLiveOutputAutoScrollEnabled,
  } = useLiveOutputAutoScrollPreference();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [optimizerPromptDraft, setOptimizerPromptDraft] = useState(PROMPT_OPTIMIZER_SYSTEM_PROMPT);
  const [optimizerPromptSaved, setOptimizerPromptSaved] = useState(PROMPT_OPTIMIZER_SYSTEM_PROMPT);
  const [optimizerPromptStatus, setOptimizerPromptStatus] = useState<"idle" | "saved" | "error">("idle");
  const [optimizerModels, setOptimizerModels] = useState<Array<{ provider: string; id: string; name: string }>>([]);
  const [optimizerModelValue, setOptimizerModelValue] = useState("");
  const [titlePromptDraft, setTitlePromptDraft] = useState(SESSION_TITLE_PROMPT);
  const [titlePromptSaved, setTitlePromptSaved] = useState(SESSION_TITLE_PROMPT);
  const [titlePromptStatus, setTitlePromptStatus] = useState<"idle" | "saved" | "error">("idle");
  const [titleModel, setTitleModel] = useState<SessionTitleModelPreference | null>(null);
  const [titleModelOptions, setTitleModelOptions] = useState<TitleModelOption[]>([]);
  const [titleModelsLoading, setTitleModelsLoading] = useState(false);
  const [titleModelsError, setTitleModelsError] = useState<string | null>(null);
  const [agentDataInfo, setAgentDataInfo] = useState<AgentDataDirectoryInfo | null>(null);
  const [agentDataDirectoryDraft, setAgentDataDirectoryDraft] = useState("");
  const [migrateAgentData, setMigrateAgentData] = useState(false);
  const [agentDataStatus, setAgentDataStatus] = useState<"idle" | "loading" | "applying" | "restarting" | "error">("idle");
  const [agentDataErrorCode, setAgentDataErrorCode] = useState<string | null>(null);
  const [agentDataErrorDetail, setAgentDataErrorDetail] = useState<string | null>(null);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  useFocusTrap(dialogRef, open, { onEscape: onClose });

  const detailEntries = useMemo<SettingsEntry[]>(() => [
    {
      key: "general",
      labelKey: "settings.general",
      descriptionKey: "settings.generalDescription",
      icon: <AliIcon name="layout" size={16} />,
    },
    {
      key: "conversation",
      labelKey: "settings.conversation",
      descriptionKey: "settings.conversationDescription",
      icon: <AliIcon name="message" size={16} />,
    },
    {
      key: "shortcuts",
      labelKey: "settings.shortcuts",
      descriptionKey: "settings.shortcutsDescription",
      icon: <AliIcon name="setting" size={16} />,
    },
    {
      key: "speech",
      labelKey: "speech.title",
      descriptionKey: "speech.description",
      icon: <AliIcon name="microphone" size={16} />,
    },
    {
      key: "automations",
      labelKey: "automations.title",
      descriptionKey: "automations.description",
      icon: <AliIcon name="calendar" size={16} />,
    },
    {
      key: "models",
      labelKey: "common.models",
      descriptionKey: "settings.modelsDescription",
      icon: <AliIcon name="api" size={16} />,
    },
    {
      key: "appearance",
      labelKey: "appearance.title",
      descriptionKey: "settings.appearanceDescription",
      icon: <AliIcon name="skin" size={16} />,
    },
    {
      key: "language",
      labelKey: "common.language",
      descriptionKey: "settings.languageDescription",
      icon: <AliIcon name="translate" size={16} />,
    },
    {
      key: "companion",
      labelKey: "companion.settingsTitle",
      descriptionKey: "settings.companionDescription",
      icon: <AliIcon name="robot" size={16} />,
    },
    {
      key: "capabilityBundles",
      labelKey: "capabilityBundles.title",
      descriptionKey: "capabilityBundles.description",
      icon: <AliIcon name="export" size={16} />,
    },
    {
      key: "tools",
      labelKey: "projectTools.title",
      descriptionKey: "projectTools.description",
      icon: <AliIcon name="build" size={16} />,
    },
    {
      key: "extensions",
      labelKey: "settings.extensions",
      descriptionKey: "settings.manageExtensionsDescription",
      icon: <AliIcon name="setting" size={16} />,
    },
    {
      key: "skills",
      labelKey: "common.skills",
      descriptionKey: "settings.skillsDescription",
      icon: <AliIcon name="solution" size={16} />,
    },
    {
      key: "plugins",
      labelKey: "common.plugins",
      descriptionKey: "settings.pluginsDescription",
      icon: <AliIcon name="package" size={16} />,
    },
    {
      key: "remote",
      labelKey: "remote.title",
      descriptionKey: "remote.description",
      icon: <AliIcon name="external-link" size={16} />,
    },
    {
      key: "harmony",
      labelKey: "harmonyStorage.title",
      descriptionKey: "harmonyStorage.description",
      icon: <AliIcon name="mobile" size={16} />,
    },
    {
      key: "usage",
      labelKey: "usage.title",
      descriptionKey: "usage.description",
      icon: <AliIcon name="chart-no-axes-column" size={16} />,
    },
    {
      key: "archived",
      labelKey: "archive.title",
      descriptionKey: "archive.description",
      icon: <AliIcon name="archive" size={16} />,
    },
  ], []);

  const entryGroups = useMemo(() => [
    { labelKey: "settings.group.personal", keys: ["general", "conversation", "shortcuts", "speech", "automations", "models", "appearance", "language", "companion"] as SettingsKey[] },
    { labelKey: "settings.group.capabilities", keys: ["tools", "capabilityBundles", "extensions", "skills", "plugins", "harmony", "remote"] as SettingsKey[] },
    { labelKey: "settings.group.history", keys: ["usage", "archived"] as SettingsKey[] },
  ], []);

  const availableEntries = useMemo(() => detailEntries.filter((entry) => (
    entry.key === "general" || entry.key === "conversation" || sections[entry.key] !== undefined
  )), [detailEntries, sections]);

  useEffect(() => {
    if (!open) setSearchQuery("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const saved = readPromptOptimizerSystemPrompt(window.localStorage);
    setOptimizerPromptDraft(saved);
    setOptimizerPromptSaved(saved);
    setOptimizerPromptStatus("idle");
    const selectedModel = readPromptOptimizerModel(window.localStorage);
    setOptimizerModelValue(selectedModel ? JSON.stringify(selectedModel) : "");
    void fetch("/api/models", { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { modelList?: Array<{ provider: string; id: string; name: string }> } | null) => setOptimizerModels(data?.modelList ?? []))
      .catch(() => setOptimizerModels([]));
    const savedTitlePrompt = readSessionTitlePrompt(window.localStorage);
    setTitlePromptDraft(savedTitlePrompt);
    setTitlePromptSaved(savedTitlePrompt);
    setTitlePromptStatus("idle");
    setTitleModel(readSessionTitleModel(window.localStorage));
  }, [open]);

  useEffect(() => {
    if (!open || activeKey !== "conversation") return;
    const controller = new AbortController();
    setTitleModelsLoading(true);
    setTitleModelsError(null);
    setTitleModelOptions([]);
    const query = modelCwd ? `?cwd=${encodeURIComponent(modelCwd)}` : "";
    void fetch(`/api/models${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { modelList?: TitleModelOption[]; error?: string };
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        setTitleModelOptions(body.modelList ?? []);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setTitleModelsError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setTitleModelsLoading(false);
      });
    return () => controller.abort();
  }, [activeKey, modelCwd, open]);

  useEffect(() => {
    if (!open || activeKey !== "general" || !desktop.available) return;
    const bridge = window.piDesktop?.getAgentDataDirectory;
    if (!bridge) return;
    let cancelled = false;
    setAgentDataStatus("loading");
    void bridge()
      .then((info) => {
        if (cancelled) return;
        setAgentDataInfo(info);
        setAgentDataDirectoryDraft(info?.currentDirectory ?? "");
        setMigrateAgentData(false);
        setAgentDataStatus("idle");
        setAgentDataErrorCode(null);
        setAgentDataErrorDetail(null);
      })
      .catch(() => {
        if (!cancelled) setAgentDataStatus("error");
      });
    return () => { cancelled = true; };
  }, [activeKey, desktop.available, open]);

  const chooseAgentDataDirectory = async () => {
    const selected = await window.piDesktop?.selectAgentDataDirectory?.(agentDataDirectoryDraft || agentDataInfo?.currentDirectory);
    if (selected) {
      setAgentDataDirectoryDraft(selected);
      setAgentDataErrorCode(null);
      setAgentDataErrorDetail(null);
    }
  };

  const applyAgentDataDirectory = async () => {
    const bridge = window.piDesktop?.applyAgentDataDirectory;
    if (!bridge || !agentDataDirectoryDraft.trim()) return;
    setAgentDataStatus("applying");
    setAgentDataErrorCode(null);
    setAgentDataErrorDetail(null);
    try {
      const result = await bridge({ directory: agentDataDirectoryDraft.trim(), migrate: true });
      if (!result.ok) {
        setAgentDataStatus("error");
        setAgentDataErrorCode(result.code ?? "migration-failed");
        setAgentDataErrorDetail(result.error?.trim() || null);
        return;
      }
      const currentDirectory = result.currentDirectory ?? agentDataDirectoryDraft.trim();
      setAgentDataInfo((current) => current ? {
        ...current,
        currentDirectory,
        configuredBy: currentDirectory === current.defaultDirectory ? "default" : "settings",
      } : current);
      setAgentDataDirectoryDraft(currentDirectory);
      setMigrateAgentData(false);
      setAgentDataStatus("restarting");
    } catch (error) {
      setAgentDataStatus("error");
      setAgentDataErrorCode("migration-failed");
      setAgentDataErrorDetail(error instanceof Error ? error.message : String(error));
    }
  };

  const saveOptimizerPrompt = () => {
    try {
      const saved = writePromptOptimizerSystemPrompt(optimizerPromptDraft, window.localStorage);
      setOptimizerPromptDraft(saved);
      setOptimizerPromptSaved(saved);
      setOptimizerPromptStatus("saved");
    } catch {
      setOptimizerPromptStatus("error");
    }
  };

  const restoreOptimizerPrompt = () => {
    try {
      const restored = resetPromptOptimizerSystemPrompt(window.localStorage);
      setOptimizerPromptDraft(restored);
      setOptimizerPromptSaved(restored);
      setOptimizerPromptStatus("saved");
    } catch {
      setOptimizerPromptStatus("error");
    }
  };

  const saveOptimizerModel = (value: string) => {
    setOptimizerModelValue(value);
    try {
      writePromptOptimizerModel(value ? JSON.parse(value) : null, window.localStorage);
      setOptimizerPromptStatus("saved");
    } catch {
      setOptimizerPromptStatus("error");
    }
  };

  const saveTitlePrompt = () => {
    try {
      const saved = writeSessionTitlePrompt(titlePromptDraft, window.localStorage);
      setTitlePromptDraft(saved);
      setTitlePromptSaved(saved);
      setTitlePromptStatus("saved");
    } catch {
      setTitlePromptStatus("error");
    }
  };

  const restoreTitlePrompt = () => {
    try {
      const restored = resetSessionTitlePrompt(window.localStorage);
      setTitlePromptDraft(restored);
      setTitlePromptSaved(restored);
      setTitlePromptStatus("saved");
    } catch {
      setTitlePromptStatus("error");
    }
  };

  const selectTitleModel = (value: string) => {
    try {
      if (!value) {
        setTitleModel(resetSessionTitleModel(window.localStorage));
        return;
      }
      const selected = titleModelOptions.find((model) => titleModelValue({ provider: model.provider, modelId: model.id }) === value);
      if (!selected) return;
      setTitleModel(writeSessionTitleModel({ provider: selected.provider, modelId: selected.id }, window.localStorage));
    } catch {
      setTitleModelsError(t("settings.sessionTitleModelSaveFailed"));
    }
  };

  const normalizedSearch = deferredSearchQuery.trim().toLocaleLowerCase();
  const filteredEntries = useMemo(() => {
    if (!normalizedSearch) return availableEntries;
    return availableEntries.filter((entry) => [
      t(entry.labelKey),
      t(entry.descriptionKey),
      ...entryGroups.filter((group) => group.keys.includes(entry.key)).map((group) => t(group.labelKey)),
    ].join(" ").toLocaleLowerCase().includes(normalizedSearch));
  }, [availableEntries, entryGroups, normalizedSearch, t]);

  if (!open || typeof document === "undefined") return null;

  const activeEntry = availableEntries.find((entry) => entry.key === activeKey) ?? availableEntries[0] ?? detailEntries[0]!;
  const searching = searchQuery.trim().length > 0;
  const sectionContent = searching ? undefined : sections[activeEntry.key];
  const selectEntry = (entry: SettingsEntry) => {
    setSearchQuery("");
    onActiveKeyChange(entry.key);
  };

  return createPortal(
    <div
      className={`${styles.backdrop} settings-backdrop${desktop.available ? ` ${styles.desktopBackdrop}` : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={t("sidebar.settings")}
    >
      <div ref={dialogRef} className={`${styles.dialog} settings-dialog`}>
        <div className={styles.workspace}>
          <nav className={`${styles.navigation} settings-navigation`} aria-label={t("settings.navigation")}>
            <button
              className={styles.backButton}
              type="button"
              onClick={onClose}
              title={t("settings.back")}
              aria-label={t("settings.back")}
            >
              <AliIcon name="arrowleft" size={16} />
              <span className={styles.backLabel}>{t("settings.back")}</span>
            </button>
            <label className={styles.navSearch}>
              <AliIcon name="search" size={14} />
              <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={t("settings.searchPlaceholder")} aria-label={t("settings.searchPlaceholder")} />
            </label>
            {entryGroups.map((group) => {
              const entries = filteredEntries.filter((entry) => group.keys.includes(entry.key));
              if (entries.length === 0) return null;
              return <div className={styles.navGroup} key={group.labelKey}>
                <div className={styles.navGroupLabel}>{t(group.labelKey)}</div>
                {entries.map((entry) => (
                  <button
                    className={styles.navItem}
                    type="button"
                    key={entry.key}
                    aria-current={activeEntry.key === entry.key ? "page" : undefined}
                    onClick={() => selectEntry(entry)}
                  >
                    <span className={styles.navIcon}>{entry.icon}</span>
                    <span>{t(entry.labelKey)}</span>
                  </button>
                ))}
              </div>;
            })}
            {filteredEntries.length === 0 ? <div className={styles.navEmpty} role="status">{t("settings.searchEmpty")}</div> : null}
          </nav>

          <main className={`${styles.content} settings-content`}>
            <div className={`${styles.contentToolbar} settings-content-toolbar`} aria-hidden="true" />
            <div className={styles.contentBody}>
            <div className={`${styles.contentCanvas} settings-embedded-section`}>
            {searching ? (
              <>
                <div className={styles.contentHeading}>
                  <h2>{t("settings.searchTitle")}</h2>
                  <p>{t("settings.searchDescription", { query: searchQuery.trim() })}</p>
                </div>
                {filteredEntries.length > 0 ? <section className={styles.searchResults} aria-label={t("settings.searchResults")}>
                  {filteredEntries.map((entry) => (
                    <button className={styles.settingRow} type="button" key={entry.key} onClick={() => selectEntry(entry)}>
                      <span className={styles.rowIcon}>{entry.icon}</span>
                      <span className={styles.rowCopy}>
                        <span className={styles.rowTitle}>{t(entry.labelKey)}</span>
                        <span className={styles.rowDescription}>{t(entry.descriptionKey)}</span>
                      </span>
                      <AliIcon name="chevron-right" size={15} />
                    </button>
                  ))}
                </section> : <div className={styles.searchEmpty} role="status">{t("settings.searchEmpty")}</div>}
              </>
            ) : <>
              {activeEntry.key === "general" ? (
              <>
                <div className={styles.contentHeading}>
                  <h2>{t("settings.general")}</h2>
                  <p>{t("settings.generalDescription")}</p>
                </div>
                <SettingsPortabilityCard />
                <NetworkProxySettings />
                {onOpenOnboarding ? <section className={styles.conversationSection}>
                  <div className={styles.conversationRow}>
                    <span className={styles.featureIcon}><AliIcon name="rocket" size={19} /></span>
                    <div className={styles.conversationCopy}>
                      <div className={styles.rowTitle}>{t("settings.firstRunGuideTitle")}</div>
                      <div className={styles.rowDescription}>{t("settings.firstRunGuideDescription")}</div>
                    </div>
                    <button className={styles.primaryButton} type="button" onClick={onOpenOnboarding}>
                      <AliIcon name="play" size={13} />
                      {t("settings.firstRunGuideAction")}
                    </button>
                  </div>
                </section> : null}
                {desktop.available && window.piDesktop?.getAgentDataDirectory ? <section className={styles.conversationSection}>
                  <div className={styles.agentDataHeader}>
                    <div className={styles.conversationCopy}>
                      <div className={styles.rowTitle}>{t("settings.agentDataDirectory")}</div>
                      <div className={styles.rowDescription}>{t("settings.agentDataDirectoryDescription")}</div>
                    </div>
                    {agentDataInfo?.configuredBy === "environment" ? <span className={styles.directoryBadge}>{t("settings.agentDataDirectoryEnvironment")}</span> : null}
                  </div>
                  <div className={styles.agentDataBody}>
                    <label className={styles.agentDataField}>
                      <span>{t("settings.agentDataDirectoryTargetPath")}</span>
                      <span className={styles.agentDataInputRow}>
                        <input
                          value={agentDataDirectoryDraft}
                          onChange={(event) => {
                            setAgentDataDirectoryDraft(event.target.value);
                            setAgentDataErrorCode(null);
                            setAgentDataErrorDetail(null);
                          }}
                          disabled={!migrateAgentData || agentDataStatus === "loading" || agentDataStatus === "applying" || agentDataInfo?.environmentOverride}
                          spellCheck={false}
                          aria-label={t("settings.agentDataDirectoryTargetPath")}
                        />
                        <button className={styles.secondaryButton} type="button" disabled={!migrateAgentData || agentDataStatus === "applying" || agentDataInfo?.environmentOverride} onClick={() => { void chooseAgentDataDirectory(); }}>{t("settings.agentDataDirectoryChoose")}</button>
                      </span>
                    </label>
                    {agentDataInfo ? <div className={styles.agentDataMeta}>{t("settings.agentDataDirectoryCurrent", { path: agentDataInfo.currentDirectory })}</div> : null}
                    {agentDataInfo ? <div className={styles.agentDataMeta}>{t("settings.agentDataDirectoryDefault", { path: agentDataInfo.defaultDirectory })}</div> : null}
                    <div className={styles.agentDataMigration}>
                      <button
                        className={styles.switch}
                        type="button"
                        role="switch"
                        aria-checked={migrateAgentData}
                        aria-label={t("settings.agentDataMigrate")}
                        disabled={agentDataStatus === "applying" || agentDataInfo?.environmentOverride}
                        onClick={() => {
                          setMigrateAgentData((current) => {
                            const next = !current;
                            if (!next) setAgentDataDirectoryDraft(agentDataInfo?.currentDirectory ?? "");
                            return next;
                          });
                          setAgentDataErrorCode(null);
                          setAgentDataErrorDetail(null);
                        }}
                      ><span /></button>
                      <span><strong>{t("settings.agentDataMigrate")}</strong><small>{t("settings.agentDataMigrateDescription")}</small></span>
                    </div>
                    <div className={styles.agentDataActions}>
                      <button className={styles.secondaryButton} type="button" disabled={!migrateAgentData || !agentDataInfo || agentDataStatus === "applying" || agentDataInfo.environmentOverride} onClick={() => setAgentDataDirectoryDraft(agentDataInfo?.defaultDirectory ?? "")}>{t("settings.agentDataDirectoryRestoreDefault")}</button>
                      <button className={styles.primaryButton} type="button" disabled={!migrateAgentData || !agentDataInfo || !agentDataDirectoryDraft.trim() || agentDataDirectoryDraft.trim() === agentDataInfo.currentDirectory || agentDataStatus === "applying" || agentDataStatus === "restarting" || agentDataInfo.environmentOverride} onClick={() => { void applyAgentDataDirectory(); }}>
                        {agentDataStatus === "applying" ? t("settings.agentDataDirectoryApplying") : agentDataStatus === "restarting" ? t("settings.agentDataDirectoryRestarting") : t("settings.agentDataDirectoryApply")}
                      </button>
                    </div>
                    {agentDataErrorCode ? <div className={styles.agentDataError} role="alert">
                      <span>{t(`settings.agentDataDirectoryError.${agentDataErrorCode}`)}</span>
                      {agentDataErrorDetail ? <code>{agentDataErrorDetail}</code> : null}
                    </div> : null}
                    {agentDataInfo?.environmentOverride ? <div className={styles.agentDataNotice}>{t("settings.agentDataDirectoryEnvironmentDescription")}</div> : null}
                    {agentDataInfo?.portableRuntimeDirectory ? <div className={styles.portableCacheNote}>
                      <AliIcon name="info" size={14} />
                      <span>{t("settings.portableRuntimeCache", { path: agentDataInfo.portableRuntimeDirectory })}</span>
                    </div> : null}
                  </div>
                </section> : null}
                {desktop.available ? <section className={styles.conversationSection}>
                  <DesktopAutoLaunchSetting />
                  <div className={styles.conversationRow}>
                    <div className={styles.conversationCopy}>
                      <div className={styles.rowTitle}>{t("settings.globalShortcut")}</div>
                      <div className={styles.rowDescription}>{t("settings.globalShortcutDescription")}</div>
                    </div>
                    <button className={styles.switch} type="button" role="switch" aria-checked={desktop.globalShortcutEnabled} onClick={() => void desktop.onGlobalShortcutToggle()}><span /></button>
                  </div>
                </section> : null}
                <div className={styles.localNote}>
                  <AliIcon name="lock" size={14} />
                  <span>{t("settings.localNote")}</span>
                </div>
              </>
              ) : activeEntry.key === "conversation" ? (
              <>
                <div className={styles.contentHeading}>
                  <h2>{t("settings.conversation")}</h2>
                  <p>{t("settings.conversationDescription")}</p>
                </div>

                <section className={styles.conversationSection}>
                  <div className={styles.conversationRow}>
                    <div className={styles.conversationCopy}>
                      <div className={styles.rowTitle}>{t("settings.liveOutputAutoScroll")}</div>
                      <div className={styles.rowDescription}>{t("settings.liveOutputAutoScrollDescription")}</div>
                    </div>
                    <button
                      className={styles.switch}
                      type="button"
                      role="switch"
                      aria-checked={liveOutputAutoScrollEnabled}
                      aria-label={t("settings.liveOutputAutoScroll")}
                      onClick={() => setLiveOutputAutoScrollEnabled(!liveOutputAutoScrollEnabled)}
                    >
                      <span />
                    </button>
                  </div>

                  <div className={`${styles.conversationRow} ${styles.sendShortcutRow}`}>
                    <div className={styles.conversationCopy}>
                      <div className={styles.rowTitle}>{t("settings.sendShortcut")}</div>
                      <div className={styles.rowDescription}>{t("settings.sendShortcutDescription")}</div>
                    </div>
                    <div className={styles.shortcutOptionGroup} role="radiogroup" aria-label={t("settings.sendShortcut")}>
                      <button
                        className={styles.shortcutOption}
                        type="button"
                        role="radio"
                        aria-checked={sendShortcut === "enter"}
                        onClick={() => setSendShortcut("enter")}
                      >
                        <kbd>{t("settings.sendShortcutEnter")}</kbd>
                      </button>
                      <button
                        className={styles.shortcutOption}
                        type="button"
                        role="radio"
                        aria-checked={sendShortcut === "ctrl-enter"}
                        onClick={() => setSendShortcut("ctrl-enter")}
                      >
                        <kbd>{t("settings.sendShortcutCtrlEnter")}</kbd>
                      </button>
                    </div>
                  </div>

                  <div className={styles.conversationRowStacked}>
                    <div className={styles.preferenceHeader}>
                      <div className={styles.conversationCopy}>
                        <div className={styles.rowTitle}>{t("settings.streamingSendDefault")}</div>
                        <div className={styles.rowDescription}>{t("settings.streamingSendDefaultDescription")}</div>
                      </div>
                      <button
                        className={styles.switch}
                        type="button"
                        role="switch"
                        aria-checked={streamingSendPreference.enabled}
                        aria-label={t("settings.streamingSendDefault")}
                        onClick={() => setStreamingSendDefaultEnabled(!streamingSendPreference.enabled)}
                      >
                        <span />
                      </button>
                    </div>
                    {streamingSendPreference.enabled ? (
                      <div className={styles.shortcutOptionGroup} role="radiogroup" aria-label={t("settings.streamingSendDefaultBehavior")}>
                        <button
                          className={styles.shortcutOption}
                          type="button"
                          role="radio"
                          aria-checked={streamingSendPreference.behavior === "steer"}
                          onClick={() => setStreamingSendDefaultBehavior("steer")}
                        >
                          {t("chat.steer")}
                        </button>
                        <button
                          className={styles.shortcutOption}
                          type="button"
                          role="radio"
                          aria-checked={streamingSendPreference.behavior === "followup"}
                          onClick={() => setStreamingSendDefaultBehavior("followup")}
                        >
                          {t("chat.followUp")}
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <div className={styles.conversationRow}>
                    <div className={styles.conversationCopy}>
                      <div className={styles.rowTitle}>{t("taskControls.notifications")}</div>
                      <div className={styles.rowDescription}>
                        {conversation.notificationCapability === "unsupported"
                          ? t("taskControls.notificationsUnsupported")
                          : t("taskControls.notificationsDescription")}
                      </div>
                    </div>
                    <button
                      className={styles.switch}
                      type="button"
                      role="switch"
                      aria-checked={conversation.notificationEnabled}
                      disabled={conversation.notificationCapability === "unsupported"}
                      onClick={() => void conversation.onNotificationToggle()}
                    >
                      <span />
                    </button>
                  </div>

                </section>

                <section className={styles.promptCard} aria-labelledby="session-title-prompt-heading">
                  <header className={styles.promptCardHeader}>
                    <h3 id="session-title-prompt-heading">{t("settings.sessionTitlePromptTitle")}</h3>
                    <p>{t("settings.sessionTitlePromptDescription")}</p>
                  </header>
                  <div className={styles.promptCardBody}>
                    <label className={styles.modelSelectField}>
                      <span>{t("settings.sessionTitleModelTitle")}</span>
                      <select
                        value={titleModel ? titleModelValue(titleModel) : ""}
                        disabled={titleModelsLoading}
                        onChange={(event) => selectTitleModel(event.target.value)}
                      >
                        <option value="">{t("settings.sessionTitleModelCurrent")}</option>
                        {titleModel && !titleModelOptions.some((model) => model.provider === titleModel.provider && model.id === titleModel.modelId) ? (
                          <option value={titleModelValue(titleModel)} disabled>
                            {t("settings.sessionTitleModelUnavailable", { model: `${titleModel.provider}/${titleModel.modelId}` })}
                          </option>
                        ) : null}
                        {titleModelOptions.map((model) => (
                          <option key={`${model.provider}:${model.id}`} value={titleModelValue({ provider: model.provider, modelId: model.id })}>
                            {model.name || model.id} · {model.provider}
                          </option>
                        ))}
                      </select>
                      <small role="status">
                        {titleModelsLoading
                          ? t("settings.sessionTitleModelsLoading")
                          : titleModelsError
                            ? t("settings.sessionTitleModelsLoadFailed", { error: titleModelsError })
                            : t("settings.sessionTitleModelDescription")}
                      </small>
                    </label>
                    <label className={styles.promptTextField}>
                      <span>{t("settings.sessionTitleInstructionLabel")}</span>
                      <small>{t("settings.sessionTitleInstructionDescription")}</small>
                      <textarea
                        className={styles.promptEditor}
                        value={titlePromptDraft}
                        maxLength={SESSION_TITLE_PROMPT_MAX_LENGTH}
                        aria-label={t("settings.sessionTitleInstructionLabel")}
                        onChange={(event) => {
                          setTitlePromptDraft(event.target.value);
                          setTitlePromptStatus("idle");
                        }}
                      />
                    </label>
                    <div className={styles.promptEditorFooter}>
                      <span role="status">
                        {titlePromptStatus === "saved"
                          ? t("settings.sessionTitlePromptSaved")
                          : titlePromptStatus === "error"
                            ? t("settings.sessionTitlePromptSaveFailed")
                            : `${Array.from(titlePromptDraft).length.toLocaleString()} / ${SESSION_TITLE_PROMPT_MAX_LENGTH.toLocaleString()}`}
                      </span>
                      <div>
                        <button className={styles.secondaryButton} type="button" onClick={restoreTitlePrompt}>{t("settings.sessionTitlePromptRestore")}</button>
                        <button
                          className={styles.primaryButton}
                          type="button"
                          disabled={!titlePromptDraft.trim() || titlePromptDraft.trim() === titlePromptSaved}
                          onClick={saveTitlePrompt}
                        >
                          {t("settings.sessionTitlePromptSave")}
                        </button>
                      </div>
                    </div>
                  </div>
                </section>

                <section className={styles.promptCard} aria-labelledby="prompt-optimizer-heading">
                  <header className={styles.promptCardHeader}>
                    <h3 id="prompt-optimizer-heading">{t("settings.promptOptimizerTitle")}</h3>
                    <p>{t("settings.promptOptimizerDescription")}</p>
                  </header>
                  <div className={styles.promptCardBody}>
                    <label className={styles.optimizerModelField}>
                      <span>{t("settings.promptOptimizerModel")}</span>
                      <select value={optimizerModelValue} onChange={(event) => saveOptimizerModel(event.target.value)}>
                        <option value="">{t("settings.promptOptimizerModelDefault")}</option>
                        {optimizerModels.map((candidate) => {
                          const value = JSON.stringify({ provider: candidate.provider, modelId: candidate.id });
                          return <option key={`${candidate.provider}/${candidate.id}`} value={value}>{candidate.name} · {candidate.provider}</option>;
                        })}
                      </select>
                      <small>{t("settings.promptOptimizerModelDescription")}</small>
                    </label>
                    <label className={styles.promptTextField}>
                      <span>{t("settings.promptOptimizerInstructionLabel")}</span>
                      <small>{t("settings.promptOptimizerInstructionDescription")}</small>
                      <textarea
                        className={styles.promptEditor}
                        value={optimizerPromptDraft}
                        maxLength={PROMPT_OPTIMIZER_MAX_SYSTEM_PROMPT_LENGTH}
                        aria-label={t("settings.promptOptimizerInstructionLabel")}
                        onChange={(event) => {
                          setOptimizerPromptDraft(event.target.value);
                          setOptimizerPromptStatus("idle");
                        }}
                      />
                    </label>
                    <div className={styles.promptEditorFooter}>
                      <span role="status">
                        {optimizerPromptStatus === "saved"
                          ? t("settings.promptOptimizerSaved")
                          : optimizerPromptStatus === "error"
                            ? t("settings.promptOptimizerSaveFailed")
                            : `${Array.from(optimizerPromptDraft).length.toLocaleString()} / ${PROMPT_OPTIMIZER_MAX_SYSTEM_PROMPT_LENGTH.toLocaleString()}`}
                      </span>
                      <div>
                        <button className={styles.secondaryButton} type="button" onClick={restoreOptimizerPrompt}>{t("settings.promptOptimizerRestore")}</button>
                        <button
                          className={styles.primaryButton}
                          type="button"
                          disabled={!optimizerPromptDraft.trim() || optimizerPromptDraft.trim() === optimizerPromptSaved}
                          onClick={saveOptimizerPrompt}
                        >
                          {t("settings.promptOptimizerSave")}
                        </button>
                      </div>
                    </div>
                  </div>
                </section>

                <section className={styles.promptCard} aria-labelledby="system-prompt-heading">
                  <header className={styles.promptCardHeader}>
                    <h3 id="system-prompt-heading">{t("system.prompt")}</h3>
                    <p>{t("system.description")}</p>
                  </header>
                  <div className={styles.promptCardBody}>
                    <SystemPromptEditor
                      effectivePrompt={conversation.systemPrompt}
                      onSaved={conversation.onSystemPromptSaved}
                    />
                  </div>
                </section>
              </>
              ) : sectionContent ? (
              sectionContent
              ) : (
              <>
                <div className={styles.contentHeading}>
                  <h2>{t(activeEntry.labelKey)}</h2>
                  <p>{t(activeEntry.descriptionKey)}</p>
                </div>
                <section className={styles.featureCard}>
                  <div className={styles.featureIcon}>{activeEntry.icon}</div>
                  <div className={styles.featureCopy}>
                    <div className={styles.featureTitle}>{t(activeEntry.labelKey)}</div>
                    <div className={styles.featureDescription}>{t(activeEntry.descriptionKey)}</div>
                  </div>
                </section>
                <div className={styles.detailHint}>{t(`settings.hint.${activeEntry.key}`)}</div>
              </>
              )}
            </>}
            </div>
            </div>
          </main>
        </div>
      </div>
    </div>,
    document.body,
  );
}
