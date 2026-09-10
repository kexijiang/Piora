import { readdir } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "../file-access";
import { getShellStore } from "./store";
import { listPathCommands } from "./profiles";
import { classifyShellInput, SHELL_BUILTINS } from "./intent";
import { completionWord, quoteShellPath } from "./completion-word";
import { readPackageScripts } from "./package-scripts";
import type { ManagedShellSession } from "./session";
import type { ShellCompletion } from "./types";

let catalog: { commands: string[]; expires: number } | null = null;
export async function commandCatalog(session?: ManagedShellSession): Promise<string[]> {
  if (!catalog || catalog.expires <= Date.now()) catalog = { commands: [...new Set([...SHELL_BUILTINS, ...await listPathCommands()])], expires: Date.now() + 60_000 };
  return [...new Set([...catalog.commands, ...(session?.commandNames?.() || [])])];
}
export async function shellCompletions(terminal: ManagedShellSession, input: string): Promise<{ intent: "command" | "agent" | "ambiguous"; completions: ShellCompletion[] }> {
  const session = terminal.state;
  const commands = await commandCatalog(terminal);
  const query = input.slice(0, 4096);
  const history = await getShellStore().history({ query, cwd: session.cwd, shell: session.profile.kind, suggestions: true, limit: 8 });
  const completions: ShellCompletion[] = history.records.map(record => ({ value: record.command, label: record.command, kind: "history", detail: [record.source, record.cwd].filter(Boolean).join(" · ") }));
  const word = completionWord(query, session.profile.kind);
  const last = word.value, prefix = word.prefix;
  if (word.commandPosition && last) for (const name of commands.filter(name => name.toLowerCase().startsWith(last.toLowerCase())).slice(0, 8)) completions.push({ value: prefix + name, label: name, kind: "command" });
  const slash = Math.max(last.lastIndexOf("/"), last.lastIndexOf("\\"));
  const folder = last.slice(0, slash + 1), stem = last.slice(slash + 1).toLowerCase();
  let lookup = folder || ".";
  if (/^~[\\/]/.test(lookup)) lookup = path.join(homedir(), lookup.slice(2));
  if (process.platform === "win32" && session.profile.kind === "bash") lookup = lookup.replace(/^\/([a-z])\//i, "$1:/");
  const directory = path.resolve(session.cwd, lookup);
  const roots = await getAllowedFileRoots();
  const files: ShellCompletion[] = [];
  if (isExistingFilePathAllowed(directory, roots)) {
    try {
      for (const entry of (await readdir(directory, { withFileTypes: true })).filter(entry => entry.name.toLowerCase().startsWith(stem)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, 20)) {
        let value = folder.startsWith("~") ? path.join(directory, entry.name) : folder + entry.name;
        if (word.commandPosition && !entry.isDirectory() && !folder) value = "./" + entry.name;
        if (session.profile.kind === "bash" || session.profile.kind === "zsh") value = value.replaceAll("\\", "/");
        if (entry.isDirectory()) value += session.profile.kind === "powershell" && !folder.includes("/") ? path.sep : "/";
        value = quoteShellPath(value, session.profile.kind);
        const invocation = word.commandPosition && session.profile.kind === "powershell" && value.startsWith("'") && !entry.isDirectory() && prefix.trim() !== "&" ? "& " : "";
        files.push({ value: prefix + invocation + value, label: entry.name + (entry.isDirectory() ? "/" : ""), kind: entry.isDirectory() ? "directory" : "file" });
      }
    } catch { /* A disappearing directory does not disable history. */ }
  }
  if (/^(?:npm|pnpm|yarn)\s+(?:run\s+)?[^\s]*$/.test(query) && isExistingFilePathAllowed(path.join(session.cwd, "package.json"), roots)) {
    try {
      const scripts = await readPackageScripts(session.cwd);
      for (const name of Object.keys(scripts).filter(name => name.startsWith(last)).slice(0, 20)) completions.push({ value: prefix + name, label: name, kind: "script", detail: scripts[name].slice(0, 150) });
    } catch { /* Not a package workspace. */ }
  }
  if (/^git\s+(?:switch|checkout)\s+[^\s]*$/.test(query)) {
    try {
      const result = await promisify(execFile)("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { cwd: session.cwd, timeout: 2000, maxBuffer: 256_000, windowsHide: true });
      for (const name of result.stdout.split(/\r?\n/).filter(name => name && name.startsWith(last)).slice(0, 20)) completions.push({ value: prefix + name, label: name, kind: "branch" });
    } catch { /* No git or no repository. */ }
  }
  const seen = new Set<string>();
  return { intent: classifyShellInput(query, commands), completions: [...completions, ...files].filter(item => { if (seen.has(item.value)) return false; seen.add(item.value); return true; }).slice(0, 20) };
}
