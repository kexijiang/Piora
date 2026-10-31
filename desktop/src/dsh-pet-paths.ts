import { cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Copy legacy data once, keeping the original as a recovery copy. Never overwrite a selected directory. */
export function preparePetRoot(agentDirectory: string, userData: string): string {
  const root = join(agentDirectory, "piora", "desktop-extensions", "dsh-pet");
  const legacy = join(userData, "desktop-extensions", "dsh-pet");
  const marker = join(legacy, ".piora-migrated");
  if (!existsSync(root) && existsSync(legacy) && !existsSync(marker)) {
    mkdirSync(dirname(root), { recursive: true });
    const staging = `${root}.migration`;
    // An interrupted copy is safe to resume; the destination is published only once complete.
    cpSync(legacy, staging, { recursive: true });
    renameSync(staging, root);
    writeFileSync(marker, root, { mode: 0o600 });
  }
  return root;
}
