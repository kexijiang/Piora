import { createHash, randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { readBoundedRegularFile } from "../runtime/bounded-file";
import { HarmonyError, asHarmonyError } from "../errors";
import type { HarmonyCheckReport } from "../check-types";
import type { HarmonyDeviceManager } from "../device-manager";
import type { HarmonyScenarioOptions } from "../types";
import { validateHarmonyScenario } from "../scenario-executor";

export interface DevelopmentValidationOptions extends HarmonyScenarioOptions {
  projectRoot: string; hapPath: string; bundleName: string; abilityName?: string;
}
export interface DevelopmentValidationDependencies {
  check(projectRoot: string, signal?: AbortSignal): Promise<HarmonyCheckReport>;
  fingerprint(projectRoot: string): string;
  manager: Pick<HarmonyDeviceManager, "installPackage" | "launchApp" | "runScenario" | "listProcesses" | "readLogs">;
}
/** Uses the existing CLI checker; does not read or claim the IDE Problems panel. */
export async function validateDevelopmentOnDevice(options: DevelopmentValidationOptions, dependencies: DevelopmentValidationDependencies) {
  validateHarmonyScenario(options);
  if (!isAbsolute(options.projectRoot) || !isAbsolute(options.hapPath) || extname(options.hapPath).toLowerCase() !== ".hap" || !/^[A-Za-z][A-Za-z0-9_.]{0,255}$/.test(options.bundleName)) throw new HarmonyError("INVALID_ARGUMENT", "Choose an absolute project, HAP and application identifier");
  const info = await lstat(options.hapPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 256 * 1024 * 1024) throw new HarmonyError("INVALID_ARGUMENT", "HAP must be a bounded regular artifact");
  const digest = async () => createHash("sha256").update(await readBoundedRegularFile(options.hapPath, 256 * 1024 * 1024)).digest("hex");
  const artifactHash = await digest(), initialSource = dependencies.fingerprint(options.projectRoot);
  const stages: Array<{ stage: string; status: string; timestamp: string; details?: unknown }> = [];
  const record = (stage: string, status: string, details?: unknown) => stages.push({ stage, status, timestamp: new Date().toISOString(), details });
  let stage = "check";
  try {
    const check = await dependencies.check(options.projectRoot, options.signal);
    record(stage, check.status, { source: "deveco-cli", projectRoot: check.projectRoot, reportId: check.id, updatedAt: check.completedAt, diagnostics: check.diagnostics });
    if (check.projectRoot !== resolve(options.projectRoot) || check.status !== "passed" || !["arkts", "lint"].every(kind => check.checks.some(item => item.kind === kind && item.status === "passed"))) throw new HarmonyError("SCENARIO_FAILED", "Both current-project ArkTS and lint checks must pass before installation");
    const fresh = async () => {
      if (options.signal?.aborted) throw new HarmonyError("COMMAND_ABORTED", "Development validation cancelled");
      if (dependencies.fingerprint(options.projectRoot) !== initialSource || check.sourceFingerprint !== initialSource || await digest() !== artifactHash) throw new HarmonyError("STALE_SNAPSHOT", "Source or HAP changed during verification; select the new artifact and restart");
    };
    await fresh(); stage = "install";
    await dependencies.manager.installPackage({ ...options, replace: true }); record(stage, "passed", { artifactHash });
    await fresh(); stage = "launch";
    await dependencies.manager.launchApp(options); record(stage, "passed");
    await fresh(); stage = "scenario";
    const scenario = await dependencies.manager.runScenario(options); record(stage, scenario.status, scenario);
    stage = "logs";
    const processes = (await dependencies.manager.listProcesses(options.serial, options.signal)).filter(process => process.name === options.bundleName || process.name.startsWith(`${options.bundleName}:`));
    const logs = [];
    for (const process of processes.slice(0, 8)) logs.push(...await dependencies.manager.readLogs({ serial: options.serial, pid: process.pid, limit: 100, signal: options.signal }));
    record(stage, processes.length ? "collected" : "unavailable", { source: "device-hilog", processIds: processes.map(process => process.pid), logs });
    await fresh();
    return { id: randomUUID(), status: scenario.status, projectRoot: options.projectRoot, artifactHash, artifactSourceBinding: "user-selected" as const, sourceFingerprint: initialSource, stages };
  } catch (error) {
    const failure = asHarmonyError(error); record(stage, "failed", failure.toJSON());
    return { id: randomUUID(), status: "incomplete" as const, projectRoot: options.projectRoot, artifactHash, sourceFingerprint: initialSource, stages };
  }
}
