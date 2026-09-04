import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export interface FirstPartyExtensionDescriptor {
  id: string;
  fileName: string;
  name: string;
  description: string;
  profiles: readonly ("normal" | "device-control")[];
  /** Core capabilities stay enabled in settings; runtime loading remains best-effort. */
  required?: boolean;
  /** Optional first-party extensions may stay unloaded until the user enables them. */
  defaultEnabled?: boolean;
}

export const FIRST_PARTY_EXTENSIONS: readonly FirstPartyExtensionDescriptor[] = [
  {
    id: "piora:file-changes",
    fileName: "piora-file-changes.ts",
    name: "Piora File Changes",
    description: "Captures per-operation file diffs for the conversation timeline.",
    profiles: ["normal"],
    required: true,
  },
  {
    id: "piora:browser",
    fileName: "piora-browser.ts",
    name: "Piora Browser",
    description: "Private headless browser and page inspection tools.",
    profiles: ["normal"],
    required: true,
  },
  {
    id: "piora:harmony",
    fileName: "piora-harmony.ts",
    name: "Piora Harmony",
    description: "Approved OpenHarmony device inspection and control tools.",
    profiles: ["normal", "device-control"],
    required: true,
  },
  {
    id: "piora:vision-agent",
    fileName: "piora-vision-agent.ts",
    name: "Piora Visual Agent",
    description: "Lets text-only primary models inspect images through a user-selected multimodal model.",
    profiles: ["normal"],
    required: true,
  },
  {
    id: "piora:automations",
    fileName: "piora-automations.ts",
    name: "Piora Scheduled Tasks",
    description: "Recurring chat heartbeats and standalone project task scheduling.",
    profiles: ["normal"],
    required: true,
  },
  {
    id: "piora:goal",
    fileName: "piora-goal.ts",
    name: "Piora Goals",
    description: "Optional goal tracking tools and /goal commands for long-running work.",
    profiles: ["normal"],
    defaultEnabled: false,
  },
  {
    id: "piora:plan",
    fileName: "piora-plan.ts",
    name: "Piora Plans",
    description: "Optional structured planning and plan-execution tools with /plan commands.",
    profiles: ["normal"],
    defaultEnabled: false,
  },
  {
    id: "piora:room",
    fileName: "piora-room.ts",
    name: "Piora Rooms",
    description: "Multi-agent room messaging, task coordination, and shared artifacts.",
    profiles: ["normal"],
  },
] as const;

/**
 * Resolve Piora-owned resources independently from the user's project cwd.
 *
 * In a packaged desktop build the tiny launcher lives in `resources/web`,
 * while the complete Next runtime (including `extensions/`) lives inside
 * `resources/web/runtime.asar`. Electron's patched filesystem accepts paths
 * beneath that archive, but `process.cwd()/extensions` points at the empty
 * outer container. The desktop supervisor provides the authoritative root;
 * the candidates keep CLI and unpacked standalone launches working too.
 */
export function firstPartyRuntimeRoot(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = environment.PIORA_WEB_RUNTIME_ROOT?.trim();
  if (configured) return resolve(configured);

  const cwd = process.cwd();
  const candidates = [cwd, join(cwd, "runtime.asar")];
  return candidates.find((candidate) => existsSync(join(candidate, "extensions"))) ?? cwd;
}

export function firstPartyExtensionPath(descriptor: FirstPartyExtensionDescriptor): string {
  return resolve(firstPartyRuntimeRoot(), "extensions", descriptor.fileName);
}

export function getFirstPartyExtensionByPath(path: string): FirstPartyExtensionDescriptor | undefined {
  const candidate = resolve(path).replaceAll("\\", "/");
  return FIRST_PARTY_EXTENSIONS.find((descriptor) => {
    const expected = firstPartyExtensionPath(descriptor).replaceAll("\\", "/");
    return process.platform === "win32"
      ? candidate.toLocaleLowerCase() === expected.toLocaleLowerCase()
      : candidate === expected;
  });
}
