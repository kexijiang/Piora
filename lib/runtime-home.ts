import path from "node:path";

export interface RuntimeHomeEnvironment {
  readonly [key: string]: string | undefined;
  PIORA_HOME?: string;
  PI_CODING_AGENT_DIR?: string;
  USERPROFILE?: string;
  HOME?: string;
}

/**
 * Resolve the home directory at request/runtime instead of through os.homedir().
 * Next's output-file tracer statically evaluates os.homedir() and can turn a
 * later dynamic filesystem call into a recursive glob over the entire user
 * profile. Windows compatibility junctions then fail that build with EPERM.
 */
export function getRuntimeHomeDirectory(
  environment: RuntimeHomeEnvironment = process.env,
): string {
  const configuredHome = environment.PIORA_HOME?.trim();
  const platformHome = (process.platform === "win32"
    ? environment.USERPROFILE
    : environment.HOME)?.trim();
  const fallbackHome = (environment.HOME || environment.USERPROFILE)?.trim();
  const homeDirectory = configuredHome || platformHome || fallbackHome;

  if (!homeDirectory) {
    throw new Error(
      "Unable to resolve the home directory. Set PIORA_HOME, USERPROFILE, or HOME.",
    );
  }

  return path.resolve(homeDirectory);
}

export function getRuntimeAgentDataDirectory(
  environment: RuntimeHomeEnvironment = process.env,
): string {
  const configuredDirectory = environment.PI_CODING_AGENT_DIR?.trim();
  if (!configuredDirectory) {
    return path.join(getRuntimeHomeDirectory(environment), ".pi", "agent");
  }
  if (configuredDirectory === "~") return getRuntimeHomeDirectory(environment);
  if (configuredDirectory.startsWith("~/") || configuredDirectory.startsWith("~\\")) {
    return path.resolve(getRuntimeHomeDirectory(environment), configuredDirectory.slice(2));
  }
  return path.resolve(configuredDirectory);
}

/** Resolve the OS user's home lazily, preserving shell/MCP tilde semantics. */
export function getRuntimeUserHomeDirectory(environment: RuntimeHomeEnvironment = process.env): string {
  return getRuntimeHomeDirectory({ USERPROFILE: environment.USERPROFILE, HOME: environment.HOME });
}
