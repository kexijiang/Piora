// On Windows the persistent cache can spend longer validating its snapshots
// on a slow filesystem than recompiling, also delaying CSS HMR. In-memory
// caching remains active. Other platforms keep Next's persistent-cache default.
export function developmentFilesystemCache(platform = process.platform, preference = process.env.PIORA_DEV_FILESYSTEM_CACHE) {
  if (preference === "1") return true;
  if (preference === "0") return false;
  return platform !== "win32";
}
