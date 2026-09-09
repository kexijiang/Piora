"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { useI18n } from "@/hooks/useI18n";
import {
  readPromptOptimizerModel,
  readPromptOptimizerSystemPrompt,
  writePromptOptimizerModel,
  type PromptOptimizerModelPreference,
} from "@/lib/prompt-optimizer-settings";
import type { SystemPromptCatalog, SystemPromptTemplate } from "@/lib/system-prompt-types";
import { AliIcon } from "./AliIcon";
import { requestConfirmation } from "./ConfirmDialog";
import styles from "./SystemPromptEditor.module.css";

interface SystemPromptResponse extends SystemPromptCatalog {
  error?: string;
}

interface Props {
  effectivePrompt: string | null;
  compact?: boolean;
  onSaved?: () => void;
}

const EMPTY_CATALOG: SystemPromptCatalog = {
  templates: [],
  defaultTemplateId: null,
  selectorVisible: true,
  maxPromptLength: 100_000,
  maxNameLength: 80,
};

const PI_DEFAULT_SELECTION_ID = "__pi_default__";

interface ModelsPayload {
  modelList?: Array<{ provider: string; id: string; name?: string }>;
  defaultModel?: { provider: string; modelId: string } | null;
  error?: string;
}

async function requestCatalog(method: string, body?: Record<string, unknown>): Promise<SystemPromptCatalog> {
  const response = await fetch("/api/system-prompt", {
    method,
    ...(body ? {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    } : {}),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({})) as SystemPromptResponse;
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

export function SystemPromptEditor({ effectivePrompt, compact = false, onSaved }: Props) {
  const { t } = useI18n();
  const promptFieldId = useId();
  const [catalog, setCatalog] = useState<SystemPromptCatalog>(EMPTY_CATALOG);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizationPreview, setOptimizationPreview] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const optimizerAbortRef = useRef<AbortController | null>(null);
  const [optimizerModels, setOptimizerModels] = useState<ModelsPayload | null>(null);
  const [optimizerModel, setOptimizerModel] = useState<PromptOptimizerModelPreference | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const modelChoice = optimizerModel ?? optimizerModels?.defaultModel;
  const resolvedOptimizerModel = modelChoice && optimizerModels?.modelList?.some((candidate) => (
    candidate.provider === modelChoice.provider && candidate.id === modelChoice.modelId
  )) ? modelChoice : null;

  useEffect(() => {
    const controller = new AbortController();
    setOptimizerModel(readPromptOptimizerModel(window.localStorage));
    setModelsLoading(true);
    void fetch("/api/models", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json() as ModelsPayload;
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!controller.signal.aborted) { setOptimizerModels(data); setModelsError(null); }
      })
      .catch((cause) => { if (!controller.signal.aborted) setModelsError(String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setModelsLoading(false); });
    return () => controller.abort();
  }, []);

  const selectedTemplate = catalog.templates.find((template) => template.id === selectedId) ?? null;
  const showingPiDefault = !creating && selectedId === PI_DEFAULT_SELECTION_ID;

  const chooseTemplate = useCallback((template: SystemPromptTemplate) => {
    optimizerAbortRef.current?.abort();
    optimizerAbortRef.current = null;
    setOptimizing(false);
    setSelectedId(template.id);
    setCreating(false);
    setName(template.name);
    setPrompt(template.prompt);
    setOptimizationPreview(null);
    setStatus(null);
    setError(null);
  }, []);

  const choosePiDefault = useCallback(() => {
    optimizerAbortRef.current?.abort();
    optimizerAbortRef.current = null;
    setOptimizing(false);
    setSelectedId(PI_DEFAULT_SELECTION_ID);
    setCreating(false);
    setName("");
    setPrompt("");
    setOptimizationPreview(null);
    setStatus(null);
    setError(null);
  }, []);

  const applyCatalog = useCallback((next: SystemPromptCatalog, preferredId?: string | null) => {
    setCatalog(next);
    if (preferredId === PI_DEFAULT_SELECTION_ID) {
      choosePiDefault();
      return;
    }
    const nextSelected = next.templates.find((template) => template.id === preferredId)
      ?? next.templates.find((template) => template.id === next.defaultTemplateId)
      ?? null;
    if (nextSelected) chooseTemplate(nextSelected);
    else choosePiDefault();
  }, [choosePiDefault, chooseTemplate]);

  useEffect(() => {
    let cancelled = false;
    void requestCatalog("GET")
      .then((next) => { if (!cancelled) applyCatalog(next); })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [applyCatalog]);

  useEffect(() => () => optimizerAbortRef.current?.abort(), []);

  const publish = useCallback((next: SystemPromptCatalog, preferredId?: string | null) => {
    applyCatalog(next, preferredId);
    window.dispatchEvent(new CustomEvent("piora:system-prompt-changed"));
    onSaved?.();
  }, [applyCatalog, onSaved]);

  const save = useCallback(async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const next = creating
        ? await requestCatalog("POST", { name, prompt })
        : await requestCatalog("PATCH", { id: selectedId, name, prompt });
      const preferred = creating
        ? next.templates.find((template) => template.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase())?.id
        : selectedId;
      publish(next, preferred ?? null);
      setStatus(t(creating ? "system.templateCreated" : "system.templateSaved"));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  }, [creating, name, prompt, publish, selectedId, t]);

  const setDefault = useCallback(async (id: string | null) => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const next = await requestCatalog("PATCH", { defaultTemplateId: id });
      publish(next, id === null ? PI_DEFAULT_SELECTION_ID : selectedId);
      setStatus(t("system.defaultUpdated"));
    } catch (defaultError) {
      setError(defaultError instanceof Error ? defaultError.message : String(defaultError));
    } finally {
      setSaving(false);
    }
  }, [publish, selectedId, t]);

  const setSelectorVisible = useCallback(async (visible: boolean) => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const next = await requestCatalog("PATCH", { selectorVisible: visible });
      setCatalog(next);
      window.dispatchEvent(new CustomEvent("piora:system-prompt-changed"));
      onSaved?.();
      setStatus(t("system.selectorVisibilitySaved"));
    } catch (visibilityError) {
      setError(visibilityError instanceof Error ? visibilityError.message : String(visibilityError));
    } finally {
      setSaving(false);
    }
  }, [onSaved, t]);

  const optimizePrompt = useCallback(async () => {
    const source = prompt.trim();
    if (!source || optimizing || !resolvedOptimizerModel) return;
    optimizerAbortRef.current?.abort();
    const controller = new AbortController();
    optimizerAbortRef.current = controller;
    setOptimizing(true);
    setOptimizationPreview(null);
    setError(null);
    setStatus(null);
    try {
      const selected = resolvedOptimizerModel;

      const response = await fetch("/api/prompts/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: source,
          provider: selected.provider,
          modelId: selected.modelId,
          systemPrompt: `${readPromptOptimizerSystemPrompt(window.localStorage)}\n\nThe text to optimize is a reusable system-prompt template. Preserve its intent and language. Improve the role, goals, constraints, tool guidance, boundaries, and verifiable outcomes where the source supports them. Do not invent project facts. Return only the optimized template text.`,
        }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({})) as { optimizedPrompt?: unknown; error?: unknown };
      if (!response.ok || typeof data.optimizedPrompt !== "string" || !data.optimizedPrompt.trim()) {
        throw new Error(typeof data.error === "string" ? data.error : t("system.optimizeFailed"));
      }
      const result = Array.from(data.optimizedPrompt.trim()).slice(0, catalog.maxPromptLength).join("");
      setOptimizationPreview(result);
    } catch (optimizeError) {
      if (!controller.signal.aborted) {
        setError(optimizeError instanceof Error ? optimizeError.message : t("system.optimizeFailed"));
      }
    } finally {
      if (optimizerAbortRef.current === controller) optimizerAbortRef.current = null;
      if (!controller.signal.aborted) setOptimizing(false);
    }
  }, [catalog.maxPromptLength, optimizing, prompt, resolvedOptimizerModel, t]);

  const remove = useCallback(async () => {
    if (!selectedTemplate || !await requestConfirmation({
      title: t("system.deleteTemplate"),
      message: t("system.deleteTemplateConfirm", { name: selectedTemplate.name }),
      confirmLabel: t("system.deleteTemplate"),
      tone: "danger",
    })) return;
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const next = await requestCatalog("DELETE", { id: selectedTemplate.id });
      publish(next);
      setStatus(t("system.templateDeleted"));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setSaving(false);
    }
  }, [publish, selectedTemplate, t]);

  const dirty = creating
    ? Boolean(name.trim() || prompt)
    : Boolean(selectedTemplate && (name !== selectedTemplate.name || prompt !== selectedTemplate.prompt));

  return (
    <div className={`${styles.editor}${compact ? ` ${styles.compact}` : ""}`}>
      <label className={styles.visibilitySetting}>
        <span className={styles.visibilityCopy}>
          <strong>{t("system.selectorVisibilityTitle")}</strong>
          <small>{t("system.selectorVisibilityDescription")}</small>
        </span>
        <span className={styles.switch}>
          <input
            type="checkbox"
            role="switch"
            checked={catalog.selectorVisible}
            disabled={loading || saving}
            onChange={(event) => { void setSelectorVisible(event.target.checked); }}
          />
          <span aria-hidden="true" />
        </span>
      </label>

      <div className={styles.library}>
        <div className={styles.libraryHeader}>
          <span>{t("system.templateLibrary")}</span>
          <button
            type="button"
            disabled={loading || saving}
            onClick={() => {
              optimizerAbortRef.current?.abort();
              optimizerAbortRef.current = null;
              setOptimizing(false);
              setCreating(true);
              setSelectedId(null);
              setName("");
              setPrompt("");
              setOptimizationPreview(null);
              setStatus(null);
              setError(null);
            }}
          >
            <AliIcon name="plus" size={12} />
            {t("system.newTemplate")}
          </button>
        </div>
        <div className={styles.templateList} aria-label={t("system.templateLibrary")}>
          <button
            type="button"
            className={styles.piDefaultRow}
            data-default={catalog.defaultTemplateId === null ? "true" : undefined}
            aria-pressed={showingPiDefault}
            disabled={saving}
            onClick={choosePiDefault}
          >
            <AliIcon name="setting" size={14} />
            <span><strong>{t("system.piDefault")}</strong><small>{t("system.piDefaultDescription")}</small></span>
            {catalog.defaultTemplateId === null ? <em>{t("system.defaultBadgeShort")}</em> : null}
          </button>
          {catalog.templates.map((template) => (
            <button
              key={template.id}
              type="button"
              aria-pressed={!creating && template.id === selectedId}
              disabled={saving}
              onClick={() => chooseTemplate(template)}
            >
              <AliIcon name="file" size={14} />
              <span><strong>{template.name}</strong><small>{template.prompt || t("system.emptyTemplate")}</small></span>
              {template.id === catalog.defaultTemplateId ? <em>{t("system.defaultBadgeShort")}</em> : null}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.form}>
        <div className={styles.formHeading}>
          <span>{t(showingPiDefault ? "system.piDefaultPreviewTitle" : creating ? "system.newTemplate" : "system.editTemplate")}</span>
          {!creating && selectedTemplate ? (
            <div>
              {catalog.defaultTemplateId !== selectedTemplate.id ? (
                <button type="button" disabled={saving} onClick={() => void setDefault(selectedTemplate.id)}>
                  {t("system.makeDefault")}
                </button>
              ) : null}
              <button type="button" disabled={saving} data-danger="true" onClick={() => void remove()}>
                {t("system.deleteTemplate")}
              </button>
            </div>
          ) : null}
        </div>
        {showingPiDefault ? (
          <div className={styles.piDefaultPreview}>
            <div className={styles.piDefaultPreviewHeader}>
              <span><AliIcon name="setting" size={15} />{t("system.piDefault")}</span>
              {catalog.defaultTemplateId !== null ? (
                <button type="button" disabled={saving} onClick={() => void setDefault(null)}>
                  {t("system.makeDefault")}
                </button>
              ) : <em>{t("system.defaultBadgeShort")}</em>}
            </div>
            <pre>{t("system.piDefaultPromptPreview")}</pre>
            <p>{t("system.piDefaultPromptDynamicDescription")}</p>
          </div>
        ) : (
          <>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t("system.templateName")}</span>
              <input
                value={name}
                maxLength={catalog.maxNameLength}
                disabled={loading || saving}
                placeholder={t("system.templateNamePlaceholder")}
                onChange={(event) => { setName(event.target.value); setStatus(null); setError(null); }}
              />
            </label>
            <div className={styles.field}>
              <span className={styles.aiFieldHeading}>
                <label className={styles.fieldLabel} htmlFor={promptFieldId}>{t("system.customLabel")}</label>
                <button
                  type="button"
                  disabled={loading || saving || optimizing || modelsLoading || !resolvedOptimizerModel || !prompt.trim()}
                  onClick={() => { void optimizePrompt(); }}
                >
                  <AliIcon name="sparkles" size={13} />
                  {t(optimizing ? "system.optimizing" : "system.optimize")}
                </button>
              </span>
              <label className={styles.optimizerModel}>
                <span>{t("settings.promptOptimizerModel")}</span>
                <select
                  aria-label={t("settings.promptOptimizerModel")}
                  value={optimizerModel ? JSON.stringify(optimizerModel) : ""}
                  disabled={modelsLoading || optimizing}
                  onChange={(event) => {
                    try {
                      const selected = writePromptOptimizerModel(event.target.value ? JSON.parse(event.target.value) : null, window.localStorage);
                      setOptimizerModel(selected);
                      setOptimizationPreview(null);
                      setError(null);
                    } catch (cause) { setError(String(cause)); }
                  }}
                >
                  <option value="">{t("system.optimizerDefaultModel")}{optimizerModels?.defaultModel ? ` · ${optimizerModels.defaultModel.provider}/${optimizerModels.defaultModel.modelId}` : ""}</option>
                  {optimizerModel && !resolvedOptimizerModel ? <option value={JSON.stringify(optimizerModel)} disabled>{optimizerModel.provider}/{optimizerModel.modelId} · {t("system.optimizerUnavailable")}</option> : null}
                  {optimizerModels?.modelList?.map((candidate) => (
                    <option key={`${candidate.provider}/${candidate.id}`} value={JSON.stringify({ provider: candidate.provider, modelId: candidate.id })}>
                      {candidate.name || candidate.id} · {candidate.provider}/{candidate.id}
                    </option>
                  ))}
                </select>
              </label>
              <span className={styles.optimizerModelInfo} role="status">
                {modelsLoading ? t("system.optimizerModelsLoading") : resolvedOptimizerModel
                  ? t("system.optimizerUsingModel", { model: `${resolvedOptimizerModel.provider}/${resolvedOptimizerModel.modelId}` })
                  : t("system.optimizeNoModel")}
              </span>
              {modelsError ? <span className={styles.fieldDescription} role="alert">{modelsError}</span> : null}
              <span className={styles.fieldDescription}>{t("system.optimizerSharedModel")}</span>
              <span className={styles.fieldDescription}>{t("system.templateDescription")}</span>
              <span className={styles.fieldDescription}>{t("system.optimizeDescription")}</span>
              <textarea
                id={promptFieldId}
                className={styles.textarea}
                value={prompt}
                rows={compact ? 8 : 12}
                maxLength={catalog.maxPromptLength}
                disabled={loading || saving}
                placeholder={t("system.customPlaceholder")}
                onChange={(event) => {
                  optimizerAbortRef.current?.abort();
                  optimizerAbortRef.current = null;
                  setOptimizing(false);
                  setPrompt(event.target.value);
                  setOptimizationPreview(null);
                  setStatus(null);
                  setError(null);
                }}
              />
              {optimizationPreview ? (
                <div className={styles.optimizationPreview}>
                  <div><AliIcon name="sparkles" size={13} /><strong>{t("system.optimizePreview")}</strong></div>
                  <pre>{optimizationPreview}</pre>
                  <div className={styles.optimizationActions}>
                    <button type="button" onClick={() => setOptimizationPreview(null)}>{t("system.keepOriginal")}</button>
                    <button
                      type="button"
                      className={styles.primaryButton}
                      onClick={() => {
                        setPrompt(optimizationPreview);
                        setOptimizationPreview(null);
                        setStatus(null);
                        setError(null);
                      }}
                    >
                      {t("system.useOptimized")}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>

            <div className={styles.footer}>
              <div className={styles.feedback}>
                <span role={error ? "alert" : "status"} data-error={Boolean(error)}>{error ?? status ?? t("system.snapshotHint")}</span>
                <span className={styles.count}>{Array.from(prompt).length.toLocaleString()} / {catalog.maxPromptLength.toLocaleString()}</span>
              </div>
              <div className={styles.actions}>
                <button className={styles.primaryButton} type="button" disabled={loading || saving || optimizing || !dirty || !name.trim()} onClick={() => void save()}>
                  {saving ? t("system.saving") : t("system.saveTemplate")}
                </button>
              </div>
            </div>
          </>
        )}
        {showingPiDefault && (error || status) ? (
          <div className={styles.previewFeedback} role={error ? "alert" : "status"} data-error={Boolean(error)}>
            {error ?? status}
          </div>
        ) : null}
      </div>

      {!compact ? (
        <details className={styles.effectivePrompt}>
          <summary>
            <span><strong>{t("system.effectiveLabel")}</strong><small>{t("system.effectiveDescription")}</small></span>
          </summary>
          <pre>{effectivePrompt === null ? t("system.load") : effectivePrompt || t("system.empty")}</pre>
        </details>
      ) : null}
    </div>
  );
}
