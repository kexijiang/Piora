"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

type Token = {
  id: string;
  name: string;
  scopes: string[];
  allowedSessionIds: string[];
  createdAt: number;
  expiresAt?: number;
  lastUsedAt?: number;
  active: boolean;
};

const SCOPE_OPTIONS = [
  ["capabilities.read", "remote.scopeCapabilities"],
  ["session.create", "remote.scopeCreate"],
  ["session.state.read", "remote.scopeState"],
  ["session.history.read", "remote.scopeHistory"],
  ["session.tools.read", "remote.scopeTools"],
  ["session.message.send", "remote.scopeMessage"],
  ["session.steer", "remote.scopeSteer"],
  ["session.abort", "remote.scopeAbort"],
  ["session.events.read", "remote.scopeEvents"],
  ["session.messages.read", "remote.scopeMessages"],
] as const;

export function RemoteControlSettings({ sessionId }: { sessionId?: string | null }) {
  const { t } = useI18n();
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState("Remote client");
  const [scopes, setScopes] = useState<string[]>([
    "capabilities.read",
    "session.create",
    "session.state.read",
    "session.history.read",
    "session.tools.read",
    "session.message.send",
    "session.events.read",
  ]);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [apiBase, setApiBase] = useState("/api/remote/v1");
  const [connector, setConnector] = useState<{ state?: string; enabled?: boolean; lastError?: string }>({});
  const [queueLength, setQueueLength] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [tokenResponse, statusResponse] = await Promise.all([
        fetch("/api/remote/tokens", { cache: "no-store" }),
        fetch(`/api/remote/status${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, { cache: "no-store" }),
      ]);
      if (tokenResponse.ok) setTokens((await tokenResponse.json() as { tokens?: Token[] }).tokens ?? []);
      if (statusResponse.ok) {
        const status = await statusResponse.json() as { connector?: typeof connector; state?: { queueLength?: number } };
        setConnector(status.connector ?? {});
        setQueueLength(status.state?.queueLength ?? null);
      }
    } catch { /* settings remains usable while the server is restarting */ }
  }, [sessionId]);

  useEffect(() => {
    setApiBase(`${window.location.origin}/api/remote/v1`);
    void load();
  }, [load]);

  const create = async () => {
    if ((!sessionId && !scopes.includes("session.create")) || scopes.length === 0) return;
    setError(null);
    try {
      const response = await fetch("/api/remote/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, scopes, allowedSessionIds: sessionId ? [sessionId] : [] }),
      });
      const data = await response.json() as { token?: string; error?: string };
      if (!response.ok || !data.token) throw new Error(data.error ?? `HTTP ${response.status}`);
      setNewToken(data.token);
      setName("Remote client");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const revoke = async (id: string) => {
    await fetch(`/api/remote/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
    await load();
  };

  const copyToken = async () => { if (newToken) await navigator.clipboard?.writeText(newToken); };
  const copyApiBase = async () => { await navigator.clipboard?.writeText(apiBase); };
  const date = useMemo(() => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }), []);

  return (
    <div className="settings-embedded-surface" style={{ height: "100%", overflowY: "auto", padding: "26px 30px 34px" }}>
      <div style={{ marginBottom: 22 }}>
        <h2 style={{ margin: 0, color: "var(--text)", fontSize: "calc(var(--text-lg) * 1.22)", fontWeight: 680 }}>{t("remote.title")}</h2>
        <p style={{ margin: "7px 0 0", color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{t("remote.description")}</p>
      </div>
      <section className="settings-conversation-section">
        <p style={{ color: "var(--status-attention)", lineHeight: 1.5 }}>{t("remote.warning")}</p>
        <label style={{ display: "grid", gap: 6, maxWidth: 720, marginBottom: 14 }}>
          <span>{t("remote.apiBase")}</span>
          <span style={{ display: "flex", gap: 8 }}><code style={{ flex: 1, overflowWrap: "anywhere" }}>{apiBase}</code><button type="button" onClick={() => void copyApiBase()}>{t("remote.copyBase")}</button></span>
        </label>
        <label style={{ display: "grid", gap: 6, maxWidth: 520 }}><span>{t("remote.tokenName")}</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div style={{ display: "grid", gap: 7, marginTop: 14 }}>
          {SCOPE_OPTIONS.map(([scope, key]) => <label key={scope} style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={scopes.includes(scope)} onChange={() => setScopes((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope])} /><span>{t(key)}</span></label>)}
        </div>
        <button type="button" disabled={(!sessionId && !scopes.includes("session.create")) || scopes.length === 0} onClick={() => void create()}>{t("remote.create")}</button>
        {!sessionId ? <p>{t("remote.noSession")}</p> : null}
        {newToken ? <div style={{ marginTop: 14, padding: 12, border: "1px solid var(--accent)", borderRadius: "var(--radius-control)" }}><strong>{t("remote.tokenOnce")}</strong><code style={{ display: "block", margin: "8px 0", overflowWrap: "anywhere" }}>{newToken}</code><button type="button" onClick={() => void copyToken()}>{t("remote.copy")}</button><button type="button" onClick={() => setNewToken(null)} style={{ marginLeft: 8 }}>{t("remote.dismiss")}</button></div> : null}
        {error ? <p role="alert" style={{ color: "var(--status-failed)" }}>{error}</p> : null}
      </section>
      <section className="settings-conversation-section" style={{ marginTop: 18 }}>
        <h3>{t("remote.tokens")}</h3>
        {tokens.length === 0 ? <p>{t("remote.noTokens")}</p> : tokens.map((token) => <div key={token.id} style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderTop: "1px solid var(--border)" }}><div><strong>{token.name}</strong><div style={{ color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>{token.active ? t("remote.active") : t("remote.revoked")} · {date.format(token.createdAt)} · {token.lastUsedAt ? date.format(token.lastUsedAt) : t("remote.neverUsed")}</div></div>{token.active ? <button type="button" onClick={() => void revoke(token.id)}>{t("remote.revoke")}</button> : null}</div>)}
      </section>
      <section className="settings-conversation-section" style={{ marginTop: 18 }}>
        <h3>{t("remote.connector")}</h3>
        <p>{connector.enabled ? `${t("remote.connectorState")}: ${connector.state ?? "unknown"}` : t("remote.connectorDisabled")}</p>
        {connector.lastError ? <p>{connector.lastError}</p> : null}
        {sessionId ? <p>{t("remote.queue")}: {queueLength ?? 0}</p> : null}
      </section>
    </div>
  );
}
