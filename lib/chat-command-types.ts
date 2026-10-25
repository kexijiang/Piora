export type ChatCommandSource = "builtin" | "extension" | "prompt" | "skill";
export type ChatCommandArgumentMode = "none" | "required" | "optional" | "opaque";
export type ChatCommandPhase = "preparing" | "queued" | "executing" | "waiting_input" | "waiting_client" | "model" | "settling";

export interface ChatCommandDescriptor {
  key: string;
  name: string;
  description?: string;
  source: ChatCommandSource;
  sourceInfo?: { path: string; source: string; scope: "user" | "project" | "temporary"; origin: "package" | "top-level"; baseDir?: string };
  argumentMode: ChatCommandArgumentMode;
  argumentHint?: string;
  busyBehavior: "immediate" | "wait" | "read";
  supported: boolean;
  unavailableReason?: string;
  usesTemplateArguments?: boolean;
}

export interface ChatCommandCatalog {
  revision: string;
  commands: ChatCommandDescriptor[];
  diagnostics: string[];
}

export interface ChatCommandResult {
  title: string;
  message?: string;
  details?: string[];
  warnings?: string[];
  resources?: { extensions: number; skills: number; prompts: number; commands: number };
  compact?: { tokensBefore?: number; tokensAfter?: number; summary?: string };
  rename?: { before?: string; after: string };
  stats?: import("./pi-types").SessionStatsInfo;
  clientAction?: { id: string; kind: "copy"; characters: number; expiresAt: number };
}

export interface ChatCommandStep {
  id: string;
  kind: "command" | "prompt";
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "blocked";
  startedAt?: number;
  completedAt?: number;
  runId?: string;
  error?: string;
}

export interface ChatCommandOperation {
  inputOptions?: ChatInputOptions;
  version: 1;
  rawText: string;
  catalogRevision: string;
  command: ChatCommandDescriptor;
  arguments: string;
  afterPrompt?: string;
  phase: ChatCommandPhase;
  steps: ChatCommandStep[];
  result?: ChatCommandResult;
  startedAt?: number;
  completedAt?: number;
  anchorEntryId?: string;
}

export type ParsedChatInput =
  | { kind: "message"; text: string }
  | { kind: "command"; command: ChatCommandDescriptor; arguments: string; invocation: string; afterPrompt?: string }
  | { kind: "invalid"; code: "UNKNOWN_COMMAND" | "UNSUPPORTED_COMMAND" | "COMMAND_ARGUMENT_REQUIRED" | "UNUSED_TEMPLATE_ARGUMENTS" | "COMMAND_ATTACHMENTS_UNSUPPORTED" | "AMBIGUOUS_AFTER_PROMPT"; name: string };

export interface ChatInputOptions {
  submissionId?: string;
  delivery?: "next_turn" | "steer" | "followUp";
  inputMode?: "auto" | "text";
  commandKey?: string;
  catalogRevision?: string;
  afterPrompt?: string;
}

export interface ChatCommandView {
  revision?: number;
  queuePaused?: boolean;
  commandId: string;
  idempotencyKey: string;
  targetSessionId: string;
  acceptedAt: number;
  status: import("./session-message-types").SessionCommandStatus;
  operation?: ChatCommandOperation;
  preview?: string;
  attachments?: number;
  errorCode?: string;
  errorMessage?: string;
  local?: boolean;
}
