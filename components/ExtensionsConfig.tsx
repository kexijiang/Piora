"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "@/hooks/useI18n";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ExtensionInventoryItem, ExtensionsResponse } from "@/lib/api-types";
import { AliIcon } from "./AliIcon";
import { CapabilityPrimer } from "./CapabilityPrimer";
import { ComputerControlSettings } from "./ComputerControlSettings";
import settingsStyles from "./SettingsDialog.module.css";

interface Props {
  cwd: string;
  sessionId?: string | null;
  onReloaded?: () => void;
}

export function ExtensionsConfig({ cwd, sessionId, onReloaded }: Props) {
  const { t } = useI18n();
  const [data, setData] = useState<ExtensionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/extensions?cwd=${encodeURIComponent(cwd)}`);
      const next = await response.json() as ExtensionsResponse & { error?: string };
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

  const groups = useMemo(() => {
    const extensions = data?.extensions ?? [];
    return [
      { key: "builtIn", label: t("extensions.builtIn"), items: extensions.filter((item) => item.builtIn) },
      { key: "installed", label: t("extensions.installed"), items: extensions.filter((item) => !item.builtIn) },
    ].filter((group) => group.items.length > 0);
  }, [data?.extensions, t]);

  const toggle = useCallback(async (extension: ExtensionInventoryItem) => {
    const enabled = !extension.enabled;
    setBusyId(extension.id);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/extensions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, id: extension.id, enabled }),
      });
      const next = await response.json() as ExtensionsResponse & { error?: string };
      if (!response.ok || next.error) throw new Error(next.error ?? `HTTP ${response.status}`);
      setData(next);
      window.dispatchEvent(new Event("piora:extensions-changed"));

      if (sessionId) {
        try {
          await sendAgentCommand(sessionId, { type: "restart_extensions" });
          onReloaded?.();
          setMessage(t("extensions.applied"));
        } catch {
          setMessage(t("extensions.reloadPending"));
        }
      } else {
        setMessage(t("extensions.appliedNextSession"));
      }
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally {
      setBusyId(null);
    }
  }, [cwd, onReloaded, sessionId, t]);

  return (
    <div className="settings-embedded-surface" style={{ height: "100%", overflowY: "auto", padding: "26px 30px 34px" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 22 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ margin: 0, color: "var(--text)", fontSize: "calc(var(--text-lg) * 1.22)", fontWeight: 680 }}>{t("extensions.title")}</h2>
          <p style={{ margin: "7px 0 0", color: "var(--text-muted)", fontSize: "var(--text-sm)", maxWidth: 720 }}>{t("extensions.description")}</p>
        </div>
        <button className="ui-button" type="button" onClick={() => void load()} disabled={loading || busyId !== null}>
          <AliIcon name="reload" size={14} /> {t("i18n.refresh")}
        </button>
      </div>

      <CapabilityPrimer current="extension" />
      <ComputerControlSettings />

      {error && <div role="alert" style={{ marginBottom: 12, color: "#dc2626", fontSize: "var(--text-sm)" }}>{error}</div>}
      {message && <div role="status" style={{ marginBottom: 12, color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{message}</div>}

      {loading && !data ? (
        <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{t("extensions.loading")}</div>
      ) : groups.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{t("extensions.empty")}</div>
      ) : groups.map((group) => (
        <section key={group.key} style={{ marginBottom: 24 }} aria-labelledby={`extensions-${group.key}`}>
          <h3 id={`extensions-${group.key}`} style={{ margin: "0 0 9px", fontSize: "var(--text-sm)", color: "var(--text)" }}>{group.label}</h3>
          <div style={{ display: "grid", gap: 8 }}>
            {group.items.map((extension) => {
              const busy = busyId === extension.id;
              return (
                <div key={extension.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 14px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <strong style={{ fontSize: "var(--text-sm)", color: "var(--text)" }}>{extension.name}</strong>
                      <span style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{extension.source}</span>
                    </div>
                    {extension.description && <div style={{ marginTop: 4, color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>{extension.description}</div>}
                    <div style={{ marginTop: 6, color: "var(--text-dim)", fontSize: "var(--text-xs)", overflowWrap: "anywhere" }}>
                      {[extension.tools.length ? `${extension.tools.length} ${t("extensions.tools")}` : "", extension.commands.length ? `${extension.commands.length} ${t("extensions.commands")}` : "", extension.path].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <div className="ui-inline-actions">
                    <span className="ui-status-badge">{busy ? t("extensions.saving") : extension.required ? t("extensions.required") : !extension.configurable ? t("extensions.managedByPlugin") : extension.enabled ? t("extensions.enabled") : t("extensions.disabled")}</span>
                    <button className={settingsStyles.switch} type="button" role="switch" aria-checked={extension.enabled} aria-label={`${extension.name}: ${extension.enabled ? t("extensions.enabled") : t("extensions.disabled")}`} disabled={busyId !== null || !extension.configurable} onClick={() => void toggle(extension)}><span /></button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {data?.diagnostics.length ? (
        <details style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>
          <summary>{data.diagnostics.length} {t("extensions.diagnostics")}</summary>
          <ul>{data.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.path}:${index}`}>{diagnostic.path}: {diagnostic.error}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}
