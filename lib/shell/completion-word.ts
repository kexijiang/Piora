import type { ShellKind } from "./types";

/** Decode just the editable final shell word; never evaluate expansions. */
export function completionWord(input: string, shell: ShellKind): { prefix: string; value: string; commandPosition: boolean } {
  let start = 0, value = "", quote = "", active = false, commandPosition = true, firstWord = true;
  for (let index = 0; index < input.length; index++) {
    const char = input[index], next = input[index + 1];
    if (!active && !/\s/.test(char)) { start = index; active = true; commandPosition = firstWord; }
    if (quote) {
      if (char === quote) {
        if (shell === "powershell" && quote === "'" && next === "'") { value += "'"; index++; }
        else quote = "";
      } else if (quote === '"' && (shell === "powershell" && char.charCodeAt(0) === 96 || shell !== "powershell" && shell !== "cmd" && char === "\\" && next && /["$\x60\\\n]/.test(next))) {
        if (next) { value += next; index++; }
      } else value += char;
      continue;
    }
    if (/\s/.test(char)) { if (active) firstWord = false; active = false; value = ""; start = index + 1; commandPosition = firstWord; continue; }
    if (/[;|&<>]/.test(char)) { active = false; firstWord = char !== "<" && char !== ">"; value = ""; start = index + 1; commandPosition = firstWord; continue; }
    if (char === '"' || char === "'" && shell !== "cmd") { quote = char; continue; }
    if ((shell === "powershell" && char.charCodeAt(0) === 96 || shell === "cmd" && char === "^" || shell !== "powershell" && shell !== "cmd" && char === "\\") && next) {
      value += next; index++; continue;
    }
    value += char;
  }
  return { prefix: input.slice(0, start), value, commandPosition };
}

export function quoteShellPath(value: string, shell: ShellKind): string {
  if (/^[\w@%+=:,./\\-]+$/u.test(value)) return value;
  if (shell === "cmd") return '"' + value.replaceAll('"', '""') + '"';
  return "'" + value.replaceAll("'", shell === "powershell" ? "''" : "'\\''") + "'";
}
