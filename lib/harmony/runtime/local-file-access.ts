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
