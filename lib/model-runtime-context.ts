import { stat } from "fs/promises";
import { join, resolve } from "path";
import {
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getProjectlessChatWorkspace } from "@/lib/projectless-chat-server";
import { sessionPathKey } from "@/lib/session-path";
import { installModelThinkingCompat } from "./model-thinking-compat";
import { installAnalyticsModelObserver } from "./analytics-telemetry";

export class ModelRequestCwdError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403,
    readonly code: "invalid_cwd" | "access_denied",
  ) {
    super(message);
    this.name = "ModelRequestCwdError";
  }
}

/**
 * Resolve and authorize the cwd used to enumerate models.
 *
 * Model discovery can import project extensions, so callers must use the same
 * allowed-root path as `/api/models` instead of constructing
 * a bare ModelRuntime.
 */
export async function resolveModelRequestCwd(requestedCwd?: string | null): Promise<string> {
  // A request without an explicit project comes from the new-chat landing
  // surface. process.cwd() points at the installed app in packaged builds and
  // is intentionally outside the user's allowed roots, so use Piora's managed
  // projectless workspace instead.
  const projectlessWorkspace = getProjectlessChatWorkspace();
  const cwd = resolve(requestedCwd || projectlessWorkspace);

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    throw new ModelRequestCwdError(`Directory does not exist: ${cwd}`, 400, "invalid_cwd");
  }
  if (!cwdStat.isDirectory()) {
    throw new ModelRequestCwdError(`Not a directory: ${cwd}`, 400, "invalid_cwd");
  }

  // This directory is created and owned by Piora itself. Authorize it without
  // deriving roots from every persisted Session: that scan is exactly what
  // made the EXE landing page's first model request appear to fail or hang.
  if (sessionPathKey(cwd) === sessionPathKey(projectlessWorkspace)) return cwd;

  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    throw new ModelRequestCwdError("Access denied", 403, "access_denied");
  }
  return cwd;
}

/** Build Pi services for the validated workspace. */
export async function createTrustedModelServices(cwd: string, analyticsSource = "system") {
  const agentDir = getAgentDir();
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
  });
  installModelThinkingCompat(services.modelRuntime);
  installAnalyticsModelObserver(services.modelRuntime, analyticsSource);
  return services;
}

/**
 * Build only the model/settings layer. This intentionally skips extensions so
 * one broken package cannot hide every otherwise usable configured model from
 * the landing page.
 */
export async function createCoreModelServices(cwd: string) {
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  installModelThinkingCompat(modelRuntime);
  installAnalyticsModelObserver(modelRuntime);
  return {
    modelRuntime,
    settingsManager: SettingsManager.create(cwd, agentDir),
  };
}
