import { createPackageWithOptions } from "@electron/asar";

export async function createWebRuntimeArchive(source, destination) {
  // ConPTY loads sibling DLLs and starts a worker by filename. Keep its JS,
  // native bindings, helper executables and DLLs in one real directory.
  // Sharp's versioned @img bindings must also be available to the native loader.
  // Shell workers and scripts are opened by Node workers / external shells.
  // They must live at the real sidecar paths resolved by shellAssetPath().
  // The DevEco CLI is started as a child-process script. Keep its executable
  // package on disk while preserving the virtual runtime.asar path used by
  // Electron's ASAR-aware filesystem.
  // Harmony children, PowerShell audio helpers and HDC-pushed driver resources
  // require real sidecar files, with ordinary Node resolution inside the child.
  await createPackageWithOptions(source, destination, { unpackDir: "**/{node-pty,@img,@deveco,shell/runtime,hypium-driver,harmony/audio,harmony/runtime,.harmony-worker}" });
}
