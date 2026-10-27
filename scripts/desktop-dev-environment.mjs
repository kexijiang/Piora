import { join, resolve } from "node:path";

export function desktopDevelopmentEnvironment(root, environment = process.env) {
  const userData = environment.PIORA_DESKTOP_DEV_USER_DATA?.trim();
  const directory = userData ? resolve(root, userData) : join(root, ".piora-data", "desktop-dev");
  return {
    PIORA_DESKTOP_DEV_USER_DATA: directory,
    PIORA_DESKTOP_DATA_DIR: join(directory, "runtime", "normal"),
    PI_CODING_AGENT_DIR: environment.PI_CODING_AGENT_DIR?.trim()
      ? resolve(root, environment.PI_CODING_AGENT_DIR.trim()) : join(directory, "agent"),
    PIORA_RUNTIME_PROFILE: "normal",
  };
}
