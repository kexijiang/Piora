/**
 * Piora shell guard.
 *
 * The built-in bash/powershell tools have no default timeout, so a model that
 * runs a dev server, a watch process, or an interactive git command hangs the
 * whole task on a tool call that never returns. This extension intercepts shell
 * arguments before the original tool executes, preserving its configuration:
 *
 * - inject a default timeout when the model omits one (env:
 *   `PIORA_SHELL_TIMEOUT_SECONDS`, default 600s),
 * - reject obvious long-running server/watch commands with actionable guidance
 *   (run them in the background instead),
 * - reject obvious interactive commands that would wait for terminal input.
 *
 * An explicit `timeout` argument always passes through untouched: a bounded run
 * is a legitimate way to smoke-test a server startup.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_SHELL_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 2_147_483;

export function readShellTimeoutSeconds(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const parsed = Number(env.PIORA_SHELL_TIMEOUT_SECONDS?.trim());
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.min(Math.floor(parsed), MAX_TIMEOUT_SECONDS))
    : DEFAULT_SHELL_TIMEOUT_SECONDS;
}

interface SimpleCommand { words: string[]; background: boolean }

/** A conservative lexer, not a shell interpreter. Complex scripts still get a timeout. */
function simpleCommands(command: string): SimpleCommand[] {
  // Do not mistake heredoc/script bodies or command substitutions for commands.
  if (/<<|@['"]|\$\(|`/.test(command)) return [];
  const result: SimpleCommand[] = [];
  let words: string[] = [];
  let word = "";
  let quote = "";
  const finishWord = () => { if (word) words.push(word); word = ""; };
  const finishCommand = (background = false) => {
    finishWord();
    if (words.length) result.push({ words, background });
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = "";
      else if (ch === "\\" && quote === '"' && /["\\]/.test(command[i + 1] ?? "")) word += command[++i];
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && !word) {
      while (i < command.length && command[i] !== "\n") i++;
      finishCommand();
    } else if (ch === "\\" && /[\s'";&|]/.test(command[i + 1] ?? "")) {
      word += command[++i];
    } else if (ch === "&" && /[<>]/.test(command[i - 1] ?? "")) {
      word += ch; // 2>&1 is redirection, not background execution.
    } else if (/[;&|\n]/.test(ch)) {
      const doubled = command[i + 1] === ch && (ch === "&" || ch === "|");
      finishCommand(ch === "&" && !doubled);
      if (doubled) i++;
    } else if (/\s/.test(ch)) finishWord();
    else word += ch;
  }
  if (quote) return [];
  finishCommand();
  return result;
}

function classifyCommand(words: string[]): "long-running" | "interactive" | undefined {
  let index = 0;
  while (/^[\w]+=.*/.test(words[index] ?? "")) index++;
  const executable = (words[index] ?? "").split(/[\\/]/).at(-1)!.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
  const args = words.slice(index + 1);
  if (["nohup", "setsid", "start-process", "start-job"].includes(executable)) return;
  // Check real argument tokens; quoted search text never becomes an executable.
  if (args.some(arg => ["--help", "--version", "-h"].includes(arg))) return;
  if (["npx", "bunx"].includes(executable)) return classifyCommand(args.filter(arg => !["-y", "--yes", "--no-install"].includes(arg)));
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    const script = args[0] === "run" ? args[1] : args[0];
    if (/^(dev|serve|start|watch)(:|$)/i.test(script ?? "")) return "long-running";
  }
  if (["next", "nuxt", "astro", "remix", "gatsby", "ng", "vue-cli-service"].includes(executable)
    && ["dev", "serve", "start"].includes(args[0])) return "long-running";
  if (executable === "vite" && (!args.length || ["dev", "preview"].includes(args[0]) || args[0].startsWith("--"))) return "long-running";
  if (["serve", "http-server", "live-server", "json-server", "ngrok", "localtunnel", "webpack-dev-server", "nodemon", "uvicorn", "gunicorn", "daphne"].includes(executable)) return "long-running";
  if (["webpack", "webpack-cli"].includes(executable) && (args[0] === "serve" || args.includes("--watch"))) return "long-running";
  if (["tsc", "esbuild", "swc", "node", "deno", "bun"].includes(executable)
    && args.some(arg => arg === "--watch" || arg.startsWith("--watch=") || (["tsc", "esbuild", "swc"].includes(executable) && arg === "-w"))) return "long-running";
  if ((["flask", "streamlit"].includes(executable) && args[0] === "run")
    || (executable === "jekyll" && args[0] === "serve") || (executable === "hugo" && args[0] === "server")
    || (executable === "rails" && ["s", "server"].includes(args[0])) || (executable === "php" && args.includes("-S"))
    || (/^python(?:\d+(?:\.\d+)?)?$/.test(executable) && args.some((arg, i) => arg === "-m" && args[i + 1] === "http.server"))
    || (executable === "tail" && args.some(arg => ["-f", "-F", "--follow"].includes(arg) || arg.startsWith("--follow=")))) return "long-running";
  if (executable === "read-host") return "interactive";
  if (executable !== "git") return;
  // Skip Git's global options with separate values, e.g. git -C repo commit.
  while (["-C", "-c", "--git-dir", "--work-tree"].includes(args[0])) args.splice(0, 2);
  const [subcommand, ...flags] = args;
  if (subcommand === "commit" && !flags.some(arg => /^-(?:[a-z]*m|[FC])/.test(arg)
    || /^(?:--message|--file|--reuse-message)(?:=|$)/.test(arg) || ["--no-edit", "--dry-run"].includes(arg))) return "interactive";
  if (subcommand === "rebase" && flags.some(arg => arg === "--interactive" || /^-[a-z]*i[a-z]*$/.test(arg))) return "interactive";
  if (["add", "checkout"].includes(subcommand) && flags.some(arg => arg === "--patch" || /^-[a-z]*p[a-z]*$/.test(arg)
    || (subcommand === "add" && (arg === "--edit" || /^-[a-z]*e[a-z]*$/.test(arg))))) return "interactive";
}

export type ShellGuardResult =
  | { kind: "run"; timeout?: number }
  | { kind: "reject"; category: "long-running" | "interactive"; message: string };

function excerpt(command: string): string {
  const single = command.trim().replace(/\s+/g, " ");
  return single.length > 120 ? `${single.slice(0, 117)}...` : single;
}

function rejectMessage(category: "long-running" | "interactive", command: string, matched: string): string {
  const shown = excerpt(command);
  return category === "long-running"
    ? `Piora blocked this shell command: "${shown}" looks like a long-running server or watch process (matched "${matched}") and would never return. Shell tool commands must terminate on their own. Options: (1) start it in the background and poll instead, e.g. \`npm run dev > dev.log 2>&1 &\` then read dev.log; (2) run it in the integrated terminal; (3) pass an explicit \`timeout\` in seconds if you deliberately want it killed after a bounded time.`
    : `Piora blocked this shell command: "${shown}" is interactive (matched "${matched}") and would wait for terminal input that never arrives. Use a non-interactive form (e.g. \`git commit -m "..."\`, \`git add -A\` instead of \`git add -p\`, \`git rebase\` without \`-i\`), or pass an explicit \`timeout\` in seconds to bound it.`;
}

/**
 * Decide how a shell tool call should run. Pure so it can be unit-tested
 * without spawning a shell.
 */
export function resolveShellGuard(
  input: { command?: unknown; timeout?: unknown },
  defaultTimeoutSeconds: number,
): ShellGuardResult {
  if (typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0) {
    return { kind: "run", timeout: input.timeout };
  }
  const command = typeof input.command === "string" ? input.command : "";
  for (const statement of simpleCommands(command)) {
    if (statement.background) continue;
    const category = classifyCommand(statement.words);
    if (category) return { kind: "reject", category, message: rejectMessage(category, command, statement.words[0]) };
  }
  return { kind: "run", timeout: defaultTimeoutSeconds };
}

export default function pioraShellGuard(api: ExtensionAPI): void {
  const defaultTimeoutSeconds = readShellTimeoutSeconds();
  api.on("tool_call", (event) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") return;
    const guard = resolveShellGuard(event.input, defaultTimeoutSeconds);
    if (guard.kind === "reject") return { block: true, reason: guard.message };
    event.input.timeout = guard.timeout;
  });
}
