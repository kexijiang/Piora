// Keep old values: auto remains HUMAN approval; AI review requires explicit opt-in.
export const PERMISSION_MODES = ["auto", "review", "full", "ask"] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];
export interface ToolPermissionState { mode: PermissionMode; revision: number; legacy?: boolean }
export interface ToolPermissionEvidence { trustedTool: boolean; safeTarget: boolean }
export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.includes(value as PermissionMode);
}

/** Only known structured operations are exempt. Names/keywords never prove arbitrary code safe. */
export function needsToolApproval(state: ToolPermissionState, name: string, input: unknown, evidence?: ToolPermissionEvidence): boolean {
  if (state.legacy || state.mode === "full") return false;
  if (!evidence?.trustedTool) return true;
  if (name === "piora_request_user_input") return false;
  if (["read", "grep", "find", "ls"].includes(name) && evidence.safeTarget) return false;
  const action = input && typeof input === "object" ? (input as { action?: unknown }).action : undefined;
  if (name === "browser" && ["snapshot", "screenshot", "tabs", "scroll", "wait_for_user"].includes(String(action))) return false;
  if (state.mode === "auto" || state.mode === "review") {
    if (["write", "edit"].includes(name) && evidence.safeTarget) return false;
    // Opening a page is navigation. Click/type/press can submit, delete, or purchase;
    // without structured effect metadata they require approval in auto mode.
    if (name === "browser" && evidence.safeTarget && ["open", "new_tab"].includes(String(action))) return false;
  }
  return true;
}
