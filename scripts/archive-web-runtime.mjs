import { createPackageWithOptions } from "@electron/asar";

export async function createWebRuntimeArchive(source, destination) {
  // ConPTY loads sibling DLLs and starts a worker by filename. Keep its JS,
  // native bindings, helper executables and DLLs in one real directory.
  // Sharp's versioned @img bindings must also be available to the native loader.
  // Shell workers and scripts are opened by Node workers / external shells.
  // They must live at the real sidecar paths resolved by shellAssetPath().
  // Harmony children, PowerShell audio helpers and HDC-pushed driver resources
  // require real sidecar files, with ordinary Node resolution inside the child.
  // SQLite diagnostics import ESM and read their adjacent WASM binary from an ordinary worker.
  // Log ESM workers and their archive dependencies require real sidecar paths.
  await createPackageWithOptions(source, destination, { unpackDir: "**/{node-pty,@img,@sqlite.org,shell/runtime,hypium-driver,harmony/audio,harmony/runtime,harmony/log-library/vendor,7z-bin,yauzl,pend,harmony-video,.harmony-worker}" });
}
