"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { sendAgentCommand } from "@/lib/agent-client";
import { useI18n } from "@/hooks/useI18n";
import styles from "./PluginsConfig.module.css";

interface Server {
  name: string; source: string; scope: "global" | "project" | "extension"; override?: string;
  enabled?: boolean; liveEndpoint?: string; configurationCurrent?: boolean; transport: string; endpoint: string; exposure: string; state: string;
  tools: Array<{ name: string; exposure: string }>; resources: boolean;
}
interface State { enabled: boolean; projectTrusted: boolean; owner: string; live: boolean; servers: Server[]; diagnostics: string[] }
const exposures = ["direct", "deferred", "codemode", "hidden"];

export function NativeMcpConfig({ cwd, sessionId, onReloaded }: { cwd: string; sessionId: string | null; onReloaded?: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<State | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [needsReload, setNeedsReload] = useState(false);
  const [name, setName] = useState(""), [scope, setScope] = useState<"global" | "project">("global"), [definition, setDefinition] = useState("");
  const sequence = useRef(0), busyRef = useRef(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    const id = ++sequence.current;
    try {
      const params = new URLSearchParams({ cwd, ...(sessionId ? { sessionId } : {}) });
      const response = await fetch(`/api/mcp?${params}`, { signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      if (sequence.current === id) { setData(result); setError(null); }
    } catch (error) { if (!signal?.aborted && sequence.current === id) setError(error instanceof Error ? error.message : "MCP status unavailable"); }
  }, [cwd, sessionId]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    const interval = sessionId ? setInterval(() => { if (!busyRef.current) void load(controller.signal); }, 3000) : undefined;
    return () => { controller.abort(); if (interval) clearInterval(interval); };
  }, [load, sessionId]);
  const mutate = async (operation: Record<string, unknown>) => {
    const id = ++sequence.current; busyRef.current = true; setBusy(true); setError(null);
    try {
      const response = await fetch("/api/mcp", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cwd, sessionId, ...operation }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      if (sequence.current === id) { setData(result); setNeedsReload(true); } return true;
    } catch (error) { setError(error instanceof Error ? error.message : "MCP configuration failed"); return false; }
    finally { busyRef.current = false; setBusy(false); }
  };
  const command = async (message: string) => {
    if (!sessionId) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await sendAgentCommand(sessionId, { type: "prompt", message }); await load(); }
    catch (error) { setError(error instanceof Error ? error.message : "MCP command failed"); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const reload = async () => {
    if (!sessionId) return;
    busyRef.current = true; setBusy(true); setError(null);
    try { await sendAgentCommand(sessionId, { type: "reload" }); setNeedsReload(false); await load(); onReloaded?.(); }
    catch (error) { setError(error instanceof Error ? error.message : "Session reload failed"); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <section className={styles.nativePanel} aria-labelledby="native-mcp-title" style={{ display: "grid", gap: 14, minWidth: 0 }}>
    <h3 id="native-mcp-title">{t("nativeMcp.title")}</h3>
    <p>{t("nativeMcp.description")}</p>
    {error ? <p role="alert">{error}</p> : null}
    {!data ? <p>{t("i18n.loading")}</p> : <>
      <label><input type="checkbox" checked={data.enabled} disabled={busy} onChange={event => { void mutate({ action: "integration", enabled: event.target.checked }); }} /> {t("nativeMcp.enable")}</label>
      <p>{t("nativeMcp.permissions")}</p>
      <p>{t("nativeMcp.owner", { owner: data.owner === "native" ? t("nativeMcp.native") : data.owner === "replacement" ? t("nativeMcp.replacement") : t("nativeMcp.notStarted") })}</p>
      {!data.live ? <p>{t("nativeMcp.noLiveSession")}</p> : null}
      {needsReload ? <p>{t("nativeMcp.reloadHint")} <button type="button" disabled={busy || !sessionId} onClick={() => { void reload(); }}>{t("i18n.reloadSession")}</button></p> : null}
      <button type="button" disabled={busy} onClick={() => { void load(); }}>{t("nativeMcp.refresh")}</button>
      {data.servers.length === 0 ? <p>{t("nativeMcp.empty")}</p> : data.servers.map(server => <details key={`${server.scope}:${server.name}`} className={styles.serverCard} open>
        <summary className={styles.serverSummary}><strong>{server.name}</strong><span>{server.transport}</span><span>{t(`nativeMcp.state.${server.state}`)}</span></summary>
        <div className={styles.serverBody}>
          <p>{server.endpoint}</p>
          {server.configurationCurrent === false ? <p>{t("nativeMcp.pendingConfiguration")} {server.liveEndpoint ? t("nativeMcp.liveEndpoint", { endpoint: server.liveEndpoint }) : ""}</p> : null}
          <p>{t("nativeMcp.source", { source: server.source })}</p>
          {server.override ? <p>{t("nativeMcp.override", { path: server.override })}</p> : null}
          {server.scope === "extension" ? <button type="button" disabled={busy || !sessionId} onClick={() => { void mutate({ action: "approve-registered", name: server.name, enabled: server.state === "approval-required" }); }}>{server.state === "approval-required" ? t("nativeMcp.approve") : t("nativeMcp.revoke")}</button> : <>
            <label><input type="checkbox" checked={server.enabled !== false} disabled={busy} onChange={event => { void mutate({ action: "server", scope: server.override ? "project" : server.scope, name: server.name, enabled: event.target.checked }); }} /> {t("nativeMcp.serverEnabled")}</label>
            <label>{t("nativeMcp.exposure")} <select aria-label={`${server.name} ${t("nativeMcp.exposure")}`} value={server.exposure} disabled={busy} onChange={event => { void mutate({ action: "server", scope: server.override ? "project" : server.scope, name: server.name, exposure: event.target.value }); }}>{exposures.map(exposure => <option key={exposure} value={exposure}>{t(`nativeMcp.exposure.${exposure}`)}</option>)}</select></label>
          </>}
          <p>{t("nativeMcp.liveTools", { count: server.tools.filter(tool => tool.exposure !== "hidden").length })}</p>
          {server.tools.length ? <ul>{server.tools.map(tool => <li key={tool.name}><code>{tool.name}</code> · {tool.exposure}</li>)}</ul> : null}
          {server.resources ? <p>{t("nativeMcp.resources")}</p> : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" disabled={busy || !sessionId || !data.enabled || data.owner !== "native"} onClick={() => { void command(`/mcp reconnect ${server.name}`); }}>{t("nativeMcp.reconnect")}</button>
            {server.transport === "http" ? <button type="button" disabled={busy || !sessionId || !data.enabled || data.owner !== "native"} onClick={() => { void command(`/mcp login ${server.name}`); }}>{t("nativeMcp.login")}</button> : null}
          </div>
        </div>
      </details>)}
      {data.diagnostics.length ? <ul role="status">{data.diagnostics.map((diagnostic, index) => <li key={index}>{diagnostic}</li>)}</ul> : null}
      <form style={{ display: "grid", gap: 8 }} onSubmit={event => {
        event.preventDefault();
        let config: unknown;
        try { config = JSON.parse(definition); } catch { setError(t("nativeMcp.invalidJson")); return; }
        void mutate({ action: "server", name, scope, config }).then(ok => { if (ok) { setDefinition(""); setName(""); } });
      }}>
        <h4>{t("nativeMcp.add")}</h4>
        <label style={{ display: "grid", gap: 6 }}>{t("nativeMcp.name")} <input style={{ width: "100%", minWidth: 0 }} value={name} required maxLength={100} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <label style={{ display: "grid", gap: 6 }}>{t("nativeMcp.scope")} <select value={scope} disabled={busy} onChange={event => setScope(event.target.value as "global" | "project")}><option value="global">{t("nativeMcp.global")}</option><option value="project" disabled={!data.projectTrusted}>{t("nativeMcp.project")}</option></select></label>
        <label>{t("nativeMcp.definition")}<textarea value={definition} required spellCheck={false} disabled={busy} rows={6} onChange={event => setDefinition(event.target.value)} placeholder={'{"command":"node","args":["/path/to/server.mjs"],"enabled":false,"exposure":"codemode"}'} style={{ display: "block", width: "100%", fontFamily: "var(--font-mono)" }} /></label>
        <p>{t("nativeMcp.privateConfig")}</p>
        {!data.projectTrusted ? <p>{t("nativeMcp.projectTrust")}</p> : null}
        <button type="submit" disabled={busy || !name.trim() || !definition.trim()}>{t("i18n.save")}</button>
      </form>
    </>}
  </section>;
}
