"use client";

import { useEffect, useState } from "react";
import { copyText } from "@/lib/clipboard";
import type { HarmonyMediaArtifact, HarmonyScenarioResult, HarmonyScenarioStepResult } from "@/lib/harmony/types";
import { scenarioActionLabels } from "./ScenarioStepEditor";
import styles from "../HarmonyPanel.module.css";

function ScreenshotResult({ artifact, serial, chinese, final = false }: { artifact: HarmonyMediaArtifact; serial: string; chinese: boolean; final?: boolean }) {
  const [failed, setFailed] = useState(false), [notice, setNotice] = useState("");
  const copy = (zh: string, en: string) => chinese ? zh : en;
  if (artifact.kind !== "screenshot" || artifact.serial !== serial || !artifact.filename) return null;
  // The private media endpoint needs the desktop's same-origin authentication;
  // a server-side image optimizer must not fetch or retain this device image.
  // eslint-disable-next-line @next/next/no-img-element
  const preview = <img loading="lazy" alt={final ? copy("场景结束时的设备截图", "Device screenshot at scenario completion") : copy("本步骤采集的设备截图", "Device screenshot from this step")} onError={() => setFailed(true)}
    src={`/api/harmony/media/preview?serial=${encodeURIComponent(serial)}&filename=${encodeURIComponent(artifact.filename)}`} />;
  return <div className={styles.scenarioScreenshot}>
    {failed ? <p>{copy("截图文件当前不可预览，保存记录与路径仍保留。", "The screenshot cannot be previewed now; its saved record and path remain.")}</p>
      : preview}
    <small>{artifact.width}×{artifact.height} · {artifact.size} B · {artifact.createdAt}</small>
    <code>{artifact.path}</code>
    <button type="button" onClick={() => void copyText(artifact.path).then(() => setNotice(copy("路径已复制", "Path copied")), () => setNotice(copy("复制失败，请手动复制路径。", "Copy failed; copy the path manually.")))}>{copy("复制截图路径", "Copy screenshot path")}</button>
    {notice ? <span role="status">{notice}</span> : null}
  </div>;
}

export function ScenarioStepResults({ steps, serial, chinese, live = false }: {
  steps: HarmonyScenarioStepResult[]; serial: string; chinese: boolean; live?: boolean;
}) {
  const [clock, setClock] = useState(Date.now);
  const hasRunningStep = steps.some(step => step.status === "running");
  useEffect(() => {
    if (!live || !hasRunningStep) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live, hasRunningStep]);
  const statusLabels = chinese ? { passed: "已完成", failed: "失败", running: "运行中", "not-run": "未执行" }
    : { passed: "Completed", failed: "Failed", running: "Running", "not-run": "Not run" };
  return <ol className={styles.scenarioSummary}>{steps.map((step, index) => {
    const started = Date.parse(step.receipt?.startedAt ?? "");
    const duration = live && step.status === "running" && Number.isFinite(started) ? Math.max(0, clock - started) : step.durationMs;
    return <li key={step.id ?? step.index ?? index} data-step-status={step.status}>
      <strong>{scenarioActionLabels[step.action]?.[chinese ? 0 : 1] ?? (chinese ? "设备步骤" : "Device step")}</strong>{step.label ? ` · ${step.label}` : ""} · {statusLabels[step.status] ?? (chinese ? "状态未确认" : "Unconfirmed")}
      {Number.isFinite(duration) ? ` · ${duration} ms` : ""}
      {step.message ? <p>{step.message}</p> : null}
      {step.receipt?.dispatchState === "sent" && step.receipt.verification === "not-run" ? <small>{chinese ? "命令已执行，效果未独立核验。" : "Command completed; effect was not independently verified."}</small> : null}
      {step.screenshot ? <ScreenshotResult key={step.screenshot.filename} artifact={step.screenshot} serial={serial} chinese={chinese} /> : null}
    </li>;
  })}</ol>;
}

export function ScenarioReportMetadata({ device, observation, observationError, screenshot, logs, serial, chinese }: {
  device?: HarmonyScenarioResult["device"]; observation?: HarmonyScenarioResult["finalObservation"];
  screenshot?: HarmonyMediaArtifact; serial: string;
  logs?: HarmonyScenarioResult["logs"];
  observationError?: HarmonyScenarioResult["finalObservationError"]; chinese: boolean;
}) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const quality: Record<string, string> = chinese ? { valid: "有效", partial: "不完整", empty: "空", unavailable: "不可用", parse_failed: "解析失败" }
    : { valid: "Valid", partial: "Partial", empty: "Empty", unavailable: "Unavailable", parse_failed: "Parse failed" };
  return <>
    {device ? <p>{device.model ?? copy("型号未提供", "Model unavailable")} · {device.osVersion ?? copy("系统版本未提供", "OS version unavailable")} · API {device.apiVersion ?? "—"}</p> : null}
    {observation ? <p>{copy("最终 UI 观察", "Final UI observation")}: {observation.capturedAt} · {observation.nodeCount} {copy("个节点", "nodes")} · {quality[observation.quality?.treeStatus ?? ""] ?? copy("质量未确认", "Quality unconfirmed")}</p> : null}
    {observationError ? <p role="status">{copy("最终画面或 UI 采集未完成：", "Final frame or UI capture did not complete: ")}{String(observationError.message ?? observationError.code ?? "")}</p> : null}
    {screenshot ? <section aria-label={copy("结束截图", "Final screenshot")}><strong>{copy("结束截图", "Final screenshot")}</strong><ScreenshotResult key={screenshot.filename} artifact={screenshot} serial={serial} chinese={chinese} final /></section> : null}
    {logs ? <details><summary>{copy("报告日志片段", "Report log excerpt")} · {logs.entries.length} {copy("行", "lines")}</summary>
      <p>{copy("采集时设备最近日志，可能包含场景开始前及其他应用的日志，不是本次运行的完整日志。", "Recent device logs at collection time; may include earlier or other-app entries. This is not the complete log of this run.")} · {logs.capturedAt}</p>
      {logs.status === "failed" ? <p role="status">{copy("日志未采集：", "Logs were not collected: ")}{String(logs.error?.message ?? logs.error?.code ?? copy("原因未提供", "Reason unavailable"))}</p>
        : <><p>{copy(`最多 ${logs.limit} 行 / 128 KiB`, `Up to ${logs.limit} lines / 128 KiB`)}{logs.truncated ? ` · ${copy("内容已截断", "Content truncated")}` : ""}</p><pre style={{ maxHeight: 240, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{logs.entries.map(entry => entry.raw).join("\n") || copy("本次采集没有日志行。", "No log rows were returned at collection time.")}</pre></>}
    </details> : null}
  </>;
}
