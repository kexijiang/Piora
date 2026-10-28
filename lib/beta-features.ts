import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { BETA_FEATURES, DEFAULT_BETA_FEATURES, type BetaFeatures } from "./beta-feature-types";

const configPath = (root: string) => join(root, "piora", "beta-features.json");
export function readBetaFeatures(root = getAgentDir()): BetaFeatures {
  try {
    const saved = JSON.parse(readFileSync(configPath(root), "utf8"));
    if (saved.version !== 1) return { ...DEFAULT_BETA_FEATURES };
    return { intelligentUi: saved.intelligentUi === true };
  } catch { return { ...DEFAULT_BETA_FEATURES }; }
}
export function writeBetaFeatures(value: unknown, root = getAgentDir()): BetaFeatures {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !BETA_FEATURES.some(feature => feature.id === key))
    || BETA_FEATURES.some(({ id }) => typeof (value as Record<string, unknown>)[id] !== "boolean")) {
    throw new Error("Expected boolean values for the registered beta features");
  }
  const features: BetaFeatures = { intelligentUi: (value as BetaFeatures).intelligentUi };
  const path = configPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify({ version: 1, ...features }, null, 2)}\n`);
  return features;
}
