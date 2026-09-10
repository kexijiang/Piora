import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": path.resolve(import.meta.dirname, "..") } });
const { ShellStore } = await jiti.import("./shell/store.ts");
const { shellCompletions } = await jiti.import("./shell/completions.ts");
const { completionWord, quoteShellPath } = await jiti.import("./shell/completion-word.ts");
const { listPathCommands } = await jiti.import("./shell/profiles.ts");
const { classifyShellInput } = await jiti.import("./shell/intent.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");
test("completion decodes the final word and quotes shell metacharacters literally", () => {
  assert.deepEqual(completionWord("Get-Content 'folder with spaces/na", "powershell"), { prefix: "Get-Content ", value: "folder with spaces/na", commandPosition: false });
  assert.equal(completionWord("cat folder\\ with\\ spaces/na", "bash").value, "folder with spaces/na");
  assert.equal(completionWord("Get-Content 'one''s/na", "powershell").value, "one's/na");
  assert.equal(completionWord("echo ok | myfunc", "bash").commandPosition, true);
  assert.equal(quoteShellPath("one's/$name.txt", "powershell"), "'one''s/$name.txt'");
  assert.equal(quoteShellPath("one's/$name.txt", "bash"), "'one'\\''s/$name.txt'");
  assert.equal(classifyShellInput("find the command I used yesterday", ["find"]), "agent");
  assert.equal(classifyShellInput("help Get-ChildItem", ["help"]), "command");
  assert.equal(classifyShellInput("请列出文件", [], "command"), "command", "explicit modes always win");
});
test("path, live-command and project-script suggestions are grounded and safely reusable", { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "piora-shell-complete-"));
  const store = new ShellStore(root, false); globalThis.__pioraShellStore = store; allowFileRoot(root);
  try {
    await mkdir(path.join(root, "folder with spaces")); await writeFile(path.join(root, "folder with spaces", "name $literal.txt"), "test");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite", deploy: "example-publish" } }));
    const terminal = kind => ({ state: { id: "fixture", cwd: root, profile: { kind } }, commandNames: () => ["piora_demo_alias"] });
    for (const kind of ["powershell", "bash"]) {
      const result = await shellCompletions(terminal(kind), "cat 'folder with spaces/na");
      const suggestion = result.completions.find(item => item.kind === "file");
      assert.equal(suggestion.value, "cat 'folder with spaces/name $literal.txt'");
      const enteredDirectory = await shellCompletions(terminal(kind), "cat 'folder with spaces/'");
      assert.ok(enteredDirectory.completions.some(item => item.label === "name $literal.txt"), "a trailing separator lists inside the directory");
    }
    const commands = await shellCompletions(terminal("powershell"), "piora_demo");
    assert.ok(commands.completions.some(item => item.value === "piora_demo_alias"));
    assert.equal((await shellCompletions(terminal("powershell"), "piora_demo_alias")).intent, "command");
    const scripts = await shellCompletions(terminal("bash"), "npm run d");
    assert.deepEqual(scripts.completions.filter(item => item.kind === "script").map(item => item.value).sort(), ["npm run deploy", "npm run dev"]);
    await writeFile(path.join(root, "ignored.txt"), "not an executable");
    const executable = process.platform === "win32" ? "command.cmd" : "command";
    await writeFile(path.join(root, executable), "test"); await chmod(path.join(root, executable), 0o755);
    assert.deepEqual(await listPathCommands(root), [executable], "PATH inventory excludes ordinary files");
  } finally {
    await store.close(); delete globalThis.__pioraShellStore;
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(root).startsWith("piora-shell-complete-"));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
