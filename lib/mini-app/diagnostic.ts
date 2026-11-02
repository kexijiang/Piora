import { isMiniAppError } from "./limits";

export interface MiniAppDiagnostic {
  code: string;
  message: string;
  path?: string;
  repairable: boolean;
  issues?: Array<{ code: string; message: string; path: string; repairable: boolean }>;
  contract?: { tool: "piora_render_mini_app"; planVersion: 1; resubmit: string; required: readonly string[]; omitUnused: readonly string[] };
}

/** Only app-owned errors may supply diagnostics; never echo arbitrary VM stacks. */
export function miniAppDiagnostic(error: unknown, fallback: MiniAppDiagnostic): MiniAppDiagnostic {
  if (!isMiniAppError(error)) return fallback;
  const rawIssues = (error as typeof error & { issues?: unknown }).issues;
  const issues = Array.isArray(rawIssues) ? rawIssues.slice(0, 8).filter(isMiniAppError).map(issue => ({
    code: issue.code.slice(0, 80), message: issue.message.slice(0, 600), path: issue.path.slice(0, 240), repairable: issue.repairable,
  })) : undefined;
  return { code: error.code.slice(0, 80), message: error.message.slice(0, 600),
    path: error.path.slice(0, 240), repairable: error.repairable,
    ...(issues?.length ? { issues } : {}),
    ...(error.repairable ? { contract: { tool: "piora_render_mini_app" as const, planVersion: 1 as const,
      resubmit: "Resubmit a complete plan including purpose and all required keys below, not a patch. Keep planVersion:1; correct all issues together without changing the task.",
      required: ["planVersion", "id", "title", "purpose", "assumptions", "inputs", "stateSchema", "document", "viewports", "playback", "program", "initialSnapshot"],
      omitUnused: ["inputPresets", "migration", "conversion", "actions"] } } : {}) };
}
