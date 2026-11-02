/** Trusted, bundled Node worker. Generated source is only evaluated by QuickJS. */
import { parentPort, workerData } from "node:worker_threads";
import { MiniAppVm, type MiniAppVmRequest, type MiniAppCheckpoint } from "./vm";
import { compileMiniAppPlan, validateMiniAppCheckpoint, validateMiniAppInputs, validateMiniAppResult } from "./plan";
import { boundedJson } from "./json";
import { MINI_APP_LIMITS, MiniAppError } from "./limits";
import { miniAppStepRequest } from "./playback";
import { miniAppPresetTrials, miniAppScenePickTrials } from "./interaction-trial";
import { miniAppEventRequest } from "./events";
import { answerDataDigest } from "../answer-output-receipts";
import { MINI_APP_ACTION_PREVIEW_LIMITS, miniAppPreviewChoices, miniAppPreviewOutcome, type MiniAppActionEvidence } from "./action-preview";

void (async () => {
  let vm: MiniAppVm | undefined;
  try {
    const data = JSON.parse(workerData.request);
    boundedJson(data, MINI_APP_LIMITS.replyBytes);
    const compiled = compileMiniAppPlan(data.plan);
    vm = await MiniAppVm.create(new Uint8Array(workerData.wasm), compiled.plan.program, undefined, !!data.migration);
    const restoring = data.snapshot !== undefined;
    if (restoring && (data.inputs !== undefined || data.migration !== undefined)) throw new MiniAppError("SCHEMA", "Initialization inputs or migration cannot accompany a restored checkpoint");
    if (data.parameterInputs !== undefined && !restoring) throw new MiniAppError("SCHEMA", "Parameter application requires saved progress");
    if (data.inputs !== undefined) validateMiniAppInputs(compiled.plan, data.inputs);
    const snapshot: MiniAppCheckpoint = restoring ? validateMiniAppCheckpoint(compiled, data.snapshot)
      : { inputs: data.inputs ?? compiled.initialInputs, state: null, rng: 0x50494f52, tick: 0 };
    const request: MiniAppVmRequest = { command: restoring ? "project" : "init", snapshot };
    if (data.migration) {
      const source = compileMiniAppPlan(data.migration.sourcePlan);
      if (!compiled.plan.migration || source.plan.id !== compiled.plan.id || answerDataDigest(source.plan) !== compiled.plan.migration.fromPlanDigest) throw new MiniAppError("CONFLICT", "Progress migration does not match its source program");
      const previous = validateMiniAppCheckpoint(source, data.migration.snapshot);
      request.command = "migrate";
      request.previous = { inputs: previous.inputs, state: previous.state, rng: previous.rng, tick: previous.tick };
      if (compiled.plan.migration.clock === "preserve") { snapshot.tick = previous.tick; snapshot.rng = previous.rng; }
    }
    let initial = validateMiniAppResult(compiled, vm.run(request));
    if (data.preview === true) {
      if (!restoring || data.parameterInputs !== undefined) throw new MiniAppError("SCHEMA", "Local previews require an unchanged saved checkpoint");
      const choices = miniAppPreviewChoices(compiled, initial.frame);
      const preview: MiniAppActionEvidence = { version: 2, sourceCheckpointDigest: answerDataDigest(initial.snapshot),
        eligibleActions: choices.length, omittedActions: Math.max(0, choices.length - MINI_APP_ACTION_PREVIEW_LIMITS.actions), actions: [] };
      for (const choice of choices.slice(0, MINI_APP_ACTION_PREVIEW_LIMITS.actions)) {
        if (choice.disabled) { preview.actions.push({ ...choice, status: "disabled" }); continue; }
        // Every VM invocation recreates the program closure and decodes a fresh
        // snapshot. No result feeds the next alternative, including tick/RNG.
        const result = validateMiniAppResult(compiled, vm.run(miniAppEventRequest(compiled, initial.snapshot, { type: "click", id: choice.id }, initial.frame)));
        preview.actions.push(miniAppPreviewOutcome(choice, initial.snapshot, result));
      }
      boundedJson(preview, MINI_APP_ACTION_PREVIEW_LIMITS.bytes);
      parentPort!.postMessage({ result: boundedJson(initial, MINI_APP_LIMITS.replyBytes), preview });
      return;
    }
    if (data.parameterInputs !== undefined) {
      const inputs = validateMiniAppInputs(compiled.plan, data.parameterInputs);
      const released = validateMiniAppResult(compiled, vm.run({ command: "event", snapshot: initial.snapshot, event: { type: "blur" } }));
      const values = Object.fromEntries(compiled.plan.inputs.map(input => [input.id, inputs[input.id]]));
      initial = validateMiniAppResult(compiled, vm.run({ command: "preset", snapshot: { ...released.snapshot, inputs }, event: { type: "parameters", values } }));
      if (snapshot.view) initial.snapshot.view = snapshot.view;
    }
    // Explore a bounded prefix of the actual discrete transition, not just its
    // first state. Keep the initial result for publication; historical reads
    // must never advance the saved checkpoint or retroactively reject its future.
    if (!restoring) {
      const limit = compiled.plan.playback?.mode === "discrete" ? MINI_APP_LIMITS.discreteTrialSteps : 1;
      let current = initial;
      for (let index = 0; index < limit && !current.frame.playback?.finished; index++) {
        const step = miniAppStepRequest(compiled, current.snapshot);
        if (!step) break;
        try { current = validateMiniAppResult(compiled, vm.run(step)); }
        catch (error) {
          if (error instanceof MiniAppError) throw new MiniAppError(error.code, `Trial step ${index + 1}: ${error.message}`, error.path, error.repairable);
          throw error;
        }
      }
      for (const event of [...miniAppPresetTrials(compiled), ...miniAppScenePickTrials(compiled, initial)]) {
        // These are independent UI choices, not a burst of user input. A fresh
        // VM avoids charging their aggregate CPU time against one live instance.
        // Warm projection is bounded startup; each actual event retains 8ms.
        vm.dispose(); vm = undefined;
        try {
          vm = await MiniAppVm.create(new Uint8Array(workerData.wasm), compiled.plan.program);
          const baseline = validateMiniAppResult(compiled, vm.run({ command: "project", snapshot: initial.snapshot }));
          validateMiniAppResult(compiled, vm.run(miniAppEventRequest(compiled, baseline.snapshot, event, baseline.frame)));
        } catch (error) {
          if (error instanceof MiniAppError) throw new MiniAppError(error.code,
            (event.type === "input-preset" ? `Trial input preset ${event.id}: ${error.message}` : `Trial scene selection ${event.id}/${event.object ?? "clear"}: ${error.message}`)
              + (event.type === "scene-pick" && error.code === "STATE" ? ". Selection state must accept the emitted object IDs or deliberately map them." : ""), error.path, error.repairable);
          throw error;
        }
      }
    }
    parentPort!.postMessage({ result: boundedJson(initial, MINI_APP_LIMITS.replyBytes) });
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof MiniAppError
      ? { code: error.code, path: error.path, repairable: error.repairable, message: error.message }
      : { code: "EXECUTION", path: "program", repairable: false, message: "Mini app trial failed" } });
  } finally { vm?.dispose(); parentPort!.close(); }
})();
