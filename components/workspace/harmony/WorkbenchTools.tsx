"use client";

import { useEffect, useRef, useState } from "react";
import type { HarmonyDoctorReport } from "@/lib/harmony/contracts/capabilities";
import type { ScenarioExecution } from "@/lib/harmony/scenario/execution-store";
import { ApplicationPicker } from "./ApplicationPicker";
import { DeviceFiles } from "./DeviceFiles";
import { DeviceConsole } from "./DeviceConsole";
import { ScenarioWorkbench } from "./ScenarioWorkbench";
import styles from "../HarmonyPanel.module.css";
import type { AudioOutput } from "@/lib/harmony/audio/acoustic-provider";

interface Props { serial: string; canControl: boolean; ensureControl: () => Promise<string>; tab: string; active: boolean; chinese: boolean; geometryId?: string; cwd?: string | null; ownerId?: string; onCleanupConfirmed?: () => Promise<void> }
export function WorkbenchTools({ serial, canControl, ensureControl, tab, active, chinese, geometryId, cwd, ownerId, onCleanupConfirmed }: Props) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const [report, setReport] = useState<HarmonyDoctorReport>(), [history, setHistory] = useState<ScenarioExecution[]>([]);
  const [key, setKey] = useState("volume_down"), [duration, setDuration] = useState(800), [calibration, setCalibration] = useState<string>();
  const [audioPath, setAudioPath] = useState(""), [asset, setAsset] = useState<string>(), [outputs, setOutputs] = useState<AudioOutput[]>([]), [outputId, setOutputId] = useState("");
  const [bundle, setBundle] = useState(""), [entry, setEntry] = useState(""), [ready, setReady] = useState(""), [expected, setExpected] = useState(""), [profileId, setProfileId] = useState<string>();
  const [assistantApp, setAssistantApp] = useState(""), [assistantControl, setAssistantControl] = useState("");
  const [mode, setMode] = useState("tap"), [x, setX] = useState(0), [y, setY] = useState(0), [pairing, setPairing] = useState("");
  const [includeTree, setIncludeTree] = useState(false), [includeScreenshot, setIncludeScreenshot] = useState(false);
  const [message, setMessage] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  const copy = (zh: string, en: string) => chinese ? zh : en;
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { if (!active) controller.current?.abort(); }, [active]);
  if (!active || !serial) return null;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(path, { cache: "no-store", signal: controller.current?.signal,
      ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? data.error ?? copy("操作失败，请查看设备连接和诊断", "Operation failed; check the connection and diagnostics"));
    return data;
  };
  const run = async (operation: () => Promise<void>) => {
    if (busy) return; controller.current = new AbortController(); setBusy(true); setError(undefined); setMessage(undefined);
    try { await operation(); } catch (failure) { if (!controller.current.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const fieldStyle = { width: "100%", marginBottom: 6 };
  return <section className={styles.workbench} aria-label={copy("设备工具内容", "Device workbench")}>
      {error ? <p role="alert">{error}</p> : null}{message ? <p role="status">{message}</p> : null}
      {busy ? <button type="button" onClick={() => { controller.current?.abort(); setMessage(copy("已请求取消；请查看设备释放状态。", "Cancellation requested; check release state.")); }}>{copy("取消本次操作", "Cancel this operation")}</button> : null}
      <div hidden={tab !== "apps"}><ApplicationPicker serial={serial} canControl={canControl} ensureControl={ensureControl} chinese={chinese} cwd={cwd}/></div>
      {tab === "files" ? <DeviceFiles serial={serial} chinese={chinese} cwd={cwd} canControl={canControl} ensureControl={ensureControl} /> : null}
      {tab === "commands" ? <DeviceConsole serial={serial} chinese={chinese} canControl={canControl} ensureControl={ensureControl} /> : null}
      <div hidden={tab !== "scenarios"}><ScenarioWorkbench active={tab === "scenarios"} serial={serial} canControl={canControl} ensureControl={ensureControl} cwd={cwd} chinese={chinese}/></div>
      {tab === "diagnostics" ? <>
        <ol><li>{copy("连接 USB 并在手机确认调试授权。", "Connect USB and allow debugging on the phone.")}</li><li>{copy("检查设备、画面及 UI 树；锁屏时请手动解锁。", "Check the device, frame and UI tree; unlock manually when needed.")}</li><li>{copy("在测试应用校准点击或保持操作。", "Calibrate input in a test app.")}</li><li>{copy("搜索测试应用，再预览和执行场景。已连接设备可直接操作。", "Find the test app, then preview and run a scenario. Connected devices are ready for control.")}</li></ol>
        <p>{copy("只读检查连接、命令和坐标能力，不自动解锁。已探测不代表真机动作已验证。", "Read-only connection, command and geometry checks. Never unlocks automatically. Probed commands are not verified physical effects.")}</p>
        <details><summary>{copy("恢复清理不确定的设备", "Recover a device with uncertain cleanup")}</summary><p>{copy("先在手机确认所有按键和触摸已松开，录屏已停止。此操作会重新读取现场，记录人工确认，再允许重新取得控制。", "First physically confirm all keys and touch are released and recording is stopped. This rereads the device, records manual confirmation, then allows control to be reacquired.")}</p><button disabled={busy} onClick={() => void run(async () => { await request("/api/harmony/calibration", { action: "confirm_cleanup", serial, released: true, recordingStopped: true }); if (controller.current?.signal.aborted) return; setMessage(copy("设备已恢复，可重新操作或录屏。", "Device recovered. You can control it or start recording.")); await onCleanupConfirmed?.(); })}>{copy("已检查手机并确认释放", "I checked the phone and confirm release")}</button></details>
        <button disabled={busy} onClick={() => void run(async () => setReport((await request(`/api/harmony/capabilities?reprobe=1&serial=${encodeURIComponent(serial)}`)).report))}>{copy("检查设备", "Check device")}</button>
        {report ? <ul>{report.checks.map(check => <li key={check.name}>{check.name}: {check.status}{check.reason ? ` · ${check.reason}` : ""}</li>)}{report.capabilities.map(capability => <li key={capability.action}><strong>{capability.action}</strong>: {capability.status} · {capability.evidence}<br/><small>{capability.reason}</small></li>)}</ul> : null}
      </> : null}
      {tab === "diagnostics" ? <details><summary>{copy("导出支持包", "Export support bundle")}</summary>
        <label><input type="checkbox" checked={includeTree} onChange={event => setIncludeTree(event.target.checked)}/>{copy("包含当前 UI 文本（可能含私聊内容）", "Include current UI text (may include private conversations)")}</label><br/>
        <label><input type="checkbox" checked={includeScreenshot} onChange={event => setIncludeScreenshot(event.target.checked)}/>{copy("包含当前截图", "Include current screenshot")}</label><br/>
        <button disabled={busy} onClick={() => void run(async () => { const data = await request("/api/harmony/support", { serial, includeTree, includeScreenshot }); setMessage(JSON.stringify(data)); })}>{copy("保存到本机", "Save locally")}</button>
      </details> : null}
      {tab === "inputs" ? <>
        <p>{copy("选择精确时长并开始校准，观察手机达到预期状态且按键已松开后再保存。不会自动开屏或解锁。", "Choose the duration and start calibration, then save after observing expected behavior and release. No automatic wake or unlock.")}</p>
        <label>{copy("按键", "Key")}<select value={key} onChange={event => { setKey(event.target.value); setCalibration(undefined); }} style={fieldStyle}><option value="volume_down">{copy("音量减", "Volume down")}</option><option value="volume_up">{copy("音量加", "Volume up")}</option><option value="power">{copy("电源", "Power")}</option><option value="touch">{copy("触摸保持", "Touch hold")}</option></select></label>
        <label>{copy("保持时长（毫秒）", "Hold duration (ms)")}<input type="number" min={50} max={key === "touch" ? 15000 : key === "power" ? 3000 : 5000} value={duration} onChange={event => { setDuration(Number(event.target.value)); setCalibration(undefined); }} style={fieldStyle}/></label>
        {key === "touch" ? <><label>X <input type="number" value={x} onChange={event => setX(Number(event.target.value))}/></label><label>Y <input type="number" value={y} onChange={event => setY(Number(event.target.value))}/></label><p>{copy("使用原生屏幕坐标，并保持当前画面实时连接。", "Use native display coordinates and keep the current frame live.")}</p></> : null}
        <button disabled={!canControl || busy || (key === "touch" && !geometryId)} onClick={() => void run(async () => { const data = await request("/api/harmony/calibration", { action: key === "touch" ? "touch_hold" : "key_hold", serial, leaseToken: await ensureControl(), ...(key === "touch" ? { x, y, geometryId, coordinateSpace: "native" } : { key }), durationMs: duration }); setCalibration(data.result.calibration?.id); })}>{copy("执行一次校准", "Run calibration once")}</button>
        {key === "power" ? <details><summary>{copy("将本次校准保存为助手入口（可选）", "Save this calibration as an assistant entry (optional)")}</summary><label>{copy("实际出现的助手应用包名", "Observed assistant app bundle")}<input value={assistantApp} onChange={event => setAssistantApp(event.target.value)} style={fieldStyle}/></label><label>{copy("助手界面的唯一控件 ID", "Unique control ID on the assistant screen")}<input value={assistantControl} onChange={event => setAssistantControl(event.target.value)} style={fieldStyle}/></label></details> : null}
        {calibration ? <button disabled={busy} onClick={() => void run(async () => { await request("/api/harmony/calibration", { action: "confirm", serial, id: calibration, released: true, observedExpectedBehavior: true, ...(key === "power" && assistantApp && assistantControl ? { assistant: { appId: assistantApp, selector: { id: assistantControl } } } : {}) }); setMessage(`${copy("已确认配置 ID", "Confirmed profile ID")}: ${calibration}`); setCalibration(undefined); })}>{copy("已观察到预期行为，且按键已松开", "Observed expected behavior and release")}</button> : null}
      </> : null}
      {tab === "voice" ? <>
        <h3>{copy("语音识别验证", "Verify speech recognition")}</h3>
        <p>{copy("通过所选电脑扬声器让真实手机听到语料。必须核对手机当前应用和实际识别文字；播放结束不算识音通过。", "Play through an explicitly selected speaker into the real phone microphone. The phone app and recognized transcript must match; playback completion alone does not pass.")}</p>
        <fieldset><legend>{copy("1 · 选择语料", "1 · Audio clip")}</legend>
        <label>{copy("本地 WAV 文件完整路径", "Full path of local WAV")}<input value={audioPath} onChange={event => { setAudioPath(event.target.value); setAsset(undefined); }} style={fieldStyle}/></label>
        <button disabled={busy || !audioPath} onClick={() => void run(async () => { const data = await request("/api/harmony/audio", { action: "import", path: audioPath }); setAsset(data.asset.id); setMessage(`${data.asset.durationMs} ms · SHA-256 ${data.asset.hash}`); })}>{copy("校验并导入", "Validate and import")}</button>
        </fieldset><fieldset><legend>{copy("2 · 声音输出", "2 · Audio output")}</legend>
        <button disabled={busy} onClick={() => void run(async () => setOutputs((await request("/api/harmony/audio")).outputs))}>{copy("查找声音输出", "Find audio outputs")}</button>
        <label>{copy("声音输出", "Audio output")}<select value={outputId} onChange={event => setOutputId(event.target.value)} style={fieldStyle}><option value="">{copy("请选择，不使用默认设备", "Select an explicit output")}</option>{outputs.map(output => <option key={output.id} value={String(output.id)}>{output.name}</option>)}</select></label>
        <button disabled={busy || !asset || outputId === ""} onClick={() => void run(async () => { await request("/api/harmony/audio", { action: "preview", audioAssetId: asset, output: outputs.find(output => String(output.id) === outputId) }); setMessage(copy("语料预览结束；尚未验证手机识别。", "Preview completed; phone recognition has not been tested.")); })}>{copy("在所选输出预览语料", "Preview on selected output")}</button>
        </fieldset><fieldset><legend>{copy("3 · 手机入口与识别结果", "3 · Phone entry and transcript")}</legend>
        <label>{copy("语音入口方式", "Voice entry mode")}<select value={mode} onChange={event => setMode(event.target.value)}><option value="tap">{copy("点击开始监听", "Tap to listen")}</option><option value="push-to-talk">{copy("按住说话", "Push to talk")}</option></select></label>
        {mode === "push-to-talk" ? <label>{copy("已校准的保持时长（毫秒）", "Calibrated hold duration (ms)")}<input type="number" min={50} max={15000} value={duration} onChange={event => setDuration(Number(event.target.value))}/></label> : null}
        <details><summary>{copy("配置手机应用与控件", "Configure phone app and controls")}</summary>
        <label>{copy("目标应用包名", "Target app bundle")}<input value={bundle} onChange={event => setBundle(event.target.value)} style={fieldStyle}/></label>
        <label>{copy("语音入口控件 ID", "Voice entry control ID")}<input value={entry} onChange={event => setEntry(event.target.value)} style={fieldStyle}/></label>
        <label>{copy("正在聆听控件 ID", "Listening-ready control ID")}<input value={ready} onChange={event => setReady(event.target.value)} style={fieldStyle}/></label>
        </details>
        <label>{copy("预期手机识别文字", "Expected phone transcript")}<input value={expected} onChange={event => setExpected(event.target.value)} style={fieldStyle}/></label>
        <button disabled={busy || !canControl || !asset || outputId === "" || !bundle || !entry || !ready || !expected} onClick={() => void run(async () => {
          const data = await request("/api/harmony/audio", { action: "calibrate", serial, leaseToken: await ensureControl(), audioAssetId: asset, geometryId, profile: { targetAppId: bundle, output: outputs.find(output => String(output.id) === outputId), entry: { id: entry }, ready: { id: ready }, result: { text: expected, match: "exact" }, mode, ...(mode === "push-to-talk" ? { holdDurationMs: duration } : {}) } });
          setProfileId(data.result.profile?.id); setMessage(copy("手机识别结果已匹配，声学配置已保存。", "Phone transcript matched; acoustic profile saved."));
        })}>{copy("校准并验证手机识音", "Calibrate and verify phone recognition")}</button>
        </fieldset>
        <details><summary>{copy("高级：自有 debug App PCM 桥接", "Own debug app only: PCM bridge")}</summary>
          <p>{copy("此路径不覆盖麦克风或语音识别。配对时填入控制者 ID；只接受 50–250 ms 的单声道 16 kHz PCM WAV。", "This path does not test the microphone or recognition. Pair using the control owner ID; accepts 50–250 ms mono 16 kHz PCM WAV.")}</p>
          <code>{ownerId}</code><label>{copy("手机显示的短时配对 JSON", "Short-lived pairing JSON shown by the phone")}<textarea value={pairing} onChange={event => setPairing(event.target.value)} autoComplete="off" style={fieldStyle}/></label>
          <button disabled={busy || !asset || !canControl || !pairing} onClick={() => void run(async () => { const data = await request("/api/harmony/audio", { action: "app_test", serial, leaseToken: await ensureControl(), audioAssetId: asset, pairing: JSON.parse(pairing) }); setPairing(""); setMessage(JSON.stringify(data.result)); })}>{copy("注入一次并核对 PCM hash", "Inject once and verify PCM hash")}</button>
        </details>
        {profileId ? <p>{copy("语音配置 ID", "Voice profile ID")}: <code style={{ overflowWrap: "anywhere" }}>{profileId}</code></p> : null}
      </> : null}
      {tab === "history" ? <>
        <button disabled={busy} onClick={() => void run(async () => setHistory((await request(`/api/harmony/scenario?serial=${encodeURIComponent(serial)}`)).executions))}>{copy("刷新执行记录", "Refresh executions")}</button>
        <ol>{history.slice(0,20).map(record => <li key={record.id}><strong>{record.status}</strong> · {record.startedAt}<br/>{record.steps.filter(step => step.status === "passed").length}/{record.steps.length} · {record.checkpoint?.name ?? copy("无检查点", "No checkpoint")}
          {record.status !== "running" && record.checkpoint ? <button disabled={busy || !canControl} onClick={() => void run(async () => { const data = await request("/api/harmony/scenario", { serial, leaseToken: await ensureControl(), resumeExecutionId: record.id }); setMessage(JSON.stringify(data.result)); })}>{copy("重新核对现场并恢复安全步骤", "Recheck state and resume safe steps")}</button> : null}
          {record.status !== "running" ? <button disabled={busy} onClick={() => void run(async () => { await request("/api/harmony/scenario", { action: "remove", executionId: record.id, serial }); setHistory(items => items.filter(item => item.id !== record.id)); })}>{copy("删除此记录及私有输入", "Delete record and private inputs")}</button> : null}
          <button onClick={() => { const blob = new Blob([JSON.stringify(record, null, 2)], { type: "application/json" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `harmony-${record.id}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>{copy("导出结果", "Export result")}</button>
          <details><summary>{copy("步骤结果", "Step results")}</summary><ul>{record.steps.map(step => <li key={step.index}>{step.action}: {step.status}{step.message ? ` · ${step.message}` : ""}</li>)}</ul></details>
        </li>)}</ol>
      </> : null}
  </section>;
}
