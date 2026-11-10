import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";

export interface LaboratorySettings { planGoalEnabled: boolean }
export function getLaboratorySettingsPath(): string { return join(getAgentDir(), "piora", "laboratory.json"); }

export function parseLaboratorySettings(value: unknown): LaboratorySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 1 || typeof (value as LaboratorySettings).planGoalEnabled !== "boolean") {
    throw new TypeError("Laboratory settings require only a boolean planGoalEnabled field.");
  }
  return { planGoalEnabled: (value as LaboratorySettings).planGoalEnabled };
}

/** Read on each admission/continuation so an existing session sees a saved toggle. */
export function readLaboratorySettings(): LaboratorySettings {
  let raw: string;
  try { raw = readFileSync(getLaboratorySettingsPath(), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { planGoalEnabled: false };
    throw error;
  }
  try { return parseLaboratorySettings(JSON.parse(raw)); }
  catch { throw new Error("Laboratory settings are invalid; restore them before continuing."); }
}

export function writeLaboratorySettings(value: unknown): LaboratorySettings {
  const settings = parseLaboratorySettings(value);
  const path = getLaboratorySettingsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(path, JSON.stringify(settings));
  return settings;
}
