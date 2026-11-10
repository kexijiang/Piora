import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import type { ModelReference } from "./model-policy";

const pathFor = (root: string) => join(root, "piora", "default-model.json");

function validate(value: unknown): ModelReference {
  const model = value as Partial<ModelReference> | null;
  if (!model || typeof model.provider !== "string" || !model.provider.trim()
    || typeof model.modelId !== "string" || !model.modelId.trim()
    || model.provider.length > 1000 || model.modelId.length > 1000) {
    throw new Error("Invalid default model");
  }
  return { provider: model.provider.trim(), modelId: model.modelId.trim() };
}

/** Only explicit Piora selections opt in; old SDK/launcher defaults stay ignored. */
export function readDefaultModel(root = getAgentDir()): ModelReference | null {
  try { return validate(JSON.parse(readFileSync(pathFor(root), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("无法读取默认模型，请检查 piora/default-model.json。");
  }
}

export function writeDefaultModel(value: unknown, root = getAgentDir()): ModelReference {
  const model = validate(value);
  const file = pathFor(root);
  mkdirSync(dirname(file), { recursive: true });
  writePrivateFileAtomicSync(file, `${JSON.stringify(model, null, 2)}\n`);
  return model;
}
