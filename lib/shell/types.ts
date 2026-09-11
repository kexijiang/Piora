/** Browser-safe wire types. All OS/model/database work remains on the server. */
export type ShellKind = "powershell" | "bash" | "zsh" | "cmd" | "custom";
export type ShellInputMode = "auto" | "command" | "agent";
export type ShellRunStatus = "running" | "awaiting_approval" | "awaiting_input" | "completed" | "failed" | "cancelled" | "interrupted";
export type CommandStatus = "accepted" | "running" | "completed" | "failed" | "interrupted" | "unknown";

export interface ShellModelPreference { provider: string; modelId: string; thinkingLevel?: string }
export interface ShellSettings {
  executable: string | null;
  model: ShellModelPreference | null;
  importSystemHistory: boolean;
  importPiHistory: boolean;
  sources: HistorySource[];
}
export interface ShellProfile { executable: string; label: string; kind: ShellKind; integrated: boolean; bundled?: boolean }
export interface ShellSession {
  id: string;
  title: string;
  initialCwd: string;
  /** Workspace that owns the tab; background commands may start in a subdirectory. */
  workspaceCwd?: string;
  cwd: string;
  profile: ShellProfile;
  createdAt: number;
  updatedAt: number;
  generation: number;
  connected: boolean;
  integration: "starting" | "ready" | "unavailable";
  integrationError: string | null;
  owner: "human" | "agent";
  activeCommandId: string | null;
  activeRunId: string | null;
  model: ShellModelPreference | null;
  draft: string;
  closed: boolean;
}
export interface CommandBlock {
  id: string;
  terminalId: string;
  runId: string | null;
  clientRequestId: string | null;
  command: string;
  cwd: string;
  endCwd: string | null;
  shell: ShellKind;
  source: "human" | "shell-agent";
  status: CommandStatus;
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  output: string;
  outputTruncated: boolean;
}
export interface ShellReference {
  kind: "file" | "message" | "command";
  label: string;
  path?: string;
  text?: string;
  sourceId?: string;
}
export interface ShellApproval {
  id: string;
  command: string;
  cwd: string;
  generation: number;
  reason: string;
}
export interface ShellRun {
  id: string;
  terminalId: string;
  clientRequestId: string;
  prompt: string;
  status: ShellRunStatus;
  model: ShellModelPreference | null;
  startedAt: number;
  endedAt: number | null;
  response: string;
  error: string | null;
  steps: number;
  approval: ShellApproval | null;
  question: string | null;
  references: ShellReference[];
}
export interface HistoryRecord {
  id: string;
  sourceId: string;
  source: "human" | "shell-agent" | "pi-agent" | "powershell" | "bash" | "zsh" | "legacy";
  command: string;
  cwd: string | null;
  shell: ShellKind | null;
  executedAt: number | null;
  importedAt: number;
  exitCode: number | null;
  status: CommandStatus | null;
  favorite: boolean;
  terminalId: string | null;
  sessionId: string | null;
}
export interface HistorySource {
  id: string;
  path: string;
  kind: "powershell" | "bash" | "zsh";
  enabled: boolean;
  offset?: number;
  fingerprint?: string;
  imported?: number;
  updatedAt?: number;
  error?: string | null;
}
export interface HistoryQuery {
  query?: string;
  cwd?: string;
  shell?: ShellKind;
  source?: HistoryRecord["source"];
  status?: CommandStatus;
  favorite?: boolean;
  offset?: number;
  limit?: number;
  suggestions?: boolean;
}
export type ShellHistoryFilters = Pick<HistoryQuery, "cwd" | "shell" | "source" | "status" | "favorite">;
export interface ShellSnapshot {
  session: ShellSession;
  commands: CommandBlock[];
  runs: ShellRun[];
  output: string;
  sequence: number;
}
export interface ShellTimelinePage {
  commands: CommandBlock[];
  runs: ShellRun[];
  nextCursor: string | null;
}
export type ShellEvent = { terminalId: string; generation: number; sequence: number } & (
  | { type: "snapshot"; snapshot: ShellSnapshot }
  | { type: "session"; session: ShellSession }
  | { type: "command"; command: CommandBlock }
  | { type: "output"; commandId: string | null; data: string }
  | { type: "run"; run: ShellRun }
  | { type: "clear" }
  | { type: "error"; error: string }
);
export interface ShellCompletion { value: string; label: string; kind: "history" | "file" | "directory" | "command" | "branch" | "script"; detail?: string }
