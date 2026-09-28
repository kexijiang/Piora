import { getAllowedFileRoots, isExistingFilePathAllowed } from "../../file-access";
import { HarmonyError } from "../errors";

export async function assertScenarioHapsAllowed(steps: unknown[]): Promise<void> {
  const installs = steps.filter((step): step is { action: "install_app"; hapPath?: unknown } =>
    Boolean(step && typeof step === "object" && (step as { action?: unknown }).action === "install_app"));
  if (!installs.length) return;
  const roots = await getAllowedFileRoots();
  for (const step of installs) {
    if (typeof step.hapPath !== "string" || !isExistingFilePathAllowed(step.hapPath, roots)) {
      throw new HarmonyError("INVALID_ARGUMENT", "Select a HAP within an allowed workspace root");
    }
  }
}
