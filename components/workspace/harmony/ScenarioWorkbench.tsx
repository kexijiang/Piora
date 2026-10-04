"use client";
import { useEffect, useRef, useState } from "react";
import type { HarmonyScenarioResult, HarmonyScenarioStep, HarmonyScenarioStepResult } from "@/lib/harmony/types";
import type { ScenarioExecution } from "@/lib/harmony/scenario/execution-store";
import type { HarmonyApplication } from "@/lib/harmony/observation/applications";
import { ScenarioStepEditor, scenarioActionLabels } from "./ScenarioStepEditor";
import { ScenarioReportMetadata, ScenarioStepResults } from "./ScenarioStepResults";
import styles from "../HarmonyPanel.module.css";

interface Template { id: string; title: string; version: number; parameters: Record<string, string | number> }
const primaryTemplates = ["launch-and-verify", "chinese-input", "push-to-talk"];
const fieldLabels: Record<string, [string, string]> = {
  title: ["预期首页文字", "Expected home screen text"], text: ["测试文字", "Test text"],
  target: ["目标控件 ID", "Target control ID"], rotation: ["旋转角度", "Rotation"],
  audioAssetId: ["已导入的语料 ID", "Imported audio ID"], profileId: ["已验证的语音配置 ID", "Verified voice profile ID"],
  geometryId: ["当前画面几何 ID", "Current frame geometry ID"],
};
export function ScenarioWorkbench({ serial, active, canControl, ensureControl, cwd, chinese }: {
  serial: string; active: boolean; canControl: boolean; ensureControl: () => Promise<string>; cwd?: string | null; chinese: boolean;
}) {
  const [templates, setTemplates] = useState<Template[]>([]), [templateId, setTemplateId] = useState("launch-and-verify");
  const [parameters, setParameters] = useState<Record<string, string | number>>({}), [steps, setSteps] = useState<HarmonyScenarioStep[]>([]);
  const [applications, setApplications] = useState<HarmonyApplication[]>([]), [bundle, setBundle] = useState("");
  const [ability, setAbility] = useState(""), [hap, setHap] = useState("");
  const [busy, setBusy] = useState(false), [result, setResult] = useState<Record<string, unknown> | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(false), [loadVersion, setLoadVersion] = useState(0);
  const [customMode, setCustomMode] = useState(false), [editorOpen, setEditorOpen] = useState(false);
  const [preview, setPreview] = useState<{ stepCount: number; requiredActions: HarmonyScenarioStep["action"][] } | null>(null);
  const [captureFinalScreenshot, setCaptureFinalScreenshot] = useState(false);
  const [collectLogs, setCollectLogs] = useState(false);
  const [executingRunId, setExecutingRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<ScenarioExecution | null>(null), [progressError, setProgressError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const loaded = useRef(false);
  const copy = (zh: string, en: string) => chinese ? zh : en;
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (!active) controller.current?.abort(); }, [active]);
  useEffect(() => {
    if (!active || !executingRunId) return;
    const current = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden) {
        try {
          const response = await fetch(`/api/harmony/scenario?serial=${encodeURIComponent(serial)}&clientRunId=${encodeURIComponent(executingRunId)}`, {
            cache: "no-store", signal: AbortSignal.any([current.signal, AbortSignal.timeout(10000)]),
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error?.message ?? data.error ?? `HTTP ${response.status}`);
          if (!Array.isArray(data.executions)) throw new Error("Invalid execution progress");
          const execution = data.executions[0] as ScenarioExecution | undefined;
          if (!current.signal.aborted) {
            if (execution?.serial === serial && execution.clientRunId === executingRunId && Array.isArray(execution.steps)) setProgress(execution);
            setProgressError("");
          }
        } catch (reason) { if (!current.signal.aborted) setProgressError(String(reason)); }
      }
      if (!current.signal.aborted) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { current.abort(); clearTimeout(timer); };
  }, [active, executingRunId, serial]);
  useEffect(() => {
    if (!active || loaded.current) return;
    const current = new AbortController();
    setLoading(true);
    const read = async (path: string) => {
      const response = await fetch(path, { signal: current.signal, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? data.error ?? `HTTP ${response.status}`);
      return data;
    };
    void Promise.allSettled([read("/api/harmony/templates"), read(`/api/harmony/apps?serial=${encodeURIComponent(serial)}`)])
      .then(([catalog, apps]) => {
        if (current.signal.aborted) return;
        if (catalog.status === "fulfilled") {
          const values = catalog.value.templates as Template[];
          setTemplates(values);
          setParameters(current => Object.keys(current).length ? current : values.find(item => item.id === "launch-and-verify")?.parameters ?? {});
        } else setTemplates([]);
        if (apps.status === "fulfilled") setApplications(apps.value.applications);
        else { setApplications([]); setBundle(""); setAbility(""); }
        loaded.current = true;
        setError([catalog, apps].filter(item => item.status === "rejected").map(item => String((item as PromiseRejectedResult).reason)).join(" · "));
      }).catch(reason => { if (!current.signal.aborted) setError(String(reason)); })
      .finally(() => { if (!current.signal.aborted) setLoading(false); });
    return () => current.abort();
  }, [active, serial, loadVersion]);

  const request = async (path: string, body?: unknown) => {
    const response = await fetch(path, { signal: controller.current?.signal, cache: "no-store", ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? data.error ?? `HTTP ${response.status}`);
    return data;
  };
  const run = async (work: () => Promise<void>) => {
    if (controller.current) return;
    const current = new AbortController(); controller.current = current; setBusy(true); setError(""); setResult(null); setProgress(null); setProgressError("");
    try { await work(); } catch (reason) { setError(current.signal.aborted ? copy("已请求取消，请查看设备清理状态。", "Cancellation requested; check device cleanup state.") : String(reason)); }
    finally { if (controller.current === current) { controller.current = null; setBusy(false); setExecutingRunId(null); } }
  };
  const changeTemplate = (id: string) => {
    setCustomMode(false); setEditorOpen(false); setPreview(null);
    setTemplateId(id); setSteps([]); setResult(null); setProgress(null);
    const defaults = { ...templates.find(value => value.id === id)?.parameters };
    // Example IDs must never be mistaken for a calibrated audio setup.
    if (id === "push-to-talk") { defaults.audioAssetId = ""; defaults.profileId = ""; defaults.geometryId = ""; }
    setParameters(defaults);
  };
  const compile = async () => {
    if (customMode) {
      const data = await request("/api/harmony/scenario/preview", { steps, policy: { captureFinalScreenshot, collectLogs } });
      setPreview({ stepCount: data.stepCount ?? steps.length, requiredActions: data.requiredActions ?? [...new Set(steps.map(step => step.action))] });
      return steps;
    }
    const bound = { ...parameters, ...(templateId === "launch-and-verify" ? { bundleName: bundle } : {}) };
    const data = await request("/api/harmony/templates", { id: templateId, parameters: bound });
    let compiled = data.steps as HarmonyScenarioStep[];
    if (templateId === "launch-and-verify") {
      compiled = [{ action: "launch_app", bundleName: bundle, abilityName: ability,
        waitFor: { selector: { text: String(parameters.title ?? ""), match: "exact" } } }, ...compiled.slice(1)];
    } else {
      compiled = [{ action: "launch_app", bundleName: bundle, abilityName: ability }, ...compiled];
    }
    compiled = compiled.map(step => ({ ...step, id: step.id ?? crypto.randomUUID() }));
    const previewData = await request("/api/harmony/scenario/preview", { steps: compiled, policy: { captureFinalScreenshot, collectLogs } });
    setSteps(compiled); setPreview({ stepCount: previewData.stepCount ?? compiled.length, requiredActions: previewData.requiredActions ?? [...new Set(compiled.map(step => step.action))] }); return compiled;
  };
  const ready = customMode ? steps.length > 0 : Boolean(bundle && ability && templates.length && Object.entries(parameters).every(([key, value]) => key === "bundleName" || String(value).trim()));
  const statusLabels: Record<string, string> = { passed: copy("测试通过", "Passed"), failed: copy("测试失败", "Failed"), cancelled: copy("已取消", "Cancelled"), interrupted: copy("已中断", "Interrupted"), running: copy("运行中", "Running") };
  const resultStatus = typeof result?.status === "string" ? result.status : "";
  const resultSteps = Array.isArray(result?.steps) ? result.steps.filter((step): step is HarmonyScenarioStepResult => step !== null && typeof step === "object") : [];
  const reportResult = result as Partial<HarmonyScenarioResult> | null;
  return <section aria-label={copy("场景与工程验证", "Scenario and project validation")}>
    <div className={styles.toolTitle}><h3>{copy("运行测试", "Run a test")}</h3><button type="button" disabled={busy || loading} onClick={() => { loaded.current = false; setLoadVersion(value => value + 1); }}>{copy("刷新", "Refresh")}</button></div>
    <label>{copy("测试应用", "Test app")}<select disabled={busy || loading} value={bundle} onChange={event => {
      const next = event.target.value; setBundle(next); setAbility(""); if (!customMode) { setSteps([]); setPreview(null); setResult(null); }
      if (next) void run(async () => {
        const app = (await request(`/api/harmony/apps?serial=${encodeURIComponent(serial)}&bundleName=${encodeURIComponent(next)}`)).applications?.[0] as HarmonyApplication | undefined;
        if (!app) throw new Error(copy("未找到应用入口", "App entry unavailable"));
        setApplications(items => items.map(item => item.bundleName === next ? app : item));
        setAbility(app.abilities?.length === 1 ? app.abilities[0] : "");
      });
    }}><option value="">{loading ? copy("正在读取手机应用…", "Loading apps…") : copy("选择手机上的应用", "Choose an installed app")}</option>{applications.map(app => <option key={app.bundleName} value={app.bundleName}>{app.label ?? app.bundleName}</option>)}</select></label>
    {bundle && (applications.find(app => app.bundleName === bundle)?.abilities?.length ?? 0) !== 1 ? <label>{copy("启动入口", "App entry")}<select value={ability} disabled={busy} onChange={event => { setAbility(event.target.value); if (!customMode) { setSteps([]); setPreview(null); setResult(null); } }}><option value="">{copy("选择入口", "Choose entry")}</option>{applications.find(app => app.bundleName === bundle)?.abilities?.map(name => <option key={name}>{name}</option>)}</select></label> : null}
    <div className={styles.scenarioEditorHeading}>
      <button type="button" disabled={busy} onClick={() => {
        setCustomMode(true); setEditorOpen(true); setSteps([]); setPreview(null); setResult(null); setError("");
      }}>{copy("新建自定义场景", "New custom scenario")}</button>
      <button type="button" disabled={busy || customMode || !ready} onClick={() => void run(async () => {
        await compile(); setCustomMode(true); setEditorOpen(true);
      })}>{copy("编辑模板步骤", "Edit template steps")}</button>
      {customMode ? <button type="button" disabled={busy} onClick={() => changeTemplate(templateId)}>{copy("返回模板模式", "Return to templates")}</button> : null}
    </div>
    <fieldset className={styles.scenarioChoices} hidden={customMode}><legend>{copy("选择场景", "Choose a scenario")}</legend>
      {templates.filter(template => primaryTemplates.includes(template.id)).sort((a, b) => primaryTemplates.indexOf(a.id) - primaryTemplates.indexOf(b.id)).map(template => {
        const index = primaryTemplates.indexOf(template.id);
        return <label key={template.id} data-selected={templateId === template.id}><input type="radio" name={`scenario-${serial}`} checked={templateId === template.id} disabled={busy} onChange={() => changeTemplate(template.id)} /><span><strong>{(chinese ? ["启动并检查", "中文输入", "语音识别"] : ["Launch and check", "Chinese input", "Speech recognition"])[index]}</strong><small>{(chinese ? ["打开应用并核对首页文字", "在测试应用输入文字并核对结果", "使用已校准配置核对手机识别结果"] : ["Open the app and check home screen text", "Enter text in the test app and verify it", "Verify the phone transcript with a calibrated profile"])[index]}</small></span></label>;
      })}
    </fieldset>
    <details><summary>{copy("更多场景", "More scenarios")}</summary><select aria-label={copy("更多场景", "More scenarios")} value={primaryTemplates.includes(templateId) ? "" : templateId} disabled={busy} onChange={event => { if (event.target.value) changeTemplate(event.target.value); }}><option value="">{copy("选择其他场景", "Choose another scenario")}</option>{templates.filter(template => !primaryTemplates.includes(template.id)).map(template => <option key={template.id} value={template.id}>{template.title}</option>)}</select></details>
    <fieldset hidden={customMode}><legend>{copy("验证内容", "What to verify")}</legend>
      {Object.entries(parameters).filter(([key]) => key !== "bundleName").map(([key, value]) => <label key={key}>{fieldLabels[key]?.[chinese ? 0 : 1] ?? key}<input type={typeof value === "number" ? "number" : "text"} value={value} disabled={busy} onChange={event => { setParameters(current => ({ ...current, [key]: typeof value === "number" ? Number(event.target.value) : event.target.value })); setSteps([]); setPreview(null); setResult(null); }} /></label>)}
      {templateId !== "launch-and-verify" ? <p>{copy("内置输入与列表场景使用自有测试 App 的控件；语音场景须先在“语音”中完成校准。", "Input and list templates use the owned test app's controls. Calibrate voice in the Voice tab first.")}</p> : null}
    </fieldset>
    {editorOpen ? <>
      <ScenarioStepEditor steps={steps} onChange={next => { setSteps(next); setPreview(null); setResult(null); setProgress(null); }} chinese={chinese} disabled={busy} app={bundle ? { bundleName: bundle, ...(ability ? { abilityName: ability } : {}) } : undefined} />
      <p className={styles.inlineHint}>{copy(`目标设备：${serial}。步骤中的应用包名独立保存，切换上方应用不会更改现有步骤。`, `Device: ${serial}. Step app targets are saved separately; choosing an app does not retarget existing steps.`)}</p>
    </> : null}
    <label className={styles.scenarioCheckbox}><input type="checkbox" checked={captureFinalScreenshot} disabled={busy} onChange={event => { setCaptureFinalScreenshot(event.target.checked); setPreview(null); }} />{copy("结束时采集截图", "Capture a final screenshot")}</label>
    <label className={styles.scenarioCheckbox}><input type="checkbox" checked={collectLogs} disabled={busy} onChange={event => { setCollectLogs(event.target.checked); setPreview(null); }} />{copy("报告包含设备日志片段（最多 200 行）", "Include a device log excerpt in the report (up to 200 lines)")}</label>
    <div className={styles.scenarioEditorHeading}><button type="button" disabled={busy || !ready} onClick={() => void run(async () => { await compile(); setEditorOpen(true); })}>{copy("预览场景", "Preview scenario")}</button>
      <span>{customMode ? copy("自定义步骤", "Custom steps") : copy("模板步骤", "Template steps")}</span></div>
    {preview ? <div className={styles.scenarioPreview} role="status">
      <strong>{copy(`参数校验通过 · ${preview.stepCount} 个步骤`, `Parameters validated · ${preview.stepCount} steps`)}</strong>
      <p>{copy("未读取或操作设备；实际设备能力和权限在运行时核对。", "No device reads or actions. Actual capabilities and permissions are checked when running.")}</p>
      <p>{preview.requiredActions.map(action => scenarioActionLabels[action]?.[chinese ? 0 : 1] ?? action).join(" · ")}</p>
    </div> : null}
    <button className={styles.primaryButton} disabled={busy || loading || !canControl || !ready} onClick={() => void run(async () => {
      const compiled = await compile();
      const leaseToken = await ensureControl();
      controller.current?.signal.throwIfAborted();
      const clientRunId = crypto.randomUUID(); setExecutingRunId(clientRunId);
      const data = await request("/api/harmony/scenario", { serial, leaseToken, clientRunId, steps: compiled, policy: { captureFinalScreenshot, collectLogs } }); setResult(data.result);
    })}>{busy ? copy("正在处理场景…", "Processing scenario…") : copy("运行测试", "Run test")}</button>
    <p className={styles.inlineHint}>{copy("连接设备后可直接执行所选场景。", "Run the selected scenario directly on the connected device.")}</p>
    {busy ? <button onClick={() => controller.current?.abort()}>{copy("停止测试", "Stop test")}</button> : null}
    {error ? <p role="alert">{error}</p> : null}
    {executingRunId || (!result && progress) ? <section className={styles.scenarioPreview} aria-label={copy("场景执行进度", "Scenario execution progress")}>
      <strong aria-live="polite">{executingRunId ? copy("正在执行本次场景", "Executing this scenario") : copy("最后确认的执行状态", "Last confirmed execution state")}</strong>
      {progressError ? <p role="status">{copy("进度读取失败，当前状态尚未确认：", "Progress could not be read; current state is unconfirmed: ")}{progressError}</p> : null}
      {progress ? <>
        <p>{copy(`已完成 ${progress.steps.filter(step => step.status === "passed").length}/${progress.steps.length} 步`, `${progress.steps.filter(step => step.status === "passed").length}/${progress.steps.length} steps completed`)}</p>
        <ScenarioStepResults steps={progress.steps} serial={serial} chinese={chinese} live={Boolean(executingRunId && !progressError)} />
      </> : <p>{copy("等待本次执行记录，不沿用上一次进度。", "Waiting for this run's record; previous progress is not reused.")}</p>}
    </section> : null}
    {result ? <div className={styles.testResult} role="status" data-status={resultStatus}><strong>{statusLabels[resultStatus] ?? copy("验证结果", "Validation result")}</strong>
      <ScenarioReportMetadata device={reportResult?.device} observation={reportResult?.finalObservation} observationError={reportResult?.finalObservationError} screenshot={reportResult?.finalScreenshot} logs={reportResult?.logs} serial={serial} chinese={chinese} />
      {resultSteps.length ? <ScenarioStepResults steps={resultSteps} serial={serial} chinese={chinese} /> : null}
      <button type="button" onClick={() => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = `harmony-scenario-${typeof result.executionId === "string" ? result.executionId.replace(/[^a-zA-Z0-9-]/g, "") : "result"}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}>{copy("导出本次结果", "Export this result")}</button>
      {Array.isArray(result.reports) ? <p>{copy(`已读取 ${result.reports.length} 份工程记录。`, `Loaded ${result.reports.length} project records.`)}</p> : null}
    </div> : null}
    <details><summary>{copy("预览步骤与工程验证", "Steps and project validation")}</summary>
      <button disabled={busy || !ready} onClick={() => void run(async () => { await compile(); })}>{copy("检查参数并预览步骤", "Validate and preview steps")}</button>
      {steps.length ? <ol className={styles.scenarioSummary}>{steps.map((step, index) => <li key={step.id ?? index}>{scenarioActionLabels[step.action][chinese ? 0 : 1]}{"bundleName" in step ? ` · ${step.bundleName}` : "selector" in step ? ` · ${step.selector.text || step.selector.id || step.selector.type || ""}` : "name" in step ? ` · ${step.name}` : ""}</li>)}</ol> : null}
      <p>{copy("当前工程", "Current project")}: {cwd || copy("请先选择工程", "Select a project first")}</p>
      <label>{copy("该工程的 HAP 完整路径", "Full HAP path from this project")}<input value={hap} onChange={event => setHap(event.target.value)} /></label>
      <p>{copy("先检查 ArkTS 与 lint，再安装所选 HAP，执行场景并收集日志。", "Checks ArkTS and lint, installs the selected HAP, then runs the scenario and collects logs.")}</p>
      <button disabled={busy || !cwd || !canControl || !ready || !hap || !bundle} onClick={() => void run(async () => {
        const compiled = await compile(); const leaseToken = await ensureControl();
        const data = await request("/api/harmony/validate", { projectRoot: cwd, hapPath: hap, bundleName: bundle, serial, leaseToken, steps: compiled }); setResult(data.result);
      })}>{copy("运行验证链", "Run validation chain")}</button>
      <button disabled={busy || !cwd} onClick={() => void run(async () => { const data = await request(`/api/harmony/validate?projectRoot=${encodeURIComponent(cwd!)}`); setResult({ reports: data.reports }); })}>{copy("读取该工程验证记录", "Load project validation reports")}</button>
    </details>
  </section>;
}
