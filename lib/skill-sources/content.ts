import { createHash } from "node:crypto";
import JSZip from "jszip";
import type { Readable } from "node:stream";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { safeRelative } from "./store";
import { SkillSourceError } from "./types";

export const MAX_BYTES = 50 * 1024 * 1024;
export const MAX_FILES = 2000;
export function validateFiles(files: Map<string, Buffer>) {
  if (files.size > MAX_FILES) throw new SkillSourceError("size", "Skill has too many files");
  let total = 0;
  const names = new Set<string>();
  for (const [name, content] of files) {
    safeRelative(name);
    const key = name.toLowerCase();
    if (names.has(key)) throw new SkillSourceError("path", "Duplicate skill file path");
    names.add(key); total += content.length;
    if (total > MAX_BYTES) throw new SkillSourceError("size", "Skill exceeds 50 MB");
  }
  for (const name of names) {
    const parts = name.split("/"); parts.pop();
    while (parts.length) { if (names.has(parts.join("/"))) throw new SkillSourceError("path", "Conflicting file and directory paths"); parts.pop(); }
  }
}
export async function unzipSkill(bytes: Buffer): Promise<Map<string, Buffer>> {
  if (bytes.length > MAX_BYTES) throw new SkillSourceError("size", "Download exceeds 50 MB");
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  if (entries.length > MAX_FILES) throw new SkillSourceError("size", "Archive has too many entries");
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const entry of entries) {
    const original = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName || entry.name;
    safeRelative(original.replace(/\/$/, ""));
    if (typeof entry.unixPermissions === "number" && (entry.unixPermissions & 0o170000) === 0o120000) throw new SkillSourceError("path", "Skill archives cannot contain links");
    if (entry.dir) continue;
    // Stream expansion with an enforced limit instead of allocating a ZIP bomb.
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = entry.nodeStream() as Readable;
      stream.on("data", (chunk: Buffer) => {
        const buffer = Buffer.from(chunk); total += buffer.length;
        if (total > MAX_BYTES) { stream.pause(); stream.destroy(); reject(new SkillSourceError("size", "Expanded skill exceeds 50 MB")); return; }
        chunks.push(buffer);
      });
      stream.once("error", reject); stream.once("end", resolve);
    });
    files.set(original, Buffer.concat(chunks));
  }
  validateFiles(files);
  if (files.has("SKILL.md")) return files;
  const roots = [...files.keys()].filter(p => p.endsWith("/SKILL.md"));
  if (roots.length !== 1) throw new SkillSourceError("format", "Archive must contain one skill root");
  const prefix = roots[0].slice(0, -8);
  if ([...files.keys()].some(p => !p.startsWith(prefix))) throw new SkillSourceError("format", "Archive contains files outside the skill root");
  return new Map([...files].map(([name, bytes]) => [name.slice(prefix.length), bytes]));
}
export function skillMetadata(files: Map<string, Buffer>) {
  validateFiles(files);
  const bytes = files.get("SKILL.md");
  if (!bytes || bytes.length > 1024 * 1024) throw new SkillSourceError("format", "A SKILL.md of at most 1 MB is required");
  const readme = bytes.toString("utf8");
  const { frontmatter } = parseFrontmatter<Record<string, unknown>>(readme);
  const name = frontmatter.name;
  if (typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new SkillSourceError("format", "Invalid SKILL.md name");
  if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) throw new SkillSourceError("format", "SKILL.md description is required");
  return { name, description: frontmatter.description, readme, requirements: frontmatter.compatibility ? String(frontmatter.compatibility) : frontmatter.metadata ? JSON.stringify(frontmatter.metadata, null, 2) : undefined };
}
export function withoutToggle(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^(---\n)([\s\S]*?)(\n---)/, (_all, start, body, end) => start + body.replace(/^disable-model-invocation\s*:.*(?:\n|$)/m, "").replace(/\n$/, "") + end);
}
export function contentHash(files: Map<string, Buffer>): string {
  const hash = createHash("sha256");
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const content = name === "SKILL.md" ? Buffer.from(withoutToggle(bytes.toString("utf8"))) : bytes;
    hash.update(`${Buffer.byteLength(name)}:${name}:${content.length}:`).update(content);
  }
  return hash.digest("hex");
}
