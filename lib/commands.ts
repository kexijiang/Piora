import { filterFileEntries } from "./file-fuzzy.ts";

export type CommandGroup = "navigate" | "session" | "model" | "panel" | "settings" | "git";

export interface CommandContext {
  hasProject: boolean;
  hasSession: boolean;
  isRunning: boolean;
  isGitRepository: boolean;
  actions: Partial<Record<string, (argument?: string) => void | Promise<void>>>;
}

export interface CommandArgument {
  alias: string;
  placeholder: string;
  required?: boolean;
  aliases?: string[];
}

export interface Command {
  id: string;
  group: CommandGroup;
  title: string;
  keywords?: string[];
  shortcut?: string;
  source?: string;
  argument?: CommandArgument;
  enabled: (ctx: CommandContext) => true | { reason: string };
  run: (ctx: CommandContext, argument?: string) => void | Promise<void>;
}

export interface PiSlashCommand {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: { path: string; source: string; scope: "user" | "project" | "temporary"; origin: "package" | "top-level"; baseDir?: string };
}

export type SlashCommandPaletteItem = PiSlashCommand | { name: string; description: string; source: "builtin" };
export type SlashCommandSource = SlashCommandPaletteItem["source"];

export const BUILTIN_SLASH_COMMANDS: SlashCommandPaletteItem[] = [
  { name: "compact", description: "chat.commandCompact", source: "builtin" },
  { name: "reload", description: "chat.commandReload", source: "builtin" },
  { name: "name", description: "chat.commandName", source: "builtin" },
  { name: "session", description: "chat.commandSession", source: "builtin" },
  { name: "copy", description: "chat.commandCopy", source: "builtin" },
];

const command = (id: string, group: CommandGroup, title: string, options: { keywords?: string[]; shortcut?: string; needs?: "project" | "session" | "git"; whenIdle?: boolean; argument?: CommandArgument } = {}): Command => ({
  id, group, title, keywords: options.keywords, shortcut: options.shortcut, argument: options.argument,
  enabled: (ctx) => {
    if (!ctx.actions[id]) return { reason: "commands.unavailable" };
    if (options.needs === "project" && !ctx.hasProject) return { reason: "commands.needsProject" };
    if (options.needs === "session" && !ctx.hasSession) return { reason: "commands.needsSession" };
    if (options.whenIdle && ctx.isRunning) return { reason: "commands.busy" };
    if (options.needs === "git" && !ctx.isGitRepository) return { reason: "commands.needsGit" };
    return true;
  },
  run: async (ctx, argument) => { await ctx.actions[id]?.(argument); },
});

export const GUI_COMMANDS: Command[] = [
  command("navigate.newSession", "navigate", "commands.newSession", { needs: "project" }),
  command("navigate.chooseProject", "navigate", "commands.chooseProject"),
  command("navigate.searchFiles", "navigate", "commands.searchFiles", { needs: "project" }),
  command("navigate.searchChats", "navigate", "commands.searchChats"),
  command("navigate.focusComposer", "navigate", "commands.focusComposer", { needs: "project" }),
  command("navigate.history", "navigate", "commands.history", { needs: "session" }),
  command("session.rename", "session", "commands.rename", { needs: "session", whenIdle: true, argument: { alias: "rename", aliases: ["name", "重命名"], placeholder: "commands.argument.taskName", required: true } }),
  command("session.duplicate", "session", "commands.duplicate", { needs: "session", whenIdle: true }),
  command("session.archive", "session", "commands.archive", { needs: "session", whenIdle: true }),
  command("session.pin", "session", "commands.pin", { needs: "session", whenIdle: true }),
  command("session.export", "session", "commands.export", { needs: "session" }),
  command("session.compact", "session", "commands.compact", { needs: "session", whenIdle: true }),
  command("session.stop", "session", "commands.stop", { shortcut: "Esc", needs: "session" }),
  command("session.stats", "session", "commands.stats", { needs: "session" }),
  command("model.select", "model", "commands.selectModel", { needs: "project", whenIdle: true }),
  command("model.thinking", "model", "commands.thinking", { needs: "project" }),
  command("panel.review", "panel", "commands.openReview", { needs: "git" }),
  command("panel.files", "panel", "commands.openFiles", { needs: "project" }),
  command("panel.commands", "panel", "commands.openCommands", { needs: "session" }),
  command("panel.browser", "panel", "commands.openBrowser"),
  command("panel.design", "panel", "commands.openDesign", { needs: "project" }),
  command("composer.voiceInput", "navigate", "commands.voiceInput", { needs: "project" }),
  command("companion.togglePanel", "panel", "commands.openCompanionPanel"),
  command("capture.screenshot", "panel", "commands.screenshot"),
  command("panel.toggleSidebar", "panel", "commands.toggleSidebar"),
  command("panel.close", "panel", "commands.closePanel"),
  command("settings.general", "settings", "commands.settings"),
  command("git.stageAll", "git", "commands.stageAll", { needs: "git" }),
  command("git.unstageAll", "git", "commands.unstageAll", { needs: "git" }),
  command("git.commit", "git", "commands.commit", { needs: "git", argument: { alias: "commit", aliases: ["提交"], placeholder: "commands.argument.commitMessage" } }),
  command("git.refresh", "git", "commands.refreshGit", { needs: "git" }),
];

export function buildSlashCommandRegistry(commands: PiSlashCommand[], busy: boolean): SlashCommandPaletteItem[] {
  return [...(busy ? [] : BUILTIN_SLASH_COMMANDS), ...commands];
}

export function getSlashCommandDescription(command: SlashCommandPaletteItem, t: (key: string) => string): string {
  return command.source === "builtin" ? t(command.description) : command.description ?? "";
}

export function filterSlashCommandRegistry(commands: SlashCommandPaletteItem[], query: string, t: (key: string) => string): SlashCommandPaletteItem[] {
  const indexed = commands.map((item, index) => ({ path: `${item.name} ${getSlashCommandDescription(item, t)}`, isDir: false, index }));
  const matches = filterFileEntries(indexed, query, commands.length);
  return matches.map((match) => commands[(match as typeof indexed[number]).index]);
}

export function filterGuiCommands(commands: Command[], query: string, title: (command: Command) => string): Command[] {
  if (!query.trim()) return commands;
  const indexed = commands.map((item, index) => ({ path: `${title(item)} ${(item.keywords ?? []).join(" ")}`, isDir: false, index }));
  return filterFileEntries(indexed, query, commands.length).map((match) => commands[(match as typeof indexed[number]).index]);
}

export interface GuiCommandInvocation {
  token: string;
  argument: string;
  command: Command | null;
}

function commandAliases(command: Command): string[] {
  const fallback = command.id.split(".").pop() ?? command.id;
  return command.argument
    ? [command.argument.alias, ...(command.argument.aliases ?? []), fallback]
    : [fallback];
}

export function filterGuiCommandInvocationCandidates(commands: Command[], token: string): Command[] {
  const normalized = token.trim().toLocaleLowerCase();
  return commands.filter((item) => item.argument && (!normalized || commandAliases(item).some((alias) => alias.toLocaleLowerCase().startsWith(normalized))));
}

export function getGuiCommandInvocationPrefix(command: Command): string {
  return `>${command.argument?.alias ?? command.id.split(".").pop() ?? command.id} `;
}

export function parseGuiCommandInvocation(query: string, commands: Command[]): GuiCommandInvocation | null {
  const trimmedStart = query.trimStart();
  if (!trimmedStart.startsWith(">")) return null;
  const body = trimmedStart.slice(1);
  const separator = body.search(/\s/);
  const token = (separator === -1 ? body : body.slice(0, separator)).toLocaleLowerCase();
  const argument = separator === -1 ? "" : body.slice(separator).trimStart();
  const command = token
    ? commands.find((item) => commandAliases(item).some((alias) => alias.toLocaleLowerCase() === token)) ?? null
    : null;
  return { token, argument, command };
}
