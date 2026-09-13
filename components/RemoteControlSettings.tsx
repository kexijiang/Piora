"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { AliIcon } from "./AliIcon";
import styles from "./RemoteControlSettings.module.css";

type Token = {
  id: string;
  name: string;
  scopes: string[];
  allowedSessionIds: string[];
  createdAt: number;
  expiresAt?: number;
  lastUsedAt?: number;
  active: boolean;
  revokedAt?: number;
  creationPolicy?: { allowedPolicies: string[]; cwdRoots: string[] };
};

const SCOPE_GROUPS = [
  {
    title: "remote.readScopes",
    icon: "eye",
    options: [
      ["capabilities.read", "remote.scopeCapabilities"],
      ["session.state.read", "remote.scopeState"],
      ["session.history.read", "remote.scopeHistory"],
      ["session.tools.read", "remote.scopeTools"],
      ["session.events.read", "remote.scopeEvents"],
      ["session.messages.read", "remote.scopeMessages"],
    ],
  },
  {
    title: "remote.controlScopes",
    icon: "compose",
    options: [
      ["session.create", "remote.scopeCreate"],
      ["session.message.send", "remote.scopeMessage"],
      ["session.steer", "remote.scopeSteer"],
      ["session.abort", "remote.scopeAbort"],
    ],
  },
] as const;

export function RemoteControlSettings({ sessionId }: { sessionId?: string | null }) {
  const { t, locale } = useI18n();
  const formId = useId();
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [copied, setCopied] = useState<"base" | "token" | null>(null);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState("Remote client");
  const [grantCurrent, setGrantCurrent] = useState(false);
  const [creationMode, setCreationMode] = useState("notes");
  const [creationRoots, setCreationRoots] = useState("");
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
  const [serverId, setServerId] = useState("");
  const [connector, setConnector] = useState<{ state?: string; enabled?: boolean; lastError?: string }>({});
  const [queueLength, setQueueLength] = useState<number | null>(null);
  const [busyTokenId, setBusyTokenId] = useState<string | null>(null);
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<string | null>(null);
  const activeTokens = tokens.filter((token) => token.active);
  const inactiveTokens = tokens.filter((token) => !token.active);
  const [error, setError] = useState<string | null>(null);
  const roots = creationRoots.split(/\r?\n/).map((root) => root.trim()).filter(Boolean);
  const canCreate = name.trim().length > 0 && scopes.length > 0 && (scopes.includes("session.create") ? roots.length > 0 : Boolean(sessionId && grantCurrent));

  const load = useCallback(async () => {
    try {
      const [tokenResponse, statusResponse] = await Promise.all([
        fetch("/api/remote/tokens", { cache: "no-store" }),
        fetch(`/api/remote/status${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, { cache: "no-store" }),
      ]);
      if (!tokenResponse.ok) throw new Error(`HTTP ${tokenResponse.status}`);
      if (tokenResponse.ok) setTokens((await tokenResponse.json() as { tokens?: Token[] }).tokens ?? []);
      if (statusResponse.ok) {
        const status = await statusResponse.json() as { serverId?: string; connector?: typeof connector; state?: { queueLength?: number } };
        setServerId(status.serverId ?? "");
        setConnector(status.connector ?? {});
        setQueueLength(status.state?.queueLength ?? null);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setApiBase(`${window.location.origin}/api/remote/v1`);
    void load();
  }, [load]);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const create = async () => {
    if (!canCreate || isCreating) return;
    setIsCreating(true);
    setCopied(null);
    setError(null);
    try {
      const response = await fetch("/api/remote/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, scopes, allowedSessionIds: sessionId && grantCurrent ? [sessionId] : [],
          ...(scopes.includes("session.create") ? { creationPolicy: { allowedPolicies: creationMode === "agent" ? ["notes", "agent"] : ["notes"], cwdRoots: roots } } : {}),
        }),
      });
      const data = await response.json() as { token?: string; error?: string };
      if (!response.ok || !data.token) throw new Error(data.error ?? `HTTP ${response.status}`);
      setNewToken(data.token);
      setName("Remote client");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setIsCreating(false);
    }
  };

  const mutateToken = async (id: string, permanent: boolean) => {
    if (busyTokenId) return;
    setBusyTokenId(id);
    setError(null);
    try {
      const response = await fetch(`/api/remote/tokens/${encodeURIComponent(id)}${permanent ? "?permanent=true" : ""}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      setDeleteConfirmationId(null);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyTokenId(null);
    }
  };

  const revoke = (id: string) => mutateToken(id, false);

  const copy = async (value: string, target: "base" | "token") => {
    try {
      if (!navigator.clipboard) throw new Error(t("remote.copyUnavailable"));
      await navigator.clipboard.writeText(value);
      setCopied(target);
    } catch {
      setError(t("remote.copyUnavailable"));
    }
  };

  const date = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }), [locale]);

  const renderToken = (token: Token) => (
    <article key={token.id} className={styles.tokenRow}>
      <div className={styles.tokenMain}>
        <span className={styles.tokenIcon}><AliIcon name="key" size={18} /></span>
        <div className={styles.tokenInfo}>
          <div className={styles.tokenTitle}>
            <strong>{token.name}</strong>
            <span className={styles.statusBadge} data-active={token.active}>
              <span className={styles.statusDot} />
              {t(token.active ? "remote.active" : token.revokedAt ? "remote.revokedStatus" : "remote.expiredStatus")}
            </span>
          </div>
          <div className={styles.tokenMeta}>
            <span>{t("remote.createdAt", { date: date.format(token.createdAt) })}</span>
            <span>{token.lastUsedAt ? t("remote.lastUsedAt", { date: date.format(token.lastUsedAt) }) : t("remote.neverUsed")}</span>
            <span>{t("remote.scopeCount", { count: token.scopes.length })}</span>
          </div>
          {token.scopes.includes("session.create") ? <p className={styles.hint}>{token.creationPolicy ? token.creationPolicy.allowedPolicies.join(", ") + " · " + (token.creationPolicy.cwdRoots.join("; ") || t("remote.noCreationRoots")) : t("remote.legacyCreation")}</p> : null}
        </div>
        {token.active ? (
          <button type="button" className="ui-button" data-variant="danger" disabled={busyTokenId !== null} onClick={() => void revoke(token.id)}>{t("remote.revoke")}</button>
        ) : (
          <button type="button" className="ui-button" data-variant="danger" disabled={busyTokenId !== null || deleteConfirmationId === token.id} onClick={() => setDeleteConfirmationId(token.id)}><AliIcon name="delete" />{t("remote.deleteRecord")}</button>
        )}
      </div>
      {deleteConfirmationId === token.id ? (
        <div className={styles.confirmation}>
          <p>{t("remote.deleteConfirm", { name: token.name })}</p>
          <div className="ui-inline-actions">
            <button type="button" className="ui-button" data-variant="danger" disabled={busyTokenId !== null} onClick={() => void mutateToken(token.id, true)}>{t("remote.confirmDelete")}</button>
            <button type="button" className="ui-button" disabled={busyTokenId !== null} onClick={() => setDeleteConfirmationId(null)}>{t("remote.cancelDelete")}</button>
          </div>
        </div>
      ) : null}
    </article>
  );

  return (
    <div className={styles.page}>
      <div className={styles.content}>
        <header className={styles.header}>
          <span className={styles.headerIcon}><AliIcon name="api" size={24} /></span>
          <div>
            <h2>{t("remote.title")}</h2>
            <p>{t("remote.description")}</p>
          </div>
        </header>

        {error ? <div role="alert" className={styles.error}><AliIcon name="alert" size={17} /><span>{error}</span></div> : null}

        <section className={styles.endpoint} aria-labelledby={formId + "-endpoint"}>
          <div className={styles.sectionHeading}>
            <h3 id={formId + "-endpoint"}><AliIcon name="link" size={17} />{t("remote.apiBase")}</h3>
            <span className={styles.protocol}>HTTP / SSE</span>
          </div>
          <div className={styles.addressRow}>
            <code>{apiBase}</code>
            <button type="button" className="ui-button" onClick={() => void copy(apiBase, "base")}><AliIcon name={copied === "base" ? "check" : "copy"} />{t(copied === "base" ? "remote.copied" : "remote.copyBase")}</button>
          </div>
          <p className={styles.hint}>{t("remote.endpointHelp")}</p>
          <p className={styles.hint}>{t("remote.serverId")}: <code>{serverId || "—"}</code></p>
        </section>

        <form className={styles.card} onSubmit={(event) => { event.preventDefault(); void create(); }} aria-labelledby={formId + "-create"}>
          <div className={styles.cardHeading}>
            <div>
              <h3 id={formId + "-create"}>{t("remote.createTitle")}</h3>
              <p>{t("remote.createHelp")}</p>
            </div>
            <AliIcon name="key" size={20} />
          </div>
          <div className={styles.formBody}>
            <label className={styles.nameField} htmlFor={formId + "-name"}>
              <span>{t("remote.tokenName")}</span>
              <input id={formId + "-name"} className="ui-input" value={name} required maxLength={120} disabled={isCreating} placeholder={t("remote.namePlaceholder")} onChange={(event) => setName(event.target.value)} />
            </label>
            <div className={styles.permissionsHeading}>
              <span>{t("remote.permissions")}</span>
              <span className={styles.count}>{t("remote.selectedScopes", { count: scopes.length })}</span>
            </div>
            <div className={styles.scopeGrid}>
              {SCOPE_GROUPS.map((group) => (
                <fieldset key={group.title} className={styles.scopeGroup} disabled={isCreating}>
                  <legend><AliIcon name={group.icon} size={15} />{t(group.title)}</legend>
                  {group.options.map(([scope, key]) => (
                    <label key={scope} className={styles.scopeOption}>
                      <input type="checkbox" checked={scopes.includes(scope)} onChange={() => setScopes((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope])} />
                      <span>{t(key)}</span>
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
            {scopes.includes("session.create") ? <>
              <label className={styles.nameField}>
                <span>{t("remote.creationMode")}</span>
                <select className="ui-input" value={creationMode} disabled={isCreating} onChange={(event) => setCreationMode(event.target.value)}>
                  <option value="notes">{t("remote.notesOnly")}</option>
                  <option value="agent">{t("remote.allowAgent")}</option>
                </select>
              </label>
              <label className={styles.nameField}>
                <span>{t("remote.creationRoots")}</span>
                <textarea className="ui-input" rows={3} value={creationRoots} required disabled={isCreating} onChange={(event) => setCreationRoots(event.target.value)} />
              </label>
              <p className={styles.hint}>{t("remote.creationHelp")}</p>
            </> : null}
            {sessionId ? <label className={styles.scopeOption}>
              <input type="checkbox" checked={grantCurrent} disabled={isCreating} onChange={(event) => setGrantCurrent(event.target.checked)} />
              <span>{t("remote.grantCurrent")}</span>
            </label> : null}
            <div className={styles.warning}>
              <AliIcon name="lock" size={17} />
              <p>{t("remote.warning")}</p>
            </div>
          </div>
          <div className={styles.formFooter}>
            <p className={styles.hint}>
              {t(!name.trim() ? "remote.nameRequired" : scopes.length === 0 ? "remote.scopesRequired" : scopes.includes("session.create") && roots.length === 0 ? "remote.noCreationRoots" : sessionId && grantCurrent ? "remote.sessionBound" : "remote.noSession")}
            </p>
            <button type="submit" className="ui-button" data-variant="accent" disabled={!canCreate || isCreating}><AliIcon name="plus" />{t(isCreating ? "remote.creating" : "remote.create")}</button>
          </div>
        </form>

        {newToken ? (
          <section className={styles.secret} aria-labelledby={formId + "-secret"}>
            <h3 id={formId + "-secret"}><AliIcon name="check-circle" size={18} />{t("remote.tokenCreated")}</h3>
            <p>{t("remote.tokenOnce")}</p>
            <code className={styles.secretValue}>{newToken}</code>
            <div className="ui-inline-actions">
              <button type="button" className="ui-button" data-variant="accent" onClick={() => void copy(newToken, "token")}><AliIcon name={copied === "token" ? "check" : "copy"} />{t(copied === "token" ? "remote.copied" : "remote.copy")}</button>
              <button type="button" className="ui-button" onClick={() => setNewToken(null)}>{t("remote.dismiss")}</button>
            </div>
          </section>
        ) : null}
        <span className={styles.srOnly} role="status">{copied ? t("remote.copied") : ""}</span>

        <section className={styles.card} aria-labelledby={formId + "-tokens"} aria-busy={isLoading}>
          <div className={styles.cardHeading}>
            <div>
              <h3 id={formId + "-tokens"}>{t("remote.tokens")}<span className={styles.count}>{isLoading ? "—" : activeTokens.length}</span></h3>
              <p>{t("remote.manageHelp")}</p>
            </div>
            <AliIcon name="lock" size={20} />
          </div>
          {isLoading ? <p className={styles.emptyState} role="status">{t("remote.loading")}</p> : activeTokens.length === 0 ? (
            <div className={styles.emptyState}><AliIcon name="key" size={23} /><strong>{t("remote.noActiveTokens")}</strong><span>{t("remote.emptyHelp")}</span></div>
          ) : activeTokens.map(renderToken)}
          <details className={styles.history}>
            <summary><AliIcon name="history" size={16} /><span>{t("remote.revokedRecords")}</span><span className={styles.count}>{isLoading ? "—" : inactiveTokens.length}</span><AliIcon name="chevron-right" className={styles.chevron} size={16} /></summary>
            <p className={styles.historyHelp}>{t("remote.historyHelp")}</p>
            {inactiveTokens.length === 0 ? <p className={styles.historyHelp}>{t("remote.noInactiveTokens")}</p> : inactiveTokens.map(renderToken)}
          </details>
        </section>

        <section className={styles.connector} aria-labelledby={formId + "-connector"}>
          <span className={styles.connectorIcon}><AliIcon name="cloud" size={21} /></span>
          <div className={styles.connectorBody}>
            <div className={styles.sectionHeading}>
              <h3 id={formId + "-connector"}>{t("remote.connector")}</h3>
              <span className={styles.statusBadge}>{isLoading ? t("remote.loading") : connector.enabled ? connector.state ?? t("remote.unknownState") : t("remote.disabled")}</span>
            </div>
            <p className={styles.hint}>{t("remote.connectorHelp")}</p>
            {!isLoading && !connector.enabled ? <p className={styles.hint}>{t("remote.connectorDisabled")}</p> : null}
            {connector.lastError ? <p className={styles.connectorError}>{connector.lastError}</p> : null}
            {sessionId ? <p className={styles.hint}>{t("remote.queue")}: {queueLength ?? "—"}</p> : null}
          </div>
        </section>
      </div>
    </div>
  );
}
