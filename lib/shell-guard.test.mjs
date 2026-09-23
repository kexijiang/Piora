import assert from "node:assert/strict";
import test from "node:test";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { discoverWindowsBash } from "./windows-bash.ts";
import {
  DEFAULT_SHELL_TIMEOUT_SECONDS,
  readShellTimeoutSeconds,
  resolveShellGuard,
} from "../extensions/piora-shell-guard.ts";
import registerPioraShellGuard from "../extensions/piora-shell-guard.ts";

test("readShellTimeoutSeconds honors env overrides with sane bounds", () => {
  assert.equal(readShellTimeoutSeconds({}), DEFAULT_SHELL_TIMEOUT_SECONDS);
  assert.equal(readShellTimeoutSeconds({ PIORA_SHELL_TIMEOUT_SECONDS: "120" }), 120);
  assert.equal(readShellTimeoutSeconds({ PIORA_SHELL_TIMEOUT_SECONDS: "0" }), DEFAULT_SHELL_TIMEOUT_SECONDS);
  assert.equal(readShellTimeoutSeconds({ PIORA_SHELL_TIMEOUT_SECONDS: "nope" }), DEFAULT_SHELL_TIMEOUT_SECONDS);
});

test("a default timeout is injected when the model omits one", () => {
  assert.deepEqual(resolveShellGuard({ command: "ls -la" }, 600), { kind: "run", timeout: 600 });
  assert.deepEqual(resolveShellGuard({ command: "npm run build" }, 300), { kind: "run", timeout: 300 });
  assert.deepEqual(resolveShellGuard({ command: "npm test" }, 300), { kind: "run", timeout: 300 });
});

test("an explicit timeout passes through untouched and bypasses rejection", () => {
  assert.deepEqual(resolveShellGuard({ command: "ls", timeout: 30 }, 600), { kind: "run", timeout: 30 });
  const server = resolveShellGuard({ command: "npm run dev", timeout: 15 }, 600);
  assert.equal(server.kind, "run");
  assert.equal(server.timeout, 15);
});

test("long-running server and watch commands are rejected with guidance", () => {
  for (const command of [
    "npm run dev",
    "pnpm dev",
    "yarn start",
    "next dev",
    "vite",
    "vite --host",
    "npx serve dist",
    "tsc --watch",
    "node --watch app.js",
    "python -m http.server 8080",
    "uvicorn app:app --reload",
    "tail -f dev.log",
  ]) {
    const result = resolveShellGuard({ command }, 600);
    assert.equal(result.kind, "reject", `expected rejection for: ${command}`);
    assert.equal(result.category, "long-running", command);
    assert.match(result.message, /background/);
  }
});

test("build and one-shot commands stay allowed", () => {
  for (const command of [
    "npm run build",
    "vite build",
    "npm run lint",
    "git status",
    "pytest -q",
    "deno test",
  ]) {
    const result = resolveShellGuard({ command }, 600);
    assert.equal(result.kind, "run", `expected approval for: ${command}`);
  }
});

test("commands that intentionally background their server are allowed", () => {
  for (const command of [
    "npm run dev > dev.log 2>&1 &",
    "nohup npm run dev > dev.log 2>&1 &",
    "Start-Process npm -ArgumentList 'run','dev'",
  ]) {
    const result = resolveShellGuard({ command }, 600);
    assert.equal(result.kind, "run", `expected approval for: ${command}`);
  }
});

function registerHandler() {
  let handler;
  registerPioraShellGuard({
    registerTool: () => assert.fail("must preserve configured SDK tools"),
    on: (event, callback) => { assert.equal(event, "tool_call"); handler = callback; },
  });
  return handler;
}

test("the extension patches shell arguments without replacing tools", () => {
  const handler = registerHandler();
  for (const toolName of ["bash", "powershell"]) {
    const input = { command: "echo test" };
    assert.equal(handler({ toolName, input }), undefined);
    assert.equal(input.timeout, 600);
    assert.equal(handler({ toolName, input: { command: "npm run dev" } }).block, true);
    assert.equal(handler({ toolName, input: { command: "git commit" } }).block, true);
  }
  const input = { command: "git commit" };
  handler({ toolName: "other-tool", input });
  assert.equal(input.timeout, undefined);
});

test("guarded bash still executes with the configured executable and command prefix", async (t) => {
  const shellPath = discoverWindowsBash();
  if (process.platform === "win32" && !shellPath) { t.skip("Git Bash is not installed"); return; }
  const tool = createBashTool(process.cwd(), { shellPath, commandPrefix: "export PIORA_SHELL_GUARD_TEST=configured" });
  const input = { command: 'printf "%s" "$PIORA_SHELL_GUARD_TEST"' };
  assert.equal(registerHandler()({ toolName: "bash", input }), undefined);
  const result = await tool.execute("guard-test", input);
  assert.equal(result.content[0].text, "configured");
});

test("harmless arguments, quoted text, help and script bodies do not become commands", () => {
  for (const command of [
    'rg "git commit" README.md', 'echo "npm run dev"', 'printf "%s" "Read-Host; git commit"',
    "vite --version", "npx vite --version", "vite --help", "uvicorn --version", "git commit --help",
    "git commit --dry-run", "node -e 'console.log(\"git commit\")'",
    "cat <<'EOF'\nnpm run dev\ngit commit\nEOF", 'Get-Content "git commit"',
  ]) assert.equal(resolveShellGuard({ command }, 600).kind, "run", command);
});

test("checks each real foreground command without mistaking quoted separators or redirection", () => {
  for (const command of [
    'cd "folder with spaces" && npm run dev', 'echo "safe; text"; git commit',
    "echo Start-Process; npm run dev", "npm run dev > dev.log 2>&1", "git -C repo commit", 'npm run "dev"',
    '"C:\\tools\\vite.cmd" --host',
  ]) assert.equal(resolveShellGuard({ command }, 600).kind, "reject", command);
  for (const command of ['npm run dev > dev.log 2>&1 &', 'npm run dev & echo ready', 'Start-Process npm -ArgumentList "run","dev"']) {
    assert.equal(resolveShellGuard({ command }, 600).kind, "run", command);
  }
});

test("interactive commands are rejected while non-interactive forms pass", () => {
  for (const command of ["git commit", "git commit --amend", "git rebase -i HEAD~3", "git add -p", "git checkout -p", "Read-Host"]) {
    const result = resolveShellGuard({ command }, 600);
    assert.equal(result.kind, "reject", `expected rejection for: ${command}`);
    assert.equal(result.category, "interactive", command);
    assert.match(result.message, /interactive/);
  }
  for (const command of [
    'git commit -m "fix"',
    'git commit -am "fix"',
    "git commit --amend --no-edit",
    "git commit -F message.txt",
    "git add -A",
    "git add --help",
    "git rebase main",
  ]) {
    const result = resolveShellGuard({ command }, 600);
    assert.equal(result.kind, "run", `expected approval for: ${command}`);
  }
});
