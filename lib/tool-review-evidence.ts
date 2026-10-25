import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { getFirstPartyExtensionByPath } from "./first-party-extensions";
import type { ToolInfo } from "./pi-types";
import { TOOL_REVIEW_LIMITS } from "./tool-review-types";
import { reviewArguments, redactReviewText } from "./tool-review-redaction";

export function reviewHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
const sensitivePath = /(?:^|[\\/])(?:\.git|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.codex|\.pi|\.env(?:\.[^\\/]*)?|auth\.json|credentials(?:\.[^\\/]*)?|id_rsa|id_ed25519|[^\\/]*\.(?:pem|key|pfx|p12))(?:[\\/]|$)/i;
export function isReviewSensitivePath(path: string): boolean { return sensitivePath.test(path); }

/** Resolve every existing parent, including Windows junctions, for not-yet-created files. */
export function reviewRealPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) throw new Error("Path has no existing parent");
  return resolve(reviewRealPath(parent), relative(parent, path));
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
// Match the installed SDK's tool path normalization before assigning scope.
// Its private path helpers are not package exports; regression tests cover these aliases.
function toolPath(requested: string, cwd: string, read: boolean): string {
  let path = requested.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
  if (process.platform === "win32" && !path.includes("\\")) path = path.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i,
    (_, drive: string, tail: string | undefined) => `${drive.toUpperCase()}:\\${(tail ?? "").replaceAll("/", "\\")}`);
  if (path === "~") path = homedir();
  else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) path = join(homedir(), path.slice(2));
  if (path.startsWith("file://")) path = fileURLToPath(path);
  const resolved = resolve(cwd, path);
  if (!read || existsSync(resolved)) return resolved;
  return [resolved.replace(/ (AM|PM)\./gi, "\u202f$1."), resolved.normalize("NFD"), resolved.replace(/'/g, "\u2019"), resolved.normalize("NFD").replace(/'/g, "\u2019")]
    .find(candidate => existsSync(candidate)) ?? resolved;
}
function readBounded(path: string): string {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > TOOL_REVIEW_LIMITS.maxFileBytes) throw new Error("Evidence file exceeds budget");
    const buffer = Buffer.alloc(TOOL_REVIEW_LIMITS.maxFileBytes + 1);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    if (count > TOOL_REVIEW_LIMITS.maxFileBytes) throw new Error("Evidence file exceeds budget");
    return buffer.subarray(0, count).toString("utf8");
  } finally { closeSync(fd); }
}
export interface ReviewEvidence {
  fingerprint: string;
  classification: { trustedTool: boolean; safeTarget: boolean };
  context: unknown;
  manualReason?: string;
}
/** No subprocesses and no model-directed filesystem access. Evidence is bounded and host-selected. */
export function collectReviewEvidence(input: { name: string; args: unknown; cwd: string; tool?: ToolInfo; browser?: unknown }): ReviewEvidence {
  const args = input.args && typeof input.args === "object" ? input.args as Record<string, unknown> : {};
  const firstParty = input.tool?.sourceInfo?.path ? getFirstPartyExtensionByPath(input.tool.sourceInfo.path)?.id : undefined;
  const trustedTool = input.tool?.sourceInfo?.source === "builtin"
    || (input.name === "browser" && firstParty === "piora:browser")
    || (input.name === "piora_request_user_input" && input.tool?.sourceInfo?.source === "builtin");
  const snapshots: unknown[] = [];
  let manualReason: string | undefined;
  let safeTarget = false;
  const cwd = reviewRealPath(resolve(input.cwd));
  const recordPath = (requested: string, includeText = false) => {
    if (snapshots.length >= TOOL_REVIEW_LIMITS.maxEvidenceFiles) { manualReason = "Evidence budget exceeded; confirm the operation manually."; return; }
    const lexicalPath = toolPath(requested, cwd, input.name === "read");
    const path = reviewRealPath(lexicalPath);
    const scoped = inside(cwd, path);
    const sensitive = isReviewSensitivePath(scoped ? relative(cwd, path) : path)
      || isReviewSensitivePath(inside(cwd, lexicalPath) ? relative(cwd, lexicalPath) : lexicalPath);
    const stat = existsSync(path) ? statSync(path) : null;
    const entry: Record<string, unknown> = { requested, path, sensitive, exists: !!stat, size: stat?.size, mtimeMs: stat?.mtimeMs, ctimeMs: stat?.ctimeMs, ino: stat?.ino };
    if (stat?.isDirectory()) {
      // Never enumerate unbounded trees; root metadata is not proof of recursive contents.
      entry.directory = true;
    } else if (stat?.isFile() && scoped && !sensitive && stat.size <= TOOL_REVIEW_LIMITS.maxFileBytes) {
      const text = readBounded(path);
      entry.hash = reviewHash(text);
      if (includeText) {
        const redacted = redactReviewText(text);
        entry.content = redacted;
        if (redacted !== text) manualReason = "Evidence contains credentials; confirm locally without sending those values to the reviewer.";
      }
    } else if (includeText) manualReason = "Required evidence is missing, sensitive, or exceeds the read budget.";
    snapshots.push(entry);
    return !sensitive && scoped;
  };
  try {
    if (["read", "write", "edit", "ls", "grep", "find"].includes(input.name)) {
      const path = typeof args.path === "string" ? args.path : ["ls", "grep", "find"].includes(input.name) ? "." : undefined;
      if (path) {
        safeTarget = recordPath(path) === true;
        if (input.name === "grep" && (snapshots[0] as { directory?: boolean } | undefined)?.directory) {
          safeTarget = false;
          manualReason = "Recursive content search may include sensitive files. Confirm the search scope manually.";
        }
      }
    }
    const command = typeof args.command === "string" ? args.command : "";
    if (["bash", "powershell"].includes(input.name)) {
      // Package scripts are executable evidence, never trusted instructions.
      if (/\b(?:npm|pnpm|yarn|bun)\b/.test(command)) {
        recordPath(join(cwd, "package.json"), true);
        if (/\b(?:cd|pushd|Set-Location)\b|--prefix|--cwd|--workspace|\s-w\s/i.test(command)) manualReason = "The command changes package scope; verify the actual scripts and targets manually.";
      }
      const scripts = Array.from(command.matchAll(/(?:^|[\s"'])([\w./\\-]+\.(?:mjs|cjs|js|ts|py|sh|ps1|cmd|bat))(?=$|[\s"'])/g), match => match[1]);
      for (const path of [...new Set(scripts)]) recordPath(path, true);
      // Recursive deletion requires a separately verified inventory; do not infer safety from a directory name.
      if (/\b(?:rm|rmdir|rd|Remove-Item|git\s+clean)\b/i.test(command)) manualReason = "Deletion requires confirmation of the exact target and recoverability.";
    }
  } catch { manualReason = "The operation target or required evidence could not be verified."; }
  const sanitized = reviewArguments(input.args);
  if (JSON.stringify(sanitized) !== JSON.stringify(input.args)) manualReason = "Arguments contain sensitive data; local confirmation is required.";
  const action = String(args.action ?? "");
  if (input.name === "browser" && ["open", "new_tab"].includes(action) && typeof args.url === "string") {
    try {
      const url = new URL(args.url);
      safeTarget = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !manualReason;
    } catch { safeTarget = false; }
  }
  if (input.name === "browser" && !["open", "new_tab", "snapshot", "screenshot", "tabs", "scroll", "wait_for_user"].includes(action) && !input.browser) {
    manualReason = "The browser target could not be bound to a current page; confirm locally.";
  }
  const context = { tool: input.name, source: input.tool?.sourceInfo?.source ?? "unknown", description: redactReviewText(input.tool?.description ?? "").slice(0, 4000), args: sanitized, cwd, evidence: snapshots, browser: reviewArguments(input.browser) };
  return { fingerprint: reviewHash({ name: input.name, args: input.args, cwd, source: input.tool?.sourceInfo, snapshots, browser: input.browser }), classification: { trustedTool, safeTarget }, context, manualReason };
}
