import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getRuntimeAgentDataDirectory } from "@/lib/runtime-home";
import { listAllSessions } from "@/lib/session-reader";
import { allowFileRoot } from "@/lib/allowed-roots";
import { harmonyRuntimeAsset } from "@/lib/harmony/runtime/asset-path";

type Library = ReturnType<typeof import("./vendor/log-library.mjs").createLogLibrary> & {
  management: ReturnType<typeof import("./vendor/log-management.mjs").createLogManagement>;
};
type LibraryState = { root: string; library: Promise<Library> };
const state = globalThis as typeof globalThis & { __pioraLogLibrary?: LibraryState };

/** Load the original modules with Node so worker URLs also work in standalone. */
export function getHarmonyLogLibrary(): Promise<Library> {
  const root = join(getRuntimeAgentDataDirectory(), "piora", "harmony-log-workbench");
  if (state.__pioraLogLibrary?.root === root) return state.__pioraLogLibrary.library;
  const previous = state.__pioraLogLibrary;
  const library = (async () => {
    if (previous) await (await previous.library).dispose();
    const modulePath = pathToFileURL(harmonyRuntimeAsset("lib", "harmony", "log-library", "vendor", "log-library.mjs")).href;
    const runtime = await import(/* webpackIgnore: true */ modulePath) as typeof import("./vendor/log-library.mjs");
    allowFileRoot(root);
    return runtime.createLogLibrary(root, { listSessions: async () => (await listAllSessions()).map(session => ({ id: session.id, name: session.name })) }) as Library;
  })();
  state.__pioraLogLibrary = { root, library };
  void library.catch(() => { if (state.__pioraLogLibrary?.library === library) delete state.__pioraLogLibrary; });
  return library;
}
