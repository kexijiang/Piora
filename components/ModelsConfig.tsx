"use client";

import { ModelErrorText } from "./ModelErrorText";
import styles from "./ModelsConfig.module.css";

import { useState, useEffect, useCallback, useRef } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import type { ModelCatalogPreset, ModelCatalogRecommendation } from "@/lib/model-catalog";
import type { DiscoveredModel } from "@/lib/model-discovery";
import { prioritizeProvider } from "@/lib/model-policy";
import { AliIcon } from "./AliIcon";
import { requestConfirmation } from "./ConfirmDialog";
import { ModelProviderIcon } from "./ModelProviderIcon";

function ModelFallbackSetting() {
  const { t } = useI18n();
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/models/fallback", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const config = await response.json() as { enabled: boolean };
        if (!controller.signal.aborted) setEnabled(config.enabled);
      })
      .catch((reason) => { if (!controller.signal.aborted) setError(String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, []);
  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/models/fallback", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !enabled }),
      });
      const config = await response.json() as { enabled: boolean; error?: string };
      if (!response.ok) throw new Error(config.error || `HTTP ${response.status}`);
      setEnabled(config.enabled);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <div data-settings-id="models.fallback" style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
    <label style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text)", fontSize: "var(--text-sm)" }}>
      <input type="checkbox" role="switch" checked={enabled} disabled={busy} onChange={() => void toggle()} />
      <strong>{t("models.fallback.title")}</strong>
    </label>
    <p style={{ margin: "5px 0 0", color: "var(--text-muted)", fontSize: "var(--text-xs)" }}>{t("models.fallback.description")}</p>
    {error ? <p role="alert" style={{ color: "var(--error, #dc2626)", margin: "5px 0 0" }}>{<ModelErrorText value={error} />}</p> : null}
  </div>;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface OAuthProvider {
  id: string;
  name: string;
  usesCallbackServer: boolean;
  loggedIn: boolean;
  /** Provider also accepts an API key, so it appears in both picker sections. */
  supportsApiKey?: boolean;
}

interface ApiKeyProvider {
  id: string;
  displayName: string;
  configured: boolean;
  source?: string;
  modelCount: number;
  /** Provider also supports OAuth, so it appears in both picker sections. */
  supportsOAuth?: boolean;
  canRemoveStoredCredential?: boolean;
}

type OAuthLoginState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "auth"; url: string; instructions: string | null; token: string }
  | { phase: "device_code"; userCode: string; verificationUri: string; intervalSeconds: number | null; expiresInSeconds: number | null }
  | { phase: "prompt"; message: string; placeholder: string | null; token: string }
  | { phase: "select"; message: string; options: { id: string; label: string }[]; token: string }
  | { phase: "progress"; message: string }
  | { phase: "success" }
  | { phase: "error"; message: string };

interface ModelEntry {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  compat?: Record<string, unknown>;
}

interface ProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ModelEntry[];
  modelOverrides?: Record<string, unknown>;
}

interface ModelsJson {
  providers?: Record<string, ProviderEntry>;
}

interface ConfiguredModelRef {
  provider: string;
  id: string;
}

function collectConfiguredModelRefs(config: ModelsJson): ConfiguredModelRef[] {
  const refs: ConfiguredModelRef[] = [];
  for (const [provider, entry] of Object.entries(config.providers ?? {})) {
    for (const model of entry.models ?? []) {
      const id = model.id.trim();
      if (id) refs.push({ provider, id });
    }
  }
  return refs;
}

function configuredModelKey(model: ConfiguredModelRef): string {
  return `${model.provider}/${model.id}`;
}

interface ManagedModel {
  provider: string;
  id: string;
  name: string;
  enabled: boolean;
}

interface ModelScopeResponse {
  models: ManagedModel[];
  enabledPatterns: string[] | null;
  projectOverride: boolean;
  warnings: string[];
  enabledCount: number;
  totalCount: number;
  configuredDefault: { provider: string; modelId: string } | null;
  effectiveDefault: { provider: string; modelId: string } | null;
  changed?: boolean;
}

interface VisionAgentConfigState {
  enabled: boolean;
  provider: string | null;
  modelId: string | null;
}

interface VisionAgentModelOption {
  provider: string;
  modelId: string;
  name: string;
}

interface VisionAgentResponse {
  config: VisionAgentConfigState;
  models: VisionAgentModelOption[];
  error?: string;
}

type VisionAgentTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; latencyMs: number; observation: string }
  | { phase: "error"; message: string };

type ModelTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; latencyMs?: number; status?: number; responseText?: string }
  | { phase: "error"; message: string; latencyMs?: number; status?: number };

type ModelDiscoveryState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "success"; models: DiscoveredModel[]; endpoint: string }
  | { phase: "error"; message: string };

type ModelCatalogState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "success"; recommendation: ModelCatalogRecommendation; appliedCount: number }
  | { phase: "error"; message: string };

type Selection =
  | { type: "vision-agent" }
  | { type: "provider"; name: string }
  | { type: "model"; providerName: string; index: number }
  | { type: "oauth"; providerId: string }
  | { type: "apikey"; providerId: string }
  | { type: "managed"; providerId: string };

const API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;

// ── Form field helpers ────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.field} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", fontWeight: 500 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle = {
  padding: "6px 9px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-control)",
  color: "var(--text)",
  fontSize: "var(--text-sm)",
  outline: "none",
  width: "100%",
  boxSizing: "border-box" as const,
};

function TextInput({ value, onChange, placeholder, mono }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
    style={{ ...inputStyle, fontFamily: mono ? "var(--font-mono)" : "inherit" }} />;
}

function SecretTextInput({
  value,
  onChange,
  placeholder,
  mono,
  onKeyDown,
  autoComplete = "off",
  spellCheck = false,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  autoComplete?: string;
  spellCheck?: boolean;
  style?: React.CSSProperties;
}) {
  const [visible, setVisible] = useState(false);
  const { t } = useI18n();

  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);

  return (
    <div style={{ position: "relative", width: "100%", ...style }}>
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        style={{ ...inputStyle, paddingRight: 34, fontFamily: mono ? "var(--font-mono)" : "inherit" }}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
         aria-label={visible ? t("i18n.hideDetails") : t("i18n.showDetails")}
         title={visible ? t("i18n.hideDetails") : t("i18n.showDetails")}
        style={{
          position: "absolute",
          right: 5,
          top: "50%",
          transform: "translateY(-50%)",
          width: 24,
          height: 24,
          padding: 0,
          border: "none",
          background: "transparent",
          color: "var(--text-dim)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {visible ? (
          <AliIcon name="eye-close" size={15} />
        ) : (
          <AliIcon name="eye" size={15} />
        )}
      </button>
    </div>
  );
}

function NumInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <input type="number" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={inputStyle} />;
}

function Select({ value, onChange, options, required }: { value: string; onChange: (v: string) => void; options: readonly string[]; required?: boolean }) {
  const { t } = useI18n();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, color: value ? "var(--text)" : "var(--text-dim)" }}>
       {!required && <option value="">— {t("models.form.inherit")} —</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        style={{ width: 13, height: 13, accentColor: "var(--accent)", cursor: "pointer" }} />
      {label}
    </label>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 2 }}>{children}</div>;
}

function visualModelValue(model: Pick<VisionAgentModelOption, "provider" | "modelId">): string {
  return JSON.stringify([model.provider, model.modelId]);
}

function VisionAgentDetail({ cwd }: { cwd?: string }) {
  const { t } = useI18n();
  const [config, setConfig] = useState<VisionAgentConfigState>({ enabled: false, provider: null, modelId: null });
  const [models, setModels] = useState<VisionAgentModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testState, setTestState] = useState<VisionAgentTestState>({ phase: "idle" });

  useEffect(() => {
    let active = true;
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    fetch(`/api/vision-agent${query}`)
      .then(async (response) => {
        const body = await response.json() as VisionAgentResponse;
        if (!active) return;
        if (body.config) setConfig(body.config);
        setModels(Array.isArray(body.models) ? body.models : []);
        if (!response.ok || body.error) setError(body.error ?? `HTTP ${response.status}`);
      })
      .catch((loadError) => { if (active) setError(String(loadError)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [cwd]);

  const selectedValue = config.provider && config.modelId
    ? visualModelValue({ provider: config.provider, modelId: config.modelId })
    : "";
  const selectedIsAvailable = models.some((model) => visualModelValue(model) === selectedValue);
  const staleSelected = selectedValue && !selectedIsAvailable
    ? { provider: config.provider!, modelId: config.modelId!, name: t("models.visualModelUnavailable") }
    : null;

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const response = await fetch("/api/vision-agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, ...(cwd ? { cwd } : {}) }),
      });
      const body = await response.json() as { config?: VisionAgentConfigState; error?: string };
      if (!response.ok || body.error || !body.config) throw new Error(body.error ?? `HTTP ${response.status}`);
      setConfig(body.config);
      setSaved(true);
      setTimeout(() => setSaved(false), 2_000);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!config.provider || !config.modelId) return;
    setTestState({ phase: "testing" });
    setError(null);
    try {
      const response = await fetch("/api/vision-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...config, ...(cwd ? { cwd } : {}) }),
      });
      const body = await response.json() as { ok?: boolean; latencyMs?: number; observation?: string; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setTestState({ phase: "success", latencyMs: body.latencyMs ?? 0, observation: body.observation ?? "" });
    } catch (testError) {
      setTestState({ phase: "error", message: testError instanceof Error ? testError.message : String(testError) });
    }
  };

  if (loading) {
    return <div style={{ color: "var(--text-muted)", fontSize: "var(--text-sm)" }}>{t("i18n.loading")}</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, maxWidth: 680 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 34, height: 34, borderRadius: "var(--radius-control)", display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--bg-selected)", color: "var(--accent)" }}>
          <AliIcon name="eye" size={18} />
        </span>
        <div>
          <div style={{ color: "var(--text)", fontSize: "var(--text-md)", fontWeight: 700 }}>{t("models.visualAgent")}</div>
          <div style={{ marginTop: 2, color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>{t("models.visualAgentSubtitle")}</div>
        </div>
      </div>

      <div style={{ padding: 14, border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 14 }}>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 9, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(event) => setConfig((current) => ({ ...current, enabled: event.target.checked }))}
            style={{ width: 15, height: 15, marginTop: 2, accentColor: "var(--accent)" }}
          />
          <span>
            <span style={{ display: "block", color: "var(--text)", fontSize: "var(--text-sm)", fontWeight: 600 }}>{t("models.visualAgentEnable")}</span>
            <span style={{ display: "block", marginTop: 3, color: "var(--text-muted)", fontSize: "var(--text-xs)", lineHeight: 1.5 }}>{t("models.visualAgentEnableHint")}</span>
          </span>
        </label>

        <Field label={t("models.visualModel")}>
          <select
            value={selectedValue}
            onChange={(event) => {
              if (!event.target.value) {
                setConfig((current) => ({ ...current, provider: null, modelId: null }));
                return;
              }
              const [provider, modelId] = JSON.parse(event.target.value) as [string, string];
              setConfig((current) => ({ ...current, provider, modelId }));
            }}
            style={inputStyle}
          >
            <option value="">{t("models.visualModelSelect")}</option>
            {staleSelected && (
              <option value={visualModelValue(staleSelected)}>{staleSelected.provider} · {staleSelected.modelId} ({staleSelected.name})</option>
            )}
            {models.map((model) => (
              <option key={visualModelValue(model)} value={visualModelValue(model)}>
                {model.provider} · {model.name || model.modelId} ({model.modelId})
              </option>
            ))}
          </select>
        </Field>

        {models.length === 0 && (
          <div role="note" style={{ color: "#b45309", fontSize: "var(--text-xs)", lineHeight: 1.5 }}>{t("models.visualModelEmpty")}</div>
        )}
        <div role="note" style={{ padding: "9px 10px", borderRadius: "var(--radius-control)", background: "var(--bg)", color: "var(--text-muted)", fontSize: "var(--text-xs)", lineHeight: 1.55 }}>
          {t("models.visualAgentRoutingHint")}
        </div>
        <div role="note" style={{ color: "var(--text-dim)", fontSize: "var(--text-xs)", lineHeight: 1.55 }}>
          {t("models.visualAgentPrivacyHint")}
        </div>
      </div>

      {error && <div role="alert" style={{ color: "#dc2626", fontSize: "var(--text-sm)" }}>{<ModelErrorText value={error} />}</div>}
      {testState.phase === "success" && <div role="status" style={{ color: "#15803d", fontSize: "var(--text-xs)", lineHeight: 1.5 }}>{t("models.visualAgentTestSuccess", { latency: testState.latencyMs })} · {testState.observation}</div>}
      {testState.phase === "error" && <div role="alert" style={{ color: "#dc2626", fontSize: "var(--text-xs)" }}>{<ModelErrorText value={testState.message} />}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || saved || (config.enabled && (!selectedValue || !selectedIsAvailable))}
          style={{ minWidth: 112, padding: "7px 14px", border: "none", borderRadius: "var(--radius-control)", background: saved ? "#16a34a" : "var(--accent)", color: "#fff", fontSize: "var(--text-sm)", fontWeight: 600, cursor: saving || saved || (config.enabled && (!selectedValue || !selectedIsAvailable)) ? "not-allowed" : "pointer", opacity: saving || (config.enabled && (!selectedValue || !selectedIsAvailable)) ? 0.55 : 1 }}
        >
          {saved ? t("i18n.saved") : saving ? t("i18n.saving") : t("models.visualAgentSave")}
        </button>
        <button
          type="button"
          onClick={() => void test()}
          disabled={!selectedValue || !selectedIsAvailable || testState.phase === "testing"}
          style={{ padding: "7px 14px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: "var(--text-sm)", cursor: !selectedValue || !selectedIsAvailable || testState.phase === "testing" ? "not-allowed" : "pointer", opacity: !selectedValue || !selectedIsAvailable ? 0.55 : 1 }}
        >
          {testState.phase === "testing" ? t("models.visualAgentTesting") : t("models.visualAgentTest")}
        </button>
      </div>
    </div>
  );
}

// ── Provider detail ───────────────────────────────────────────────────────────

function ProviderDetail({ name, provider, onChange, onRename, onDelete, onAddModels }: {
  name: string; provider: ProviderEntry;
  onChange: (p: ProviderEntry) => void; onRename: (n: string) => void; onDelete: () => void;
  onAddModels: (models: DiscoveredModel[]) => void;
}) {
  const { t } = useI18n();
  const [editingName, setEditingName] = useState(name);
  const [discoveryState, setDiscoveryState] = useState<ModelDiscoveryState>({ phase: "idle" });
  const [connectionTest, setConnectionTest] = useState<ModelTestState>({ phase: "idle" });
  const connectionRequestRef = useRef(0);
  useEffect(() => {
    const requests = connectionRequestRef;
    requests.current++;
    setConnectionTest({ phase: "idle" });
    return () => { requests.current++; };
  }, [name, provider]);
  const testConnection = async () => {
    const model = provider.models?.find(model => model.id.trim());
    if (!model || connectionTest.phase === "testing") return;
    const token = ++connectionRequestRef.current;
    setConnectionTest({ phase: "testing" });
    try {
      const response = await fetch("/api/models-config/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName: name, provider, model }),
      });
      const result = await response.json() as { ok?: boolean; error?: string; latencyMs?: number };
      if (token !== connectionRequestRef.current) return;
      setConnectionTest(response.ok && result.ok ? { phase: "success", latencyMs: result.latencyMs } : { phase: "error", message: result.error ?? `HTTP ${response.status}` });
    } catch (error) {
      if (token === connectionRequestRef.current) setConnectionTest({ phase: "error", message: String(error) });
    }
  };
  const [discoveryQuery, setDiscoveryQuery] = useState("");
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const discoveryRequestIdRef = useRef(0);
  const selectShownRef = useRef<HTMLInputElement>(null);
  useEffect(() => setEditingName(name), [name]);
  const set = <K extends keyof ProviderEntry>(k: K, v: ProviderEntry[K]) => onChange({ ...provider, [k]: v });

  useEffect(() => {
    if (!provider.api) onChange({ ...provider, api: "openai-completions" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.api]);

  useEffect(() => {
    discoveryRequestIdRef.current += 1;
    setDiscoveryState({ phase: "idle" });
    setDiscoveryQuery("");
    setSelectedModelIds([]);
  }, [name, provider.baseUrl, provider.api, provider.apiKey]);

  const handleDiscoverModels = useCallback(async () => {
    if (!provider.baseUrl?.trim() || discoveryState.phase === "loading") return;
    const requestId = ++discoveryRequestIdRef.current;
    setDiscoveryState({ phase: "loading" });
    setSelectedModelIds([]);
    try {
      const res = await fetch("/api/models-config/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName: name, provider: { ...provider, models: undefined } }),
      });
      const data = await res.json() as { models?: DiscoveredModel[]; endpoint?: string; error?: string };
      if (requestId !== discoveryRequestIdRef.current) return;
      if (!res.ok || data.error || !data.models) {
        setDiscoveryState({ phase: "error", message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      setDiscoveryState({ phase: "success", models: data.models, endpoint: data.endpoint ?? provider.baseUrl });
    } catch (error) {
      if (requestId !== discoveryRequestIdRef.current) return;
      setDiscoveryState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [discoveryState.phase, name, provider]);

  const existingModelIds = new Set((provider.models ?? []).map((model) => model.id));
  const discoveredModels = discoveryState.phase === "success" ? discoveryState.models : [];
  const normalizedDiscoveryQuery = discoveryQuery.trim().toLocaleLowerCase();
  const filteredDiscoveredModels = discoveredModels.filter((model) => !normalizedDiscoveryQuery
    || model.id.toLocaleLowerCase().includes(normalizedDiscoveryQuery)
    || model.name?.toLocaleLowerCase().includes(normalizedDiscoveryQuery));
  const shownDiscoveredModels = filteredDiscoveredModels.slice(0, 300);
  const selectableShownIds = shownDiscoveredModels
    .filter((model) => !existingModelIds.has(model.id))
    .map((model) => model.id);
  const selectedCount = selectedModelIds.filter((id) => !existingModelIds.has(id)).length;
  const allShownSelected = selectableShownIds.length > 0
    && selectableShownIds.every((id) => selectedModelIds.includes(id));
  const someShownSelected = !allShownSelected
    && selectableShownIds.some((id) => selectedModelIds.includes(id));

  useEffect(() => {
    if (selectShownRef.current) selectShownRef.current.indeterminate = someShownSelected;
  }, [someShownSelected]);

  const toggleDiscoveredModel = (id: string) => {
    setSelectedModelIds((current) => current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id]);
  };

  const toggleShownModels = () => {
    const shownIds = new Set(selectableShownIds);
    setSelectedModelIds((current) => allShownSelected
      ? current.filter((id) => !shownIds.has(id))
      : Array.from(new Set([...current, ...selectableShownIds])));
  };

  const addSelectedModels = () => {
    if (discoveryState.phase !== "success") return;
    const selected = new Set(selectedModelIds);
    const additions = discoveryState.models.filter((model) => selected.has(model.id) && !existingModelIds.has(model.id));
    if (additions.length === 0) return;
    onAddModels(additions);
    setSelectedModelIds([]);
  };

  return (
    <div className={styles.connectionCard} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className={styles.connectionHeader} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
         <div className={styles.connectionTitle}><AliIcon name="api" size={21} /><span>{name}</span></div>
        <button onClick={async () => {
          if (await requestConfirmation({ title: t("i18n.delete"), message: t("models.deleteProviderConfirm", { name }), confirmLabel: t("i18n.delete"), tone: "danger" })) onDelete();
        }}
          style={{ padding: "3px 8px", background: "none", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 4, color: "#ef4444", cursor: "pointer", fontSize: "var(--text-xs)" }}>
           {t("i18n.delete")}
        </button>
      </div>

       <Field label={t("models.ui.providerName")}>
        <TextInput value={editingName} onChange={setEditingName} placeholder="provider-name" mono />
        {editingName !== name && editingName.trim() && (
          <button onClick={() => onRename(editingName.trim())}
            style={{ marginTop: 4, padding: "3px 10px", background: "var(--accent)", border: "none", borderRadius: 4, color: "#fff", cursor: "pointer", fontSize: "var(--text-xs)", alignSelf: "flex-start" }}>
             {t("i18n.rename")}
          </button>
        )}
      </Field>

      <Field label={t("models.form.endpoint")}>
        <TextInput value={provider.baseUrl ?? ""} onChange={(v) => set("baseUrl", v || undefined)}
          placeholder="https://api.example.com/v1" mono />
      </Field>

      <Field label={t("models.form.secretKey")}>
        <SecretTextInput value={provider.apiKey ?? ""} onChange={(v) => set("apiKey", v || undefined)}
          placeholder={t("models.form.keyHint")} mono />
        <span style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginTop: 2 }}>
          {t("models.form.secretHint")}
        </span>
      </Field>

      <Field label={t("models.form.protocol")}>
        <Select value={provider.api ?? "openai-completions"} onChange={(v) => set("api", v)} options={API_OPTIONS} required />
      </Field>

      <div className={styles.connectionActions}>
        <button className={styles.testConnection} disabled={!provider.models?.some(model => model.id.trim()) || connectionTest.phase === "testing"} title={!provider.models?.some(model => model.id.trim()) ? t("models.ui.testNeedsModel") : undefined} onClick={() => void testConnection()}><AliIcon name="link" size={16} />{connectionTest.phase === "testing" ? t("i18n.checking") : t("models.ui.testConnection")}</button>
        <button className={styles.testConnection} onClick={() => void handleDiscoverModels()} disabled={!provider.baseUrl?.trim() || discoveryState.phase === "loading"}><AliIcon name="download" size={15} />{discoveryState.phase === "loading" ? t("models.discoveryFetching") : t("models.discoveryFetch")}</button>
        {connectionTest.phase === "success" ? <span role="status" className={styles.connectionResult}>✓ {t("models.ui.connectionPassed")}{connectionTest.latencyMs != null ? ` · ${connectionTest.latencyMs} ms` : ""}</span> : null}
      </div>
      {connectionTest.phase === "error" ? <div role="alert"><ModelErrorText value={connectionTest.message} /></div> : null}
      <details className={styles.advanced} style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        <summary style={{ cursor: "pointer", color: "var(--text-muted)", fontSize: "var(--text-sm)", fontWeight: 600 }}>{t("models.advancedSettings")}</summary>
        <div style={{ paddingTop: 12 }}>
          <CompatOverridesEditor compat={provider.compat} onChange={(c) => set("compat", c)} />
        </div>
      </details>

      <div className={styles.importArea} style={{ borderTop: "1px solid var(--border)", paddingTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>

        {discoveryState.phase === "error" && (
          <div style={{ padding: "7px 9px", border: "1px solid rgba(239,68,68,0.3)", borderRadius: "var(--radius-control)", color: "#ef4444", fontSize: "var(--text-xs)", lineHeight: 1.4 }}>
            {<ModelErrorText value={discoveryState.message} />}
          </div>
        )}

        {discoveryState.phase === "success" && (
          <>
            <input
              value={discoveryQuery}
              onChange={(event) => setDiscoveryQuery(event.target.value)}
              placeholder={t("models.discoveryFilterPlaceholder", { count: discoveryState.models.length })}
              aria-label={t("models.discoveryFilter")}
              style={{ ...inputStyle, width: "100%", minWidth: 0 }}
            />

            <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "var(--bg-panel)" }}>
              <label
                style={{
                  minHeight: 32, padding: "5px 9px", display: "flex", alignItems: "center", gap: 8,
                  position: "sticky", top: 0, zIndex: 1, borderBottom: "1px solid var(--border)",
                  background: "var(--bg)", cursor: selectableShownIds.length ? "pointer" : "default",
                  color: "var(--text-muted)", fontSize: "var(--text-xs)", fontWeight: 600,
                }}
              >
                <input
                  ref={selectShownRef}
                  type="checkbox"
                  checked={allShownSelected}
                  disabled={selectableShownIds.length === 0}
                  onChange={toggleShownModels}
                  style={{ width: 13, height: 13, accentColor: "var(--accent)", flexShrink: 0 }}
                />
                {t("models.discoverySelectShown")}
              </label>
              {shownDiscoveredModels.length === 0 ? (
                <div style={{ padding: 12, color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>{t("models.discoveryNoMatches")}</div>
              ) : shownDiscoveredModels.map((model, index) => {
                const alreadyAdded = existingModelIds.has(model.id);
                const checked = selectedModelIds.includes(model.id);
                return (
                  <label
                    key={model.id}
                    style={{
                      minHeight: 36, padding: "6px 9px", display: "flex", alignItems: "center", gap: 8,
                      borderTop: index === 0 ? "none" : "1px solid var(--border)", cursor: alreadyAdded ? "default" : "pointer",
                      opacity: alreadyAdded ? 0.65 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked || alreadyAdded}
                      disabled={alreadyAdded}
                      onChange={() => toggleDiscoveredModel(model.id)}
                      style={{ width: 13, height: 13, accentColor: "var(--accent)", flexShrink: 0 }}
                    />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: "var(--text-xs)" }}>{model.name ?? model.id}</span>
                      {model.name && <code style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)" }}>{model.id}</code>}
                    </span>
                    {alreadyAdded && <span style={{ color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>{t("models.discoveryAdded")}</span>}
                  </label>
                );
              })}
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span title={discoveryState.endpoint} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: "var(--text-xs)" }}>
                {filteredDiscoveredModels.length > shownDiscoveredModels.length
                  ? t("models.discoveryShowing", { shown: shownDiscoveredModels.length, total: filteredDiscoveredModels.length })
                  : t("models.discoveryFetched", { count: discoveryState.models.length })}
              </span>
              <button
                onClick={addSelectedModels}
                disabled={selectedCount === 0}
                style={{ height: 28, padding: "0 11px", border: "none", borderRadius: "var(--radius-control)", background: selectedCount ? "var(--accent)" : "var(--bg-panel)", color: selectedCount ? "#fff" : "var(--text-dim)", cursor: selectedCount ? "pointer" : "not-allowed", fontSize: "var(--text-xs)", fontWeight: 600, whiteSpace: "nowrap" }}
              >
                {selectedCount
                  ? t("models.discoveryAddSelectedCount", { count: selectedCount })
                  : t("models.discoveryAddSelected")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── ThinkingLevelMap editor ───────────────────────────────────────────────────

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];
const THINKING_LABELS = { off: "chat.thinkingLevelOff", minimal: "chat.thinkingLevelMinimal", low: "chat.thinkingLevelLow", medium: "chat.thinkingLevelMedium", high: "chat.thinkingLevelHigh", xhigh: "chat.thinkingLevelXhigh", max: "chat.thinkingLevelMax" } as const;

const LEVEL_COLORS: Record<ThinkingLevel, string> = {
  off:     "var(--text-dim)",
  minimal: "#6b7280",
  low:     "#60a5fa",
  medium:  "#a78bfa",
  high:    "#f472b6",
  xhigh:   "#fb923c",
  max:     "#ef4444",
};

function ThinkingLevelMapEditor({
  value,
  onChange,
}: {
  value: Record<string, string | null> | undefined;
  onChange: (v: Record<string, string | null> | undefined) => void;
}) {
  const { t } = useI18n();
  const map = value ?? {};

  const setLevel = (level: ThinkingLevel, entry: string | null | "omit") => {
    const next = { ...map };
    if (entry === "omit") {
      delete next[level];
    } else {
      next[level] = entry;
    }
    onChange(Object.keys(next).length ? next : undefined);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {THINKING_LEVELS.map((level) => {
        const raw = map[level];
        const state: "omit" | "null" | "string" =
          !(level in map) ? "omit" : raw === null ? "null" : "string";
        const strVal = typeof raw === "string" ? raw : "";
        const color = LEVEL_COLORS[level];

        const btnBase: React.CSSProperties = {
          padding: "4px 10px",
          fontSize: "var(--text-xs)",
          border: "none",
          cursor: "pointer",
          fontWeight: 400,
          transition: "background 0.1s, color 0.1s",
          whiteSpace: "nowrap",
          background: "var(--bg-panel)",
          color: "var(--text-dim)",
        };
        const btnActive: React.CSSProperties = {
          background: "var(--accent)",
          color: "#fff",
          fontWeight: 600,
        };
        const btnActiveDisabled: React.CSSProperties = {
          background: "#ef4444",
          color: "#fff",
          fontWeight: 600,
        };

        return (
          <div
            key={level}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 4px",
              borderRadius: "var(--radius-control)",
              background: "transparent",
              border: "1px solid transparent",
            }}
          >
            {/* Level badge */}
            <div style={{ display: "flex", alignItems: "center", gap: 5, width: 68, flexShrink: 0 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0, opacity: state === "null" ? 0.3 : 1 }} />
              <span style={{
                fontSize: "var(--text-xs)",
                fontFamily: "var(--font-mono)",
                color: state === "null" ? "var(--text-dim)" : "var(--text-muted)",
                textDecoration: state === "null" ? "line-through" : "none",
              }}>
                {t(THINKING_LABELS[level])}
              </span>
            </div>

            {/* Default + Disabled buttons */}
            <div style={{ display: "flex", borderRadius: "var(--radius-control)", border: "1px solid var(--border)", overflow: "hidden", flexShrink: 0 }}>
              <button
                onClick={() => setLevel(level, "omit")}
                style={{ ...btnBase, ...(state === "omit" ? btnActive : {}) }}
              >
                {t("i18n.default")}
              </button>
              <button
                onClick={() => setLevel(level, null)}
                style={{ ...btnBase, borderLeft: "1px solid var(--border)", ...(state === "null" ? btnActiveDisabled : {}) }}
              >
                {t("i18n.disabled")}
              </button>
            </div>

            {/* Custom button + input fused */}
            <div style={{ display: "flex", borderRadius: "var(--radius-control)", border: `1px solid ${state === "string" ? "var(--accent)" : "var(--border)"}`, overflow: "hidden", transition: "border-color 0.1s" }}>
              <button
                onClick={() => setLevel(level, strVal || level)}
                style={{ ...btnBase, ...(state === "string" ? btnActive : {}), borderRight: "1px solid var(--border)", flexShrink: 0 }}
              >
                {t("i18n.custom")}
              </button>
              <input
                value={strVal}
                onChange={(e) => setLevel(level, e.target.value)}
                onFocus={() => { if (state !== "string") setLevel(level, strVal || level); }}
                placeholder={level}
                maxLength={10}
                style={{
                  width: "12ch",
                  background: state === "string" ? "var(--bg)" : "var(--bg-panel)",
                  border: "none",
                  outline: "none",
                  color: state === "string" ? "var(--text)" : "var(--text-dim)",
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-xs)",
                  padding: "4px 7px",
                  transition: "background 0.1s, color 0.1s",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Model detail ──────────────────────────────────────────────────────────────

const DEEPSEEK_COMPAT = {
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
} as const;

function hasDeepseekCompat(model: ModelEntry): boolean {
  return model.compat?.thinkingFormat === "deepseek";
}

function setDeepseekCompat(model: ModelEntry, enabled: boolean): ModelEntry {
  if (enabled) {
    return { ...model, compat: { ...(model.compat ?? {}), ...DEEPSEEK_COMPAT } };
  }
  if (!model.compat) return model;
  const rest = { ...model.compat };
  delete rest.thinkingFormat;
  delete rest.requiresReasoningContentOnAssistantMessages;
  return { ...model, compat: Object.keys(rest).length ? rest : undefined };
}

// Strict OpenAI-compatible servers (vLLM, llama.cpp, one-api gateways) often
// reject fields the auto-detected compat sends, and the compaction summarizer
// talks to the same endpoint — a rejected summary request means auto-compaction
// never persists. These overrides let users strip the problematic fields.
const COMPAT_TOGGLE_KEYS = ["supportsReasoningEffort", "supportsStore"] as const;
const MAX_TOKENS_FIELD_VALUES = ["max_tokens", "max_completion_tokens"] as const;

function CompatOverridesEditor({ compat, inherited, onChange }: {
  compat?: Record<string, unknown>;
  /** Channel-level values the model falls back to when it sets no override. */
  inherited?: Record<string, unknown>;
  onChange: (compat: Record<string, unknown> | undefined) => void;
}) {
  const { t } = useI18n();
  const effective = (key: string) => compat?.[key] ?? inherited?.[key];
  // Setting a value equal to what the channel already provides clears the
  // per-model override, so later channel-level edits keep applying to it.
  const setOverride = (key: string, value: unknown) => {
    const next = { ...compat };
    if (value === undefined || (inherited && inherited[key] === value)) {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange(Object.keys(next).length ? next : undefined);
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        {COMPAT_TOGGLE_KEYS.map((key) => {
          const checked = effective(key) !== false;
          return (
            <Check
              key={key}
              label={key === "supportsReasoningEffort" ? t("models.compatReasoningEffort") : t("models.compatStoreField")}
              checked={checked}
              onChange={(v) => setOverride(key, v === checked ? undefined : v)}
            />
          );
        })}
        <Field label={t("models.compatMaxTokensField")}>
          <Select
            value={typeof effective("maxTokensField") === "string" ? String(effective("maxTokensField")) : ""}
            onChange={(v) => setOverride("maxTokensField", v || undefined)}
            options={[...MAX_TOKENS_FIELD_VALUES]}
          />
        </Field>
      </div>
      <p style={{ margin: "6px 0 0", color: "var(--text-dim)", fontSize: "var(--text-xs)", lineHeight: 1.5 }}>
        {inherited ? t("models.compatModelHint") : t("models.compatProviderHint")}
      </p>
    </div>
  );
}

function fillEmptyModelFields(
  model: ModelEntry,
  preset: ModelCatalogPreset,
): { model: ModelEntry; appliedCount: number } {
  const next = { ...model };
  let appliedCount = 0;
  if (!model.name?.trim() && preset.name) {
    next.name = preset.name;
    appliedCount += 1;
  }
  if (model.reasoning === undefined && preset.reasoning === true) {
    next.reasoning = true;
    appliedCount += 1;
  }
  if (!model.input?.length && preset.input?.length) {
    next.input = [...preset.input];
    appliedCount += 1;
  }
  if (model.contextWindow === undefined && preset.contextWindow !== undefined) {
    next.contextWindow = preset.contextWindow;
    appliedCount += 1;
  }
  if (model.maxTokens === undefined && preset.maxTokens !== undefined) {
    next.maxTokens = preset.maxTokens;
    appliedCount += 1;
  }

  if (preset.cost) {
    const cost = { ...(model.cost ?? {}) };
    let costChanged = false;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      if (cost[key] === undefined && preset.cost[key] !== undefined) {
        cost[key] = preset.cost[key];
        costChanged = true;
        appliedCount += 1;
      }
    }
    if (costChanged) next.cost = cost;
  }
  return { model: next, appliedCount };
}

function ModelDetail({
  providerName,
  provider,
  model,
  onChange,
  onDelete,
}: {
  providerName: string;
  provider: ProviderEntry;
  model: ModelEntry;
  onChange: (m: ModelEntry) => void;
  onDelete: () => void;
}) {
  const [testState, setTestState] = useState<ModelTestState>({ phase: "idle" });
  const { t } = useI18n();
  const [catalogState, setCatalogState] = useState<ModelCatalogState>({ phase: "idle" });
  const catalogRequestIdRef = useRef(0);
  const catalogUndoRef = useRef<ModelEntry | null>(null);
  const set = <K extends keyof ModelEntry>(k: K, v: ModelEntry[K]) => onChange({ ...model, [k]: v });
  const costVal = (k: keyof NonNullable<ModelEntry["cost"]>) => model.cost?.[k] !== undefined ? String(model.cost[k]) : "";
  const setCost = (k: keyof NonNullable<ModelEntry["cost"]>, v: string) => {
    const n = parseFloat(v);
    onChange({ ...model, cost: { ...(model.cost ?? {}), [k]: isNaN(n) ? undefined : n } });
  };
  const testSummary = (() => {
    if (testState.phase === "idle") return null;
     if (testState.phase === "testing") return t("i18n.testingModel");
    const meta = [
      testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
      testState.status !== undefined ? `HTTP ${testState.status}` : null,
    ].filter(Boolean);
    if (testState.phase === "success") {
       return [t("i18n.connected"), ...meta, testState.responseText || null].filter(Boolean).join(" · ");
    }
     return [t("i18n.failed"), ...meta, testState.message].filter(Boolean).join(" · ");
  })();

  useEffect(() => {
    setTestState({ phase: "idle" });
  }, [providerName, provider.baseUrl, provider.api, provider.apiKey, model.id, model.api]);

  useEffect(() => {
    catalogRequestIdRef.current += 1;
    setCatalogState({ phase: "idle" });
    catalogUndoRef.current = null;
  }, [providerName, provider.baseUrl, model.id]);

  const handleTest = useCallback(async () => {
    if (!model.id.trim() || testState.phase === "testing") return;
    setTestState({ phase: "testing" });
    try {
      const res = await fetch("/api/models-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerName, provider, model }),
      });
      const d = await res.json() as {
        ok?: boolean;
        error?: string;
        latencyMs?: number;
        status?: number;
        responseText?: string;
      };
      if (!res.ok || !d.ok) {
        setTestState({
          phase: "error",
          message: d.error ?? `HTTP ${res.status}`,
          latencyMs: d.latencyMs,
          status: d.status,
        });
        return;
      }
      setTestState({
        phase: "success",
        latencyMs: d.latencyMs,
        status: d.status,
        responseText: d.responseText,
      });
    } catch (e) {
      setTestState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [model, provider, providerName, testState.phase]);

  const handleCatalogFill = useCallback(async () => {
    const query = model.id.trim();
    if (!query || catalogState.phase === "loading") return;
    const requestId = ++catalogRequestIdRef.current;
    setCatalogState({ phase: "loading" });
    try {
      const params = new URLSearchParams({ q: query, provider: providerName, limit: "50" });
      if (provider.baseUrl?.trim()) params.set("baseUrl", provider.baseUrl.trim());
      const res = await fetch(`/api/models-config/catalog?${params}`);
      const data = await res.json() as { recommendation?: ModelCatalogRecommendation; error?: string };
      if (requestId !== catalogRequestIdRef.current) return;
      if (!res.ok || data.error || !data.recommendation) {
        setCatalogState({ phase: "error", message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      const filled = fillEmptyModelFields(model, data.recommendation.preset);
      if (filled.appliedCount > 0) {
        catalogUndoRef.current = model;
        onChange(filled.model);
      }
      setCatalogState({
        phase: "success",
        recommendation: data.recommendation,
        appliedCount: filled.appliedCount,
      });
    } catch (error) {
      if (requestId !== catalogRequestIdRef.current) return;
      setCatalogState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [catalogState.phase, model, onChange, provider.baseUrl, providerName]);

  const undoCatalogFill = () => {
    const previous = catalogUndoRef.current;
    if (!previous) return;
    catalogUndoRef.current = null;
    onChange(previous);
    setCatalogState({ phase: "idle" });
  };

  const catalogResultSummary = (() => {
    if (catalogState.phase !== "success") return null;
    const { recommendation, appliedCount } = catalogState;
    const applied = appliedCount > 0
      ? t("models.catalogFilled", { count: appliedCount })
      : t("models.catalogNoEmptyFields");
    if (recommendation.price.status === "unreliable") {
      const price = recommendation.price.reason === "no-exact-match"
        ? t("models.catalogNoExactMatch")
        : t("models.catalogPriceUnreliable");
      return `${applied} · ${price}`;
    }
    const price = recommendation.price.method === "provider"
      ? t("models.catalogPriceProvider", { provider: recommendation.price.providerName ?? recommendation.price.providerId ?? providerName })
      : recommendation.price.method === "base-url"
        ? t("models.catalogPriceBaseUrl", { provider: recommendation.price.providerName ?? recommendation.price.providerId ?? providerName })
        : t("models.catalogPriceConsensus", {
            support: recommendation.price.support,
            total: recommendation.price.total,
          });
    return `${applied} · ${price}`;
  })();
  const catalogStatusText = catalogState.phase === "error"
    ? catalogState.message
    : catalogResultSummary;
  const catalogStatusColor = catalogState.phase === "error"
    ? "#ef4444"
    : catalogState.phase === "success" && catalogState.recommendation.price.status === "unreliable"
      ? "#d97706"
      : "var(--text-dim)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
         <SectionTitle>{t("i18n.model")}</SectionTitle>
        <button onClick={onDelete}
          style={{ height: 24, padding: "0 8px", background: "none", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 4, color: "#ef4444", cursor: "pointer", fontSize: "var(--text-xs)", boxSizing: "border-box" }}>
           {t("i18n.remove")}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label={t("models.form.modelId")}><TextInput value={model.id} onChange={(v) => set("id", v)} placeholder="model-id" mono /></Field>
        <Field label={t("models.form.name")}><TextInput value={model.name ?? ""} onChange={(v) => set("name", v || undefined)} placeholder={t("models.form.displayName")} /></Field>
      </div>

      <div data-draft-model-test-actions style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 30 }}>
        <button
          type="button"
          onClick={() => void handleTest()}
          disabled={!model.id.trim() || testState.phase === "testing"}
          title={model.id.trim() ? t("i18n.testConnection") : t("models.testRequiresId")}
          aria-label={t("i18n.testConnection")}
          style={{
            height: 30,
            padding: "0 11px",
            background: testState.phase === "success" ? "#16a34a" : "var(--bg-panel)",
            border: `1px solid ${testState.phase === "success" ? "#16a34a" : "var(--border)"}`,
            borderRadius: "var(--radius-control)",
            color: testState.phase === "success" ? "#fff" : (!model.id.trim() || testState.phase === "testing") ? "var(--text-dim)" : "var(--text-muted)",
            cursor: (!model.id.trim() || testState.phase === "testing") ? "not-allowed" : "pointer",
            fontSize: "var(--text-xs)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            boxSizing: "border-box",
            gap: 5,
            flexShrink: 0,
          }}
        >
          {testState.phase === "success" && <AliIcon name="check" size={11} />}
          {testState.phase === "testing"
            ? t("i18n.checking")
            : testState.phase === "success"
              ? t("common.ok")
              : t("i18n.testConnection")}
        </button>
        {testSummary && (
          <span
            title={testSummary}
            aria-live="polite"
            style={{
              minWidth: 0,
              maxWidth: 420,
              height: 30,
              padding: "0 9px",
              border: `1px solid ${testState.phase === "error" ? "#fecaca" : testState.phase === "success" ? "#bbf7d0" : "var(--border)"}`,
              borderRadius: "var(--radius-control)",
              background: testState.phase === "error" ? "#fee2e2" : testState.phase === "success" ? "#dcfce7" : "#e5e7eb",
              color: "#111827",
              fontSize: "var(--text-xs)",
              display: "inline-flex",
              alignItems: "center",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              boxSizing: "border-box",
            }}
          >
            {testState.phase === "error" ? <ModelErrorText value={testSummary} /> : testSummary}
          </span>
        )}
      </div>

      <div style={{ padding: "10px 0", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => void handleCatalogFill()}
            disabled={!model.id.trim() || catalogState.phase === "loading"}
            style={{
              height: 28, padding: "0 10px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)",
              background: "var(--bg-panel)",
              color: !model.id.trim() || catalogState.phase === "loading" ? "var(--text-dim)" : "var(--text-muted)",
              cursor: !model.id.trim() || catalogState.phase === "loading" ? "not-allowed" : "pointer",
              fontSize: "var(--text-xs)",
            }}
          >
            {catalogState.phase === "loading" ? t("models.catalogFilling") : t("models.catalogFill")}
          </button>
          <a
            href="https://github.com/anomalyco/models.dev"
            target="_blank"
            rel="noreferrer"
            style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: "var(--text-xs)", textDecoration: "none" }}
          >
            {t("models.catalogSource")}
          </a>
        </div>

        <div
          aria-live="polite"
          style={{
            marginTop: 6, height: 20, display: "flex", alignItems: "center",
            justifyContent: "space-between", gap: 8, color: catalogStatusColor, fontSize: "var(--text-xs)",
          }}
        >
          <span
            title={catalogStatusText ?? undefined}
            style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {catalogState.phase === "error" ? <ModelErrorText value={catalogStatusText ?? ""} /> : catalogStatusText}
          </span>
          {catalogUndoRef.current && (
            <button
              onClick={undoCatalogFill}
              style={{ flexShrink: 0, padding: "0 2px", border: "none", background: "none", color: "var(--accent)", cursor: "pointer", fontSize: "var(--text-xs)" }}
            >
              {t("models.catalogUndo")}
            </button>
          )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
        <Check label={t("models.form.imageInput")} checked={model.input?.includes("image") ?? false}
          onChange={(v) => set("input", v ? ["text", "image"] : undefined)} />
      </div>
      <p style={{ margin: "-8px 0 0", color: "var(--text-dim)", fontSize: "var(--text-xs)", lineHeight: 1.5 }}>
        {t("models.form.customImageHint")}
      </p>

      <details style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
        <summary style={{ cursor: "pointer", color: "var(--text-muted)", fontSize: "var(--text-sm)", fontWeight: 600 }}>{t("models.advancedSettings")}</summary>
        <div style={{ paddingTop: 14, display: "flex", flexDirection: "column", gap: 16 }}>
          <Field label={t("models.form.apiOverride")}>
            <Select value={model.api ?? ""} onChange={(v) => set("api", v || undefined)} options={API_OPTIONS} />
          </Field>

          <Check label={t("models.form.reasoning")} checked={model.reasoning ?? false} onChange={(v) => set("reasoning", v || undefined)} />

          {model.reasoning && (
        <>
          <Check
            label={t("models.form.deepseek")}
            checked={hasDeepseekCompat(model)}
            onChange={(v) => onChange(setDeepseekCompat(model, v))}
          />
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <SectionTitle>{t("models.form.thinkingMap")}</SectionTitle>
              {model.thinkingLevelMap && (
                <button
                  onClick={() => set("thinkingLevelMap", undefined)}
                  style={{ fontSize: "var(--text-xs)", padding: "2px 7px", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-dim)", cursor: "pointer" }}
                >
                  {t("i18n.clearAll")}
                </button>
              )}
            </div>
            <ThinkingLevelMapEditor
              value={model.thinkingLevelMap}
              onChange={(v) => set("thinkingLevelMap", v)}
            />
          </div>
        </>
          )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label={t("models.form.contextWindow")}>
          <NumInput value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
            onChange={(v) => set("contextWindow", v ? parseInt(v) : undefined)} placeholder="128000" />
        </Field>
        <Field label={t("models.form.maxTokens")}>
          <NumInput value={model.maxTokens !== undefined ? String(model.maxTokens) : ""}
            onChange={(v) => set("maxTokens", v ? parseInt(v) : undefined)} placeholder="16384" />
        </Field>
      </div>
      <p style={{ margin: "-8px 0 0", color: "var(--text-dim)", fontSize: "var(--text-xs)", lineHeight: 1.5 }}>
        自定义模型不填时默认上下文 128000、最大输出 16384。每轮回复的实际上限 = min(最大输出，上下文 − 当前上下文估算 − 4096)，因此声明值必须与真实服务一致：上下文声明得比实际大，回复会被服务的真实上限截断；声明得太小，则会频繁触发自动压缩。自动压缩也按声明的上下文计算触发时机。
      </p>

          {(model.api ?? provider.api ?? "openai-completions") === "openai-completions" && (
            <div>
              <SectionTitle>{t("models.compatSection")}</SectionTitle>
              <div style={{ marginTop: 8 }}>
                <CompatOverridesEditor
                  compat={model.compat}
                  inherited={provider.compat}
                  onChange={(compat) => set("compat", compat)}
                />
              </div>
            </div>
          )}

      <div>
        <SectionTitle>{t("models.form.cost")}</SectionTitle>
        <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
          {(["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => (
            <Field key={k} label={t(`models.form.cost.${k}`)}>
              <NumInput value={costVal(k)} onChange={(v) => setCost(k, v)} placeholder="0" />
            </Field>
          ))}
        </div>
      </div>
        </div>
      </details>
    </div>
  );
}

// ── OAuth detail ──────────────────────────────────────────────────────────────

function OAuthDetail({ provider, onRefresh }: { provider: OAuthProvider; onRefresh: () => void }) {
  const [loginState, setLoginState] = useState<OAuthLoginState>({ phase: "idle" });
  const { t } = useI18n();
  const [inputValue, setInputValue] = useState("");
  const eventSourceRef = useRef<EventSource | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (loginState.phase === "auth" || loginState.phase === "prompt") {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [loginState.phase]);

  // Reset state when provider changes
  useEffect(() => {
    setLoginState({ phase: "idle" });
    setInputValue("");
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, [provider.id]);

  useEffect(() => {
    return () => { eventSourceRef.current?.close(); };
  }, []);

  const handleLogin = useCallback(() => {
    eventSourceRef.current?.close();
    setLoginState({ phase: "connecting" });
    setInputValue("");

    const es = new EventSource(`/api/auth/login/${encodeURIComponent(provider.id)}`);
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data) as {
        type: string; url?: string; instructions?: string | null;
        token?: string; message?: string; placeholder?: string | null;
        userCode?: string; verificationUri?: string; intervalSeconds?: number | null; expiresInSeconds?: number | null;
        options?: { id: string; label: string }[];
      };
      if (data.type === "auth") {
        setLoginState({ phase: "auth", url: data.url!, instructions: data.instructions ?? null, token: data.token! });
        window.open(data.url!, "_blank", "noopener,noreferrer");
      } else if (data.type === "device_code") {
        setLoginState({
          phase: "device_code",
          userCode: data.userCode!,
          verificationUri: data.verificationUri!,
          intervalSeconds: data.intervalSeconds ?? null,
          expiresInSeconds: data.expiresInSeconds ?? null,
        });
        window.open(data.verificationUri!, "_blank", "noopener,noreferrer");
      } else if (data.type === "prompt_request") {
        setLoginState({ phase: "prompt", message: data.message!, placeholder: data.placeholder ?? null, token: data.token! });
      } else if (data.type === "select_request") {
        setLoginState({ phase: "select", message: data.message!, options: data.options ?? [], token: data.token! });
      } else if (data.type === "progress") {
        setLoginState({ phase: "progress", message: data.message! });
      } else if (data.type === "success") {
        es.close();
        setLoginState({ phase: "success" });
        onRefresh();
      } else if (data.type === "error") {
        es.close();
        setLoginState({ phase: "error", message: data.message! });
      } else if (data.type === "cancelled") {
        es.close();
        setLoginState({ phase: "idle" });
      }
    };
    es.onerror = () => {
      es.close();
      setLoginState((prev) => prev.phase === "success" ? prev : { phase: "error", message: "Connection lost" });
    };
  }, [provider.id, onRefresh]);

  const handleLogout = useCallback(async () => {
    await fetch(`/api/auth/logout/${encodeURIComponent(provider.id)}`, { method: "POST" });
    setLoginState({ phase: "idle" });
    onRefresh();
  }, [provider.id, onRefresh]);

  const submitCode = useCallback(async (token: string, code: string) => {
    if (!code.trim()) return;
    setLoginState({ phase: "progress", message: "Verifying…" });
    try {
      const res = await fetch(`/api/auth/login/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: code.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setLoginState({ phase: "error", message: d.error ?? `Server error ${res.status}` });
        return;
      }
      setInputValue("");
      // Success path: SSE stream will emit "success" and update state
    } catch (e) {
      setLoginState({ phase: "error", message: e instanceof Error ? e.message : "Network error" });
    }
  }, [provider.id]);

  const submitSelection = useCallback(async (token: string, value: string) => {
    setLoginState({ phase: "progress", message: "Continuing…" });
    try {
      const res = await fetch(`/api/auth/login/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: value }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setLoginState({ phase: "error", message: d.error ?? `Server error ${res.status}` });
      }
    } catch (e) {
      setLoginState({ phase: "error", message: e instanceof Error ? e.message : "Network error" });
    }
  }, [provider.id]);

  const isWorking = loginState.phase === "connecting" || loginState.phase === "progress" ||
    loginState.phase === "auth" || loginState.phase === "device_code" ||
    loginState.phase === "prompt" || loginState.phase === "select";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
           <SectionTitle>{t("i18n.subscription")}</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: provider.loggedIn ? "#4ade80" : "var(--border)", display: "inline-block" }} />
          <span style={{ fontSize: "var(--text-xs)", color: provider.loggedIn ? "#4ade80" : "var(--text-dim)" }}>
             {provider.loggedIn ? t("i18n.connected") : t("i18n.notConnected")}
          </span>
        </div>
      </div>

      {/* Status */}
      <div style={{ minHeight: 48 }}>
        {loginState.phase === "idle" && (
          <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-muted)", lineHeight: 1.5 }}>
             {provider.loggedIn ? t("models.oauthConnectedHint") : t("models.oauthConnectHint", { name: provider.name })}
          </p>
        )}
        {loginState.phase === "connecting" && (
            <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>{t("i18n.openingBrowser")}</p>
        )}
        {loginState.phase === "select" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-muted)", lineHeight: 1.5 }}>
              {loginState.message}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {loginState.options.map((option) => (
                <button
                  key={option.id}
                  onClick={() => submitSelection(loginState.token, option.id)}
                  style={{ padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", color: "var(--text)", cursor: "pointer", fontSize: "var(--text-sm)", textAlign: "left" }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {(loginState.phase === "auth" || loginState.phase === "prompt") && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-muted)", lineHeight: 1.5 }}>
              {loginState.phase === "auth"
                ? t("models.login.browserHint")
                : loginState.message}
            </p>
            {loginState.phase === "auth" && (
              <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-dim)", lineHeight: 1.5 }}>
                {t("models.login.notOpened")}
                <a href={loginState.url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", wordBreak: "break-all" }}>
                  {t("models.login.open")}
                </a>
                .
              </p>
            )}
            <div style={{ display: "flex", gap: 6 }}>
              <input
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submitCode(loginState.token, inputValue); }}
                placeholder={loginState.phase === "auth" ? "http://localhost:1455/auth/callback?code=…" : (loginState.placeholder ?? "Enter value…")}
                style={{ flex: 1, padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", color: "var(--text)", fontSize: "var(--text-sm)", outline: "none", fontFamily: "var(--font-mono)", boxSizing: "border-box" }}
              />
              <button
                onClick={() => submitCode(loginState.token, inputValue)}
                disabled={!inputValue.trim()}
                style={{ padding: "6px 12px", background: inputValue.trim() ? "var(--accent)" : "var(--bg-panel)", border: "none", borderRadius: "var(--radius-control)", color: inputValue.trim() ? "#fff" : "var(--text-dim)", cursor: inputValue.trim() ? "pointer" : "not-allowed", fontSize: "var(--text-sm)", fontWeight: 600, flexShrink: 0 }}
              >
                 {t("i18n.submit")}
              </button>
            </div>
          </div>
        )}
        {loginState.phase === "device_code" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-muted)", lineHeight: 1.5 }}>
              {t("models.login.codeHint")}
            </p>
            <div style={{ padding: "8px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", color: "var(--text)", fontSize: "var(--text-md)", fontWeight: 700, fontFamily: "var(--font-mono)", letterSpacing: 0 }}>
              {loginState.userCode}
            </div>
            <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-dim)", lineHeight: 1.5 }}>
              <a href={loginState.verificationUri} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", wordBreak: "break-all" }}>
                {loginState.verificationUri}
              </a>
              {loginState.expiresInSeconds ? ` Expires in ${Math.ceil(loginState.expiresInSeconds / 60)} minutes.` : ""}
            </p>
          </div>
        )}
        {loginState.phase === "progress" && (
          <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>{loginState.message}</p>
        )}
        {loginState.phase === "success" && (
             <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "#4ade80" }}>{t("i18n.connectedSuccessfully")}</p>
        )}
        {loginState.phase === "error" && (
          <div style={{ margin: 0, fontSize: "var(--text-sm)", color: "#f87171" }}><ModelErrorText value={loginState.message} /></div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8 }}>
        {isWorking ? (
          <button
            onClick={() => { eventSourceRef.current?.close(); setLoginState({ phase: "idle" }); }}
            style={{ padding: "5px 12px", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", color: "var(--text-muted)", cursor: "pointer", fontSize: "var(--text-sm)" }}
          >
             {t("i18n.cancel")}
          </button>
        ) : (
          <>
            <button
              onClick={handleLogin}
              style={{ padding: "5px 14px", background: "var(--accent)", border: "none", borderRadius: "var(--radius-control)", color: "#fff", cursor: "pointer", fontSize: "var(--text-sm)", fontWeight: 600 }}
            >
               {provider.loggedIn ? t("i18n.relogin") : t("i18n.login")}
            </button>
            {provider.loggedIn && (
              <button
                onClick={async () => {
                  if (!await requestConfirmation({ title: t("models.removeConfiguration"), message: t("models.removeCredentialConfirm", { name: provider.name }), confirmLabel: t("models.removeConfiguration"), tone: "danger" })) return;
                  void handleLogout();
                }}
                style={{ padding: "5px 12px", background: "none", border: "1px solid rgba(239,68,68,0.3)", borderRadius: "var(--radius-control)", color: "#ef4444", cursor: "pointer", fontSize: "var(--text-sm)" }}
              >
                 {t("models.removeConfiguration")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── API Key detail ────────────────────────────────────────────────────────────

function ApiKeyDetail({ provider, onRefresh }: { provider: ApiKeyProvider; onRefresh: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const { t } = useI18n();

  // Reset state when provider changes
  useEffect(() => {
    setApiKey("");
    setError(null);
    setSavedOk(false);
  }, [provider.id]);

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setError(d.error ?? `HTTP ${res.status}`);
      } else {
        setApiKey("");
        setSavedOk(true);
        setTimeout(() => setSavedOk(false), 2000);
        onRefresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [apiKey, provider.id, onRefresh]);

  const handleRemove = useCallback(async () => {
    setRemoving(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) setError(d.error ?? `HTTP ${res.status}`);
      else onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setRemoving(false);
    }
  }, [provider.id, onRefresh]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
         <SectionTitle>{t("models.form.secretKey")}</SectionTitle>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: provider.configured ? "#4ade80" : "var(--border)", display: "inline-block" }} />
          <span style={{ fontSize: "var(--text-xs)", color: provider.configured ? "#4ade80" : "var(--text-dim)" }}>
             {provider.configured ? t("i18n.configured") : t("i18n.notConfigured")}
          </span>
        </div>
      </div>

      <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-muted)", lineHeight: 1.5 }}>
        {provider.configured
          ? provider.canRemoveStoredCredential
            ? t("models.apiKeyStoredHint")
            : t("models.apiKeyExternalHint")
          : t("models.apiKeyConfigureHint", { name: provider.displayName, count: provider.modelCount })}
      </p>

      <Field label={t("models.form.secretKey")}>
        <div style={{ display: "flex", gap: 6 }}>
          <SecretTextInput
            value={apiKey}
            onChange={setApiKey}
            onKeyDown={(e) => { if (e.key === "Enter" && apiKey.trim()) handleSave(); }}
            placeholder={provider.configured ? "Enter new key to replace…" : "sk-…"}
            style={{ flex: 1 }}
            autoComplete="off"
            spellCheck={false}
            mono
          />
          <button
            onClick={handleSave}
            disabled={saving || !apiKey.trim() || savedOk}
            style={{
              padding: "6px 12px",
              background: savedOk ? "#16a34a" : apiKey.trim() ? "var(--accent)" : "var(--bg-panel)",
              border: "none", borderRadius: "var(--radius-control)",
              color: (apiKey.trim() || savedOk) ? "#fff" : "var(--text-dim)",
              cursor: (saving || !apiKey.trim() || savedOk) ? "not-allowed" : "pointer",
              fontSize: "var(--text-sm)", fontWeight: 600, flexShrink: 0,
              display: "flex", alignItems: "center", gap: 5,
            }}
          >
            {savedOk && (
              <AliIcon name="check" size={12} />
            )}
             {savedOk ? t("i18n.saved") : saving ? t("i18n.saving") : t("i18n.save")}
          </button>
        </div>
      </Field>

      {error && <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "#f87171" }}>{<ModelErrorText value={error} />}</p>}

      {provider.configured && provider.canRemoveStoredCredential && (
        <button
          onClick={async () => {
            if (!await requestConfirmation({ title: t("models.removeConfiguration"), message: t("models.removeCredentialConfirm", { name: provider.displayName }), confirmLabel: t("models.removeConfiguration"), tone: "danger" })) return;
            void handleRemove();
          }}
          disabled={removing}
          style={{
            alignSelf: "flex-start", padding: "5px 12px",
            background: "none", border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: "var(--radius-control)", color: "#ef4444",
            cursor: removing ? "not-allowed" : "pointer", fontSize: "var(--text-sm)",
          }}
        >
           {removing ? t("i18n.removing") : t("models.removeConfiguration")}
        </button>
      )}
      {provider.configured && !provider.canRemoveStoredCredential && (
        <p role="note" style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--text-dim)", lineHeight: 1.5 }}>
          {t("models.externalCredential")}
        </p>
      )}
    </div>
  );
}

// ── Add provider picker ───────────────────────────────────────────────────────

interface AddProviderPickerProps {
  oauthProviders: OAuthProvider[];
  apiKeyProviders: ApiKeyProvider[];
  hiddenProviders: { id: string; label: string }[];
  onSelectOAuth: (id: string) => void;
  onSelectApiKey: (id: string) => void;
  onRestoreProvider: (id: string) => Promise<boolean>;
  onAddCustom: () => void;
  onClose: () => void;
}

function AddProviderPicker({
  oauthProviders, apiKeyProviders, hiddenProviders,
  onSelectOAuth, onSelectApiKey, onRestoreProvider, onAddCustom, onClose,
}: AddProviderPickerProps) {
  const [search, setSearch] = useState("");
  const [restoringProvider, setRestoringProvider] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState(false);
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 30); }, []);

  const q = search.trim().toLowerCase();

  const availableOAuth = prioritizeProvider(
    oauthProviders.filter((p) => !p.loggedIn && (!q || p.name.toLowerCase().includes(q))),
    (provider) => provider.id,
  );
  const availableApiKey = prioritizeProvider(
    apiKeyProviders.filter((p) => !p.configured && (!q || p.displayName.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))),
    (provider) => provider.id,
  );
  const visibleHiddenProviders = prioritizeProvider(
    hiddenProviders.filter((provider) => !q || provider.label.toLowerCase().includes(q) || provider.id.toLowerCase().includes(q)),
    (provider) => provider.id,
  );
  const showCustom = !q || "custom".includes(q) || "openai-compatible".includes(q) || "anthropic-compatible".includes(q);

  const totalCount = visibleHiddenProviders.length + availableOAuth.length + availableApiKey.length + (showCustom ? 1 : 0);

  const cardStyle: React.CSSProperties = {
    display: "flex", flexDirection: "row", alignItems: "center", gap: 8,
    padding: "10px 12px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-control)",
    boxSizing: "border-box",
    cursor: "pointer",
    minWidth: 0,
    textAlign: "left",
    transition: "border-color 0.12s, background 0.12s",
    width: "100%",
  };



  return (
    <div
      className="app-shell-dialog-backdrop"
      style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="app-shell-dialog" style={{ width: 820, maxWidth: "calc(100vw - 32px)", maxHeight: "min(72vh, calc(100vh - 32px))", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.22)", overflow: "hidden" }}>
        {/* Search */}
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <AliIcon name="search" size={13} style={{ color: "var(--text-dim)" }} />
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
             placeholder={t("i18n.searchProviders")}
            style={{ flex: 1, background: "none", border: "none", outline: "none", color: "var(--text)", fontSize: "var(--text-base)", boxSizing: "border-box" }}
          />
        </div>

        {/* Card grid */}
        <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          {totalCount === 0 ? (
            <div style={{ padding: "20px 0", fontSize: "var(--text-sm)", color: "var(--text-dim)", textAlign: "center" }}>{t("i18n.noProviders")}</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))", gap: 8 }}>
              {visibleHiddenProviders.length > 0 && (
                <div style={{ gridColumn: "1 / -1", fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
                  {t("models.hiddenProviders")}
                </div>
              )}
              {visibleHiddenProviders.map((provider) => (
                <button
                  key={`hidden:${provider.id}`}
                  type="button"
                  disabled={restoringProvider !== null}
                  onClick={async () => {
                    setRestoreError(false);
                    setRestoringProvider(provider.id);
                    const restored = await onRestoreProvider(provider.id);
                    setRestoringProvider(null);
                    if (restored) onClose();
                    else setRestoreError(true);
                  }}
                  style={{ ...cardStyle, opacity: restoringProvider && restoringProvider !== provider.id ? 0.55 : 1 }}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{provider.label}</div>
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginTop: 2 }}>
                      {restoringProvider === provider.id ? t("models.restoringProvider") : t("models.restoreProvider")}
                    </div>
                  </div>
                  <ModelProviderIcon provider={provider.id} size={28} />
                </button>
              ))}
              {restoreError && (
                <div role="alert" style={{ gridColumn: "1 / -1", padding: "8px 10px", borderRadius: "var(--radius-control)", background: "rgba(239,68,68,0.08)", color: "#dc2626", fontSize: "var(--text-xs)" }}>
                  {t("models.restoreProviderFailed")}
                </div>
              )}

              {availableApiKey.length > 0 && (
                <div style={{ gridColumn: "1 / -1", paddingTop: visibleHiddenProviders.length > 0 ? 6 : 0, fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{t("models.form.secretKey")}</div>
              )}
              {availableApiKey.map((p) => (
                <button key={p.id} onClick={() => { onSelectApiKey(p.id); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.displayName}</div>
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginTop: 2 }}>{t("models.form.count", { count: p.modelCount })}</div>
                  </div>
                  <ModelProviderIcon provider={p.id} size={28} />
                </button>
              ))}

              {availableOAuth.length > 0 && (
                 <div style={{ gridColumn: "1 / -1", paddingTop: availableApiKey.length > 0 ? 6 : 0, fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{t("i18n.subscriptions")}</div>
              )}
              {availableOAuth.map((p) => (
                <button key={p.id} onClick={() => { onSelectOAuth(p.id); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginTop: 2 }}>{t("models.login.oauth")}</div>
                  </div>
                  <ModelProviderIcon provider={p.id} size={28} />
                </button>
              ))}

              {showCustom && (
                 <div style={{ gridColumn: "1 / -1", paddingTop: availableApiKey.length > 0 || availableOAuth.length > 0 ? 6 : 0, fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{t("i18n.custom")}</div>
              )}
              {showCustom && (
                <button
                  onClick={() => { onAddCustom(); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("models.form.compatible")}</div>
                     <div style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginTop: 2 }}>{t("i18n.customEndpoint")}</div>
                  </div>
                  <span style={{ width: 26, height: 26, borderRadius: "var(--radius-control)", background: "var(--bg-hover)", border: "1px dashed var(--border)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <AliIcon name="plus" size={13} style={{ color: "var(--text-dim)" }} />
                  </span>
                </button>
              )}

            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ModelsConfig({
  cwd,
  onClose,
  onModelsChanged,
  embedded = false,
}: {
  cwd?: string;
  onClose: () => void;
  onModelsChanged?: () => void;
  embedded?: boolean;
}) {
  const isMobile = useIsMobile();
  const { t } = useI18n();
  const [config, setConfig] = useState<ModelsJson>({ providers: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detailTab, setDetailTab] = useState<"connection" | "models">("connection");
  useEffect(() => setDetailTab("connection"), [selection]);
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [apiKeyProviders, setApiKeyProviders] = useState<ApiKeyProvider[]>([]);
  const [oauthProvidersLoaded, setOauthProvidersLoaded] = useState(false);
  const [apiKeyProvidersLoaded, setApiKeyProvidersLoaded] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [modelScope, setModelScope] = useState<ModelScopeResponse | null>(null);
  const [modelScopeLoading, setModelScopeLoading] = useState(true);
  const [modelScopeError, setModelScopeError] = useState<string | null>(null);
  const [modelScopeBusyKey, setModelScopeBusyKey] = useState<string | null>(null);
  const [managedModelTests, setManagedModelTests] = useState<Record<string, ModelTestState>>({});
  const [modelImageInput, setModelImageInput] = useState<Record<string, boolean>>({});
  const [modelCapabilityBusyKey, setModelCapabilityBusyKey] = useState<string | null>(null);
  const modelScopeMutationRef = useRef(false);
  const persistedConfiguredModelKeysRef = useRef<Set<string>>(new Set());
  const configMutationRef = useRef(false);
  const persistedProviderNamesRef = useRef(new Map<string, string>());
  const persistedModelTargetsRef = useRef(new WeakMap<ModelEntry, ConfiguredModelRef>());
  const rememberPersistedConfig = useCallback((saved: ModelsJson) => {
    persistedProviderNamesRef.current = new Map();
    persistedModelTargetsRef.current = new WeakMap();
    for (const [provider, value] of Object.entries(saved.providers ?? {})) {
      persistedProviderNamesRef.current.set(provider, provider);
      for (const model of value.models ?? []) persistedModelTargetsRef.current.set(model, { provider, id: model.id });
    }
  }, []);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, !embedded, {
    onEscape: modelScopeBusyKey === null && !saving ? onClose : undefined,
  });

  const loadOAuthProviders = useCallback(() => {
    setOauthProvidersLoaded(false);
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then((d: { providers: OAuthProvider[] }) => setOauthProviders(d.providers))
      .catch(() => {})
      .finally(() => setOauthProvidersLoaded(true));
  }, []);

  const loadApiKeyProviders = useCallback(() => {
    setApiKeyProvidersLoaded(false);
    fetch("/api/auth/all-providers")
      .then((r) => r.json())
      .then((d: { providers: ApiKeyProvider[] }) => setApiKeyProviders(d.providers))
      .catch(() => {})
      .finally(() => setApiKeyProvidersLoaded(true));
  }, []);

  const loadModelScope = useCallback(async () => {
    setModelScopeLoading(true);
    setModelScopeError(null);
    try {
      const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const response = await fetch(`/api/models/scope${query}`);
      const body = await response.json() as ModelScopeResponse & { error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
      setModelScope(body);
    } catch (error) {
      setModelScope(null);
      setModelScopeError(error instanceof Error ? error.message : String(error));
    } finally {
      setModelScopeLoading(false);
    }
  }, [cwd]);

  const loadModelCapabilities = useCallback(async () => {
    try {
      const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      const response = await fetch(`/api/model-capabilities${query}`);
      const body = await response.json() as { imageInput?: Record<string, boolean>; error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
      setModelImageInput(body.imageInput ?? {});
    } catch {
      setModelImageInput({});
    }
  }, [cwd]);

  const updateModelImageInput = useCallback(async (model: ManagedModel, imageInput: boolean) => {
    const key = `${model.provider}/${model.id}`;
    setModelCapabilityBusyKey(key);
    try {
      const response = await fetch("/api/model-capabilities", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(cwd ? { cwd } : {}), provider: model.provider, id: model.id, imageInput }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
      setModelImageInput((current) => ({ ...current, [key]: imageInput }));
      onModelsChanged?.();
    } catch (error) {
      setModelScopeError(error instanceof Error ? error.message : String(error));
    } finally {
      setModelCapabilityBusyKey(null);
    }
  }, [cwd, onModelsChanged]);

  // A dual-auth provider moves between the two lists when its credential type
  // changes, so any auth change has to reload both — refreshing only one leaves
  // the provider rendered twice, and disconnecting the stale row would delete
  // the credential that was just created (#309).
  const refreshAuthProviders = useCallback(() => {
    loadOAuthProviders();
    loadApiKeyProviders();
  }, [loadOAuthProviders, loadApiKeyProviders]);

  useEffect(() => {
    fetch("/api/models-config")
      .then((r) => r.json())
      .then((d: ModelsJson) => {
        const normalized = d.providers ? d : { ...d, providers: {} };
        setConfig(normalized);
        rememberPersistedConfig(normalized);
        persistedConfiguredModelKeysRef.current = new Set(
          collectConfiguredModelRefs(normalized).map(configuredModelKey),
        );
      })
      .catch(() => setConfig({ providers: {} }))
      .finally(() => setLoading(false));
    refreshAuthProviders();
    void loadModelScope();
    void loadModelCapabilities();
  }, [loadModelCapabilities, loadModelScope, refreshAuthProviders, rememberPersistedConfig]);

  useEffect(() => {
    setManagedModelTests({});
  }, [cwd]);

  const addCustomProvider = useCallback(() => {
    let finalName = "new-provider";
    let n = 1;
    while (config.providers?.[finalName]) finalName = `new-provider-${n++}`;
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [finalName]: { api: "openai-completions" } } }));
    setSelection({ type: "provider", name: finalName });
  }, [config.providers]);

  const updateProvider = useCallback((name: string, p: ProviderEntry) => {
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [name]: p } }));
  }, []);

  const renameProvider = useCallback((oldName: string, newName: string) => {
    const persistedName = persistedProviderNamesRef.current.get(oldName);
    persistedProviderNamesRef.current.delete(oldName);
    if (persistedName) persistedProviderNamesRef.current.set(newName, persistedName);
    setConfig((prev) => {
      const entries = Object.entries(prev.providers ?? {});
      const idx = entries.findIndex(([k]) => k === oldName);
      if (idx === -1) return prev;
      entries[idx] = [newName, entries[idx][1]];
      return { ...prev, providers: Object.fromEntries(entries) };
    });
    setSelection((prev) => {
      if (!prev) return prev;
      if (prev.type === "provider" && prev.name === oldName) return { type: "provider", name: newName };
      if (prev.type === "model" && prev.providerName === oldName) return { ...prev, providerName: newName };
      return prev;
    });
  }, []);

  const persistDeletion = useCallback(async (target: { provider: string; id?: string } | undefined, apply: () => void) => {
    if (configMutationRef.current) return;
    configMutationRef.current = true;
    setSaving(true); setSaveError(null); setSavedOk(false);
    try {
      if (target) {
        const response = await fetch("/api/models-config", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(target) });
        const result = await response.json() as { success?: boolean; error?: string };
        if (!response.ok || !result.success) throw new Error(result.error ?? `HTTP ${response.status}`);
        for (const key of persistedConfiguredModelKeysRef.current) {
          if (target.id === undefined ? key.startsWith(`${target.provider}/`) : key === configuredModelKey({ provider: target.provider, id: target.id })) persistedConfiguredModelKeysRef.current.delete(key);
        }
      }
      apply(); setManagedModelTests({});
      if (target) { onModelsChanged?.(); refreshAuthProviders(); await loadModelScope(); }
    } catch (error) { setSaveError(error instanceof Error ? error.message : String(error)); }
    finally { configMutationRef.current = false; setSaving(false); }
  }, [loadModelScope, onModelsChanged, refreshAuthProviders]);

  const deleteProvider = useCallback((name: string) => {
    const provider = persistedProviderNamesRef.current.get(name);
    void persistDeletion(provider ? { provider } : undefined, () => {
      setConfig((prev) => { const providers = { ...(prev.providers ?? {}) }; delete providers[name]; return { ...prev, providers }; });
      persistedProviderNamesRef.current.delete(name); setSelection(null);
    });
  }, [persistDeletion]);

  const addModel = useCallback((providerName: string) => {
    const index = config.providers?.[providerName]?.models?.length ?? 0;
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? []), { id: "" }];
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
    setSelection({ type: "model", providerName, index });
  }, [config.providers]);

  const addDiscoveredModels = useCallback((providerName: string, discovered: DiscoveredModel[]) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      const existingIds = new Set(models.map((model) => model.id));
      for (const discoveredModel of discovered) {
        if (existingIds.has(discoveredModel.id)) continue;
        existingIds.add(discoveredModel.id);
        models.push({ id: discoveredModel.id, name: discoveredModel.name });
      }
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
  }, []);

  const updateModel = useCallback((providerName: string, index: number, m: ModelEntry) => {
    const previous = config.providers?.[providerName]?.models?.[index];
    const target = previous && persistedModelTargetsRef.current.get(previous);
    if (target) persistedModelTargetsRef.current.set(m, target);
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      models[index] = m;
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
  }, [config.providers]);

  const removeModel = useCallback((providerName: string, index: number) => {
    const model = config.providers?.[providerName]?.models?.[index];
    if (!model) return;
    void persistDeletion(persistedModelTargetsRef.current.get(model), () => {
      setConfig((prev) => {
        const provider = prev.providers?.[providerName] ?? {};
        const models = (provider.models ?? []).filter(entry => entry !== model);
        return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models: models.length ? models : undefined } } };
      });
      setSelection({ type: "provider", name: providerName });
    });
  }, [config.providers, persistDeletion]);

  const updateModelScope = useCallback(async (
    action: "hide" | "restore" | "hide-provider" | "restore-provider" | "restore-all",
    target?: Pick<ManagedModel, "provider" | "id"> | { provider: string },
  ): Promise<boolean> => {
    if (modelScopeMutationRef.current) return false;
    modelScopeMutationRef.current = true;
    const busyKey = action === "restore-all"
      ? "restore-all"
      : `${action}:${target?.provider ?? ""}${"id" in (target ?? {}) ? `/${(target as Pick<ManagedModel, "id">).id}` : ""}`;
    setModelScopeBusyKey(busyKey);
    setModelScopeError(null);
    try {
      const response = await fetch("/api/models/scope", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(cwd ? { cwd } : {}),
          action,
          ...(target ?? {}),
        }),
      });
      const body = await response.json() as ModelScopeResponse & { code?: string; error?: string };
      if (!response.ok || body.error) {
        const message = body.code === "last_model"
          ? t("models.lastVisibleModel")
          : body.code === "project_scope_override"
            ? t("models.projectScopeOverride")
            : body.error ?? `HTTP ${response.status}`;
        throw new Error(message);
      }
      setModelScope(body);
      if (
        (action === "hide" || action === "hide-provider")
        && target?.provider
        && body.models.some((model) => model.provider === target.provider)
        && body.models.filter((model) => model.provider === target.provider).every((model) => !model.enabled)
      ) {
        setSelection(null);
      }
      if (body.changed) onModelsChanged?.();
      return true;
    } catch (error) {
      setModelScopeError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      modelScopeMutationRef.current = false;
      setModelScopeBusyKey(null);
    }
  }, [cwd, onModelsChanged, t]);

  const handleManagedModelTest = useCallback(async (model: ManagedModel) => {
    const key = `${model.provider}/${model.id}`;
    if (managedModelTests[key]?.phase === "testing") return;
    setManagedModelTests((current) => ({ ...current, [key]: { phase: "testing" } }));
    try {
      const response = await fetch("/api/models-config/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerName: model.provider,
          modelId: model.id,
          ...(cwd ? { cwd } : {}),
        }),
      });
      const body = await response.json() as {
        ok?: boolean;
        error?: string;
        latencyMs?: number;
        status?: number;
        responseText?: string;
      };
      const nextState: ModelTestState = response.ok && body.ok
        ? {
            phase: "success",
            latencyMs: body.latencyMs,
            status: body.status,
            responseText: body.responseText,
          }
        : {
            phase: "error",
            message: body.error ?? `HTTP ${response.status}`,
            latencyMs: body.latencyMs,
            status: body.status,
          };
      setManagedModelTests((current) => ({ ...current, [key]: nextState }));
    } catch (error) {
      setManagedModelTests((current) => ({
        ...current,
        [key]: {
          phase: "error",
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  }, [cwd, managedModelTests]);

  const refreshProviderState = useCallback(() => {
    setManagedModelTests({});
    refreshAuthProviders();
    void loadModelScope();
  }, [loadModelScope, refreshAuthProviders]);

  const handleSave = useCallback(async () => {
    if (configMutationRef.current) return;
    configMutationRef.current = true;
    const configuredModels = collectConfiguredModelRefs(config);
    const newlyConfiguredModels = configuredModels.filter(
      (model) => !persistedConfiguredModelKeysRef.current.has(configuredModelKey(model)),
    );
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      const res = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) setSaveError(d.error ?? `HTTP ${res.status}`);
      else {
        rememberPersistedConfig(config);
        setSavedOk(true);
        setManagedModelTests({});
        setTimeout(() => setSavedOk(false), 2000);
        for (const model of newlyConfiguredModels) {
          await updateModelScope("restore", model);
        }
        if (newlyConfiguredModels.length === 0) await loadModelScope();
        persistedConfiguredModelKeysRef.current = new Set(
          configuredModels.map(configuredModelKey),
        );
        refreshAuthProviders();
        onModelsChanged?.();
      }
    } catch (e) {
      setSaveError(String(e));
    } finally {
      configMutationRef.current = false;
      setSaving(false);
    }
  }, [config, loadModelScope, onModelsChanged, refreshAuthProviders, updateModelScope, rememberPersistedConfig]);

  const configuredProviders = prioritizeProvider(
    Object.entries(config.providers ?? {}),
    ([provider]) => provider,
  );
  const managedProviderIds = prioritizeProvider(
    [...new Set((modelScope?.models ?? []).map((model) => model.provider))],
    (provider) => provider,
  );
  const hiddenProviderIds = managedProviderIds.filter((providerId) => {
    const providerModels = (modelScope?.models ?? []).filter((model) => model.provider === providerId);
    return providerModels.length > 0 && providerModels.every((model) => !model.enabled);
  });
  const hiddenProviderIdSet = new Set(hiddenProviderIds);
  const providers = configuredProviders.filter(([provider]) => !hiddenProviderIdSet.has(provider));
  const activeOAuth = prioritizeProvider(
    oauthProviders.filter((p) => p.loggedIn && !hiddenProviderIdSet.has(p.id)),
    (provider) => provider.id,
  );
  const activeApiKey = prioritizeProvider(
    apiKeyProviders.filter((p) => p.configured && !hiddenProviderIdSet.has(p.id)),
    (provider) => provider.id,
  );
  const representedProviderIds = new Set([
    ...activeOAuth.map((provider) => provider.id),
    ...activeApiKey.map((provider) => provider.id),
    ...configuredProviders.map(([provider]) => provider),
  ]);
  const scopeOnlyProviderIds = managedProviderIds.filter((provider) =>
    !representedProviderIds.has(provider) && !hiddenProviderIdSet.has(provider));
  const hiddenProviders = hiddenProviderIds.map((providerId) => ({
    id: providerId,
    label: apiKeyProviders.find((provider) => provider.id === providerId)?.displayName
      ?? oauthProviders.find((provider) => provider.id === providerId)?.name
      ?? providerId,
  }));
  const firstApiKeyProviderId = activeApiKey[0]?.id;
  const firstOAuthProviderId = activeOAuth[0]?.id;
  const firstScopeOnlyProviderId = scopeOnlyProviderIds[0];
  const firstCustomProviderName = providers[0]?.[0];

  useEffect(() => {
    if (selection) return;
    if (!oauthProvidersLoaded || !apiKeyProvidersLoaded || modelScopeLoading) return;
    if (firstApiKeyProviderId) {
      setSelection({ type: "apikey", providerId: firstApiKeyProviderId });
      return;
    }
    if (firstOAuthProviderId) {
      setSelection({ type: "oauth", providerId: firstOAuthProviderId });
      return;
    }
    if (firstScopeOnlyProviderId) {
      setSelection({ type: "managed", providerId: firstScopeOnlyProviderId });
      return;
    }
    if (firstCustomProviderName) {
      setSelection({ type: "provider", name: firstCustomProviderName });
    }
  }, [apiKeyProvidersLoaded, firstApiKeyProviderId, firstCustomProviderName, firstOAuthProviderId, firstScopeOnlyProviderId, modelScopeLoading, oauthProvidersLoaded, selection]);

  const renderManagedModels = (providerId: string) => {
    const providerModels = (modelScope?.models ?? []).filter((model) => model.provider === providerId);
    const visibleCount = providerModels.filter((model) => model.enabled).length;
    const hiddenCount = providerModels.length - visibleCount;
    const restoreAllBusy = modelScopeBusyKey === "restore-all";
    const hideProviderBusy = modelScopeBusyKey === `hide-provider:${providerId}`;
    const scopeMutationBusy = modelScopeBusyKey !== null;

    return (
      <div className={styles.modelsCard} style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <SectionTitle>{t("models.availableModels")}</SectionTitle>
          {!modelScopeLoading && providerModels.length > 0 && (
            <span style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: "var(--text-dim)" }}>
              {t("models.visibleCount", { visible: visibleCount, total: providerModels.length })}
            </span>
          )}
          {hiddenCount > 0 && (
            <button
              type="button"
              disabled={scopeMutationBusy || modelScope?.projectOverride}
              onClick={() => void updateModelScope("restore-all")}
              style={{
                padding: "4px 8px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                background: "transparent",
                color: "var(--text-muted)",
                cursor: scopeMutationBusy || modelScope?.projectOverride ? "not-allowed" : "pointer",
                fontSize: "var(--text-xs)",
                opacity: scopeMutationBusy || modelScope?.projectOverride ? 0.55 : 1,
              }}
            >
              {restoreAllBusy ? t("i18n.saving") : t("models.restoreAll")}
            </button>
          )}
          {visibleCount > 0 && (
            <button
              type="button"
              disabled={scopeMutationBusy || modelScope?.projectOverride}
              onClick={async () => {
                if (!await requestConfirmation({ title: t("models.hideProvider"), message: t("models.hideProviderConfirm", { name: providerId }), confirmLabel: t("models.hideProvider") })) return;
                void updateModelScope("hide-provider", { provider: providerId });
              }}
              style={{
                padding: "4px 8px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                background: "transparent",
                color: "var(--text-muted)",
                cursor: scopeMutationBusy || modelScope?.projectOverride ? "not-allowed" : "pointer",
                fontSize: "var(--text-xs)",
                opacity: scopeMutationBusy || modelScope?.projectOverride ? 0.55 : 1,
              }}
            >
              {hideProviderBusy ? t("i18n.saving") : t("models.hideProvider")}
            </button>
          )}
        </div>


        {modelScopeError && modelScope && (
          <div role="alert" style={{ padding: "9px 10px", borderRadius: "var(--radius-control)", background: "rgba(239,68,68,0.08)", color: "#dc2626", fontSize: "var(--text-sm)" }}>
            {<ModelErrorText value={modelScopeError} />}
          </div>
        )}

        {modelScope && modelScope.warnings.length > 0 && (
          <div role="note" style={{ padding: "9px 10px", borderRadius: "var(--radius-control)", background: "rgba(245,158,11,0.09)", color: "#b45309", fontSize: "var(--text-xs)", lineHeight: 1.5 }}>
            {modelScope.warnings.map((warning) => <div key={warning}>{warning}</div>)}
          </div>
        )}

        {modelScopeLoading ? (
          <div style={{ padding: "12px 0", fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>{t("i18n.loading")}</div>
        ) : modelScopeError && !modelScope ? (
          <div role="alert" style={{ padding: "9px 10px", borderRadius: "var(--radius-control)", background: "rgba(239,68,68,0.08)", color: "#dc2626", fontSize: "var(--text-sm)" }}>
            {<ModelErrorText value={modelScopeError} />}
          </div>
        ) : providerModels.length === 0 ? (
          <div style={{ padding: "12px 0", fontSize: "var(--text-sm)", color: "var(--text-dim)" }}>{t("models.noProviderModels")}</div>
        ) : (
          <div className={styles.modelTable} style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", overflow: "hidden" }}>
            <div className={styles.tableHeader}><span>{t("models.form.modelName")}</span><span>{t("models.form.imageInput")}</span><span>{t("i18n.test")}</span><span>{t("models.ui.actions")}</span></div>
            {providerModels.map((model, index) => {
              const isDefault = modelScope?.effectiveDefault?.provider === model.provider
                && modelScope.effectiveDefault.modelId === model.id;
              const customIndex = config.providers?.[providerId]?.models?.findIndex(entry => entry.id === model.id) ?? -1;
              const testKey = `${model.provider}/${model.id}`;
              const testState = managedModelTests[testKey] ?? { phase: "idle" };
              const testMeta = testState.phase === "success" || testState.phase === "error"
                ? [
                    testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
                    testState.status !== undefined ? `HTTP ${testState.status}` : null,
                  ].filter(Boolean)
                : [];
              const testSummary = testState.phase === "testing"
                ? t("i18n.testingModel")
                : testState.phase === "success"
                  ? [t("models.testAvailable"), ...testMeta, testState.responseText || null].filter(Boolean).join(" · ")
                  : testState.phase === "error"
                    ? [t("models.testUnavailable"), ...testMeta, testState.message].filter(Boolean).join(" · ")
                    : null;
              return (
                <div
                  key={`${model.provider}/${model.id}`}
                  className={styles.modelDataRow}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 9,
                    minHeight: 42,
                    padding: "7px 9px",
                    borderTop: index === 0 ? "none" : "1px solid var(--border)",
                    background: model.enabled ? "var(--bg)" : "var(--bg-panel)",
                    opacity: model.enabled ? 1 : 0.68,
                  }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: model.enabled ? "#22c55e" : "var(--text-dim)" }} />
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: "var(--text-sm)", fontWeight: 500 }}>
                        {model.name || model.id}
                      </span>
                      {isDefault && (
                        <span style={{ flexShrink: 0, padding: "1px 5px", borderRadius: 999, background: "var(--bg-selected)", color: "var(--accent)", fontSize: "var(--text-xs)", fontWeight: 600 }}>
                          {t("models.defaultBadge")}
                        </span>
                      )}
                    </span>
                    <code style={{ display: "block", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>
                      {model.id}
                    </code>
                    {testSummary && (
                      <span
                        role={testState.phase === "error" ? "alert" : "status"}
                        aria-live="polite"
                        title={testSummary}
                        style={{
                          display: "block",
                          marginTop: 3,
                          color: testState.phase === "error"
                            ? "#dc2626"
                            : testState.phase === "success"
                              ? "#15803d"
                              : "var(--text-dim)",
                          fontSize: "var(--text-xs)",
                          lineHeight: 1.35,
                          overflowWrap: "anywhere",
                        }}
                      >
                        {testState.phase === "error" ? <ModelErrorText value={testSummary} /> : testSummary}
                      </span>
                    )}

                  </span>
                    <label title={t("models.form.imageHint")} style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 5, color: "var(--text-muted)", fontSize: "var(--text-xs)", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={modelImageInput[testKey] ?? false}
                        disabled={modelCapabilityBusyKey === testKey}
                        onChange={(event) => void updateModelImageInput(model, event.target.checked)}
                        style={{ width: 13, height: 13, accentColor: "var(--accent)" }}
                      />
                      {t("models.form.imageSupport")}
                    </label>
                  <button
                    type="button"
                    data-model-test={testKey}
                    disabled={testState.phase === "testing"}
                    onClick={() => void handleManagedModelTest(model)}
                    title={`${t("i18n.testConnection")}: ${model.name || model.id}`}
                    aria-label={`${t("i18n.testConnection")}: ${model.name || model.id}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 5,
                      minWidth: 52,
                      minHeight: "max(28px, calc(var(--text-xs) + 12px))",
                      padding: "4px 9px",
                      border: `1px solid ${testState.phase === "error"
                        ? "rgba(220,38,38,0.3)"
                        : testState.phase === "success"
                          ? "rgba(21,128,61,0.3)"
                          : "var(--border)"}`,
                      borderRadius: "var(--radius-control)",
                      background: testState.phase === "error"
                        ? "rgba(220,38,38,0.07)"
                        : testState.phase === "success"
                          ? "rgba(21,128,61,0.08)"
                          : "var(--bg-panel)",
                      color: testState.phase === "error"
                        ? "#dc2626"
                        : testState.phase === "success"
                          ? "#15803d"
                          : "var(--text-muted)",
                      cursor: testState.phase === "testing" ? "wait" : "pointer",
                      opacity: testState.phase === "testing" ? 0.68 : 1,
                      fontSize: "var(--text-xs)",
                      fontWeight: 550,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {testState.phase === "success" && (
                      <AliIcon name="check" size={12} />
                    )}
                    {testState.phase === "testing"
                      ? t("i18n.checking")
                      : testState.phase === "idle"
                        ? t("i18n.test")
                        : t("models.testAgain")}
                  </button>
                  <button
                    type="button"
                    disabled={scopeMutationBusy || (customIndex < 0 && modelScope?.projectOverride)}
                    onClick={async () => {
                      if (customIndex >= 0) {
                        if (await requestConfirmation({ title: t("i18n.delete"), message: t("models.deleteModelConfirm", { id: model.id }), confirmLabel: t("i18n.delete"), tone: "danger" })) removeModel(providerId, customIndex);
                        return;
                      }
                      if (model.enabled) {
                        if (!await requestConfirmation({ title: t("models.hideModel"), message: t("models.hideModelConfirm", { id: model.name || model.id }), confirmLabel: t("models.hideModel") })) return;
                        void updateModelScope("hide", model);
                      } else {
                        void updateModelScope("restore", model);
                      }
                    }}
                    title={customIndex >= 0 ? t("i18n.delete") : model.enabled ? t("models.hideModel") : t("models.restoreModel")}
                    aria-label={customIndex >= 0 ? t("i18n.delete") : model.enabled ? t("models.hideModel") : t("models.restoreModel")}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 28,
                      height: 28,
                      padding: 0,
                      border: "none",
                      borderRadius: "var(--radius-control)",
                      background: "transparent",
                      color: model.enabled ? "#ef4444" : "var(--accent)",
                      cursor: scopeMutationBusy || modelScope?.projectOverride ? "not-allowed" : "pointer",
                      opacity: scopeMutationBusy || modelScope?.projectOverride ? 0.45 : 0.82,
                    }}
                  >
                    {model.enabled ? (
                      <AliIcon name="delete" size={13} />
                    ) : (
                      <AliIcon name="reload" size={13} />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {modelScope?.projectOverride && (
          <div role="note" style={{ fontSize: "var(--text-xs)", lineHeight: 1.5, color: "#b45309" }}>
            {t("models.projectScopeOverride")}
          </div>
        )}
        <details className={styles.modelGuide}><summary>{t("models.ui.usageHelp")}</summary><p>{t("models.scopeChangeHint")}</p></details>
      </div>
    );
  };

  // Resolve current detail
  const detailContent = (() => {
    if (!selection) return null;
    if (selection.type === "vision-agent") return <div className={styles.visionPage}><ModelFallbackSetting /><VisionAgentDetail cwd={cwd} /></div>;
    const selectedProvider = selection.type === "provider" ? selection.name : selection.type === "model" ? selection.providerName : selection.providerId;
    if (detailTab === "models") return renderManagedModels(selectedProvider);
    if (selection.type === "oauth") {
      const p = oauthProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <OAuthDetail key={p.id} provider={p} onRefresh={refreshProviderState} />
          {renderManagedModels(p.id)}
        </div>
      );
    }
    if (selection.type === "apikey") {
      const p = apiKeyProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <ApiKeyDetail key={p.id} provider={p} onRefresh={refreshProviderState} />
          {renderManagedModels(p.id)}
        </div>
      );
    }
    if (selection.type === "managed") {
      return renderManagedModels(selection.providerId);
    }
    if (selection.type === "provider") {
      const provider = config.providers?.[selection.name];
      if (!provider) return null;
      const hasManagedModels = (modelScope?.models ?? []).some((model) => model.provider === selection.name);
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <ProviderDetail
            key={selection.name}
            name={selection.name}
            provider={provider}
            onChange={(p) => updateProvider(selection.name, p)}
            onRename={(n) => renameProvider(selection.name, n)}
            onDelete={() => deleteProvider(selection.name)}
            onAddModels={(models) => addDiscoveredModels(selection.name, models)}
          />
          {hasManagedModels && renderManagedModels(selection.name)}
        </div>
      );
    }
    const provider = config.providers?.[selection.providerName];
    const model = provider?.models?.[selection.index];
    if (!model) return null;
    return (
      <ModelDetail
        key={`${selection.providerName}-${selection.index}`}
        providerName={selection.providerName}
        provider={provider}
        model={model}
        onChange={(m) => updateModel(selection.providerName, selection.index, m)}
        onDelete={() => removeModel(selection.providerName, selection.index)}
      />
    );
  })();

  return (
    <>
    <div className={embedded ? undefined : "app-shell-dialog-backdrop"} style={{ position: embedded ? "relative" : "fixed", inset: embedded ? undefined : 0, zIndex: embedded ? undefined : 1000, width: "100%", height: "100%", minHeight: 0, background: embedded ? "var(--bg)" : "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (!embedded && e.target === e.currentTarget && modelScopeBusyKey === null && !saving) onClose(); }}>
      <div ref={dialogRef} className={`${styles.dialog} ${embedded ? "" : "app-shell-dialog"}`} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-label={t("common.models")} style={{ width: embedded ? "100%" : isMobile ? "calc(100vw - 16px)" : 1100, maxWidth: embedded ? "none" : "calc(100vw - 16px)", height: embedded ? "100%" : isMobile ? "calc(100dvh - 16px)" : "88vh", maxHeight: embedded ? "none" : "calc(100dvh - 16px)", background: "var(--bg)", border: embedded ? "none" : "1px solid var(--border)", borderRadius: embedded ? 0 : 14, display: "flex", flexDirection: "column", boxShadow: embedded ? "none" : "0 8px 32px rgba(0,0,0,0.18)", overflow: "hidden" }}>

        {/* Header */}
        <div className={`app-shell-dialog-header ${styles.header}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 18px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
             <span className={styles.heading}><AliIcon name="setting" size={22} />{t("models.ui.title")}</span>
            <span className={styles.subtitle}>{t("models.form.subtitle")}</span>
          </div>
          {!embedded && <button onClick={onClose} disabled={modelScopeBusyKey !== null || saving} title={t("i18n.close")} aria-label={t("i18n.close")} style={{ display: "inline-flex", width: 28, height: 28, alignItems: "center", justifyContent: "center", background: "none", border: "none", borderRadius: "var(--radius-control)", color: "var(--text-muted)", cursor: modelScopeBusyKey !== null || saving ? "not-allowed" : "pointer", opacity: modelScopeBusyKey !== null || saving ? 0.55 : 1, padding: 0 }}><AliIcon name="close" size={16} /></button>}
        </div>

        {/* Body */}
        <div inert={saving} aria-busy={saving} style={{ flex: 1, display: "flex", flexDirection: isMobile ? "column" : "row", overflow: "hidden" }}>

          {/* Left: tree */}
          <div className={styles.sidebar} style={{
            width: isMobile ? "100%" : 210,
            maxHeight: isMobile ? "40vh" : undefined,
            borderRight: isMobile ? "none" : "1px solid var(--border)",
            borderBottom: isMobile ? "1px solid var(--border)" : "none",
            display: "flex", flexDirection: "column", flexShrink: 0, background: "var(--bg-panel)",
          }}>
            <div className={styles.sidebarHeading}><span>{t("models.ui.providers")}</span><button className={styles.addChannel} onClick={() => setPickerOpen(true)}><AliIcon name="plus" size={13} />{t("models.ui.addProvider")}</button></div>
            <div className={styles.tree} style={{ flex: 1, overflowY: "auto", padding: "8px 6px" }}>
              <div
                onClick={() => setSelection({ type: "vision-agent" })}
                style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 8px", marginBottom: 6, borderRadius: "var(--radius-control)", cursor: "pointer", background: selection?.type === "vision-agent" ? "var(--bg-selected)" : "none" }}
                onMouseEnter={(event) => { if (selection?.type !== "vision-agent") event.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(event) => { if (selection?.type !== "vision-agent") event.currentTarget.style.background = "none"; }}
              >
                <AliIcon name="eye" size={16} style={{ color: "var(--accent)" }} />
                <span style={{ fontSize: "var(--text-sm)", color: "var(--text)", fontWeight: selection?.type === "vision-agent" ? 600 : 400 }}>{t("models.ui.vision")}</span>
              </div>
              <div style={{ margin: "0 8px 6px", borderTop: "1px solid var(--border)" }} />
              {/* Active API key providers are first so DeepSeek is globally first when configured. */}
              {activeApiKey.map((p) => {
                const isSelected = selection?.type === "apikey" && selection.providerId === p.id;
                const scopedModels = (modelScope?.models ?? []).filter((model) => model.provider === p.id);
                const visibleModels = scopedModels.filter((model) => model.enabled).length;
                return (
                  <div
                    key={p.id}
                    onClick={() => setSelection({ type: "apikey", providerId: p.id })}
                    style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", borderRadius: "var(--radius-control)", cursor: "pointer", background: isSelected ? "var(--bg-selected)" : "none" }}
                    onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "none"; }}
                    >
                    <ModelProviderIcon provider={p.id} size={16} />
                    <span style={{ fontSize: "var(--text-sm)", color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.displayName}</span>
                    {scopedModels.length > 0 && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)" }}>{visibleModels}/{scopedModels.length}</span>}
                  </div>
                );
              })}

              {/* Active OAuth subscriptions */}
              {activeOAuth.map((p) => {
                const isSelected = selection?.type === "oauth" && selection.providerId === p.id;
                const scopedModels = (modelScope?.models ?? []).filter((model) => model.provider === p.id);
                const visibleModels = scopedModels.filter((model) => model.enabled).length;
                return (
                  <div
                    key={p.id}
                    onClick={() => setSelection({ type: "oauth", providerId: p.id })}
                    style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", borderRadius: "var(--radius-control)", cursor: "pointer", background: isSelected ? "var(--bg-selected)" : "none" }}
                    onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = "none"; }}
                    >
                    <ModelProviderIcon provider={p.id} size={16} />
                    <span style={{ fontSize: "var(--text-sm)", color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                    {scopedModels.length > 0 && <span style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)" }}>{visibleModels}/{scopedModels.length}</span>}
                  </div>
                );
              })}

              {/* Models registered by extensions or the Pi runtime without a separate auth/config row. */}
              {scopeOnlyProviderIds.map((providerId) => {
                const isSelected = selection?.type === "managed" && selection.providerId === providerId;
                const scopedModels = (modelScope?.models ?? []).filter((model) => model.provider === providerId);
                const visibleModels = scopedModels.filter((model) => model.enabled).length;
                return (
                  <div
                    key={providerId}
                    onClick={() => setSelection({ type: "managed", providerId })}
                    style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", borderRadius: "var(--radius-control)", cursor: "pointer", background: isSelected ? "var(--bg-selected)" : "none" }}
                    onMouseEnter={(event) => { if (!isSelected) event.currentTarget.style.background = "var(--bg-hover)"; }}
                    onMouseLeave={(event) => { if (!isSelected) event.currentTarget.style.background = "none"; }}
                  >
                    <ModelProviderIcon provider={providerId} size={16} />
                    <span style={{ fontSize: "var(--text-sm)", color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{providerId}</span>
                    <span style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)" }}>{visibleModels}/{scopedModels.length}</span>
                  </div>
                );
              })}

              {/* Divider before custom providers, only when there are active managed providers */}
              {(activeOAuth.length > 0 || activeApiKey.length > 0 || scopeOnlyProviderIds.length > 0) && providers.length > 0 && (
                <div style={{ margin: "4px 8px", borderTop: "1px solid var(--border)" }} />
              )}

              {/* Custom providers */}
              {loading ? (
                 <div style={{ padding: "10px 8px", fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>{t("i18n.loading")}</div>
              ) : providers.map(([pName, pData]) => {
                const isProviderSelected = selection?.type === "provider" && selection.name === pName;
                const models = pData.models ?? [];
                return (
                  <div key={pName} className={styles.providerGroup} style={{ marginBottom: 2 }}>
                    {/* Provider row */}
                    <div
                      className={styles.providerRow} data-selected={isProviderSelected}
                      onClick={() => setSelection({ type: "provider", name: pName })}
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 8px", borderRadius: "var(--radius-control)", cursor: "pointer", background: isProviderSelected ? "var(--bg-selected)" : "none" }}
                      onMouseEnter={(e) => { if (!isProviderSelected) e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { if (!isProviderSelected) e.currentTarget.style.background = "none"; }}
                    >
                      <AliIcon name="api" size={11} style={{ color: "var(--text-dim)" }} />
                      <span style={{ fontSize: "var(--text-sm)", fontWeight: isProviderSelected ? 600 : 400, color: "var(--text)", fontFamily: "var(--font-mono)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {pName}
                      </span>
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (await requestConfirmation({ title: t("i18n.delete"), message: t("models.deleteProviderConfirm", { name: pName }), confirmLabel: t("i18n.delete"), tone: "danger" })) deleteProvider(pName);
                        }}
                        title={t("i18n.delete")}
                        aria-label={t("i18n.delete")}
                        style={{
                          flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                          width: 18, height: 18, padding: 0, border: "none", borderRadius: 4,
                          background: "transparent", color: "var(--text-dim)", cursor: "pointer",
                          opacity: 0.55, transition: "opacity 0.12s, color 0.12s, background 0.12s",
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.opacity = "1";
                          e.currentTarget.style.color = "#ef4444";
                          e.currentTarget.style.background = "rgba(239,68,68,0.1)";
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.opacity = "0.55";
                          e.currentTarget.style.color = "var(--text-dim)";
                          e.currentTarget.style.background = "transparent";
                        }}
                      >
                        <AliIcon name="delete" size={11} />
                      </button>
                    </div>

                    {/* Model rows */}
                    {models.map((m, i) => {
                      const isModelSelected = selection?.type === "model" && selection.providerName === pName && selection.index === i;
                      return (
                        <div
                          key={i}
                          className={styles.modelTreeRow}
                          onClick={() => setSelection({ type: "model", providerName: pName, index: i })}
                          style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px 5px 26px", borderRadius: "var(--radius-control)", cursor: "pointer", background: isModelSelected ? "var(--bg-selected)" : "none" }}
                          onMouseEnter={(e) => { if (!isModelSelected) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isModelSelected) e.currentTarget.style.background = "none"; }}
                        >
                          <span style={{ fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", color: m.id ? "var(--text-muted)" : "var(--text-dim)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                             {m.id || t("i18n.newModel")}
                          </span>
                          {m.reasoning && (
                            <span style={{ fontSize: "var(--text-xs)", padding: "1px 4px", background: "rgba(99,102,241,0.12)", color: "rgba(99,102,241,0.8)", borderRadius: 3, flexShrink: 0 }}>T</span>
                          )}
                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation();
                              const label = m.id || t("i18n.newModel");
                              if (await requestConfirmation({ title: t("i18n.delete"), message: t("models.deleteModelConfirm", { id: label }), confirmLabel: t("i18n.delete"), tone: "danger" })) removeModel(pName, i);
                            }}
                            title={t("i18n.delete")}
                            aria-label={t("i18n.delete")}
                            style={{
                              flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                              width: 18, height: 18, padding: 0, border: "none", borderRadius: 4,
                              background: "transparent", color: "var(--text-dim)", cursor: "pointer",
                              opacity: 0.55, transition: "opacity 0.12s, color 0.12s, background 0.12s",
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.opacity = "1";
                              e.currentTarget.style.color = "#ef4444";
                              e.currentTarget.style.background = "rgba(239,68,68,0.1)";
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.opacity = "0.55";
                              e.currentTarget.style.color = "var(--text-dim)";
                              e.currentTarget.style.background = "transparent";
                            }}
                          >
                            <AliIcon name="delete" size={11} />
                          </button>
                        </div>
                      );
                    })}

                    {/* Add model button */}
                    <div
                      onClick={(e) => { e.stopPropagation(); addModel(pName); }}
                      style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 8px 4px 26px", borderRadius: "var(--radius-control)", cursor: "pointer", color: "var(--text-dim)" }}
                      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                    >
                       <span style={{ fontSize: "var(--text-xs)" }}>+ {t("i18n.model")}</span>
                    </div>
                  </div>
                );
              })}
            </div>


          </div>

          {/* Right: detail */}
          <div className={styles.detail} style={{ flex: 1, overflowY: "auto", padding: 20 }}>
            <nav className={styles.tabs} aria-label={t("models.ui.sections")}>
              {selection?.type !== "vision-agent" ? <><button aria-pressed={detailTab === "connection"} onClick={() => setDetailTab("connection")}><AliIcon name="link" size={17} />{t("models.ui.connection")}</button><button aria-pressed={detailTab === "models"} onClick={() => setDetailTab("models")}><AliIcon name="brain" size={17} />{t("models.ui.models")}</button></> : <button aria-pressed="true">{t("models.ui.vision")}</button>}
            </nav>
            {loading ? null : detailContent ?? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: "var(--text-base)" }}>
                 {t("i18n.selectProviderModel")}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className={styles.footer} style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 10, padding: "10px 18px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
          {saveError && <span role="alert" style={{ fontSize: "var(--text-sm)", color: "#f87171", flex: 1 }}>{<ModelErrorText value={saveError} />}</span>}
          {!embedded && <button onClick={onClose} disabled={modelScopeBusyKey !== null || saving} style={{ padding: "6px 14px", background: "none", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", color: "var(--text-muted)", cursor: modelScopeBusyKey !== null || saving ? "not-allowed" : "pointer", opacity: modelScopeBusyKey !== null || saving ? 0.55 : 1, fontSize: "var(--text-base)" }}>
             {t("i18n.close")}
          </button>}
          <button onClick={handleSave} disabled={saving || savedOk} style={{
            position: "relative",
            padding: "6px 16px",
            minWidth: 92,
            background: savedOk ? "#16a34a" : saving ? "var(--bg-panel)" : "var(--accent)",
            border: "none", borderRadius: "var(--radius-control)",
            color: savedOk ? "#fff" : saving ? "var(--text-muted)" : "#fff",
            cursor: (saving || savedOk) ? "default" : "pointer", fontSize: "var(--text-base)", fontWeight: 600,
            display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
            transition: "background-color 0.2s ease, color 0.2s ease",
            animation: savedOk ? "saved-pop 0.45s ease" : undefined,
          }}>
            {savedOk && (
              <AliIcon name="check" size={14} style={{ animation: "saved-check-draw 0.35s ease forwards" }} />
            )}
             <span>{savedOk ? t("i18n.saved") : saving ? t("i18n.saving") : t("i18n.save")}</span>
          </button>
        </div>
      </div>
    </div>
    {pickerOpen && (
      <AddProviderPicker
        oauthProviders={oauthProviders}
        apiKeyProviders={apiKeyProviders}
        hiddenProviders={hiddenProviders}
        onSelectOAuth={(id) => setSelection({ type: "oauth", providerId: id })}
        onSelectApiKey={(id) => setSelection({ type: "apikey", providerId: id })}
        onRestoreProvider={async (id) => {
          const restored = await updateModelScope("restore-provider", { provider: id });
          if (!restored) return false;
          if (config.providers?.[id]) setSelection({ type: "provider", name: id });
          else if (apiKeyProviders.some((provider) => provider.id === id && provider.configured)) {
            setSelection({ type: "apikey", providerId: id });
          } else if (oauthProviders.some((provider) => provider.id === id && provider.loggedIn)) {
            setSelection({ type: "oauth", providerId: id });
          } else setSelection({ type: "managed", providerId: id });
          return true;
        }}
        onAddCustom={addCustomProvider}
        onClose={() => setPickerOpen(false)}
      />
    )}
    </>
  );
}
