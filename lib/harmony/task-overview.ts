import type { HarmonyDatabaseExportJob } from "./database-export-jobs";
import type { HarmonyTransferJob } from "./transfer-jobs";
import type { ScenarioExecution } from "./scenario/execution-store";
import type { HarmonyMediaArtifact } from "./types";
import type { HarmonyOperationTask } from "./operation-tasks";

export type HarmonyTaskCategory = "active" | "completed" | "attention";
export interface HarmonyTaskOverviewItem {
  id: string;
  kind: "transfer" | "database" | "scenario" | "media" | "installation" | "snapshot";
  category: HarmonyTaskCategory;
  status: string;
  title: string;
  createdAt: string;
  error?: string;
  completedItems?: number;
  totalItems?: number;
  completedBytes?: number;
  rows?: number;
  bytes?: number;
  format?: string;
  passedSteps?: number;
  totalSteps?: number;
  mediaKind?: HarmonyMediaArtifact["kind"];
  operation?: HarmonyOperationTask;
}

function category(status: string): HarmonyTaskCategory {
  if (status === "queued" || status === "running") return "active";
  if (status === "completed" || status === "passed") return "completed";
  return "attention";
}

/** Read-only index over existing journals. Item-level actions stay with their source workbenches. */
export function summarizeHarmonyTasks(input: {
  transfers: HarmonyTransferJob[];
  databases: HarmonyDatabaseExportJob[];
  scenarios: ScenarioExecution[];
  media: HarmonyMediaArtifact[];
  operations?: HarmonyOperationTask[];
}, maximum = 100, filter: HarmonyTaskCategory | "all" = "all"): { tasks: HarmonyTaskOverviewItem[]; counts: Record<HarmonyTaskCategory | "all", number>; truncated: boolean } {
  const recordedMedia = new Set((input.operations ?? []).map(task => task.mediaFilename).filter(Boolean));
  const tasks: HarmonyTaskOverviewItem[] = [
    ...(input.operations ?? []).map(task => ({ id: task.id,
      kind: task.kind === "screenshot" || task.kind === "recording" ? "media" as const : task.kind,
      ...(task.kind === "screenshot" || task.kind === "recording" ? { mediaKind: task.kind } : {}),
      status: task.status, category: category(task.status), title: task.title,
      createdAt: task.createdAt, error: task.error, bytes: task.bytes, operation: task })),
    ...input.transfers.map(job => ({ id: job.id, kind: "transfer" as const, status: job.status, category: category(job.status),
      title: job.items[0]?.path ?? `#${job.id.slice(0, 8)}`, completedItems: job.completedItems, totalItems: job.totalItems,
      completedBytes: job.completedBytes, createdAt: job.createdAt, error: job.error })),
    ...input.databases.map(job => ({ id: job.id, kind: "database" as const, status: job.status, category: category(job.status),
      title: job.source, format: job.format, rows: job.rows, bytes: job.bytes,
      createdAt: job.createdAt, error: job.error })),
    ...input.scenarios.map(run => ({ id: run.id, kind: "scenario" as const, status: run.status, category: category(run.status),
      title: `#${run.id.slice(0, 8)}`,
      passedSteps: run.steps.filter(step => step.status === "passed").length, totalSteps: run.steps.length, createdAt: run.startedAt,
      error: run.steps.find(step => step.status === "failed")?.message })),
    ...input.media.filter(item => !recordedMedia.has(item.filename)).map(item => ({ id: item.filename, kind: "media" as const, status: "completed", category: "completed" as const,
      title: item.filename, mediaKind: item.kind, bytes: item.size, createdAt: item.createdAt })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const counts = { all: tasks.length, active: 0, completed: 0, attention: 0 };
  for (const task of tasks) counts[task.category]++;
  const matching = filter === "all" ? tasks : tasks.filter(task => task.category === filter);
  return { tasks: matching.slice(0, maximum), counts, truncated: matching.length > maximum };
}
