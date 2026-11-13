import { join } from "node:path";
import { installAnalyticsModelObserver } from "./analytics-telemetry";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Global settings never read project files or execute project extensions. */
export async function createGlobalModelServices(agentDir = getAgentDir()) {
  const settingsManager = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  installAnalyticsModelObserver(modelRuntime);
  return { settingsManager, modelRuntime };
}
