import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { boundedJson, type JsonRecord } from "./json";
import { MINI_APP_LIMITS, MiniAppError } from "./limits";
import { compileMiniAppPlan, validateMiniAppCheckpoint, validateMiniAppInputs, validateMiniAppResult, type MiniAppPlan1, type MiniAppResult } from "./plan";
import { answerDataDigest } from "../answer-output-receipts";
import type { MiniAppCheckpoint, MiniAppVmReply } from "./vm";
import { firstPartyRuntimeRoot } from "../first-party-extensions";
import { validateMiniAppActionEvidence, type MiniAppActionEvidence } from "./action-preview";

declare global { var __pioraMiniAppTrialCapacity: { active: number } | undefined }
const capacity = () => globalThis.__pioraMiniAppTrialCapacity ??= { active: 0 };

interface TrialOptions { snapshot?: MiniAppCheckpoint; inputs?: JsonRecord; parameterInputs?: JsonRecord;
  migration?: { sourcePlan: MiniAppPlan1; snapshot: MiniAppCheckpoint }; signal?: AbortSignal; assetDirectory?: string }
interface TrialReply { result: MiniAppResult; preview?: MiniAppActionEvidence }

export async function trialMiniApp(plan: unknown, options: TrialOptions = {}): Promise<MiniAppResult> {
  return (await runTrial(plan, options)).result;
}
/** Read-only alternatives, all starting from the same copied, confirmed checkpoint. */
export async function previewMiniAppActions(plan: unknown, snapshot: MiniAppCheckpoint, options: Pick<TrialOptions, "signal" | "assetDirectory"> = {}): Promise<MiniAppActionEvidence> {
  return (await runTrial(plan, { ...options, snapshot }, true)).preview!;
}

/** Expensive compilation and generated execution never run on the request thread. */
async function runTrial(plan: unknown, options: TrialOptions, preview = false): Promise<TrialReply> {
  if (options.signal?.aborted) throw new MiniAppError("STOPPED", "Mini app generation was cancelled");
  if (capacity().active >= 2) throw new MiniAppError("BUSY", "Mini app trial capacity is in use");
  if (options.snapshot && (options.inputs || options.migration)) throw new MiniAppError("SCHEMA", "Initialization inputs or migration cannot accompany a restored checkpoint");
  if (options.parameterInputs && !options.snapshot) throw new MiniAppError("SCHEMA", "Parameter application requires saved progress");
  const request = boundedJson({ plan, ...(preview ? { preview: true } : {}), ...(options.snapshot ? { snapshot: options.snapshot } : {}), ...(options.inputs ? { inputs: options.inputs } : {}),
    ...(options.parameterInputs ? { parameterInputs: options.parameterInputs } : {}),
    ...(options.migration ? { migration: options.migration } : {}) }, MINI_APP_LIMITS.replyBytes);
  // Only the pure bounded compiler runs here. A second compile inside the worker
  // validates its own boundary; request callers cannot provide compiled trees.
  const compiled = compileMiniAppPlan(plan);
  if (options.inputs) validateMiniAppInputs(compiled.plan, options.inputs);
  if (options.parameterInputs) validateMiniAppInputs(compiled.plan, options.parameterInputs);
  if (options.migration) {
    const source = compileMiniAppPlan(options.migration.sourcePlan);
    if (!compiled.plan.migration || source.plan.id !== compiled.plan.id || answerDataDigest(source.plan) !== compiled.plan.migration.fromPlanDigest) throw new MiniAppError("CONFLICT", "Progress migration does not match its source program");
    validateMiniAppCheckpoint(source, options.migration.snapshot);
  }
  capacity().active++;
  try {
    const directory = options.assetDirectory ?? join(firstPartyRuntimeRoot(), ".mini-app-runtime");
    const [manifest, source, wasm] = await Promise.all([
      readFile(join(directory, "manifest.json"), "utf8").then(JSON.parse),
      readFile(join(directory, "server-worker.cjs")),
      readFile(join(directory, "quickjs.wasm")),
    ]);
    if (source.length > 4 * 1024 * 1024 || createHash("sha256").update(source).digest("hex") !== manifest.workerSha256) throw new MiniAppError("RUNTIME", "Mini app worker asset is missing or changed");
    if (wasm.length > 8 * 1024 * 1024 || createHash("sha256").update(wasm).digest("hex") !== manifest.wasmSha256) throw new MiniAppError("RUNTIME", "Mini app VM asset is missing or changed");
    if (options.signal?.aborted) throw new MiniAppError("STOPPED", "Mini app generation was cancelled");
    return await new Promise<TrialReply>((resolve, reject) => {
      // Evaluated code here is the verified first-party bundle, never the model's
      // program. Passing verified bytes also avoids a path replacement race.
      const worker = new Worker(source.toString("utf8"), { eval: true, name: "piora-mini-app-trial",
        workerData: { request, wasm }, resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 } });
      let done = false;
      const finish = (error?: Error, result?: TrialReply) => {
        if (done) return;
        done = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
        // Do not release concurrency capacity until the worker actually exits.
        void worker.terminate().finally(() => error ? reject(error) : resolve(result!));
      };
      const abort = () => finish(new MiniAppError("STOPPED", "Mini app generation was cancelled"));
      const timer = setTimeout(() => finish(new MiniAppError("WATCHDOG", "Mini app trial did not respond")), 5000);
      options.signal?.addEventListener("abort", abort, { once: true });
      worker.once("error", () => finish(new MiniAppError("WORKER", "Mini app trial worker failed")));
      worker.once("exit", () => { if (!done) finish(new MiniAppError("WORKER", "Mini app trial ended without a result")); });
      worker.once("message", value => {
        try {
          if (value?.error) {
            boundedJson(value.error, 8000);
            const error = value.error;
            finish(new MiniAppError(typeof error.code === "string" ? error.code : "EXECUTION", typeof error.message === "string" ? error.message : "Mini app trial failed", typeof error.path === "string" ? error.path : "program", error.repairable === true));
          } else if (typeof value?.result === "string" && value.result.length <= MINI_APP_LIMITS.replyBytes) {
            const result = validateMiniAppResult(compiled, JSON.parse(value.result) as MiniAppVmReply);
            if (preview && answerDataDigest(result.snapshot) !== answerDataDigest(options.snapshot)) throw new MiniAppError("PROTOCOL", "Preview changed its source checkpoint");
            finish(undefined, { result, ...(preview ? { preview: validateMiniAppActionEvidence(compiled, result, value.preview) } : {}) });
          } else finish(new MiniAppError("PROTOCOL", "Invalid mini app trial result"));
        } catch (error) { finish(error instanceof MiniAppError ? error : new MiniAppError("PROTOCOL", "Invalid mini app trial response")); }
      });
      if (options.signal?.aborted) abort();
    });
  } finally { capacity().active--; }
}
