"use client";

import { useEffect, useState } from "react";
import type { ActionApproval } from "@/lib/harmony/policy/approval-store";
import styles from "../HarmonyPanel.module.css";

export function ApprovalDialog({ serial, active, chinese }: { serial: string; active: boolean; chinese: boolean }) {
  const [approvals, setApprovals] = useState<ActionApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!active || !serial) { setApprovals([]); return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/harmony/approval?serial=${encodeURIComponent(serial)}`, { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(chinese ? "无法读取设备授权请求" : "Could not load device approvals");
        const payload = await response.json() as { approvals: ActionApproval[] };
        if (!controller.signal.aborted) {
          setApprovals(Array.isArray(payload.approvals) ? payload.approvals.filter(item => item.status === "pending") : []);
          setError(null);
        }
      } catch (failure) { if (!controller.signal.aborted) setError(String(failure)); }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, serial, chinese, refresh]);

  const resolve = async (id: string, approved: boolean) => {
    setBusy(id); setError(null);
    try {
      const response = await fetch("/api/harmony/approval", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resolve", id, approved }) });
      if (!response.ok) throw new Error(chinese ? "授权已过期或无法保存，请重新发起操作" : "Approval expired or could not be saved; request the action again");
      setApprovals(items => items.filter(item => item.id !== id));
      setRefresh(value => value + 1);
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(null); }
  };

  if (!approvals.length && !error) return null;
  const labels: Record<ActionApproval["action"], string> = {
    install_app: chinese ? "安装应用" : "Install app", uninstall_app: chinese ? "卸载应用" : "Uninstall app",
    clear_app_data: chinese ? "清除应用数据" : "Clear app data", initialize_mirror: chinese ? "安装并初始化投屏服务" : "Install and initialize video service",
    start_recording: chinese ? "开始录屏" : "Start recording",
    calibrate_input: chinese ? "校准实体键或触摸保持" : "Calibrate physical key or touch hold",
    calibrate_audio: chinese ? "播放语料并校准手机识音" : "Play fixture and calibrate phone recognition",
    test_control: chinese ? "授权此任务控制指定应用" : "Allow this task to control this app",
    system_control: chinese ? "执行一次系统按键操作" : "Execute one system key operation",
  };
  return <section className={`${styles.workbench} ${styles.approvalPanel}`} aria-label={chinese ? "设备操作授权" : "Device action approvals"}>
    {error ? <p role="alert">{error}</p> : null}
    {approvals.map(item => <div key={item.id} style={{ marginBottom: 12 }}>
      <strong>{labels[item.action]} · {item.serial}</strong>
      <p>{String(item.parameters.bundleName ?? item.parameters.hapPath ?? "")}</p>
      <details><summary>{chinese ? "本次操作参数" : "Action parameters"}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(item.parameters, null, 2)}</pre></details>
      <small>{chinese ? "任务" : "Task"}: {item.sessionId ?? item.ownerId}</small>
      {item.artifactHash ? <details><summary>SHA-256</summary><code style={{ overflowWrap: "anywhere" }}>{item.artifactHash}</code></details> : null}
      <p>{item.action === "test_control" ? (chinese ? "批准后请重试原操作。" : "Retry the original action after approval.") : chinese ? "仅允许此任务执行一次，批准后请重试原操作。卸载或清除数据无法撤销。投屏服务需要手机的屏幕采集权限，不会自动解锁。" : "Allows this task to execute once. Retry the original action after approval. Uninstalling or clearing data is irreversible. Video capture requires phone permission and never unlocks the phone."}</p>
      {item.action === "test_control" ? <p>{chinese ? "此授权持续到本次控制租约结束，只允许所列应用。应用内的发送、提交等操作也可能产生外部影响。" : "This grant lasts for the current control lease and listed app. Sending or submitting inside that app can have external effects."}</p> : null}
      <button type="button" disabled={busy !== null} onClick={() => void resolve(item.id, true)}>{item.action === "test_control" ? (chinese ? "允许此任务" : "Allow this task") : (chinese ? "允许一次" : "Allow once")}</button>{" "}
      <button type="button" disabled={busy !== null} onClick={() => void resolve(item.id, false)}>{chinese ? "拒绝" : "Deny"}</button>
    </div>)}
  </section>;
}
