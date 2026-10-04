"use client";

import { useCallback, useEffect, useState } from "react";
import type { HarmonyTaskCategory, HarmonyTaskOverviewItem } from "@/lib/harmony/task-overview";
import { HarmonyRequestError } from "@/lib/harmony/request-error";
import styles from "../HarmonyPanel.module.css";

type Filter = HarmonyTaskCategory | "all";
type Overview = { tasks: HarmonyTaskOverviewItem[]; counts: Record<Filter, number>; truncated: boolean };

export function TaskOverview({ serial, chinese }: { serial: string; chinese: boolean }) {
  const copy = (zh: string, en: string) => chinese ? zh : en;
  const [snapshot, setSnapshot] = useState<{ serial: string; overview: Overview }>();
  const overview = snapshot?.serial === serial ? snapshot.overview : undefined;
  const [filter, setFilter] = useState<Filter>("all");
  const [error, setError] = useState("");
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/harmony/tasks?serial=${encodeURIComponent(serial)}&filter=${filter}`, { cache: "no-store", signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? data.error ?? "Unable to load tasks");
    if (!Array.isArray(data.tasks) || !data.counts) throw new Error("Invalid task overview");
    setSnapshot({ serial, overview: data }); setError("");
  }, [serial, filter]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); });
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(controller.signal).catch(() => undefined); }, 5_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [load]);
  const status = (value: string) => ({ queued: copy("排队中", "Queued"), running: copy("进行中", "Running"),
    completed: copy("已完成", "Completed"), passed: copy("已通过", "Passed"), failed: copy("失败", "Failed"),
    cancelled: copy("已取消", "Cancelled"), interrupted: copy("待核对", "Needs review") })[value as "queued"] ?? value;
  const kind = (value: HarmonyTaskOverviewItem["kind"]) => ({ transfer: copy("传输", "Transfer"), database: copy("数据库导出", "Database export"),
    scenario: copy("测试执行", "Scenario"), media: copy("媒体", "Media"), installation: copy("应用安装", "App installation"), snapshot: copy("数据库采集", "Database capture") })[value];
  const detail = (task: HarmonyTaskOverviewItem) => {
    if (task.kind === "transfer") return copy(`${task.completedItems}/${task.totalItems} 项已确认 · ${task.completedBytes} B`,
      `${task.completedItems}/${task.totalItems} confirmed · ${task.completedBytes} B`);
    if (task.kind === "database") return `${task.format?.toUpperCase()} · ${task.rows === undefined ? copy("行数待统计", "Rows pending") : copy(`${task.rows} 行`, `${task.rows} rows`)}${task.bytes === undefined ? "" : ` · ${task.bytes} B`}`;
    if (task.kind === "scenario") return copy(`${task.passedSteps}/${task.totalSteps} 步通过`, `${task.passedSteps}/${task.totalSteps} steps passed`);
    if (task.kind === "installation") return task.status === "completed" ? copy("设备已确认安装；版本信息请在应用页核对", "Device confirmed installation; check the version in Apps")
      : task.category === "active" ? copy("等待设备确认", "Awaiting device confirmation") : copy("未取得安装成功回执", "No installation success receipt");
    if (task.kind === "snapshot") return task.status === "completed" ? copy(`已核对两份副本 · ${task.bytes} B`, `Two copies verified · ${task.bytes} B`) : copy("尚未取得经验证的快照", "No verified snapshot yet");
    const media = task.mediaKind === "screenshot" ? copy("截图", "Screenshot") : copy("录屏", "Recording");
    if (task.operation?.phase === "starting" && task.category === "active") return `${media} · ${copy("等待首个编码帧确认", "Awaiting the first confirmed encoded frame")}`;
    if (task.operation?.phase === "recording" && task.category === "active") return `${media} · ${copy("正在录制", "Recording")}`;
    if (task.operation?.phase === "saving" && task.category === "active") return `${media} · ${copy("正在停止并保存", "Stopping and saving")}`;
    return `${media}${task.bytes === undefined ? ` · ${task.category === "active" ? copy("正在采集", "Capturing") : copy("尚未确认保存", "Save unconfirmed")}` : ` · ${task.bytes} B`}`;
  };
  const visible = overview?.tasks.filter(task => filter === "all" || task.category === filter) ?? [];
  const showDetails = (event: React.MouseEvent<HTMLButtonElement>, task: HarmonyTaskOverviewItem) => {
    event.currentTarget.closest('[role="tabpanel"]')?.querySelector<HTMLElement>(`[data-harmony-task-section="${task.kind}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  return <section className={styles.taskOverview} aria-label={copy("任务总览", "Task overview")}>
    <div className={styles.taskOverviewHeader}><strong>{copy("任务总览", "Task overview")}</strong><button type="button" onClick={() => void load().catch(failure => setError(failure instanceof Error ? failure.message : String(failure)))}>{copy("刷新", "Refresh")}</button></div>
    <div className={styles.taskOverviewFilters} role="group" aria-label={copy("筛选任务状态", "Filter task status")}>
      {(["all", "active", "completed", "attention"] as const).map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
        {({ all: copy("全部", "All"), active: copy("进行中", "Active"), completed: copy("已完成", "Completed"), attention: copy("失败/待核对", "Failed / review") })[value]} <span>{overview?.counts[value] ?? 0}</span>
      </button>)}
    </div>
    {error ? <p role="alert">{error}</p> : null}
    {overview?.truncated ? <small>{copy("仅汇总可索引的近期记录，当前筛选最多显示 100 项；下方可查看分类记录。", "Showing recent indexed records, up to 100 matching items; category histories remain below.")}</small> : null}
    {!overview || overview.counts.all === 0 ? <p className={styles.mediaEmpty}>{copy("暂无任务记录", "No tasks yet")}</p> : null}
    {overview && !visible.length && overview.counts.all > 0 ? <p className={styles.mediaEmpty}>{copy("此状态下没有任务", "No tasks in this status")}</p> : null}
    <div className={styles.taskOverviewList}>{visible.map(task => <article key={`${task.kind}:${task.id}`} className={styles.taskOverviewRow}>
      <div><span>{kind(task.kind)}</span><strong title={task.title}>{task.operation && task.kind === "media" ? task.mediaKind === "screenshot" ? copy("设备截图", "Device screenshot") : copy("屏幕录制", "Screen recording") : task.title}</strong><time dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleString()}</time></div>
      <small>{detail(task)}</small>
      <div><span data-category={task.category}>{status(task.status)}</span>{!task.operation || task.operation.mediaFilename ? <button type="button" onClick={event => showDetails(event, task)}>{copy("查看分类记录", "View category records")}</button> : null}</div>
      {task.operation ? <details className={styles.operationTaskDetails}><summary>{copy("查看任务详情", "View task details")}</summary>
        <dl><dt>{copy("任务 ID", "Task ID")}</dt><dd>{task.id}</dd><dt>{copy("目标设备", "Target device")}</dt><dd>{serial}</dd>
          <dt>{copy("目标", "Target")}</dt><dd>{task.operation.target}</dd>
          <dt>{copy("最近更新", "Updated")}</dt><dd>{new Date(task.operation.updatedAt).toLocaleString()}</dd>
          {task.operation.capturedAt ? <><dt>{copy("采集时间", "Captured")}</dt><dd>{new Date(task.operation.capturedAt).toLocaleString()}</dd></> : null}
          {task.operation.mediaFilename ? <><dt>{copy("保存文件", "Saved file")}</dt><dd>{task.operation.mediaFilename}</dd></> : null}
        </dl>
        {task.kind === "snapshot" ? <p>{copy("这里只保留采集记录。查看当前数据请回到数据库页重新取得快照。", "This is a capture record. Open Database to collect a fresh snapshot for current data.")}</p> : null}
        {task.status === "interrupted" ? <p>{copy("结果尚未确认，请核对设备；不会自动重试。", "Outcome is unconfirmed. Check the device; no automatic retry.")}</p> : null}
      </details> : null}
      {task.error ? <small role="alert">{task.operation?.signatureRejected ? new HarmonyRequestError({ code: "COMMAND_FAILED", details: {
        reason: "signature-rejected", deviceErrorCode: task.operation.deviceErrorCode } }, 502).messageFor(chinese) : task.error}</small> : null}
    </article>)}</div>
  </section>;
}
