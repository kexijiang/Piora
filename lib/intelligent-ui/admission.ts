import { createHash } from "node:crypto";

/** A host-owned budget lasts for a PromptRun, including retries and model fallback. */
export const UI_ADMISSION_DEFAULTS = Object.freeze({ attempts: 3, corrections: 1, windowMs: 60_000 });
export interface UiAdmissionResult {
  content: unknown[];
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
  [key: string]: unknown;
}
export interface UiAdmissionOutcome { result: UiAdmissionResult; isError: boolean }
export interface UiAdmissionCall { id: string; name: string; arguments: unknown }
export interface UiAdmissionLease {
  signal: AbortSignal;
  check(): UiAdmissionOutcome | undefined;
  settle(outcome: UiAdmissionOutcome, phase: "validation" | "execution"): UiAdmissionOutcome;
}
export type UiAdmission = { immediate: UiAdmissionOutcome } | UiAdmissionLease | undefined;
export type UiAdmissionHook = (context: { toolCall: UiAdmissionCall }, signal?: AbortSignal) => Promise<UiAdmission>;
export interface UiAdmissionOptions {
  sessionId: string;
  runId: string;
  toolNames: readonly string[];
  /** Must check the authoritative PromptRun identity, not only wrapper liveness. */
  isActive(): boolean;
  /** Stop the task through the existing runtime after repeated denied calls. */
  onRepeatedDenial?(): void;
  now?: () => number;
  limits?: { attempts: number; corrections: number; windowMs: number };
}
interface Attempt {
  digest: string;
  outcome?: UiAdmissionOutcome;
  pending: Promise<UiAdmissionOutcome>;
  resolve(outcome: UiAdmissionOutcome): void;
}

function failure(code: string, repairable = false, terminate = false): UiAdmissionOutcome {
  return { isError: true, result: {
    content: [{ type: "text", text: `Intelligent UI: ${code}. ${repairable ? "Correct the arguments once using the tool contract." : "Do not retry this UI operation; preserve the existing answer and explain the limitation."}` }],
    details: { intelligentUiDiagnostic: { code, repairable } }, isError: true,
    ...(terminate ? { terminate: true } : {}),
  } };
}

/** Bounded, canonical JSON hashing; diagnostic output never includes the input. */
function digestCall(call: UiAdmissionCall): string {
  let nodes = 0;
  let bytes = 0;
  const seen = new Set<object>();
  const hash = createHash("sha256");
  const add = (part: string) => {
    bytes += part.length;
    if (bytes > 256_000) throw new Error("UI_INPUT_TOO_LARGE");
    hash.update(part);
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 20_000 || depth > 64) throw new Error("UI_INPUT_TOO_LARGE");
    if (typeof value === "string" && value.length > 256_000) throw new Error("UI_INPUT_TOO_LARGE");
    if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
      add(JSON.stringify(value)); return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) throw new Error("UI_ARGUMENTS_INVALID");
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("UI_ARGUMENTS_INVALID");
    seen.add(value);
    if (Array.isArray(value)) {
      add("[");
      for (const item of value) { visit(item, depth + 1); add(","); }
      add("]");
    } else {
      add("{");
      for (const key of Object.keys(value).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) throw new Error("UI_ARGUMENTS_INVALID");
        add(JSON.stringify(key)); add(":"); visit(descriptor.value, depth + 1); add(",");
      }
      add("}");
    }
    seen.delete(value);
  };
  add(call.name); add("\0"); visit(call.arguments, 0);
  return hash.digest("hex");
}

function repairable(outcome: UiAdmissionOutcome): boolean {
  const details = outcome.result.details;
  if (!details || typeof details !== "object") return false;
  const diagnostic = (details as Record<string, unknown>).intelligentUiDiagnostic;
  return !!diagnostic && typeof diagnostic === "object" && (diagnostic as Record<string, unknown>).repairable === true;
}

export class UiAdmissionBudget {
  readonly admit: UiAdmissionHook;
  private readonly names: Set<string>;
  private readonly clock: () => number;
  private readonly limits: Readonly<{ attempts: number; corrections: number; windowMs: number }>;
  private readonly attempts = new Map<string, Attempt>();
  private readonly cancellation = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private count = 0;
  private corrections = 0;
  private needsCorrection = false;
  private deadline?: number;
  private terminal?: string;
  private denials = 0;
  private pendingCount = 0;

  constructor(private readonly options: UiAdmissionOptions) {
    if (!options.sessionId || !options.runId || options.toolNames.length === 0) throw new Error("UI admission requires a run identity and registered tool names");
    this.names = new Set(options.toolNames);
    this.clock = options.now ?? Date.now;
    this.limits = options.limits ?? UI_ADMISSION_DEFAULTS;
    if (![this.limits.attempts, this.limits.windowMs].every(n => Number.isSafeInteger(n) && n > 0) || !Number.isSafeInteger(this.limits.corrections) || this.limits.corrections < 0) throw new Error("Invalid UI budget limits");
    this.admit = async ({ toolCall }, signal) => this.admitCall(toolCall, signal);
  }

  snapshot() {
    return { sessionId: this.options.sessionId, runId: this.options.runId, attempts: this.count, corrections: this.corrections, deadline: this.deadline, terminal: this.terminal, denials: this.denials };
  }

  cancel(): void {
    this.terminal = "UI_CANCELLED";
    this.cancellation.abort();
    this.clearTimer();
    for (const attempt of this.attempts.values()) {
      if (!attempt.outcome) {
        attempt.outcome = failure("UI_CANCELLED");
        attempt.resolve(attempt.outcome);
      }
    }
  }

  private clearTimer(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private closed(signal?: AbortSignal): string | undefined {
    if (!this.options.isActive() || signal?.aborted || this.cancellation.signal.aborted && this.terminal !== "UI_DEADLINE_EXCEEDED") return "UI_CANCELLED";
    if (this.deadline !== undefined && this.clock() >= this.deadline) {
      this.terminal = "UI_DEADLINE_EXCEEDED";
      this.cancellation.abort();
      this.clearTimer();
    }
    return this.terminal;
  }
  private denied(code: string): UiAdmission {
    this.denials += 1;
    if (this.denials === 2) this.options.onRepeatedDenial?.();
    return { immediate: failure(code, false, this.denials >= 2) };
  }

  private async admitCall(call: UiAdmissionCall, signal?: AbortSignal): Promise<UiAdmission> {
    if (!this.names.has(call.name)) return undefined;
    const closed = this.closed(signal);
    if (closed === "UI_CANCELLED" || closed === "UI_DEADLINE_EXCEEDED") return this.denied(closed);
    if (typeof call.id !== "string" || !call.id || call.id.length > 1024) return this.denied("UI_CALL_ID_INVALID");
    let digest: string;
    try { digest = digestCall(call); }
    catch {
      // Invalid non-JSON or oversized nested inputs must not evade the budget.
      if (this.count >= this.limits.attempts) return this.denied("UI_ATTEMPTS_EXHAUSTED");
      this.startAttempt();
      this.terminal = "UI_INPUT_INVALID_OR_TOO_LARGE";
      return this.denied(this.terminal);
    }
    const existing = this.attempts.get(call.id);
    if (existing) {
      if (digest !== existing.digest) return this.denied("UI_CALL_ID_CONFLICT");
      const outcome = existing.outcome ?? await existing.pending;
      const late = this.closed(signal);
      return { immediate: late === "UI_CANCELLED" || late === "UI_DEADLINE_EXCEEDED" ? failure(late) : structuredClone(outcome) };
    }
    if (closed) return this.denied(closed);
    if (this.count >= this.limits.attempts) return this.denied("UI_ATTEMPTS_EXHAUSTED");
    // The UI tools are sequential. Reject unexpected overlap instead of letting
    // parallel/nested calls race the one-correction allowance.
    if (this.pendingCount > 0) return this.denied("UI_CALL_IN_PROGRESS");
    if (this.needsCorrection) {
      if (this.corrections >= this.limits.corrections) return this.denied("UI_CORRECTIONS_EXHAUSTED");
      this.corrections += 1;
      this.needsCorrection = false;
    }
    this.startAttempt();
    this.pendingCount += 1;
    let resolve!: Attempt["resolve"];
    const pending = new Promise<UiAdmissionOutcome>(done => { resolve = done; });
    const attempt: Attempt = { digest, pending, resolve };
    this.attempts.set(call.id, attempt);
    const executionSignal = signal ? AbortSignal.any([signal, this.cancellation.signal]) : this.cancellation.signal;
    return {
      signal: executionSignal,
      check: () => { const reason = this.closed(executionSignal); return reason ? failure(reason) : undefined; },
      settle: (outcome, phase) => {
        if (attempt.outcome) return structuredClone(attempt.outcome);
        this.pendingCount -= 1;
        const reason = this.closed(executionSignal);
        let final = reason ? failure(reason) : outcome;
        if (!reason && outcome.isError) {
          const canCorrect = phase === "validation" || repairable(outcome);
          if (canCorrect && this.corrections < this.limits.corrections) this.needsCorrection = true;
          else this.terminal = canCorrect ? "UI_CORRECTIONS_EXHAUSTED" : "UI_OPERATION_FAILED";
          // SDK validation errors can contain entire raw arguments. Never echo
          // those into diagnostics; compiler diagnostics use bounded paths.
          if (phase === "validation") final = failure("UI_ARGUMENTS_INVALID", !this.terminal);
        }
        attempt.outcome = structuredClone(final);
        attempt.resolve(attempt.outcome);
        return final;
      },
    };
  }

  private startAttempt(): void {
    this.count += 1;
    if (this.deadline !== undefined) return;
    this.deadline = this.clock() + this.limits.windowMs;
    this.timer = setTimeout(() => {
      this.terminal = "UI_DEADLINE_EXCEEDED";
      this.cancellation.abort();
      // Wake duplicate transmissions even if a faulty operation ignores abort.
      for (const attempt of this.attempts.values()) if (!attempt.outcome) attempt.resolve(failure("UI_DEADLINE_EXCEEDED"));
    }, this.limits.windowMs);
    this.timer.unref?.();
  }
}
