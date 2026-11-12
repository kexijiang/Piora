import { createHash, randomUUID } from "node:crypto";
import { readLaboratorySettings } from "./laboratory-settings.ts";
import { WorkflowStore, type WorkflowRecord } from "./workflow-store.ts";
import { MAX_WORKFLOW_TURN_BUDGET, type WorkflowAction, type WorkflowActionResult, type WorkflowCriterion, type WorkflowPromptOptions, type WorkflowSnapshot } from "./workflow-types.ts";

export { readWorkflowSnapshot } from "./workflow-store.ts";
const terminal = new Set(["completed", "cancelled", "failed"]);
export class WorkflowError extends Error {
  constructor(message: string, readonly code = "WORKFLOW_CONFLICT", readonly status = 409) { super(message); }
}
/** SDK-loaded extensions and Next routes can have distinct class identities. */
export function isWorkflowError(error: unknown): error is WorkflowError {
  if (!error || typeof error !== "object") return false;
  const value = error as { message?: unknown; code?: unknown; status?: unknown };
  return typeof value.message === "string"
    && typeof value.code === "string" && typeof value.status === "number"
    && ["INVALID_WORKFLOW", "WORKFLOW_CONFLICT", "WORKFLOW_UNAVAILABLE", "WORKFLOW_LABORATORY_DISABLED", "WORKFLOW_EXTENSION_COMMAND", "WORKFLOW_SHELL_COMMAND"].includes(value.code)
    && [400, 403, 409, 503].includes(value.status);
}
export function validateWorkflowBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_WORKFLOW_TURN_BUDGET) throw new WorkflowError("Turn budget must be an integer from 1 to 100", "INVALID_WORKFLOW", 400);
  return value;
}
function text(value: string, limit = 100_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new WorkflowError("Workflow text is empty or too large", "INVALID_WORKFLOW", 400);
  return value;
}
function requireLaboratoryEnabled(): void {
  if (!readLaboratorySettings().planGoalEnabled) throw new WorkflowError("Enable Plan and Goal in Settings > Laboratory before continuing.", "WORKFLOW_LABORATORY_DISABLED", 409);
}
export class WorkflowRuntime {
  private attached = 0;
  private activeTools?: () => string[];
  private turnRunId: string | null = null;
  private progressRevision = 0;
  private turnProgressRevision = 0;
  private toolEvidence = new Set<string>();
  private listeners = new Set<(snapshot: WorkflowSnapshot) => void>();
  constructor(readonly sessionId: string, readonly store = new WorkflowStore()) {}
  get isAttached(): boolean { return this.attached > 0; }
  attach(activeTools?: () => string[]): () => void { this.attached++; this.activeTools = activeTools; return () => { this.attached = Math.max(0, this.attached - 1); }; }
  private requireModeTools(mode: WorkflowPromptOptions["mode"]): void {
    if (mode === "agent") return;
    requireLaboratoryEnabled();
    if (!this.isAttached) throw new WorkflowError("Workflow extension is unavailable", "WORKFLOW_UNAVAILABLE", 503);
    const required = mode === "plan" ? "piora_submit_plan" : "piora_update_goal";
    if (this.activeTools && !this.activeTools().includes(required)) throw new WorkflowError(`The required workflow tool ${required} is unavailable in this session. Reopen the chat and try again.`, "WORKFLOW_UNAVAILABLE", 409);
  }
  subscribe(listener: (snapshot: WorkflowSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  getSnapshot(): WorkflowSnapshot { return this.store.read(this.sessionId).snapshot; }
  private change<T>(operation: (record: WorkflowRecord) => T): T {
    const record = this.store.read(this.sessionId);
    const before = JSON.stringify(record);
    const result = operation(record);
    if (JSON.stringify(record) !== before) {
      record.snapshot.revision++;
      if (record.snapshot.current) record.snapshot.current.updatedAt = Date.now();
      this.store.write(record);
      // Transport observers cannot turn a committed action into an apparent failure.
      for (const listener of this.listeners) {
        try { listener(structuredClone(record.snapshot)); }
        catch (error) { console.error("[piora-workflow] state observer failed", error); }
      }
    }
    return result;
  }
  configure(options: WorkflowPromptOptions & { expectedRevision?: number }): WorkflowSnapshot {
    if (!["agent", "plan", "goal"].includes(options.mode)) throw new WorkflowError("Unknown workflow mode", "INVALID_WORKFLOW", 400);
    this.requireModeTools(options.mode);
    if (options.turnBudget !== undefined) validateWorkflowBudget(options.turnBudget);
    this.change(({ snapshot }) => {
      if (options.expectedRevision !== undefined && snapshot.revision !== options.expectedRevision) throw new WorkflowError("Workflow changed; reload before selecting a mode");
      if (snapshot.current?.status === "running") throw new WorkflowError("Pause the workflow before changing mode");
      if (snapshot.mode !== options.mode && snapshot.current && !terminal.has(snapshot.current.status)) {
        snapshot.current.status = "cancelled"; snapshot.current.reason = "mode_changed";
      }
      snapshot.mode = options.mode;
      if (options.turnBudget !== undefined) snapshot.turnBudget = options.turnBudget;
    });
    return this.getSnapshot();
  }
  /** Called at actual prompt admission with the original user text. Internal continuations never replace it. */
  preparePrompt(objective: string): WorkflowSnapshot {
    this.change(({ snapshot }) => {
      if (snapshot.mode === "agent") return;
      this.requireModeTools(snapshot.mode);
      const current = snapshot.current;
      if (current?.status === "awaiting_approval") throw new WorkflowError("Review or revise the submitted plan before sending another prompt");
      if (current && !terminal.has(current.status) && current.kind === snapshot.mode) {
        if (current.kind === "goal" && current.turnsUsed >= current.turnBudget) throw new WorkflowError("Increase the turn budget before continuing the goal");
        if (current.status === "budget_exhausted") throw new WorkflowError("Increase the turn budget and resume the goal");
        if (snapshot.mode === "goal" && !["running", "waiting"].includes(current.status)) throw new WorkflowError("Resume or cancel the current goal before starting another one");
        if (current.status === "waiting") { current.noProgressTurns = 0; current.reason = ""; }
        current.status = snapshot.mode === "plan" ? "planning" : "running";
        return;
      }
      if (current) snapshot.history.push(structuredClone(current));
      snapshot.current = { id: randomUUID(), kind: snapshot.mode, status: snapshot.mode === "plan" ? "planning" : "running", objective: text(objective), title: "", markdown: "", criteria: [], progress: "", reason: "", turnBudget: snapshot.turnBudget, turnsUsed: 0, noProgressTurns: 0, version: 1, createdAt: Date.now(), updatedAt: Date.now() };
      this.progressRevision = 0; this.toolEvidence.clear();
    });
    return this.getSnapshot();
  }
  action(input: WorkflowAction): WorkflowActionResult {
    let prompt: string | undefined;
    this.change(record => {
      const key = `${input.runId}:${input.expectedRevision}:${input.action}:${input.turnBudget ?? ""}`;
      if (record.actions.includes(key)) return;
      const { snapshot } = record;
      const run = snapshot.current;
      if (!run || run.id !== input.runId || snapshot.revision !== input.expectedRevision) throw new WorkflowError("This workflow action is stale; reload its current state");
      if (["approve", "revise", "resume", "set_budget"].includes(input.action)) requireLaboratoryEnabled();
      switch (input.action) {
        case "approve":
          if (run.kind !== "plan" || run.status !== "awaiting_approval") throw new WorkflowError("This plan is not awaiting approval");
          if (!this.isAttached) throw new WorkflowError("Workflow extension is unavailable", "WORKFLOW_UNAVAILABLE", 503);
          snapshot.mode = "agent"; run.status = "running"; run.reason = "";
          prompt = `Execute the approved plan in this conversation. Preserve the approved scope and report actual verification.\n\nObjective:\n${run.objective}\n\nApproved plan (version ${run.version}):\n${run.markdown}`;
          break;
        case "revise":
          if (run.kind !== "plan" || run.status !== "awaiting_approval") throw new WorkflowError("This plan is not awaiting approval");
          snapshot.history.push(structuredClone(run)); run.version++; run.status = "planning"; run.reason = "revision_requested";
          break;
        case "exit":
          if (run.status === "running") throw new WorkflowError("Stop the active execution before exiting");
          if (!terminal.has(run.status)) { run.status = "cancelled"; run.reason = "user_exited"; }
          snapshot.mode = "agent"; break;
        case "pause":
          if (terminal.has(run.status) || run.status === "awaiting_approval") throw new WorkflowError("This workflow cannot be paused");
          run.status = "paused"; run.reason = "user_paused"; this.turnRunId = null; break;
        case "cancel":
          if (terminal.has(run.status)) throw new WorkflowError("This workflow has already ended");
          run.status = "cancelled"; run.reason = "user_cancelled"; snapshot.mode = "agent"; this.turnRunId = null; break;
        case "resume":
          if (!["paused", "waiting", "budget_exhausted", "failed"].includes(run.status)) throw new WorkflowError("This workflow cannot be resumed");
          this.requireModeTools(run.kind);
          if (run.kind === "goal" && run.turnsUsed >= run.turnBudget) throw new WorkflowError("Increase the turn budget before resuming");
          // Failed/interrupted approved execution returns to review, never edits
          // the exact artifact that was already approved under the same version.
          if (run.kind === "plan" && snapshot.mode === "agent" && run.markdown) {
            snapshot.history.push(structuredClone(run)); run.version++;
          }
          run.status = run.kind === "plan" ? "planning" : "running"; run.reason = ""; run.noProgressTurns = 0;
          snapshot.mode = run.kind;
          prompt = run.kind === "goal" ? "Continue the existing goal using its preserved objective, criteria, and evidence. Recheck the current workspace before acting." : "Continue preparing the existing plan. Submit a complete revised plan for review; do not implement it.";
          break;
        case "set_budget":
          if (run.kind !== "goal" || input.turnBudget === undefined) throw new WorkflowError("A goal turn budget is required", "INVALID_WORKFLOW", 400);
          run.turnBudget = validateWorkflowBudget(input.turnBudget); snapshot.turnBudget = run.turnBudget; break;
        default: throw new WorkflowError("Unknown workflow action", "INVALID_WORKFLOW", 400);
      }
      record.actions.push(key);
    });
    return { snapshot: this.getSnapshot(), ...(prompt ? { prompt } : {}) };
  }
  beginTurn(): string {
    const snapshot = this.getSnapshot();
    const run = snapshot.current;
    this.turnRunId = run && ["running", "planning"].includes(run.status) ? run.id : null;
    this.turnProgressRevision = this.progressRevision;
    if (!run || !this.turnRunId) return "";
    if (snapshot.mode === "plan") return `You are in Plan mode. Study the user's objective and ask necessary questions. Do not implement changes. Only read, grep, find, ls, the permitted read-only browser actions and user questions are allowed; shell and unknown/MCP tools are blocked. When ready call piora_submit_plan with a complete plan containing objective, scope, implementation steps and verification. The host saves an immutable review snapshot. Wait for the user's Execute plan action. Objective:\n${run.objective}\nPrevious plan:\n${run.markdown}`;
    if (run.kind === "goal" && snapshot.mode === "goal") return `You are in Goal mode. Pursue this original objective without narrowing or replacing it:\n${run.objective}\nBudget: ${run.turnsUsed}/${run.turnBudget} turns used. The host continues unfinished work after a turn ends. Use piora_update_goal to record checkable criteria and concrete observed evidence. Criteria are locked after first declaration. Mark completed only when every criterion is verified with actual current evidence; evidence remains your report, not automatic proof. If you need user input or cannot proceed, set waiting with a reason. Never mark completion to stop.\nCurrent goal state:\n${JSON.stringify(run)}`;
    return "";
  }
  submitPlan(title: string, markdown: string): WorkflowSnapshot {
    this.change(({ snapshot }) => {
      const run = snapshot.current;
      if (snapshot.mode !== "plan" || !run || run.id !== this.turnRunId || run.status !== "planning") throw new WorkflowError("Plan submission is not active");
      run.title = text(title, 500); run.markdown = text(markdown); run.status = "awaiting_approval"; run.reason = "";
    });
    return this.getSnapshot();
  }
  updateGoal(input: { progress: string; criteria?: WorkflowCriterion[]; status?: "running" | "completed" | "waiting"; reason?: string }): WorkflowSnapshot {
    this.change(({ snapshot }) => {
      const run = snapshot.current;
      if (snapshot.mode !== "goal" || !run || run.id !== this.turnRunId || run.status !== "running") throw new WorkflowError("Goal update is not active");
      const before = JSON.stringify([run.progress, run.criteria]);
      const progress = text(input.progress, 20_000);
      if (input.criteria) {
        if (!input.criteria.length || input.criteria.length > 50) throw new WorkflowError("Declare 1 to 50 acceptance criteria", "INVALID_WORKFLOW", 400);
        const ids = new Set<string>();
        for (const criterion of input.criteria) {
          text(criterion.id, 100); text(criterion.text, 5000);
          if (ids.has(criterion.id) || !["pending", "verified"].includes(criterion.status) || typeof criterion.evidence !== "string" || criterion.evidence.length > 20_000) throw new WorkflowError("Invalid acceptance criterion", "INVALID_WORKFLOW", 400);
          ids.add(criterion.id);
          if (criterion.status === "verified") text(criterion.evidence, 20_000);
        }
        if (run.criteria.length && (run.criteria.length !== input.criteria.length || run.criteria.some(previous => !input.criteria!.some(next => next.id === previous.id && next.text === previous.text)))) throw new WorkflowError("Acceptance criteria cannot be removed or redefined; ask the user to start a revised goal");
      }
      const criteria = input.criteria ?? run.criteria;
      if (input.status === "completed" && (!criteria.length || criteria.some(c => c.status !== "verified" || !c.evidence.trim()))) throw new WorkflowError("Every acceptance criterion needs verified evidence before completion");
      if (input.status === "waiting") text(input.reason ?? "", 5000);
      run.progress = progress; run.criteria = structuredClone(criteria);
      if (input.status) run.status = input.status;
      run.reason = input.status === "waiting" ? input.reason! : "";
      if (JSON.stringify([run.progress, run.criteria]) !== before) this.progressRevision++;
    });
    return this.getSnapshot();
  }
  recordToolEvidence(name: string, result: unknown): void {
    if (name.startsWith("piora_")) return;
    const hash = createHash("sha256").update(`${name}:${JSON.stringify(result)}`).digest("hex");
    if (!this.toolEvidence.has(hash)) { this.toolEvidence.add(hash); this.progressRevision++; }
  }
  /** Returns a continuation only for the still-current running goal, never an old/aborted turn. */
  endTurn(error = false): string | undefined {
    const turnRunId = this.turnRunId;
    this.turnRunId = null;
    let continuation: string | undefined;
    this.change(({ snapshot }) => {
      const run = snapshot.current;
      if (!run || run.id !== turnRunId || run.kind !== "goal") return;
      if (error) return; // SDK retries/fallback remain within the original logical turn.
      run.turnsUsed++;
      if (run.status !== "running") return;
      let laboratoryEnabled = false;
      try { laboratoryEnabled = readLaboratorySettings().planGoalEnabled; } catch { /* Invalid settings also stop automatic continuation. */ }
      if (!laboratoryEnabled) { run.status = "paused"; run.reason = "laboratory_disabled"; return; }
      run.noProgressTurns = this.progressRevision === this.turnProgressRevision ? run.noProgressTurns + 1 : 0;
      if (run.turnsUsed >= run.turnBudget) { run.status = "budget_exhausted"; run.reason = "turn_budget_exhausted"; }
      else if (run.noProgressTurns >= 3) { run.status = "waiting"; run.reason = "no_progress"; }
      else continuation = "Continue the current goal. Preserve its objective and acceptance criteria. Record new progress/evidence with piora_update_goal, or report waiting with a concrete reason; complete only after every criterion is verified.";
    });
    return continuation;
  }
  onPromptSettled(): void {
    this.change(({ snapshot }) => {
      const run = snapshot.current;
      if (run?.kind === "plan" && run.status === "running" && snapshot.mode === "agent") { run.status = "completed"; run.reason = "execution_finished"; }
      else if (run?.kind === "plan" && run.status === "planning") { run.status = "waiting"; run.reason = "planning_needs_input"; }
    });
  }
  onPromptError(reason: string): void {
    this.turnRunId = null;
    this.change(({ snapshot }) => { const run = snapshot.current; if (run && ["running", "planning"].includes(run.status)) { run.status = "failed"; run.reason = reason.slice(0, 5000); } });
  }
  onAbort(): void {
    this.turnRunId = null;
    this.change(({ snapshot }) => { const run = snapshot.current; if (run && ["running", "planning"].includes(run.status)) { run.status = "paused"; run.reason = "user_stopped"; } });
  }
  dispose(): void { this.onAbort(); }
}

const host = globalThis as typeof globalThis & { __pioraWorkflows?: Map<string, WorkflowRuntime> };
export function getWorkflowRuntime(sessionId: string, store = new WorkflowStore()): WorkflowRuntime {
  const runtimes = host.__pioraWorkflows ??= new Map();
  const key = `${store.directory}:${sessionId}`;
  let runtime = runtimes.get(key);
  if (!runtime) { runtime = new WorkflowRuntime(sessionId, store); runtimes.set(key, runtime); }
  return runtime;
}
export function findWorkflowRuntime(sessionId: string, store = new WorkflowStore()): WorkflowRuntime | undefined {
  return host.__pioraWorkflows?.get(`${store.directory}:${sessionId}`);
}

/** Explicit capability boundary: arbitrary shell programs cannot be proved read-only. */
export function planToolAllowed(name: string, input: Record<string, unknown>): boolean {
  if (["read", "grep", "find", "ls", "piora_submit_plan", "piora_request_user_input"].includes(name)) return true;
  if (name !== "browser") return false;
  if (["snapshot", "screenshot", "tabs", "switch_tab", "scroll"].includes(String(input.action))) return true;
  if (!["open", "new_tab"].includes(String(input.action)) || typeof input.url !== "string") return false;
  try { return ["http:", "https:"].includes(new URL(input.url).protocol); } catch { return false; }
}
