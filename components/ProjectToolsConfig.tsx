"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "@/hooks/useI18n";
import type {
  SessionCapabilitiesState,
  SessionCapabilityItem,
  SessionCapabilityKind,
  SessionCapabilitySelection,
} from "@/lib/session-capabilities";
import { AliIcon, type AliIconName } from "./AliIcon";
import styles from "./ProjectToolsConfig.module.css";
import type { ToolRuntimeInfo } from "@/lib/tool-runtime";
import { readToolInstallProgress, type ToolInstallPhase } from "@/lib/tool-install-progress";

interface ProjectToolsResponse {
  projectRoot: string;
  managed: boolean;
  capabilities: SessionCapabilitiesState;
  definitionTokens: number;
  definitionTokenLimit: number;
  diagnostics: Array<{ path: string; error: string }>;
  runtime: ToolRuntimeInfo[];
  appliedSessions?: number;
  deferredSessions?: number;
  failedSessions?: number;
  error?: string;
}

interface Props {
  cwd: string;
  onChanged?: (capabilities: SessionCapabilitiesState) => void;
}

const GROUPS: SessionCapabilityKind[] = [
  "workspace",
  "browser",
  "automation",
  "collaboration",
  "device",
  "extension",
  "interaction",
];

const TOOL_LABEL_KEYS: Record<string, string> = {
  bash: "sessionTools.tool.bash",
  read: "sessionTools.tool.read",
  edit: "sessionTools.tool.edit",
  write: "sessionTools.tool.write",
  grep: "sessionTools.tool.grep",
  find: "sessionTools.tool.find",
  ls: "sessionTools.tool.ls",
  browser: "sessionTools.tool.browser",
  piora_automation: "sessionTools.tool.automation",
  piora_room: "sessionTools.tool.room",
};

function iconFor(item: SessionCapabilityItem): AliIconName {
  switch (item.kind) {
    case "workspace": return "code";
    case "browser": return "earth";
    case "device": return "mobile";
    case "automation": return "calendar";
    case "collaboration": return "branches";
    default: return "build";
  }
}

export function ProjectToolsConfig({ cwd, onChanged }: Props) {
  const { t } = useI18n();
  const [data, setData] = useState<ProjectToolsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<{ tool: string; phase: ToolInstallPhase | "done" | "failed"; error?: string } | null>(null);
  const installRequest = useRef<AbortController | null>(null);

  useEffect(() => () => {
    installRequest.current?.abort();
    installRequest.current = null;
  }, [cwd]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/project-tools?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" });
      const next = await response.json() as ProjectToolsResponse;
      if (!response.ok || next.error) throw new Error(next.error ?? `HTTP ${response.status}`);
      setData(next);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (selection: SessionCapabilitySelection) => {
    if (!data || saving) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/project-tools", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          preset: selection.preset,
          ...(selection.enabledCapabilityIds ? { enabledCapabilityIds: selection.enabledCapabilityIds } : {}),
          expectedRevision: data.capabilities.policy.revision,
        }),
      });
      const next = await response.json() as ProjectToolsResponse;
      if (!response.ok || next.error) throw new Error(next.error ?? `HTTP ${response.status}`);
      setData(next);
      onChanged?.(next.capabilities);
      window.dispatchEvent(new CustomEvent("piora:project-tools-changed", {
        detail: { projectRoot: next.projectRoot, capabilities: next.capabilities },
      }));
      const deferred = next.deferredSessions ?? 0;
      setMessage(deferred > 0
        ? t("projectTools.savedDeferred", { count: deferred })
        : t("projectTools.saved"));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }, [cwd, data, onChanged, saving, t]);

  const install = useCallback(async (tool: "fd" | "rg") => {
    if (installRequest.current) return;
    const controller = new AbortController();
    installRequest.current = controller;
    setInstalling(tool);
    setInstallProgress({ tool, phase: "checking" });
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/project-tools", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({ cwd, tool }),
        signal: controller.signal,
      });
      await readToolInstallProgress(response, (event) => {
        if (controller.signal.aborted) return;
        if (event.type === "progress") setInstallProgress({ tool, phase: event.phase });
        if (event.type === "done") {
          setData((current) => current ? { ...current, runtime: event.runtime } : current);
          setInstallProgress({ tool, phase: "done" });
          setMessage(t("projectTools.runtimeInstalled"));
        }
      });
    } catch (installError) {
      if (!controller.signal.aborted) setInstallProgress({ tool, phase: "failed", error: installError instanceof Error ? installError.message : String(installError) });
    } finally {
      if (installRequest.current === controller) {
        installRequest.current = null;
        setInstalling(null);
      }
    }
  }, [cwd, t]);

  const groups = useMemo(() => GROUPS.map((kind) => ({
    kind,
    items: data?.capabilities.items.filter((item) => item.kind === kind) ?? [],
  })).filter((group) => group.items.length > 0), [data?.capabilities.items]);

  const toggle = (item: SessionCapabilityItem) => {
    if (!data || saving || !item.available) return;
    const enabled = new Set(data.capabilities.policy.enabledCapabilityIds);
    if (enabled.has(item.id)) enabled.delete(item.id);
    else enabled.add(item.id);
    void save({ preset: "custom", enabledCapabilityIds: [...enabled] });
  };

  const setHarmonyToolsEnabled = (enabled: boolean) => {
    if (!data || loading || saving) return;
    const selected = new Set(data.capabilities.policy.enabledCapabilityIds);
    for (const item of data.capabilities.items) {
      if (item.kind !== "device") continue;
      if (enabled && item.available) selected.add(item.id);
      else if (!enabled) selected.delete(item.id);
    }
    void save({ preset: "custom", enabledCapabilityIds: [...selected] });
  };

  return <div className={styles.surface}>
    <div className={styles.header}>
      <div>
        <h2>{t("projectTools.title")}</h2>
        <p>{t("projectTools.description")}</p>
      </div>
      <button type="button" onClick={() => void load()} disabled={loading || saving}>
        <AliIcon name="reload" size={14} />{t("i18n.refresh")}
      </button>
    </div>

    {data ? <div className={styles.scopeCard}>
      <AliIcon name="folder" size={15} />
      <strong>{t("projectTools.scope")}</strong>
      <code title={data.projectRoot}>{data.projectRoot}</code>
    </div> : null}

    {data ? <section className={styles.runtime} aria-labelledby="project-tools-runtime">
      <div className={styles.sectionHeader}>
        <div>
          <strong id="project-tools-runtime">{t("projectTools.runtimeTitle")}</strong>
          <small className={styles.runtimeDescription}>{t("projectTools.runtimeDescription")}</small>
        </div>
        {data.runtime.some((tool) => tool.offline) ? <span className={styles.runtimeOffline}>{t("projectTools.runtimeOffline")}</span> : null}
      </div>
      <div className={styles.runtimeList}>
        {data.runtime.map((tool) => {
          const available = tool.status === "available";
          const progress = installProgress?.tool === tool.id ? installProgress : null;
          const busy = progress && progress.phase !== "done" && progress.phase !== "failed";
          return <div className={styles.runtimeItem} key={tool.id}>
          <div className={styles.runtimeRow} data-available={available || undefined}>
            <span className={styles.runtimeIcon}><AliIcon name="code" size={14} /></span>
            <span className={styles.copy}>
              <strong>{tool.label}</strong>
              <small>{available
                ? `${tool.version ?? t("projectTools.runtimeUnknownVersion")} · ${tool.source === "managed" ? t("projectTools.runtimeManaged") : t("projectTools.runtimeSystem")}`
                : t("projectTools.runtimeMissing")}</small>
            </span>
            <span className={styles.runtimeState} data-available={available || undefined}>{busy ? t("projectTools.runtimeInstalling") : available ? t("projectTools.runtimeAvailable") : t("projectTools.runtimeUnavailable")}</span>
            {tool.path ? <code title={tool.path}>{tool.path}</code> : !tool.offline ? <button type="button" className={styles.installButton} disabled={installing !== null} onClick={() => void install(tool.id)}>{installing === tool.id ? t("projectTools.runtimeInstalling") : progress?.phase === "failed" ? t("projectTools.runtimeRetry") : t("projectTools.runtimeInstall")}</button> : null}
          </div>
          {progress ? <div className={styles.installProgress} data-failed={progress.phase === "failed" || undefined}>
            <span role="status">{t(`projectTools.runtimePhase.${progress.phase}`)}</span>
            {busy ? <progress aria-label={`${tool.label} ${t(`projectTools.runtimePhase.${progress.phase}`)}`} /> : null}
            {progress.error ? <small role="alert">{progress.error}</small> : null}
          </div> : null}
          </div>;
        })}
      </div>
    </section> : null}

    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {message ? <div className={styles.notice} role="status">{message}</div> : null}

    {loading && !data ? <div className={styles.empty}>{t("projectTools.loading")}</div> : groups.length === 0 ? (
      <div className={styles.empty}>{t("projectTools.empty")}</div>
    ) : <div className={styles.groups}>
      {groups.map(({ kind, items }) => {
        const enabledCount = items.filter((item) => item.available && item.enabled).length;
        const availableCount = items.filter((item) => item.available).length;
        return <section className={styles.group} key={kind} aria-labelledby={`project-tools-${kind}`}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionIdentity}>
              <strong id={`project-tools-${kind}`}>{t(`sessionTools.group.${kind}`)}</strong>
              <span className={styles.count} data-active={enabledCount > 0 || undefined}>{t("projectTools.enabledCount", { count: enabledCount, total: availableCount })}</span>
            </div>
            {kind === "device" ? <div className={styles.bulkActions} role="group" aria-label={t("sessionTools.group.device")}>
              <button type="button" disabled={loading || saving || enabledCount === availableCount}
                aria-label={t("projectTools.enableHarmony")} title={t("projectTools.enableHarmony")}
                onClick={() => setHarmonyToolsEnabled(true)}>{t("projectTools.enableAll")}</button>
              <button type="button" disabled={loading || saving || enabledCount === 0}
                aria-label={t("projectTools.disableHarmony")} title={t("projectTools.disableHarmony")}
                onClick={() => setHarmonyToolsEnabled(false)}>{t("projectTools.disableAll")}</button>
            </div> : null}
          </div>
          <div className={styles.list}>
            {items.map((item) => {
              const toolName = item.toolNames[0];
              const labelKey = TOOL_LABEL_KEYS[toolName];
              const label = item.id.startsWith("mcp-resource:") ? t("nativeMcp.resourceLabel", { server: item.id.slice(13) }) : labelKey ? t(labelKey) : item.label;
              return <label className={styles.row} key={item.id} data-enabled={item.available && item.enabled || undefined} data-unavailable={!item.available ? "true" : undefined} data-saving={saving || loading || undefined}>
                <span className={styles.icon}><AliIcon name={iconFor(item)} size={14} /></span>
                <span className={styles.copy}>
                  <strong>{label}</strong>
                  <small>{item.available ? toolName ?? t("nativeMcp.resourcePermissionHint") : t(item.unavailableReason === "profile_restricted" ? "sessionTools.profileRestricted" : "sessionTools.notAvailable")}</small>
                </span>
                {item.available ? <span className={styles.stateLabel}>{t(item.enabled ? "projectTools.on" : "projectTools.off")}</span> : null}
                <span className={styles.toggle}>
                <input
                  className={styles.switch}
                  type="checkbox"
                  role="switch"
                  checked={item.available && item.enabled}
                  disabled={loading || saving || !item.available}
                  aria-label={label}
                  onChange={() => toggle(item)}
                />
                  <span className={styles.track} aria-hidden="true" />
                </span>
              </label>;
            })}
          </div>
        </section>;
      })}
    </div>}

    {data ? <div className={styles.footer}>
      <span role="status">{saving ? t("sessionTools.saving") : t("projectTools.budget", { used: data.definitionTokens })}</span>
      <button
        type="button"
        disabled={saving || data.capabilities.policy.preset === "coding"}
        onClick={() => void save({ preset: "coding" })}
      >{t("sessionTools.useCodingDefaults")}</button>
    </div> : null}
  </div>;
}
