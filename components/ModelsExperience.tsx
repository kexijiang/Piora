"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { createDiscoveryAbort, requestDiscoveredModels, type DiscoveredModel } from "@/lib/model-discovery";
import { applyEndpointLimits, modelLimitProblem, parseModelLimitDraft, stripModelLimitUiMeta, validateCustomModelLimits } from "@/lib/model-limits";
import { ModelProviderIcon } from "./ModelProviderIcon";
import { ModelSamplingEditor } from "./ModelSamplingEditor";
import { modelSamplingError } from "@/lib/model-sampling";
import { requestConfirmation } from "./ConfirmDialog";
import { ModelErrorText } from "./ModelErrorText";
import { ModelFallbackSetting } from "./ModelFallbackSetting";
import { ApiKeyDetail, OAuthDetail, VisionAgentDetail, API_OPTIONS, type ApiKeyProvider, type OAuthProvider, type ModelEntry, type ModelsJson, type ProviderEntry, type ModelScopeResponse } from "./ModelsConfig";
import styles from "./ModelsExperience.module.css";
import { orderByProvider } from "@/lib/provider-order";
import { ProviderOrderList } from "./ProviderOrderList";

const copy = {
  zh: {
    title: "模型设置", subtitle: "连接 AI 服务，让对话开始工作", add: "添加渠道", default: "默认模型", none: "还没有可用的模型", noneHint: "添加渠道并选择模型，即可开始对话。", custom: "自定义渠道", account: "使用服务商账号或密钥", first: "第一次使用？", tip1: "填写服务商提供的接口地址", tip2: "输入访问密钥", tip3: "选择想使用的模型", vision: "视觉与回退", visionHint: "设置图片理解与模型不可用时的回退方式", manage: "管理模型", settings: "连接设置", configured: "已配置", noModels: "暂无模型", back: "返回", connect: "连接渠道", choose: "选择模型", finish: "完成", name: "渠道名称", nameHint: "起一个容易辨认的名称，例如服务商名称。", address: "接口地址", addressHint: "填写服务商提供的 API 地址，通常以 https:// 开头。", key: "访问密钥", keyHint: "填写服务商提供的 API Key；部分本地服务可能要求占位密钥。", show: "显示密钥", hide: "隐藏密钥", protocol: "接口类型", fetch: "获取可用模型", fetching: "正在获取模型…", cancel: "取消", where: "在哪里获取？", where1: "登录服务商控制台，找到 API 接口地址。", where2: "创建或复制访问密钥。", where3: "填入左侧，然后获取可用模型。", select: "选择要使用的模型", search: "搜索模型名称", manual: "找不到模型？手动添加", manualId: "模型 ID", manualAdd: "添加模型", selected: "已选择", selectedUnit: "个模型", previous: "上一步", next: "继续", completing: "正在补全模型信息…", save: "保存并完成", saving: "正在保存…", saved: "配置已保存", savedHint: "返回对话后即可选择已启用的模型。", return: "返回模型设置", limits: "补全模型信息", limitsHint: "渠道和模型目录没有提供完整信息。请查看服务商文档，填写准确数值。", context: "上下文长度", output: "最大输出", limitHint: "这两个数字通常可在服务商的模型说明中找到。", invalidLimits: "请填写有效的正整数，最大输出必须小于上下文长度，并为输入预留空间。", invalidName: "请填写未被使用的供应商名称。", invalidUrl: "请输入有效的 http 或 https 接口地址。", chooseOne: "请至少选择一个模型。", failed: "获取模型失败，请检查地址、密钥和接口类型，也可以手动添加。", noResults: "没有找到模型，可手动添加。", test: "测试模型", testing: "正在测试…", testHint: "测试会向服务商发送一次请求，可能产生费用。", testOk: "测试通过", testFailed: "测试失败", edit: "编辑模型", saveChanges: "保存修改", remove: "删除", removeQuestion: "确定删除？此操作会立即更新配置。", setDefault: "设为默认", defaultBadge: "默认", enabled: "已启用", hidden: "已隐藏", enable: "启用", hideModel: "隐藏", addModel: "添加模型", nameLabel: "显示名称", image: "支持图片输入", readError: "无法读取模型配置", retry: "重试", auth: "连接服务商", authHint: "选择你已有的服务商账号或 API 密钥。", syncedWarning: "配置已保存，但部分模型无法启用。请检查渠道认证及项目模型范围。", duplicate: "模型已存在。", saveError: "保存失败，请重试。", finishStep: "模型信息已准备好", ready: "确认模型后保存；也可以先进行测试。", statusSource: "模型信息来源", sourceEndpoint: "渠道", sourceCatalog: "模型目录", sourceManual: "手动填写", noSelection: "没有匹配的模型", showOther: "使用其他服务商", deleteProvider: "删除渠道", saveConnection: "保存连接", editConnectionHint: "更改连接信息后，可以重新获取模型。", completeMissing: "模型信息不完整", unverified: "连接尚未测试", loading: "正在加载…", restore: "恢复渠道", manageTitle: "模型管理", defaultModel: "默认模型", skipDiscovery: "手动添加模型", modelName: "模型名称", endpointOnly: "模型列表已获取；模型测试需单独进行。", providerList: "选择服务商", close: "关闭", costNotice: "已有高级配置会保留并继续生效。"
  },
  en: {
    title: "Model settings", subtitle: "Connect an AI service to start chatting", add: "Add provider", default: "Default model", none: "No models available yet", noneHint: "Add a provider and choose a model to start chatting.", custom: "Custom provider", account: "Use a provider account or API key", first: "New here?", tip1: "Enter your provider's API address", tip2: "Enter your API key", tip3: "Choose the models you want", vision: "Vision and fallback", visionHint: "Configure image understanding and fallback models", manage: "Manage models", settings: "Connection settings", configured: "Configured", noModels: "No models yet", back: "Back", connect: "Connect", choose: "Choose models", finish: "Finish", name: "Provider name", nameHint: "Choose a recognizable name, such as the service name.", address: "API address", addressHint: "Enter the API address supplied by your provider.", key: "API key", keyHint: "Enter the API key provided by your service; some local services require a placeholder key.", show: "Show key", hide: "Hide key", protocol: "API type", fetch: "Get available models", fetching: "Getting models…", cancel: "Cancel", where: "Where do I find these?", where1: "Find the API address in your provider's dashboard.", where2: "Create or copy an API key.", where3: "Enter them here and get available models.", select: "Choose models", search: "Search models", manual: "Can't find a model? Add it manually", manualId: "Model ID", manualAdd: "Add model", selected: "Selected", selectedUnit: "models", previous: "Back", next: "Continue", completing: "Completing model information…", save: "Save and finish", saving: "Saving…", saved: "Configuration saved", savedHint: "You can select enabled models in chat.", return: "Back to model settings", limits: "Complete model information", limitsHint: "The provider and catalog did not supply all required information. Check the provider's documentation for accurate values.", context: "Context length", output: "Maximum output", limitHint: "Find these values in the provider's model documentation.", invalidLimits: "Enter positive whole numbers; maximum output must be less than context length and leave room for input.", invalidName: "Enter a unique provider name.", invalidUrl: "Enter a valid http or https API address.", chooseOne: "Choose at least one model.", failed: "Could not get models. Check the address, key and API type, or add a model manually.", noResults: "No models found; add one manually.", test: "Test model", testing: "Testing…", testHint: "Testing sends one request to the provider and may incur a charge.", testOk: "Test passed", testFailed: "Test failed", edit: "Edit model", saveChanges: "Save changes", remove: "Delete", removeQuestion: "Delete this item? The configuration will be updated immediately.", setDefault: "Set default", defaultBadge: "Default", enabled: "Enabled", hidden: "Hidden", enable: "Enable", hideModel: "Hide", addModel: "Add model", nameLabel: "Display name", image: "Supports image input", readError: "Unable to load model configuration", retry: "Retry", auth: "Connect a provider", authHint: "Choose a provider account or API key.", syncedWarning: "Saved, but some models could not be enabled. Check provider authentication and project scope.", duplicate: "That model already exists.", saveError: "Save failed. Please retry.", finishStep: "Model information is ready", ready: "Review your models before saving; testing is optional.", statusSource: "Information source", sourceEndpoint: "Provider", sourceCatalog: "Model catalog", sourceManual: "Entered manually", noSelection: "No matching models", showOther: "Use another provider", deleteProvider: "Delete provider", saveConnection: "Save connection", editConnectionHint: "You can get models again after changing connection details.", completeMissing: "Model information incomplete", unverified: "Connection not tested", loading: "Loading…", restore: "Restore provider", manageTitle: "Manage models", defaultModel: "Default model", skipDiscovery: "Add a model manually", modelName: "Model name", endpointOnly: "Model list retrieved; test models separately.", providerList: "Choose a provider", close: "Close", costNotice: "Existing advanced settings are preserved and remain effective."
  },
} as const;

type View = { kind: "home" } | { kind: "picker" } | { kind: "auth"; mode: "api" | "oauth"; id: string } | { kind: "vision" } | { kind: "manage"; id: string } | { kind: "wizard"; id?: string } | { kind: "edit"; provider: string; index: number };


async function jsonRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const body = await response.json() as T & { error?: string };
  if (!response.ok || body.error) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

export function ModelsExperience({ cwd, onClose, onModelsChanged, embedded = false }: { cwd?: string; onClose: () => void; onModelsChanged?: () => void; embedded?: boolean }) {
  const { locale, t } = useI18n();
  const c = { ...(locale === "zh-CN" ? copy.zh : copy.en), ...(locale === "zh-CN" ? {
    importHint: "选择要添加的模型。接口缺失的参数已默认填入上下文 512K、最大输出不超过 65536 且不超过上下文的一半，可直接修改。", selectShown: "全选当前结果", pendingLimits: "待补全", importCount: "个模型",
    title: "模型设置", subtitle: "管理模型供应商，配置后可在聊天时选择使用。", add: "添加供应商", custom: "创建自定义供应商", name: "供应商名称", address: "Base URL", key: "API Key", protocol: "API 格式", context: "上下文窗口", output: "最大输出 Token", edit: "编辑模型配置", save: "保存", fetch: "一键识别可用模型", fetching: "正在识别…", limitsHint: "接口未提供完整参数，请按服务商文档补全以下字段。", endpointOnly: "以下模型来自当前接口。识别模型列表不会发送对话测试请求。",
    providers: "服务商", customGroup: "自定义供应商", other: "其他", models: "模型列表", newName: "新供应商", smart: "智能配置", advanced: "高级配置", reset: "重置表单", disableProvider: "禁用供应商", enableProvider: "启用供应商", refresh: "刷新", modelEmpty: "当前没有配置模型，添加模型后可在聊天中使用。", importTitle: "识别可用模型", importModels: "添加所选模型", chooseModel: "选择模型", reasoning: "支持深度思考", unsaved: "未保存", discardTitle: "放弃未保存的修改？", discardMessage: "切换后，本次填写的内容不会保存。", discardConfirm: "放弃修改", headers: "请求头 (JSON)", compat: "兼容配置 (JSON)", invalidJson: "请输入有效的 JSON 对象。"
  } : {
    importHint: "Choose models to add. Missing limits default to 512K context and up to 65536 output tokens (at most half the context); you can edit them below.", selectShown: "Select all results", pendingLimits: "Incomplete", importCount: "models",
    subtitle: "Manage model providers and choose their models in chat.", add: "Add provider", custom: "Create custom provider", name: "Provider name", address: "Base URL", key: "API Key", protocol: "API format", context: "Context window", output: "Max output tokens", edit: "Edit model configuration", save: "Save", fetch: "Detect available models", fetching: "Detecting…", limitsHint: "The endpoint did not provide all parameters. Complete the missing fields using your provider's documentation.", endpointOnly: "These models come from the current endpoint. Discovery does not send a chat test request.",
    providers: "Providers", customGroup: "Custom providers", other: "Other", models: "Models", newName: "New provider", smart: "Smart configuration", advanced: "Advanced configuration", reset: "Reset form", disableProvider: "Disable provider", enableProvider: "Enable provider", refresh: "Refresh", modelEmpty: "No models configured. Add a model to use it in chat.", importTitle: "Available models", importModels: "Add selected models", chooseModel: "Choose a model", reasoning: "Reasoning", unsaved: "Unsaved", discardTitle: "Discard unsaved changes?", discardMessage: "Your changes will be lost when you switch.", discardConfirm: "Discard", headers: "Request headers (JSON)", compat: "Compatibility (JSON)", invalidJson: "Enter a valid JSON object."
  }) };
  const rootRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ kind: "home" });
  const [config, setConfig] = useState<ModelsJson>({ providers: {} });
  const [scope, setScope] = useState<ModelScopeResponse | null>(null);
  const [providerOrder, setProviderOrder] = useState<string[]>([]);
  const [oauth, setOauth] = useState<OAuthProvider[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKeyProvider[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const requestRef = useRef(0);
  const query = "?scope=global";
  useFocusTrap(rootRef, !embedded && !modalOpen, { onEscape: busy ? undefined : () => { void closeSettings(); } });

  const reload = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true); setError(null);
    try {
      const [nextConfig, nextScope, nextOAuth, nextApi, nextOrder] = await Promise.all([
        jsonRequest<ModelsJson>("/api/models-config", { cache: "no-store" }),
        jsonRequest<ModelScopeResponse>(`/api/models/scope${query}`, { cache: "no-store" }),
        jsonRequest<{ providers: OAuthProvider[] }>("/api/auth/providers", { cache: "no-store" }),
        jsonRequest<{ providers: ApiKeyProvider[] }>("/api/auth/all-providers", { cache: "no-store" }),
        jsonRequest<{ providers: string[] }>("/api/models/provider-order", { cache: "no-store" }),
      ]);
      if (request !== requestRef.current) return;
      setConfig(nextConfig); setScope(nextScope); setOauth(nextOAuth.providers ?? []); setApiKeys(nextApi.providers ?? []);
      setProviderOrder(nextOrder.providers ?? []);
    } catch (cause) { if (request === requestRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (request === requestRef.current) setLoading(false); }
  }, [query]);
  useEffect(() => { const requests = requestRef; void reload(); return () => { ++requests.current; }; }, [reload]);

  const scopeAction = async (action: string, provider: string, id?: string) => {
    const result = await jsonRequest<ModelScopeResponse>("/api/models/scope", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, provider, ...(id ? { id } : {}), scope: "global" }) });
    setScope(result); onModelsChanged?.(); return result;
  };

  const saveProvider = async (name: string, provider: ProviderEntry, newModels: ModelEntry[], originalName?: string) => {
    setBusy(true); setError(null); setWarning(null);
    try {
      const current = await jsonRequest<ModelsJson>("/api/models-config", { cache: "no-store" });
      const providers = { ...(current.providers ?? {}) };
      if ((!originalName || name !== originalName) && Object.hasOwn(providers, name)) throw new Error(c.invalidName);
      if (originalName && !Object.hasOwn(providers, originalName)) throw new Error(c.readError);
      if (originalName && JSON.stringify(providers[originalName]) !== JSON.stringify(config.providers?.[originalName])) throw new Error(locale === "zh-CN" ? "渠道配置已被其他操作修改，请返回并刷新后重试。" : "The provider changed elsewhere. Go back and refresh before retrying.");
      if (originalName && name !== originalName) delete providers[originalName];
      const normalizedProvider = provider.apiKey === "" ? { ...provider, apiKey: undefined } : provider;
      const next = { ...current, providers: { ...providers, [name]: normalizedProvider } };
      validateCustomModelLimits(stripModelLimitUiMeta(next), current);
      await jsonRequest("/api/models-config", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(stripModelLimitUiMeta(next)) });
      setDirty(false);
      onModelsChanged?.();
      let syncFailed = false;
      const modelsToEnable = originalName && originalName !== name ? (provider.models ?? []) : newModels;
      let refreshedScope: ModelScopeResponse | null = null;
      if (modelsToEnable.length > 0) {
        try { refreshedScope = await jsonRequest<ModelScopeResponse>(`/api/models/scope${query}`, { cache: "no-store" }); }
        catch { /* The restore calls below provide a second chance. */ }
      }
      for (const model of modelsToEnable) {
        if (refreshedScope?.models.some(item => item.provider === name && item.id === model.id && item.enabled)) continue;
        try { await scopeAction("restore", name, model.id); } catch { syncFailed = true; }
      }
      if (syncFailed) setWarning(c.syncedWarning);
      onModelsChanged?.();
      await reload();
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { setBusy(false); }
  };

  const mutate = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const remove = async (provider: string, id?: string) => {
    if (!await requestConfirmation({ title: c.remove, message: c.removeQuestion, confirmLabel: c.remove, tone: "danger" })) return;
    await mutate(async () => { await jsonRequest("/api/models-config", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, ...(id ? { id } : {}) }) }); onModelsChanged?.(); if (!id) setView({ kind: "home" }); });
  };

  const removedProviders = new Set(scope?.removedProviders ?? []);
  const providerIds = orderByProvider([...new Set([...apiKeys.filter(item => item.configured).map(item => item.id), ...oauth.filter(item => item.loggedIn).map(item => item.id), ...Object.keys(config.providers ?? {})])].filter(id => !removedProviders.has(id)), [...providerOrder, ...(scope?.models ?? []).map(model => model.provider)], id => id);
  const reorderProviders = async (ids: string[]) => {
    if (busy || loading) return;
    setBusy(true); setError(null);
    try {
      const result = await jsonRequest<{ providers: string[] }>("/api/models/provider-order", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providers: [...ids, ...providerOrder.filter(id => !ids.includes(id))] }) });
      setProviderOrder(result.providers);
      if (view.kind === "home" && providerIds[0]) setView({ kind: "manage", id: providerIds[0] });
      onModelsChanged?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const authRefresh = () => { onModelsChanged?.(); void reload(); };
  const leaveView = async () => {
    if (dirty && !await requestConfirmation({ title: locale === "zh-CN" ? "放弃未保存的修改？" : "Discard unsaved changes?", message: locale === "zh-CN" ? "返回后，本次填写的内容不会保存。" : "Your changes will be lost when you leave.", confirmLabel: locale === "zh-CN" ? "放弃修改" : "Discard", tone: "danger" })) return false;
    setDirty(false); setView({ kind: "home" }); setError(null);
    return true;
  };
  const closeSettings = async () => { if (!busy && await leaveView()) onClose(); };
  const selectedProvider = view.kind === "manage" || view.kind === "wizard" ? view.id ?? "" : view.kind === "home" ? providerIds[0] ?? "" : "";
  const selectProvider = async (id: string) => {
    if (dirty && !await requestConfirmation({ title: c.discardTitle, message: c.discardMessage, confirmLabel: c.discardConfirm, tone: "danger" })) return;
    setDirty(false); setError(null); setView({ kind: "manage", id });
  };

  const catalogIds = [...new Set([...apiKeys.map(p => p.id), ...oauth.map(p => p.id), ...Object.keys(config.providers ?? {}).filter(id => removedProviders.has(id))])];
  const displayName = (id: string) => apiKeys.find(p => p.id === id)?.displayName ?? oauth.find(p => p.id === id)?.name ?? id;
  const openCatalog = async () => { if (await leaveView()) setView({ kind: "picker" }); };
  const custom = config.providers?.[selectedProvider];
  const switchScope = (action: string, id?: string) => void mutate(async () => { await scopeAction(action, selectedProvider, id); });
  return <div ref={rootRef} className={styles.root} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-label={c.title}>
    <div className={styles.page}>
      <header className={styles.header}><h2>{c.title}</h2>{!embedded && <IconButton label={c.close} icon="close" onClick={() => void closeSettings()} disabled={busy} />}</header>
      <div className={styles.toolbar}><p>{c.subtitle}</p><IconButton label={c.refresh} icon="refresh" disabled={busy || loading || dirty} onClick={() => void reload()} /><button className={styles.primary} disabled={busy} onClick={() => void openCatalog()}><Glyph name="plus" />{c.add}</button></div>
      {error && <div className={styles.error} role="alert"><ModelErrorText value={error} /></div>}
      {warning && <div className={styles.notice} role="status">{warning}</div>}
      <div className={styles.workspace}>
        <nav className={styles.sidebar} aria-label={c.providers}>
          <h3>{c.providers}</h3>
          <p className={styles.orderHint}>{locale === "zh-CN" ? "首个渠道的第一个可用模型用于新对话" : "New chats use the first available model in channel order"}</p>
          <ProviderOrderList ids={providerIds} selected={selectedProvider} disabled={busy || loading} locale={locale} displayName={displayName} enabled={id => (scope?.models ?? []).some(m => m.provider === id && m.enabled)} onSelect={id => void selectProvider(id)} onReorder={ids => void reorderProviders(ids)} />
          {view.kind === "wizard" && !view.id && <button className={styles.navItem} aria-current="page"><ModelProviderIcon provider="custom" size={18} /><span>{c.newName}</span><i className={styles.pendingDot} /></button>}
          <button className={styles.navItem} disabled={busy} onClick={() => void openCatalog()}><Glyph name="plus" /><span>{c.add}</span></button>
          <button className={`${styles.navItem} ${styles.secondaryNav}`} disabled={busy || dirty} aria-current={view.kind === "vision" ? "page" : undefined} onClick={() => setView({ kind: "vision" })}>{c.vision}</button>
        </nav>
        <main className={styles.detail}>
          {loading && !providerIds.length && <p className={styles.hint}>{c.loading}</p>}
          {(view.kind === "picker" || (view.kind === "home" && !selectedProvider && !loading)) && <><h3 className={styles.panelTitle}>{c.add}</h3><p className={styles.groupLabel}>{c.other}</p><div className={styles.catalog}><button className={styles.catalogItem} onClick={() => setView({ kind: "wizard" })}><Glyph name="plus" /><span>{c.custom}</span><span>›</span></button>{catalogIds.map(id => <button className={styles.catalogItem} key={id} disabled={busy} onClick={() => {
            if (removedProviders.has(id)) void mutate(async () => { await scopeAction("restore-removed-provider", id); setView({ kind: "manage", id }); });
            else void selectProvider(id);
          }}><ModelProviderIcon provider={id} size={28} /><span>{displayName(id)}</span><span>{removedProviders.has(id) ? c.restore : "›"}</span></button>)}</div></>}
          {view.kind === "vision" && <div className={styles.extras}><h3>{c.vision}</h3><ModelFallbackSetting /><VisionAgentDetail cwd={cwd} /></div>}
          {((["home", "manage"].includes(view.kind) && custom) || view.kind === "wizard") && <ProviderPanel key={custom ? `${selectedProvider}:${JSON.stringify(custom)}` : "new"} c={c}
            existingNames={Object.keys(config.providers ?? {})} initialName={custom ? selectedProvider : undefined} initial={custom} scope={scope} busy={busy} onDirty={setDirty} onModal={setModalOpen} saveError={error}
            onScope={switchScope} onRemove={id => void remove(selectedProvider, id)}
            saveProvider={async (name, provider, additions, original) => { const saved = await saveProvider(name, provider, additions, original); if (saved) setView({ kind: "manage", id: name }); return saved; }} />}
          {["home", "manage"].includes(view.kind) && selectedProvider && !custom && <BuiltinPanel key={selectedProvider} c={c} id={selectedProvider} name={displayName(selectedProvider)} api={apiKeys.find(p => p.id === selectedProvider)} oauth={oauth.find(p => p.id === selectedProvider)} scope={scope} busy={busy} onRefresh={authRefresh} onScope={switchScope} onRemove={async () => {
            if (!await requestConfirmation({ title: t("models.removeProvider"), message: t("models.removeProviderConfirm", { name: displayName(selectedProvider) }), confirmLabel: t("models.removeProvider"), tone: "danger" })) return;
            await mutate(async () => { await scopeAction("remove-provider", selectedProvider); setView({ kind: "home" }); });
          }} />}
        </main>
      </div>
    </div>
  </div>;
}

type Text = { [K in keyof typeof copy.zh]: string } & Record<"providers" | "customGroup" | "other" | "models" | "newName" | "smart" | "advanced" | "reset" | "disableProvider" | "enableProvider" | "refresh" | "modelEmpty" | "importTitle" | "importModels" | "chooseModel" | "reasoning" | "unsaved" | "headers" | "compat" | "invalidJson" | "discardTitle" | "discardMessage" | "discardConfirm" | "importHint" | "selectShown" | "pendingLimits" | "importCount", string>;
type SaveProvider = (name: string, provider: ProviderEntry, additions: ModelEntry[], original?: string) => Promise<boolean>;
type GlyphName = "plus" | "edit" | "trash" | "test" | "refresh" | "star" | "close" | "eye";
function Glyph({ name }: { name: GlyphName }) {
  const paths = { plus: "M12 5v14M5 12h14", edit: "m16 3 5 5-12 12-6 1 1-6Z M14 5l5 5", trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7", test: "m8 3 4 4-5 5-4-4Zm8 18-4-4 5-5 4 4ZM10 10l4 4M2 2l3 3m14 14 3 3", refresh: "M20 7a9 9 0 1 0 1 8M20 2v6h-6", star: "m12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z", close: "m6 6 12 12M6 18 18 6", eye: "M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6" };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
function IconButton({ label, tooltip = label, icon, onClick, disabled }: { label: string; tooltip?: string; icon: GlyphName; onClick: () => void; disabled?: boolean }) {
  return <button type="button" className={styles.iconButton} aria-label={label} title={tooltip} onClick={onClick} disabled={disabled}><Glyph name={icon} /></button>;
}
function Toggle({ checked, label, disabled, onChange }: { checked: boolean; label: string; disabled?: boolean; onChange: () => void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} className={styles.toggle} disabled={disabled} onClick={onChange}><span /></button>;
}
function ProviderPanel({ c, existingNames, initialName, initial, scope, busy, saveProvider, onDirty, onScope, onRemove, onModal, saveError }: {
  c: Text; existingNames: string[]; initialName?: string; initial?: ProviderEntry; scope: ModelScopeResponse | null; busy: boolean; saveProvider: SaveProvider;
  onDirty: (dirty: boolean) => void; onScope: (action: string, id?: string) => void; onRemove: (id?: string) => void;
  onModal: (open: boolean) => void; saveError: string | null;
}) {
  const [name, setName] = useState(() => {
    if (initialName !== undefined) return initialName;
    let candidate = c.newName;
    let suffix = 1;
    while (existingNames.includes(candidate)) candidate = `${c.newName}-${suffix++}`;
    return candidate;
  });
  const [provider, setProvider] = useState<ProviderEntry>(initial ?? { api: "openai-completions", models: [] });
  const [showKey, setShowKey] = useState(false);
  const [changed, setChanged] = useState(!initialName);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ModelEntry | null>(null);
  const [importing, setImporting] = useState<DiscoveredModel[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  useEffect(() => { onModal(!!editing || !!importing); return () => onModal(false); }, [editing, importing, onModal]);
  const discoveryRef = useRef<ReturnType<typeof createDiscoveryAbort> | null>(null);
  const [testStatus, setTestStatus] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const drag = useRef<{ id: string; target: string; active: boolean; timer: ReturnType<typeof setTimeout> } | null>(null);
  const { locale } = useI18n();
  const dragLabel = locale === "zh-CN" ? "长按拖动调整模型顺序，也可用 Alt + 上下方向键" : "Hold to reorder; Alt + arrow keys also move models";
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 4000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => () => { if (drag.current) clearTimeout(drag.current.timer); }, []);
  const models = provider.models ?? [];
  const managed = (scope?.models ?? []).filter(m => m.provider === initialName);
  const ids = [...new Set([...models.map(m => m.id), ...managed.map(m => m.id)])];
  const enabled = managed.some(m => m.enabled);
  useEffect(() => () => { discoveryRef.current?.cancel(); discoveryRef.current?.dispose(); }, []);
  const update = (patch: Partial<ProviderEntry>) => { setProvider(current => ({ ...current, ...patch })); setChanged(true); onDirty(true); };
  const valid = () => {
    if (!name.trim()) { setError(c.invalidName); return false; }
    try { if (!/^https?:$/.test(new URL(provider.baseUrl?.trim() ?? "").protocol)) throw new Error(); }
    catch { setError(c.invalidUrl); return false; }
    setError(null); return true;
  };
  const save = async (next = provider, additions: ModelEntry[] = []) => {
    if (!valid()) return false;
    const result = await saveProvider(name.trim(), { ...next, baseUrl: next.baseUrl?.trim() }, additions, initialName);
    if (result) { setChanged(false); onDirty(false); }
    return result;
  };
  const discover = async () => {
    if (!valid()) return;
    const controller = createDiscoveryAbort(); discoveryRef.current = controller; setDiscovering(true);
    try {
      const result = await requestDiscoveredModels({ providerName: name.trim(), provider, signal: controller.signal });
      if (!controller.signal.aborted) setImporting(result.models);
    } catch (cause) { if (!controller.signal.aborted || controller.timedOut()) setError(`${c.failed} ${cause instanceof Error ? cause.message : ""}`); }
    finally { controller.dispose(); if (discoveryRef.current === controller) { discoveryRef.current = null; setDiscovering(false); } }
  };
  const testModel = async (model: ModelEntry) => {
    if (!valid()) return;
    setTesting(model.id);
    setToast(null);
    try {
      const result = await jsonRequest<{ ok: boolean }>("/api/models-config/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerName: name.trim(), provider, model }) });
      setTestStatus(current => ({ ...current, [model.id]: result.ok ? c.testOk : c.testFailed }));
      if (result.ok) { setToast(`${model.name || model.id} · ${c.testOk}`); setTestStatus(current => { const next = { ...current }; delete next[model.id]; return next; }); }
    } catch (cause) { setTestStatus(current => ({ ...current, [model.id]: `${c.testFailed}: ${cause instanceof Error ? cause.message : String(cause)}` })); }
    finally { setTesting(null); }
  };
  const locked = busy || discovering;
  const reorder = async (from: string, to: string) => {
    if (locked || changed || from === to) return;
    const next = [...models], start = next.findIndex(m => m.id === from), end = next.findIndex(m => m.id === to);
    if (start < 0 || end < 0) return;
    next.splice(end, 0, ...next.splice(start, 1));
    await save({ ...provider, models: next });
  };
  const finishDrag = (cancelled = false) => {
    const current = drag.current;
    if (!current) return;
    clearTimeout(current.timer); drag.current = null; setDragging(null); setDropTarget(null);
    if (current.active && !cancelled) void reorder(current.id, current.target);
  };
  return <>
    <div className={styles.providerHeader}><ModelProviderIcon provider={name} size={20} /><input className={styles.providerName} aria-label={c.name} value={name} disabled={locked} onChange={e => { setName(e.target.value); setChanged(true); onDirty(true); }} />
      {initialName && <><Toggle checked={enabled} label={enabled ? c.disableProvider : c.enableProvider} disabled={locked || changed || scope?.projectOverride || !managed.length} onChange={() => onScope(enabled ? "hide-provider" : "restore-provider")} /><IconButton label={c.deleteProvider} icon="trash" onClick={() => onRemove()} disabled={locked || changed} /></>}
    </div>
    <label className={styles.field}><span>{c.address}</span><input value={provider.baseUrl ?? ""} placeholder="https://api.example.com/v1" disabled={locked} onChange={e => update({ baseUrl: e.target.value })} /></label>
    <label className={styles.field}><span>{c.protocol}</span><select value={provider.api ?? "openai-completions"} disabled={locked} onChange={e => update({ api: e.target.value })}>{API_OPTIONS.map(api => <option value={api} key={api}>{({ "openai-completions": "Chat Completions (/chat/completions)", "openai-responses": "Responses (/responses)", "anthropic-messages": "Anthropic Messages (/v1/messages)", "google-generative-ai": "Google Generative AI" })[api]}</option>)}</select></label>
    <div className={styles.field}><label htmlFor="provider-secret">{c.key}</label><div className={styles.secret}><input id="provider-secret" type={showKey ? "text" : "password"} value={provider.apiKey ?? ""} autoComplete="off" placeholder="API Key" disabled={locked} onChange={e => update({ apiKey: e.target.value })} /><IconButton label={showKey ? c.hide : c.show} icon="eye" onClick={() => setShowKey(!showKey)} /></div></div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {changed && <div className={styles.saveBar}><span className={styles.hint}>{c.unsaved}</span><button className={styles.primary} disabled={locked} onClick={() => void save()}>{busy ? c.saving : c.saveConnection}</button></div>}
    <div className={styles.listHeading}><span>{c.models}</span><div className={styles.actions}><button className={styles.button} disabled={locked} onClick={() => void discover()}><Glyph name="refresh" />{discovering ? c.fetching : c.fetch}</button><button className={styles.button} disabled={locked} onClick={() => { if (valid()) setEditing({ id: "" }); }}><Glyph name="plus" />{c.addModel}</button></div></div>
    <div className={styles.modelList}>
      {!ids.length && <p className={styles.empty}>ⓘ &nbsp;{c.modelEmpty}</p>}
      {ids.map(id => {
        const model = models.find(m => m.id === id), row = managed.find(m => m.id === id);
        return <div className={styles.modelRow} key={id} data-model-id={id} data-dragging={dragging === id} data-drop-target={dropTarget === id && dragging !== id}><div className={styles.modelLine}>
          <div className={styles.modelIdentity} role={model ? "button" : undefined} tabIndex={model ? 0 : undefined} aria-label={model ? `${dragLabel}: ${id}` : undefined} title={model ? dragLabel : undefined}
            onPointerDown={e => { if (!model || locked || changed || e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); const current = { id, target: id, active: false, timer: setTimeout(() => { current.active = true; setDragging(id); }, 250) }; drag.current = current; }}
            onPointerMove={e => { const current = drag.current; if (!current?.active) return; const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-model-id]")?.dataset.modelId; if (target && models.some(m => m.id === target)) { current.target = target; setDropTarget(target); } }}
            onPointerUp={() => finishDrag()} onPointerCancel={() => finishDrag(true)} onLostPointerCapture={() => finishDrag(true)}
            onKeyDown={e => { if (e.key === "Escape") finishDrag(true); if (!e.altKey || !["ArrowUp", "ArrowDown"].includes(e.key)) return; e.preventDefault(); const index = models.findIndex(m => m.id === id), target = models[index + (e.key === "ArrowUp" ? -1 : 1)]; if (target) void reorder(id, target.id); }}>
            <span>{model?.name || row?.name || id}</span>{model?.contextWindow && <small className={styles.contextBadge} title={`${c.context}: ${Intl.NumberFormat().format(model.contextWindow)}`}>{model.contextWindow >= 1000000 ? `${Number((model.contextWindow / 1000000).toFixed(1))}M` : model.contextWindow >= 1000 ? `${Number((model.contextWindow / 1000).toFixed(1))}K` : model.contextWindow}</small>}{model?.input?.includes("image") && <small className={styles.contextBadge}>{locale === "zh-CN" ? "视觉" : "Vision"}</small>}</div>
          {model && <IconButton label={`${c.test} ${id}`} tooltip={locale === "zh-CN" ? "测试连接" : "Test connection"} icon="test" disabled={locked || testing !== null} onClick={() => void testModel(model)} />}
          {model && <><IconButton label={`${c.edit} ${id}`} icon="edit" disabled={locked} onClick={() => setEditing(model)} /><IconButton label={`${c.remove} ${id}`} icon="trash" disabled={locked || changed} onClick={() => onRemove(id)} /></>}
          {row && <Toggle checked={row.enabled} label={`${row.enabled ? c.hideModel : c.enable} ${id}`} disabled={locked || changed || scope?.projectOverride} onChange={() => onScope(row.enabled ? "hide" : "restore", id)} />}
        </div>{(testStatus[id] || testing === id) && <div className={styles.testResult} role="status"><ModelErrorText value={testing === id ? c.testing : testStatus[id]} /></div>}</div>;
      })}
    </div>
    {!!ids.length && <p className={styles.footnote}>{c.testHint}</p>}
    {toast && <div className={styles.testToast} role="status">✓ {toast}</div>}
    {scope?.projectOverride && <p className={styles.hint}>{c.syncedWarning}</p>}
    {editing && <ModelDialog c={c} model={editing} provider={provider} providerName={name.trim()} existingIds={models.map(m => m.id)} busy={busy} saveError={saveError} onClose={() => setEditing(null)} onSave={async model => {
      const exists = !!editing.id;
      if (await save({ ...provider, models: exists ? models.map(m => m.id === editing.id ? model : m) : [...models, model] }, exists ? [] : [model])) setEditing(null);
    }} />}
    {importing && <ImportDialog c={c} providerName={name} onProviderNameChange={value => { setName(value); setChanged(true); onDirty(true); }} incoming={importing} existingIds={models.map(m => m.id)} busy={busy} saveError={saveError} onClose={() => setImporting(null)} onSave={async additions => { if (await save({ ...provider, models: [...models, ...additions] }, additions)) setImporting(null); }} />}
  </>;
}

function BuiltinPanel({ c, id, name, api, oauth, scope, busy, onRefresh, onScope, onRemove }: {
  c: Text; id: string; name: string; api?: ApiKeyProvider; oauth?: OAuthProvider; scope: ModelScopeResponse | null; busy: boolean;
  onRefresh: () => void; onScope: (action: string, id?: string) => void; onRemove: () => Promise<void>;
}) {
  const [mode, setMode] = useState(oauth?.loggedIn || !api ? "oauth" : "api");
  const { t } = useI18n();
  const models = (scope?.models ?? []).filter(m => m.provider === id), enabled = models.some(m => m.enabled);
  return <><div className={styles.providerHeader}><ModelProviderIcon provider={id} size={20} /><h3>{name}</h3>{api && oauth && <select aria-label={c.settings} value={mode} onChange={e => setMode(e.target.value)}><option value="api">API Key</option><option value="oauth">OAuth</option></select>}<Toggle checked={enabled} label={enabled ? c.disableProvider : c.enableProvider} disabled={busy || !models.length || scope?.projectOverride} onChange={() => onScope(enabled ? "hide-provider" : "restore-provider")} /><IconButton label={t("models.removeProvider")} icon="trash" disabled={busy} onClick={() => void onRemove()} /></div>
    <div className={styles.auth}>{mode === "api" && api ? <ApiKeyDetail provider={api} onRefresh={onRefresh} /> : oauth ? <OAuthDetail provider={oauth} onRefresh={onRefresh} /> : null}</div>
    <div className={styles.listHeading}>{c.models}</div><div className={styles.modelList}>{models.length ? models.map(model => <div className={styles.modelRow} key={model.id}><div className={styles.modelLine}><div className={styles.modelIdentity}>{model.name || model.id}</div><Toggle checked={model.enabled} label={`${model.enabled ? c.hideModel : c.enable} ${model.id}`} disabled={busy || scope?.projectOverride} onChange={() => onScope(model.enabled ? "hide" : "restore", model.id)} /></div></div>) : <p className={styles.empty}>{c.modelEmpty}</p>}</div></>;
}

function Modal({ title, children, onClose, busy, c, className = "" }: { title: string; children: React.ReactNode; onClose: () => void; busy: boolean; c: Text; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, { onEscape: busy ? undefined : onClose });
  return <div className={styles.backdrop}><div className={`${styles.dialog} ${className}`} ref={ref} role="dialog" aria-modal="true" aria-label={title}><div className={styles.dialogTitle}><h3>{title}</h3><IconButton label={c.close} icon="close" disabled={busy} onClick={onClose} /></div>{children}</div></div>;
}
function LimitInputs({ model, c, onChange }: { model: ModelEntry; c: Text; onChange: (patch: Partial<ModelEntry>) => void }) {
  return <><label className={styles.field}><span>{c.context}</span><input type="number" min="1" value={model.contextWindow ?? ""} onChange={e => onChange({ contextWindow: parseModelLimitDraft(e.target.value) })} /></label><label className={styles.field}><span>{c.output}</span><input type="number" min="1" value={model.maxTokens ?? ""} onChange={e => onChange({ maxTokens: parseModelLimitDraft(e.target.value) })} /></label></>;
}
function ModelDialog({ c, model, provider, providerName, existingIds, busy, onClose, onSave, saveError }: {
  c: Text; model: ModelEntry; provider: ProviderEntry; providerName: string; existingIds: string[]; busy: boolean; onClose: () => void; onSave: (next: ModelEntry) => Promise<void>;
  saveError: string | null;
}) {
  const [draft, setDraft] = useState<ModelEntry>({ ...model });
  const [smart, setSmart] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredModel[] | null>(null);
  const touched = useRef(new Set<string>());
  const dirty = useRef(false);
  const id = draft.id.trim();
  useEffect(() => {
    if (!smart || !id || discovered) { setFetching(false); return; }
    const controller = createDiscoveryAbort();
    const timer = setTimeout(async () => {
      setFetching(true);
      try {
        const result = await requestDiscoveredModels({ providerName, provider, signal: controller.signal });
        if (!controller.signal.aborted) setDiscovered(result.models);
      } catch { if (!controller.signal.aborted || controller.timedOut()) setDiscovered([]); }
      finally { controller.dispose(); if (!controller.signal.aborted || controller.timedOut()) setFetching(false); }
    }, 350);
    return () => { clearTimeout(timer); controller.cancel(); controller.dispose(); };
  }, [smart, id, discovered, provider, providerName]);
  useEffect(() => {
    if (!smart) return;
    const endpoint = discovered?.find(item => item.id === id);
    if (!endpoint) return;
    setDraft(current => {
      const next = { ...current };
      for (const field of ["contextWindow", "maxTokens"] as const) {
        if (!touched.current.has(field) && current[field] === undefined) next[field] = endpoint[field];
      }
      return next;
    });
  }, [id, discovered, smart]);
  const change = (patch: Partial<ModelEntry>) => {
    dirty.current = true; Object.keys(patch).forEach(key => touched.current.add(key));
    setDraft(current => ({ ...current, ...patch })); setError(null);
  };
  const changeId = (value: string) => { touched.current.clear(); dirty.current = true; setDraft({ id: value }); setError(null); };
  const close = async () => {
    if (busy) return;
    if (dirty.current && !await requestConfirmation({ title: c.discardTitle, message: c.discardMessage, confirmLabel: c.discardConfirm, tone: "danger" })) return;
    onClose();
  };
  const save = async () => {
    if (!id) { setError(c.manualId); return; }
    if (!model.id && existingIds.includes(id)) { setError(c.duplicate); return; }
    if (modelLimitProblem(draft)) { setError(c.invalidLimits); return; }
    const samplingError = modelSamplingError(draft);
    if (samplingError) { setError(samplingError); return; }
    setError(null);
    await onSave({ ...draft, id });
  };
  return <Modal title={model.id ? c.edit : c.addModel} onClose={() => void close()} busy={busy} c={c}>
    <div className={styles.smart}><span>{c.smart} ⓘ</span><Toggle checked={smart} label={c.smart} onChange={() => { setSmart(!smart); setFetching(false); }} disabled={busy} /></div>
    <div className={styles.dialogBody}><fieldset className={styles.dialogFields} disabled={busy}>
      <label className={styles.field}><span>{c.manualId}</span><input value={draft.id} placeholder={c.manualId} readOnly={!!model.id} onChange={e => changeId(e.target.value)} /></label>
      <LimitInputs model={draft} c={c} onChange={change} />
      {fetching && <p className={styles.hint} role="status">{c.fetching}</p>}
      {discovered && !fetching && modelLimitProblem(draft) && <p className={styles.hint}>{c.limitsHint}</p>}
      <details className={styles.advanced}><summary>{c.advanced}</summary><label className={styles.field}><span>{c.nameLabel}</span><input value={draft.name ?? ""} onChange={e => change({ name: e.target.value || undefined })} /></label><label className={styles.check}><input type="checkbox" checked={draft.input?.includes("image") ?? false} onChange={e => change({ input: e.target.checked ? ["text", "image"] : ["text"] })} />{c.image}</label><label className={styles.check}><input type="checkbox" checked={draft.reasoning ?? false} onChange={e => change({ reasoning: e.target.checked })} />{c.reasoning}</label><ModelSamplingEditor providerName={providerName} provider={provider} model={draft} onChange={change} /></details>
      {(error || saveError) && <div className={styles.error} role="alert"><ModelErrorText value={error || saveError || ""} /></div>}
    </fieldset></div>
    <div className={styles.dialogFooter}><button className={styles.link} disabled={busy} onClick={() => { touched.current.clear(); setDraft({ ...model }); setError(null); dirty.current = false; }}>{c.reset}</button><button className={styles.quiet} disabled={busy} onClick={() => void close()}>{c.cancel}</button><button className={styles.primary} disabled={busy || fetching} onClick={() => void save()}>{busy ? c.saving : c.save}</button></div>
  </Modal>;
}
function ImportDialog({ c, providerName, onProviderNameChange, incoming, existingIds, busy, onClose, onSave, saveError }: {
  c: Text; providerName: string; onProviderNameChange: (name: string) => void; incoming: DiscoveredModel[]; existingIds: string[]; busy: boolean; saveError: string | null; onClose: () => void; onSave: (models: ModelEntry[]) => Promise<void>;
}) {
  const [models, setModels] = useState<ModelEntry[]>(() => incoming.filter(m => !existingIds.includes(m.id))
    .map(m => applyEndpointLimits({ id: m.id, name: m.name }, m).model));
  // Keep fields mounted after the last missing value is entered so focus and
  // edits survive validation, selection changes and search round trips.
  const [editableIds] = useState(() => new Set(incoming.filter(modelLimitProblem).map(m => m.id)));
  const [selected, setSelected] = useState(() => new Set(models.map(m => m.id)));
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const chosen = models.filter(m => selected.has(m.id));
  const pendingCount = chosen.filter(modelLimitProblem).length;
  const filtered = models.filter(m => `${m.name ?? ""} ${m.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  const selectedShown = filtered.filter(m => selected.has(m.id)).length;
  const allShownSelected = filtered.length > 0 && selectedShown === filtered.length;
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectedShown > 0 && !allShownSelected;
  }, [selectedShown, allShownSelected]);
  useEffect(() => {
    if (error) bodyRef.current?.querySelector<HTMLInputElement>('input[aria-invalid="true"]')?.focus();
  }, [error]);
  const select = (ids: string[], checked: boolean) => {
    setSelected(current => {
      const next = new Set(current);
      for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
      return next;
    });
    setError(null);
  };
  const save = async () => {
    if (!providerName.trim()) { setError(c.invalidName); return; }
    if (!chosen.length) { setError(c.chooseOne); return; }
    if (pendingCount) { setSearch(""); setError(c.invalidLimits); return; }
    setError(null);
    await onSave(chosen);
  };
  return <Modal title={c.importTitle} c={c} busy={busy} onClose={onClose} className={styles.importDialog}>
    <label className={styles.field}><span>{c.name}</span><input value={providerName} disabled={busy} placeholder={c.nameHint} onChange={e => { onProviderNameChange(e.target.value); setError(null); }} /></label>
    <p className={styles.importHint}>{c.importHint}</p>
    <div className={styles.importToolbar}>
      <input className={styles.importSearch} type="search" aria-label={c.search} placeholder={c.search} value={search} disabled={busy} onChange={e => setSearch(e.target.value)} />
      <span className={styles.importCount}>{filtered.length} / {models.length} {c.importCount}</span>
    </div>
    <div className={styles.importColumns}>
      <label className={styles.importSelectAll}><input ref={selectAllRef} type="checkbox" aria-label={c.selectShown} checked={allShownSelected} disabled={busy || !filtered.length} onChange={e => select(filtered.map(m => m.id), e.target.checked)} /><span>{c.selectShown}</span></label>
      <span>{c.context}</span><span>{c.output}</span>
    </div>
    <div className={`${styles.dialogBody} ${styles.importBody}`} ref={bodyRef}>
      <fieldset disabled={busy} className={styles.dialogFields}>
        {!filtered.length && <p className={styles.empty}>{models.length ? c.noSelection : incoming.length ? c.duplicate : c.noResults}</p>}
        {filtered.map(model => {
          const checked = selected.has(model.id);
          const problem = modelLimitProblem(model);
          return <div className={styles.importRow} key={model.id} data-selected={checked}>
            <label className={styles.importChoice}>
              <input type="checkbox" checked={checked} onChange={e => select([model.id], e.target.checked)} />
              <span className={styles.importIdentity} title={model.name ? `${model.name}\n${model.id}` : model.id}>
                <strong>{model.name || model.id}</strong>
                {model.name && model.name !== model.id && <small>{model.id}</small>}
              </span>
            </label>
            {(["contextWindow", "maxTokens"] as const).map(field => {
              const label = field === "contextWindow" ? c.context : c.output;
              const value = model[field];
              return <label className={styles.importLimit} key={field}>
                <span className={styles.importLimitLabel}>{label}</span>
                {editableIds.has(model.id) ? <input type="number" min="1" step="1" placeholder="—" disabled={!checked} value={value ?? ""}
                  aria-invalid={!!error && checked && !!problem && ("field" in problem ? problem.field === field : field === "maxTokens")}
                  onChange={e => { const next = parseModelLimitDraft(e.target.value); setModels(current => current.map(m => m.id === model.id ? { ...m, [field]: next } : m)); setError(null); }} />
                  : <span className={styles.importValue} title={`${label}: ${value ?? "—"}`}>{value === undefined ? "—" : value >= 1000000 ? `${Number((value / 1000000).toFixed(1))}M` : value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : value}</span>}
              </label>;
            })}
          </div>;
        })}
      </fieldset>
    </div>
    {(error || saveError) && <div className={`${styles.error} ${styles.importError}`} role="alert"><ModelErrorText value={error || saveError || ""} /></div>}
    <div className={`${styles.dialogFooter} ${styles.importFooter}`}>
      <div className={styles.importSummary}><span>{c.selected} {selected.size}</span>{pendingCount > 0 && <span>{c.pendingLimits} {pendingCount}</span>}</div>
      <button className={styles.quiet} disabled={busy} onClick={onClose}>{c.cancel}</button>
      <button className={styles.primary} disabled={busy || !selected.size} onClick={() => void save()}>{busy ? c.saving : c.importModels}</button>
    </div>
  </Modal>;
}
