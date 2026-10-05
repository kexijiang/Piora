import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildSlashCommandRegistry, filterGuiCommandInvocationCandidates, filterGuiCommands, filterSlashCommandRegistry, getGuiCommandInvocationPrefix, GUI_COMMANDS, parseGuiCommandInvocation } from "./commands.ts";

const t = (key) => key;
const actions = Object.fromEntries(GUI_COMMANDS.map((command) => [command.id, () => {}]));
const full = { hasProject: true, hasSession: true, isRunning: false, isGitRepository: true, actions };

test("registers at least 25 GUI commands across every specified group", () => {
  assert.ok(GUI_COMMANDS.length >= 25);
  assert.deepEqual(new Set(GUI_COMMANDS.map((command) => command.group)), new Set(["navigate", "session", "model", "panel", "settings", "git"]));
  assert.equal(new Set(GUI_COMMANDS.map((command) => command.id)).size, GUI_COMMANDS.length);
});

test("every command reports enabled state from project, task, busy, Git, and action context", () => {
  for (const command of GUI_COMMANDS) assert.equal(command.enabled(full), true, command.id);
  assert.notEqual(GUI_COMMANDS.find((command) => command.id === "navigate.newSession").enabled({ ...full, hasProject: false }), true);
  assert.notEqual(GUI_COMMANDS.find((command) => command.id === "session.export").enabled({ ...full, hasSession: false }), true);
  assert.notEqual(GUI_COMMANDS.find((command) => command.id === "panel.review").enabled({ ...full, isGitRepository: false }), true);
  assert.notEqual(GUI_COMMANDS.find((command) => command.id === "session.compact").enabled({ ...full, isRunning: true }), true);
  assert.notEqual(GUI_COMMANDS[0].enabled({ ...full, actions: {} }), true);
});

test("Ctrl+K and slash menus can share the Pi command registry with fuzzy search", () => {
  const pi = [{ name: "deploy", description: "Deploy project", source: "extension", sourceInfo: { path: "x", source: "demo", scope: "project", origin: "package" } }];
  const slash = buildSlashCommandRegistry(pi, false);
  assert.ok(slash.some((command) => command.name === "compact" && command.source === "builtin"));
  assert.ok(slash.some((command) => command.name === "deploy" && command.source === "extension"));
  assert.deepEqual(buildSlashCommandRegistry(pi, true).filter((command) => command.source === "builtin").map((command) => command.name), ["reload"]);
  assert.equal(filterSlashCommandRegistry(slash, "dpl", t)[0].name, "deploy");
  assert.equal(filterGuiCommands(GUI_COMMANDS, "opnrvw", (command) => command.title)[0].id, "panel.review");
  assert.equal(filterGuiCommandInvocationCandidates(GUI_COMMANDS, "com")[0].id, "git.commit");
  assert.equal(filterGuiCommandInvocationCandidates(GUI_COMMANDS, "ren")[0].id, "session.rename");
});

test("palette uses focus trap, recent persistence, disabled reasons, and shared registry", () => {
  const palette = fs.readFileSync(new URL("../components/CommandPalette.tsx", import.meta.url), "utf8");
  const hook = fs.readFileSync(new URL("../hooks/useCommands.ts", import.meta.url), "utf8");
  const input = fs.readFileSync(new URL("../components/ChatInput.tsx", import.meta.url), "utf8");
  assert.match(palette, /useFocusTrap/);
  assert.match(palette, /enabled\.reason/);
  assert.match(hook, /piora-recent-commands-v1/);
  assert.match(input, /buildSlashCommandRegistry/);
  assert.match(input, /filterSlashCommandRegistry/);
});

test("parameterized commands parse stable aliases and preserve free-form arguments", () => {
  const rename = GUI_COMMANDS.find((command) => command.id === "session.rename");
  const commit = GUI_COMMANDS.find((command) => command.id === "git.commit");
  assert.equal(getGuiCommandInvocationPrefix(rename), ">rename ");
  assert.equal(parseGuiCommandInvocation(">rename 新任务名称", GUI_COMMANDS).command, rename);
  assert.equal(parseGuiCommandInvocation(">rename 新任务名称", GUI_COMMANDS).argument, "新任务名称");
  assert.equal(parseGuiCommandInvocation(">提交 修复设置搜索", GUI_COMMANDS).command, commit);
  assert.equal(parseGuiCommandInvocation("commit fix", GUI_COMMANDS), null);
});

test("palette and real app actions pass arguments to rename and commit prefill", () => {
  const palette = fs.readFileSync(new URL("../components/CommandPalette.tsx", import.meta.url), "utf8");
  const shell = fs.readFileSync(new URL("../components/AppShell.tsx", import.meta.url), "utf8");
  const review = fs.readFileSync(new URL("../components/workspace/ReviewPanel.tsx", import.meta.url), "utf8");
  assert.match(palette, /event\.key === "Tab"/);
  assert.match(palette, /onRun\(item, argument \|\| undefined\)/);
  assert.match(shell, /"session\.rename": \(argument\)/);
  assert.match(shell, /piora:prefill-commit-message/);
  assert.match(review, /commitMessageRef/);
  assert.match(review, /piora:prefill-commit-message/);
});
