import { open } from "node:fs/promises";
import path from "node:path";

export async function readPackageScripts(cwd: string): Promise<Record<string, string>> {
  const handle = await open(path.join(cwd, "package.json"), "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Project package metadata is too large");
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > stat.size) throw new Error("Project package metadata changed while reading");
    const raw = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (!raw.scripts || typeof raw.scripts !== "object" || Array.isArray(raw.scripts)) return {};
    return Object.fromEntries(Object.entries(raw.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } finally { await handle.close(); }
}
