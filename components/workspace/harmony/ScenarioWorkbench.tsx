"use client";
import { useEffect, useRef, useState } from "react";
import type { HarmonyScenarioStep } from "@/lib/harmony/types";
import type { HarmonyApplication } from "@/lib/harmony/observation/applications";
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
  const controller = useRef<AbortController | null>(null);
  const loaded = useRef(false);
  const copy = (zh: string, en: string) => chinese ? zh : en;
  useEffect(() => () => controller.current?.abort(), []);
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
    void Promise.all([read("/api/harmony/templates"), read(`/api/harmony/apps?serial=${encodeURIComponent(serial)}`)])
      .then(([catalog, apps]) => {
        if (current.signal.aborted) return;
        const values = catalog.templates as Template[];
        setTemplates(values); setApplications(apps.applications);
        setTemplateId("launch-and-verify"); setSteps([]);
        setParameters(values.find(item => item.id === "launch-and-verify")?.parameters ?? {});
        loaded.current = true; setError("");
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
    const current = new AbortController(); controller.current = current; setBusy(true); setError(""); setResult(null);
    try { await work(); } catch (reason) { setError(current.signal.aborted ? copy("已请求取消，请查看设备清理状态。", "Cancellation requested; check device cleanup state.") : String(reason)); }
    finally { if (controller.current === current) { controller.current = null; setBusy(false); } }
  };
  const changeTemplate = (id: string) => {
    setTemplateId(id); setSteps([]); setResult(null);
    const defaults = { ...templates.find(value => value.id === id)?.parameters };
    // Example IDs must never be mistaken for a calibrated audio setup.
    if (id === "push-to-talk") { defaults.audioAssetId = ""; defaults.profileId = ""; defaults.geometryId = ""; }
    setParameters(defaults);
  };
  const compile = async () => {
    const bound = { ...parameters, ...(templateId === "launch-and-verify" ? { bundleName: bundle } : {}) };
    const data = await request("/api/harmony/templates", { id: templateId, parameters: bound });
    let compiled = data.steps as HarmonyScenarioStep[];
    if (templateId === "launch-and-verify") {
      compiled = [{ action: "launch_app", bundleName: bundle, abilityName: ability,
        waitFor: { selector: { text: String(parameters.title ?? ""), match: "exact" } } }, ...compiled.slice(1)];
    } else {
      compiled = [{ action: "launch_app", bundleName: bundle, abilityName: ability }, ...compiled];
    }
    setSteps(compiled); return compiled;
  };
  const ready = Boolean(bundle && ability && templates.length && Object.entries(parameters).every(([key, value]) => key === "bundleName" || String(value).trim()));
  const statusLabels: Record<string, string> = { passed: copy("测试通过", "Passed"), failed: copy("测试失败", "Failed"), cancelled: copy("已取消", "Cancelled"), interrupted: copy("已中断", "Interrupted"), running: copy("运行中", "Running") };
  const resultStatus = typeof result?.status === "string" ? result.status : "";
  return <section aria-label={copy("场景与工程验证", "Scenario and project validation")}>
    <div className={styles.toolTitle}><h3>{copy("运行测试", "Run a test")}</h3><button type="button" disabled={busy || loading} onClick={() => { loaded.current = false; setLoadVersion(value => value + 1); }}>{copy("刷新", "Refresh")}</button></div>
    <label>{copy("测试应用", "Test app")}<select disabled={busy || loading} value={bundle} onChange={event => {
      const next = event.target.value; setBundle(next); setAbility(""); setSteps([]);
      if (next) void run(async () => {
        const app = (await request(`/api/harmony/apps?serial=${encodeURIComponent(serial)}&bundleName=${encodeURIComponent(next)}`)).applications?.[0] as HarmonyApplication | undefined;
        if (!app) throw new Error(copy("未找到应用入口", "App entry unavailable"));
        setApplications(items => items.map(item => item.bundleName === next ? app : item));
        setAbility(app.abilities?.length === 1 ? app.abilities[0] : "");
      });
    }}><option value="">{loading ? copy("正在读取手机应用…", "Loading apps…") : copy("选择手机上的应用", "Choose an installed app")}</option>{applications.map(app => <option key={app.bundleName} value={app.bundleName}>{app.label ?? app.bundleName}</option>)}</select></label>
    {bundle && (applications.find(app => app.bundleName === bundle)?.abilities?.length ?? 0) !== 1 ? <label>{copy("启动入口", "App entry")}<select value={ability} disabled={busy} onChange={event => { setAbility(event.target.value); setSteps([]); }}><option value="">{copy("选择入口", "Choose entry")}</option>{applications.find(app => app.bundleName === bundle)?.abilities?.map(name => <option key={name}>{name}</option>)}</select></label> : null}
    <fieldset className={styles.scenarioChoices}><legend>{copy("选择场景", "Choose a scenario")}</legend>
      {templates.filter(template => primaryTemplates.includes(template.id)).sort((a, b) => primaryTemplates.indexOf(a.id) - primaryTemplates.indexOf(b.id)).map(template => {
        const index = primaryTemplates.indexOf(template.id);
        return <label key={template.id} data-selected={templateId === template.id}><input type="radio" name={`scenario-${serial}`} checked={templateId === template.id} disabled={busy} onChange={() => changeTemplate(template.id)} /><span><strong>{(chinese ? ["启动并检查", "中文输入", "语音识别"] : ["Launch and check", "Chinese input", "Speech recognition"])[index]}</strong><small>{(chinese ? ["打开应用并核对首页文字", "在测试应用输入文字并核对结果", "使用已校准配置核对手机识别结果"] : ["Open the app and check home screen text", "Enter text in the test app and verify it", "Verify the phone transcript with a calibrated profile"])[index]}</small></span></label>;
      })}
    </fieldset>
    <details><summary>{copy("更多场景", "More scenarios")}</summary><select aria-label={copy("更多场景", "More scenarios")} value={primaryTemplates.includes(templateId) ? "" : templateId} disabled={busy} onChange={event => { if (event.target.value) changeTemplate(event.target.value); }}><option value="">{copy("选择其他场景", "Choose another scenario")}</option>{templates.filter(template => !primaryTemplates.includes(template.id)).map(template => <option key={template.id} value={template.id}>{template.title}</option>)}</select></details>
    <fieldset><legend>{copy("验证内容", "What to verify")}</legend>
      {Object.entries(parameters).filter(([key]) => key !== "bundleName").map(([key, value]) => <label key={key}>{fieldLabels[key]?.[chinese ? 0 : 1] ?? key}<input type={typeof value === "number" ? "number" : "text"} value={value} disabled={busy} onChange={event => { setParameters(current => ({ ...current, [key]: typeof value === "number" ? Number(event.target.value) : event.target.value })); setSteps([]); }} /></label>)}
      {templateId !== "launch-and-verify" ? <p>{copy("内置输入与列表场景使用自有测试 App 的控件；语音场景须先在“语音”中完成校准。", "Input and list templates use the owned test app's controls. Calibrate voice in the Voice tab first.")}</p> : null}
    </fieldset>
    <button className={styles.primaryButton} disabled={busy || loading || !canControl || !ready} onClick={() => void run(async () => {
      const compiled = await compile();
      const leaseToken = await ensureControl();
      const data = await request("/api/harmony/scenario", { serial, leaseToken, steps: compiled }); setResult(data.result);
    })}>{busy ? copy("测试进行中…", "Running…") : copy("运行测试", "Run test")}</button>
    <p className={styles.inlineHint}>{copy("连接设备后可直接执行所选场景。", "Run the selected scenario directly on the connected device.")}</p>
    {busy ? <button onClick={() => controller.current?.abort()}>{copy("停止测试", "Stop test")}</button> : null}
    {error ? <p role="alert">{error}</p> : null}
    {result ? <div className={styles.testResult} role="status" data-status={resultStatus}><strong>{statusLabels[resultStatus] ?? copy("验证结果", "Validation result")}</strong><details><summary>{copy("查看详细结果", "View result details")}</summary><pre>{JSON.stringify(result, null, 2)}</pre></details></div> : null}
    <details><summary>{copy("预览步骤与工程验证", "Steps and project validation")}</summary>
      <button disabled={busy || !ready} onClick={() => void run(async () => { await compile(); })}>{copy("检查参数并预览步骤", "Validate and preview steps")}</button>
      {steps.length ? <pre>{JSON.stringify(steps, null, 2)}</pre> : null}
      <p>{copy("当前工程", "Current project")}: {cwd || copy("请先选择工程", "Select a project first")}</p>
      <label>{copy("该工程的 HAP 完整路径", "Full HAP path from this project")}<input value={hap} onChange={event => setHap(event.target.value)} /></label>
      <p>{copy("先检查 ArkTS 与 lint，再安装所选 HAP，执行场景并收集日志。", "Checks ArkTS and lint, installs the selected HAP, then runs the scenario and collects logs.")}</p>
      <button disabled={busy || !cwd || !canControl || !ready || !hap} onClick={() => void run(async () => {
        const compiled = await compile(); const leaseToken = await ensureControl();
        const data = await request("/api/harmony/validate", { projectRoot: cwd, hapPath: hap, bundleName: bundle, serial, leaseToken, steps: compiled }); setResult(data.result);
      })}>{copy("运行验证链", "Run validation chain")}</button>
      <button disabled={busy || !cwd} onClick={() => void run(async () => { const data = await request(`/api/harmony/validate?projectRoot=${encodeURIComponent(cwd!)}`); setResult({ reports: data.reports }); })}>{copy("读取该工程验证记录", "Load project validation reports")}</button>
    </details>
  </section>;
}
