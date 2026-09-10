import { access, mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import type { ShellProfile } from "./types";
import { shellAssetPath, shellDataDirectory } from "./store";

export function profileFor(executable: string): ShellProfile {
  const name = path.basename(executable).replace(/\.exe$/i, "").toLowerCase();
  const kind = ["pwsh", "powershell"].includes(name) ? "powershell" : name === "bash" ? "bash" : name === "zsh" ? "zsh" : name === "cmd" ? "cmd" : "custom";
  const label = name === "pwsh" ? "PowerShell" : name === "powershell" ? "Windows PowerShell" : name === "bash" ? process.platform === "win32" ? "Git Bash" : "Bash" : name === "zsh" ? "Zsh" : name === "cmd" ? "Command Prompt" : path.basename(executable);
  return { executable, label, kind, integrated: ["powershell", "bash", "zsh"].includes(kind) };
}
export async function findExecutable(name: string): Promise<string | null> {
  const extensions = process.platform === "win32" && !path.extname(name) ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  const directories = path.isAbsolute(name) ? [""] : (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) for (const extension of extensions) {
    const candidate = path.resolve(directory, name + extension.toLowerCase());
    try { await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK); return candidate; } catch { /* Next candidate. */ }
  }
  return null;
}
export async function discoverShellProfiles(): Promise<ShellProfile[]> {
  const candidates = process.platform === "win32"
    ? ["pwsh", "powershell", process.env.ComSpec || "cmd", "C:\\Program Files\\Git\\bin\\bash.exe"]
    : [process.env.SHELL || "/bin/bash", "/bin/bash", "/bin/zsh", "/bin/sh"];
  if (process.platform === "win32") {
    const git = await findExecutable("git");
    if (git) {
      // Git for Windows is frequently installed on a non-system drive. Avoid
      // treating Windows' System32/bash.exe (a WSL launcher) as a native Bash.
      let directory = path.dirname(git);
      for (let depth = 0; depth < 3; depth++, directory = path.dirname(directory)) candidates.push(path.join(directory, "bin", "bash.exe"));
    }
  }
  const resolved = await Promise.all(candidates.map(findExecutable));
  return [...new Set(resolved.filter((item): item is string => Boolean(item)))].map(profileFor);
}
export async function resolveShellProfile(configured?: string | null): Promise<ShellProfile> {
  const chosen = configured || process.env.PI_TERMINAL_SHELL?.trim();
  if (chosen) {
    const executable = await findExecutable(chosen);
    if (!executable) throw new Error(`Shell executable not found: ${chosen}`);
    return profileFor(executable);
  }
  const profiles = await discoverShellProfiles();
  if (!profiles.length) throw new Error("No shell executable is available");
  return profiles[0];
}
const shQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export async function prepareShellLaunch(profile: ShellProfile, id: string, token: string, directory = shellDataDirectory()) {
  const env = Object.fromEntries(Object.entries({ ...process.env, TERM: "xterm-256color", TERM_PROGRAM: "Piora" }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  let args: string[] = [];
  if (!profile.integrated) return { args: profile.kind === "cmd" ? ["/D", "/Q", "/K"] : [], env };
  const root = path.join(directory, "integration", id);
  const extension = profile.kind === "powershell" ? "ps1" : profile.kind;
  // Load immutable, packaged integration code. Per-process identity belongs in
  // the child environment, not in a rewritten executable in the user's data.
  const scriptPath = shellAssetPath(`integration.${extension}`);
  env.PIORA_SHELL_TOKEN = token;
  if (profile.kind === "powershell") {
    // Honor execution policy; if script loading is prohibited the terminal stays raw.
    args = ["-NoLogo", "-NoExit", "-Command", `. '${scriptPath.replaceAll("'", "''")}'`];
  } else if (profile.kind === "bash") {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const toBashPath = (value: string) => process.platform === "win32" ? value.replace(/\\/g, "/").replace(/^([a-z]):/i, (_, drive: string) => `/${drive.toLowerCase()}`) : value;
    const rc = path.join(root, "bashrc");
    await writeFile(rc, `[[ -f ~/.bashrc ]] && source ~/.bashrc\nsource ${shQuote(toBashPath(scriptPath))}\n`, { mode: 0o600 });
    args = ["--rcfile", toBashPath(rc), "-i"];
  } else {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const original = process.env.ZDOTDIR || homedir();
    // Forward all startup files, without installing anything in the user's home.
    for (const file of [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) {
      await writeFile(path.join(root, file), `[[ -f ${shQuote(path.join(original, file))} ]] && source ${shQuote(path.join(original, file))}\n${file === ".zshrc" ? `source ${shQuote(scriptPath)}\n` : ""}`, { mode: 0o600 });
    }
    env.ZDOTDIR = root; args = ["-i"];
  }
  return { args, env };
}
export function encodeShellSubmission(profile: ShellProfile, command: string, id: string): string {
  if (!profile.integrated) return `${command}\r`;
  const payload = Buffer.from(command, "utf8").toString("base64");
  return profile.kind === "powershell" ? `. __PioraDispatch '${payload}' '${id}'\r` : `__piora_dispatch '${payload}' '${id}'\r`;
}
export async function listPathCommands(searchPath = process.env.PATH || ""): Promise<string[]> {
  const extensions = new Set((process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").toLowerCase().split(";")); extensions.add(".ps1");
  const entries = await Promise.all([...new Set(searchPath.split(path.delimiter).filter(Boolean))].map(async directory => {
    try {
      const candidates = (await readdir(directory, { withFileTypes: true })).filter(entry => (entry.isFile() || entry.isSymbolicLink()) && (process.platform !== "win32" || extensions.has(path.extname(entry.name).toLowerCase())));
      return (await Promise.all(candidates.map(async entry => {
        try { const file = path.join(directory, entry.name); if (process.platform !== "win32") await access(file, constants.X_OK); if (entry.isSymbolicLink() && !(await stat(file)).isFile()) return null; return entry.name; } catch { return null; }
      }))).filter((name): name is string => name !== null);
    } catch { return []; }
  }));
  return [...new Set(entries.flat())];
}
