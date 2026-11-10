import { createHash } from "node:crypto";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { firstPartyRuntimeRoot } from "../first-party-extensions";
import { MINI_APP_CAPABILITIES } from "./capability-manifest";
import { evaluateMiniAppCapabilities, type MiniAppCapabilityEvidence } from "./capabilities";
import type { PromptRunIdentity } from "../prompt-run-registry";
import { miniAppEnvironments } from "./environment-store";

export function miniAppRendererDigest(): string {
  try { return createHash("sha256").update(readFileSync(join(firstPartyRuntimeRoot(), ".mini-app-runtime/renderer.js"))).digest("hex"); } catch { return ""; }
}

/** Host-only switch: a model cannot supply it, and the default profile cannot use it. */
export function miniAppDevelopmentCapabilities(environment: NodeJS.ProcessEnv = process.env): boolean {
  const root = environment.PI_CODING_AGENT_DIR?.trim();
  const canonical = (path: string) => { try { return realpathSync(path).toLowerCase(); } catch { return resolve(path).toLowerCase(); } };
  return environment.NODE_ENV !== "production" && environment.PIORA_MINI_APP_CAPABILITIES === "development"
    && !!root && canonical(root) !== canonical(join(homedir(), ".pi", "agent"));
}
export function readMiniAppCapabilities(identity?: PromptRunIdentity) {
  const root = firstPartyRuntimeRoot(), digests: Record<string, string> = {};
  // Only app-owned paths from the manifest are read, never paths from a proof or plan.
  for (const file of new Set(MINI_APP_CAPABILITIES.flatMap(capability => [...capability.sources]))) {
    try { digests[file] = createHash("sha256").update(readFileSync(join(root, file))).digest("hex"); } catch { /* Missing sources invalidate evidence. */ }
  }
  let evidence: MiniAppCapabilityEvidence | undefined;
  try {
    const data = readFileSync(join(root, "lib/mini-app/capability-evidence.json"));
    // Each capability binds the complete source set. Keep a bounded budget that
    // accommodates that deliberate duplication as the implemented set grows.
    if (data.length > 512 * 1024) throw new Error("Evidence too large");
    const value = JSON.parse(data.toString("utf8")) as MiniAppCapabilityEvidence;
    if (!Array.isArray(value.entries) || value.entries.length > MINI_APP_CAPABILITIES.length
      || value.entries.some(entry => !entry || typeof entry.sources !== "object" || !entry.sources || !Array.isArray(entry.checks) || typeof entry.scope !== "string")) throw new Error("Invalid evidence");
    evidence = value;
  } catch { /* Missing or corrupt evidence never grants a capability. */ }
  return evaluateMiniAppCapabilities(evidence, digests, { platform: process.platform,
    wasm: typeof WebAssembly === "object" && existsSync(join(root, ".mini-app-runtime/quickjs.wasm")) && existsSync(join(root, ".mini-app-runtime/renderer.js")),
    webgl: miniAppEnvironments().webgl(identity, digests[".mini-app-runtime/renderer.js"] ?? ""), development: miniAppDevelopmentCapabilities() });
}
