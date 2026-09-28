import { lstat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "../../file-access";
import { HarmonyError } from "../errors";

export async function assertNewHarmonyLocalFileAllowed(destinationPath: string): Promise<void> {
  if (!isAbsolute(destinationPath)) throw new HarmonyError("INVALID_ARGUMENT", "Choose an absolute local file path");
  const roots = await getAllowedFileRoots();
  if (!isFilePathAllowed(destinationPath, roots) || !isExistingFilePathAllowed(dirname(destinationPath), roots)) {
    throw new HarmonyError("INVALID_ARGUMENT", "Choose a destination within an allowed workspace root");
  }
  const existing = await lstat(destinationPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) throw new HarmonyError("INVALID_ARGUMENT", "The local destination already exists; choose a new name");
}

export async function assertHarmonyLocalSourceAllowed(sourcePath: string): Promise<void> {
  if (!isAbsolute(sourcePath) || !isExistingFilePathAllowed(sourcePath, await getAllowedFileRoots())) {
    throw new HarmonyError("INVALID_ARGUMENT", "Choose an existing file within an allowed workspace root");
  }
  const info = await lstat(sourcePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 * 1024) {
    throw new HarmonyError("INVALID_ARGUMENT", "Upload must be a regular file no larger than 256 MiB");
  }
}
