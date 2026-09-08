import { createRequire } from "node:module";
import path from "node:path";
import type * as NodePty from "node-pty";

/** Native DLLs and the ConPTY worker must share a real filesystem directory. */
export function loadTerminalPty(): typeof NodePty {
  const runtimeRoot = process.env.PIORA_WEB_RUNTIME_ROOT?.trim();
  const requireRuntime = createRequire(path.join(runtimeRoot || process.cwd(), "package.json"));
  return requireRuntime(runtimeRoot?.endsWith(".asar")
    ? path.join(`${runtimeRoot}.unpacked`, "node_modules", "node-pty")
    : "node-pty") as typeof NodePty;
}
