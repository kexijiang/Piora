import { randomUUID } from "node:crypto";
import { needsToolApproval, type ToolPermissionState } from "./tool-permission-policy";
import { TOOL_REVIEW_LIMITS, TOOL_REVIEW_POLICY_VERSION, type ToolReviewAuthorization, type ToolReviewModel, type ToolReviewRecord, type ToolReviewStatus } from "./tool-review-types";
import { type ReviewEvidence, reviewHash } from "./tool-review-evidence";
import { redactReviewText } from "./tool-review-redaction";
import { inactiveToolReviews, saveToolReview } from "./tool-review-store";

interface ApprovalInput {
  name: string; args: unknown; toolCallId: string; runId: string;
  model?: { provider: string; id: string };
  read(): ToolPermissionState;
  active(): boolean;
  evidence(signal: AbortSignal): Promise<ReviewEvidence>;
  ask(message: string, signal: AbortSignal): Promise<"once" | "full" | "deny">;
  grantFull(): void;
}

/** Unified gate owns authorization lifetimes. The reviewer never holds executable callbacks. */
export class ToolReviewController {
  private records = new Map<string, ToolReviewRecord>();
  private attempts = new Set<AbortController>();
  private seenCalls = new Set<string>();
  private authorizations: ToolReviewAuthorization[] = [];
  private authorizationRevision = 0;
  private paused = false;
  constructor(private options: {
    root: string; sessionId: string; reviewer: ToolReviewModel;
    emit(record: ToolReviewRecord): void;
    stop(): void;
    timeoutMs?: number;
  }) {
    for (const record of inactiveToolReviews(options.root, options.sessionId)) this.records.set(record.id, record);
  }
  get stopped(): boolean { return this.paused; }
  list(): ToolReviewRecord[] { return [...this.records.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-100); }
  /** Host admission only; never extract authorization from transcript role labels. */
  admit(input: ToolReviewAuthorization, newRun: boolean): void {
    this.invalidate();
    this.authorizationRevision++;
    if (newRun) {
      this.authorizations = [];
      this.seenCalls.clear();
      if (input.source === "ui") this.paused = false;
    }
    // A later user correction supersedes earlier scope: keep source-tagged turns in order.
    this.authorizations.push(input);
  }
  invalidate(): void { for (const controller of this.attempts) controller.abort(); }
  cancel(): void {
    this.invalidate();
    for (const record of this.records.values()) {
      try {
        if (["reviewing", "needs_user", "approved"].includes(record.status)) this.update(record, "cancelled", "Operation cancelled.");
        else if (record.status === "executing") this.update(record, "interrupted", "Execution was interrupted; verify effects before retrying.");
      } catch { /* Failure to persist audit must never prevent cancellation. */ }
    }
  }
  private update(record: ToolReviewRecord, status: ToolReviewStatus, reason: string): void {
    record.status = status;
    record.reason = redactReviewText(reason).slice(0, 1600);
    record.updatedAt = Math.max(Date.now(), record.updatedAt + 1);
    saveToolReview(this.options.root, record); // Persist before releasing any executable permission.
    this.records.set(record.id, record);
    this.options.emit({ ...record });
  }
  finish(toolCallId: string, isError: boolean): void {
    for (const record of this.records.values()) if (record.toolCallId === toolCallId && record.status === "executing") {
      try { this.update(record, isError ? "failed" : "completed", record.reason); }
      catch { /* Execution already happened. Never fail the tool and provoke a retry for an audit-write failure. */ }
    }
  }
  async authorize(input: ApprovalInput): Promise<boolean> {
    if (!input.active() || this.paused) return false;
    const callKey = `${input.runId}:${input.toolCallId}`;
    if (this.seenCalls.has(callKey)) return false;
    this.seenCalls.add(callKey);
    // Bounded invalidation retries; repeated changes cannot keep a request alive indefinitely.
    for (let attempt = 0; attempt < 3 && input.active() && !this.paused; attempt++) {
      const controller = new AbortController();
      this.attempts.add(controller);
      let record: ToolReviewRecord | undefined;
      try {
        const before = input.read();
        if (before.legacy || before.mode === "full") return input.active() && !this.paused;
        const authRevision = this.authorizationRevision;
        const evidence = await input.evidence(controller.signal);
        if (controller.signal.aborted || before.revision !== input.read().revision || authRevision !== this.authorizationRevision) continue;
        if (!needsToolApproval(before, input.name, input.args, evidence.classification)) return input.active() && !this.paused;
        record = { schemaVersion: 1, policyVersion: TOOL_REVIEW_POLICY_VERSION, id: `${Date.now()}-${randomUUID()}`, sessionId: this.options.sessionId,
          runId: input.runId, toolCallId: input.toolCallId, toolName: input.name, permissionRevision: before.revision,
          fingerprint: reviewHash({ operation: evidence.fingerprint, runId: input.runId, callId: input.toolCallId, revision: before.revision, authRevision, policy: TOOL_REVIEW_POLICY_VERSION }),
          status: "needs_user", reason: "", startedAt: Date.now(), updatedAt: Date.now() };
        let allowed = false;
        let manualReason = evidence.manualReason;
        if (before.mode === "review") {
          if (!this.authorizations.length || this.authorizations.some(auth => auth.source !== "ui")) manualReason ??= "This input has no direct, host-verified user authorization. Confirm the operation manually.";
          const auth = this.authorizations.map(item => ({ ...item, text: redactReviewText(item.text) }));
          if (auth.some((item, index) => item.text !== this.authorizations[index].text)) manualReason ??= "Authorization contains sensitive values; confirm locally.";
          const context = JSON.stringify({ authorization: auth, operation: evidence.context });
          if (context.length > TOOL_REVIEW_LIMITS.maxInputChars) manualReason ??= "The complete operation and authorization exceed the review budget. Confirm manually.";
          if (!input.model) manualReason ??= "No review model is selected. Confirm manually.";
          if (!manualReason && input.model) {
            record.model = `${input.model.provider}/${input.model.id}`;
            this.update(record, "reviewing", "Reviewing this operation with the model selected at the start of the run.");
            const started = Date.now();
            let timer: ReturnType<typeof setTimeout> | undefined;
            let onAbort: (() => void) | undefined;
            try {
              // Race as well as signal: a provider that ignores AbortSignal cannot hold the gate open.
              const result = await Promise.race([
                this.options.reviewer({ context, model: input.model, signal: controller.signal }),
                new Promise<never>((_, reject) => {
                  onAbort = () => reject(new Error("Review cancelled"));
                  controller.signal.addEventListener("abort", onAbort, { once: true });
                  timer = setTimeout(() => { reject(new Error("Review timeout")); controller.abort(); }, this.options.timeoutMs ?? TOOL_REVIEW_LIMITS.timeoutMs);
                }),
              ]);
              if (!input.active() || this.paused) return false;
              if (authRevision !== this.authorizationRevision) { this.update(record, "invalidated", "User authorization changed."); return false; }
              const current = input.read();
              if (controller.signal.aborted || current.mode !== before.mode || current.revision !== before.revision) { this.update(record, "invalidated", "Permission or authorization changed."); continue; }
              const verified = await input.evidence(controller.signal);
              if (!input.active() || this.paused) return false;
              if (controller.signal.aborted || input.read().revision !== before.revision || authRevision !== this.authorizationRevision) { this.update(record, "invalidated", "Permission or authorization changed."); continue; }
              if (verified.fingerprint !== evidence.fingerprint) { this.update(record, "invalidated", "Operation or evidence changed; a new decision is required."); continue; }
              record.decision = result.decision.decision;
              record.risk = result.decision.risk;
              record.tokens = result.tokens;
              record.cost = result.cost;
              record.reason = result.decision.reason;
              record.durationMs = Date.now() - started;
              if (result.decision.decision === "deny") {
                this.paused = true;
                try { this.update(record, "denied", result.decision.reason); }
                finally { this.cancel(); this.options.stop(); }
                return false;
              }
              allowed = result.decision.decision === "allow";
              manualReason = [result.decision.reason, result.decision.question].filter(Boolean).join("\n");
            } catch {
              if (!input.active() || this.paused) return false;
              if (authRevision !== this.authorizationRevision || input.read().revision !== before.revision) { this.update(record, "invalidated", "Authorization or permission changed."); continue; }
              manualReason = "Automatic review failed or timed out. The operation has not run; confirm manually.";
              this.update(record, "failed", manualReason);
              // Timeout aborts the reviewer, but manual fallback gets its own live signal.
              this.attempts.delete(controller);
            } finally {
              if (timer) clearTimeout(timer);
              if (onAbort) controller.signal.removeEventListener("abort", onAbort);
              record.durationMs = Date.now() - started;
            }
          }
        }
        if (!input.active() || this.paused) return false;
        if (!allowed) {
          const manual = new AbortController();
          this.attempts.add(manual);
          try {
            this.update(record, "needs_user", manualReason ?? "Confirm the operation, its target and effects.");
            // Never silently hide a trailing shell operation from the human approver.
            const message = `${record.reason}\n\n${JSON.stringify(evidence.context, null, 2)}`;
            const decision = await input.ask(message, manual.signal);
            if (!input.active() || this.paused) { this.update(record, "cancelled", "Operation cancelled."); return false; }
            if (manual.signal.aborted || authRevision !== this.authorizationRevision || input.read().revision !== before.revision) { this.update(record, "invalidated", "Authorization or permission changed."); continue; }
            if (decision === "deny") { this.update(record, "cancelled", "The user declined or cancelled this operation."); return false; }
            const verified = await input.evidence(manual.signal);
            if (!input.active() || this.paused) { this.update(record, "cancelled", "Operation cancelled."); return false; }
            if (manual.signal.aborted || authRevision !== this.authorizationRevision || input.read().revision !== before.revision) { this.update(record, "invalidated", "Authorization or permission changed."); continue; }
            if (verified.fingerprint !== evidence.fingerprint) { this.update(record, "invalidated", "Operation or evidence changed."); continue; }
            if (decision === "full") input.grantFull();
          } finally { this.attempts.delete(manual); }
        }
        const current = input.read();
        if (!input.active() || this.paused || authRevision !== this.authorizationRevision) { this.update(record, "cancelled", "Operation cancelled."); return false; }
        if (current.revision !== before.revision && current.mode !== "full") { this.update(record, "invalidated", "Permission changed."); continue; }
        this.update(record, "approved", manualReason ?? record.reason);
        this.update(record, "executing", manualReason ?? record.reason);
        return true;
      } catch {
        if (record) {
          // A persistence/evidence failure must never grant access or expose raw error data.
          try { this.update(record, "failed", "Authorization could not be recorded or verified. Operation blocked."); } catch { /* fail closed */ }
        }
        return false;
      } finally { this.attempts.delete(controller); }
    }
    return false;
  }
}
