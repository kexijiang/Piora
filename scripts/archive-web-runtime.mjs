import { createPackageWithOptions } from "@electron/asar";

export async function createWebRuntimeArchive(source, destination) {
  // ConPTY loads sibling DLLs and starts a worker by filename. Keep its JS,
  // native bindings, helper executables and DLLs in one real directory.
  await createPackageWithOptions(source, destination, { unpackDir: "**/node-pty" });
}
