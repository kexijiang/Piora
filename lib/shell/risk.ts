import type { ShellKind } from "./types";
import { readPackageScripts } from "./package-scripts";
export interface ShellRisk { confirmation: boolean; reason: string }

/** Execution policy, not an OS sandbox. Unrecognized syntax always requires review. */
export function assessShellCommand(command: string, shell: ShellKind): ShellRisk {
  const review = (reason: string): ShellRisk => ({ confirmation: true, reason });
  if (command.length > 8000 || /[\r\n\x00-\x1f]/.test(command)) return review("Review this multiline script before running it.");
  if (/%[^%\s]+%|![^!\s]+!/.test(command)) return review("Review environment expansion before executing a package or shell command.");
  if (/\$\(|`|\$\{|\b(?:eval|iex|invoke-expression|invoke-command|sudo|su|runas)\b/i.test(command)) return review("This command evaluates dynamic code or changes execution privileges.");
  if (/[;&|<>]/.test(command)) return review("This command combines operations, redirects output or invokes a pipeline.");
  const tokens: string[] = command.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g) || [];
  const executable = (tokens.shift() || "").replace(/^['"]|['"]$/g, "").replaceAll("\\", "/").split("/").at(-1)!.toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, "");
  const first = (tokens[0] || "").toLowerCase();
  if (shell === "cmd" || shell === "custom") return review("This shell has no verified command lifecycle integration.");
  if (/^(?:rm|rmdir|del|erase|remove-item|mv|move|move-item|cp|copy|copy-item|tee|set-content|out-file|dd|mkfs|format|diskpart|shutdown|reboot|kill|pkill|stop-process|stop-service)$/i.test(executable)) return review("This command can delete, overwrite, move data or stop a process/service.");
  if (executable === "git") {
    if (["status", "diff", "log", "show", "ls-files", "rev-parse", "remote"].includes(first) && !tokens.includes("--output") && !tokens.some(token => token.startsWith("--output=")) && (first !== "remote" || tokens.length === 1 || tokens[1] === "-v")) return { confirmation: false, reason: "Read repository state" };
    if (["add", "commit", "fetch"].includes(first) && !tokens.some(token => /^(?:--amend|--delete|--prune(?:-tags)?|--force|--update-head-ok|--mirror|--refmap)(?:=|$)|^-[^-]*f|^\+/.test(token))) return { confirmation: false, reason: "Routine local repository work" };
    if ((first === "switch" || first === "checkout" && tokens[1] === "-b") && !tokens.some(token => /^(?:--|-f|--force|-B|-C|--force-create|--discard-changes|--orphan)$/.test(token))) return { confirmation: false, reason: "Switch branches without discarding changes" };
    return review("This Git operation may discard data, rewrite history or publish to a remote repository.");
  }
  if (["npm", "pnpm", "yarn", "pip", "pip3", "docker", "kubectl", "helm", "terraform"].includes(executable)) {
    if (["--version", "-v", "--help", "list", "ls", "ps", "version"].includes(first)) return { confirmation: false, reason: "Inspect tools or installed resources" };
    if (["npm", "pnpm", "yarn"].includes(executable) && ["install", "i", "ci", "add"].includes(first) && !tokens.some(token => /^(?:-g|--global|--prefix|--cwd|--dir)(?:=|$)|^--location=global$/i.test(token))) return { confirmation: false, reason: "Install project dependencies" };
    return review("Review the package script, installation or infrastructure operation.");
  }
  if (["vite", "vitest", "tsc", "eslint", "prettier", "jest", "mocha", "pytest"].includes(executable) && !tokens.some(token => /^(?:--exec|--eval|--pre)(?:=|$)/i.test(token))) return { confirmation: false, reason: "Run ordinary development, formatting or validation tooling" };
  if (executable === "next" && ["dev", "start", "build", "info", "lint", "typegen"].includes(first)) return { confirmation: false, reason: "Run the project development lifecycle" };
  if (["sleep", "start-sleep"].includes(executable)) return { confirmation: false, reason: "Wait without changing project data" };
  if (["node", "python", "python3", "ruby", "perl", "bash", "sh", "zsh", "pwsh", "powershell", "cmd"].includes(executable)) return review("This invokes a program or script whose effects depend on its contents.");
  if (["pwd", "ls", "dir", "echo", "printf", "cat", "head", "tail", "wc", "rg", "grep", "which", "where", "whoami", "uname", "hostname", "date", "ps", "df", "du", "free", "get-childitem", "get-content", "get-location", "get-item", "get-command", "get-process", "get-service", "get-help", "get-history", "get-alias", "test-path", "write-output"].includes(executable)) {
    if (tokens.some(token => /^(?:--pre(?:=|$)|--exec(?:=|$)|-exec|-command|--output(?:=|$)|--files-without-match)/i.test(token))) return review("This option can invoke another operation or alter normal command behavior.");
    return { confirmation: false, reason: "Inspect the current environment" };
  }
  if (["cd", "set-location"].includes(executable) && (tokens.length <= 1 || tokens.length === 2 && /^-(?:LiteralPath|Path)$/i.test(first))) return { confirmation: false, reason: "Change the terminal directory" };
  return review("The effects of this command are not known. Review it before execution.");
}

/** Inspect project scripts and their hooks before treating them as routine work. */
export async function assessShellExecution(command: string, shell: ShellKind, cwd: string, visited = new Set<string>()): Promise<ShellRisk> {
  const initial = assessShellCommand(command, shell);
  if (!initial.confirmation) return initial;
  if (/[\r\n;&|<>`]/.test(command) || /\$\(/.test(command)) return initial;
  const match = command.trim().match(/^(npm|pnpm|yarn)\s+(?:(run|run-script)\s+)?([\w:.-]+)(?:\s|$)/i);
  if (!match) return initial;
  const name = match[3];
  const suffix = command.trim().slice(match[0].trimEnd().length).trim();
  // Package-manager flags can redirect to a different project or interpreter.
  // Only explicitly forwarded script arguments are inspected with that script.
  if (suffix && !suffix.startsWith("-- ")) return initial;
  const forwarded = suffix ? suffix.slice(3).trim() : "";
  if (/^(?:deploy|publish|release|upload|clean|reset|delete|remove|migrate)(?:$|[:.-])/i.test(name)) return { confirmation: true, reason: "This project script may delete data, migrate state or publish changes." };
  if (visited.has(name) || visited.size >= 8) return { confirmation: true, reason: "This project script is recursive or too deeply nested to inspect." };
  try {
    const scripts = await readPackageScripts(cwd);
    if (!scripts || typeof scripts[name] !== "string") return initial;
    const next = new Set(visited); next.add(name);
    for (const key of ["pre" + name, name, "post" + name]) {
      if (typeof scripts[key] !== "string") continue;
      const risk = await assessShellExecution(scripts[key] + (key === name && forwarded ? " " + forwarded : ""), shell, cwd, next);
      if (risk.confirmation) return { confirmation: true, reason: `${key}: ${risk.reason}` };
    }
    return { confirmation: false, reason: "The project script and its hooks perform ordinary development work" };
  } catch { return initial; }
}
