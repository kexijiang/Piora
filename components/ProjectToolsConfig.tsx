"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "@/hooks/useI18n";
import type {
  SessionCapabilitiesState,
  SessionCapabilityItem,
  SessionCapabilityKind,
  SessionCapabilitySelection,
} from "@/lib/session-capabilities";
import { AliIcon, type AliIconName } from "./AliIcon";
import styles from "./ProjectToolsConfig.module.css";

interface ProjectToolsResponse {
  projectRoot: string;
  managed: boolean;
  capabilities: SessionCapabilitiesState;
  definitionTokens: number;
  definitionTokenLimit: number;
  diagnostics: Array<{ path: string; error: string }>;
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

  const disableHarmonyTools = () => {
    if (!data || saving) return;
    const deviceIds = new Set(data.capabilities.items.filter((item) => item.kind === "device").map((item) => item.id));
    const enabledCapabilityIds = data.capabilities.policy.enabledCapabilityIds.filter((id) => !deviceIds.has(id));
    void save({ preset: "custom", enabledCapabilityIds });
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

    {error ? <div className={styles.error} role="alert">{error}</div> : null}
    {message ? <div className={styles.notice} role="status">{message}</div> : null}

    {loading && !data ? <div className={styles.empty}>{t("projectTools.loading")}</div> : groups.length === 0 ? (
      <div className={styles.empty}>{t("projectTools.empty")}</div>
    ) : <div className={styles.groups}>
      {groups.map(({ kind, items }) => {
        const enabledCount = items.filter((item) => item.available && item.enabled).length;
        return <section className={styles.group} key={kind} aria-labelledby={`project-tools-${kind}`}>
          <div className={styles.sectionHeader}>
            <div>
              <strong id={`project-tools-${kind}`}>{t(`sessionTools.group.${kind}`)}</strong>
              <span>{enabledCount} / {items.filter((item) => item.available).length}</span>
            </div>
            {kind === "device" ? <button
              type="button"
              disabled={saving || enabledCount === 0}
              onClick={disableHarmonyTools}
            >{t("projectTools.disableHarmony")}</button> : null}
          </div>
          <div className={styles.list}>
            {items.map((item) => {
              const toolName = item.toolNames[0];
              const labelKey = TOOL_LABEL_KEYS[toolName];
              const label = labelKey ? t(labelKey) : item.label;
              return <label className={styles.row} key={item.id} data-unavailable={!item.available ? "true" : undefined}>
                <span className={styles.icon}><AliIcon name={iconFor(item)} size={14} /></span>
                <span className={styles.copy}>
                  <strong>{label}</strong>
                  <small>{item.available ? toolName : t("sessionTools.profileRestricted")}</small>
                </span>
                <input
                  className={styles.switch}
                  type="checkbox"
                  role="switch"
                  checked={item.available && item.enabled}
                  disabled={saving || !item.available}
                  aria-label={label}
                  onChange={() => toggle(item)}
                />
              </label>;
            })}
          </div>
        </section>;
      })}
    </div>}

    {data ? <div className={styles.footer}>
      <span>{t("projectTools.budget", { used: data.definitionTokens, limit: data.definitionTokenLimit })}</span>
      <button
        type="button"
        disabled={saving || data.capabilities.policy.preset === "coding"}
        onClick={() => void save({ preset: "coding" })}
      >{t("sessionTools.useCodingDefaults")}</button>
    </div> : null}
  </div>;
}
