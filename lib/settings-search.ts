import { filterFileEntries } from "./file-fuzzy.ts";

export type SettingsKey = "general" | "conversation" | "shortcuts" | "speech" | "automations" | "models" | "tools" | "capabilityBundles" | "extensions" | "skills" | "plugins" | "harmony" | "appearance" | "language" | "companion" | "remote" | "usage" | "archived";

export interface SettingsSearchItem {
  id: string;
  section: SettingsKey;
  labelKey: string;
  descriptionKey?: string;
  keywords?: string[];
  requiresProject?: boolean;
}

export const SETTINGS_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  { id: "general", section: "general", labelKey: "settings.general", descriptionKey: "settings.generalDescription", keywords: ["preferences", "偏好"] },
  { id: "general.portability", section: "general", labelKey: "settings.portability.title", descriptionKey: "settings.portability.description", keywords: ["import", "export", "backup", "导入", "导出", "迁移"] },
  { id: "general.onboarding", section: "general", labelKey: "settings.firstRunGuideTitle", descriptionKey: "settings.firstRunGuideDescription", keywords: ["welcome", "guide", "新手", "引导"] },
  { id: "general.proxy", section: "general", labelKey: "networkProxy.title", descriptionKey: "networkProxy.description", keywords: ["http", "https", "network", "代理", "网络"] },
  { id: "general.autoLaunch", section: "general", labelKey: "settings.autoLaunch", descriptionKey: "settings.autoLaunchDescription", keywords: ["startup", "boot", "login", "开机", "启动"] },
  { id: "general.globalShortcut", section: "general", labelKey: "settings.globalShortcut", descriptionKey: "settings.globalShortcutDescription", keywords: ["hotkey", "keyboard", "快捷键"] },

  { id: "conversation", section: "conversation", labelKey: "settings.conversation", descriptionKey: "settings.conversationDescription", keywords: ["chat", "session", "聊天", "会话"] },
  { id: "conversation.sendShortcut", section: "conversation", labelKey: "settings.sendShortcut", descriptionKey: "settings.sendShortcutDescription", keywords: ["enter", "ctrl enter", "发送", "换行"] },
  { id: "conversation.streamingSend", section: "conversation", labelKey: "settings.streamingSendDefault", descriptionKey: "settings.streamingSendDefaultDescription", keywords: ["queue", "steer", "排队", "引导"] },
  { id: "conversation.autoScroll", section: "conversation", labelKey: "settings.liveOutputAutoScroll", descriptionKey: "settings.liveOutputAutoScrollDescription", keywords: ["scroll", "follow", "滚动", "跟随"] },
  { id: "conversation.notifications", section: "conversation", labelKey: "taskControls.notifications", descriptionKey: "taskControls.notificationsDescription", keywords: ["notify", "notification", "通知", "完成"] },
  { id: "conversation.promptOptimizer", section: "conversation", labelKey: "settings.promptOptimizerTitle", descriptionKey: "settings.promptOptimizerDescription", keywords: ["prompt", "rewrite", "提示词", "优化"] },
  { id: "conversation.titleModel", section: "conversation", labelKey: "settings.sessionTitleModelTitle", descriptionKey: "settings.sessionTitleModelDescription", keywords: ["title", "model", "标题", "模型"] },
  { id: "conversation.systemPrompt", section: "conversation", labelKey: "system.prompt", descriptionKey: "system.description", keywords: ["system prompt", "instruction", "系统提示词", "指令"] },

  { id: "shortcuts", section: "shortcuts", labelKey: "settings.shortcuts", descriptionKey: "settings.shortcutsDescription", keywords: ["keyboard", "hotkey", "键盘", "快捷键"] },
  { id: "shortcuts.palette", section: "shortcuts", labelKey: "shortcuts.commandPalette", descriptionKey: "shortcuts.commandPaletteDescription", keywords: ["ctrl k", "command", "命令面板"] },
  { id: "shortcuts.search", section: "shortcuts", labelKey: "commands.searchChats", descriptionKey: "shortcuts.searchChatsDescription", keywords: ["find", "search", "搜索", "聊天记录"] },

  { id: "speech", section: "speech", labelKey: "speech.title", descriptionKey: "speech.description", keywords: ["voice", "dictation", "speech", "语音", "识别"] },
  { id: "speech.toggle", section: "speech", labelKey: "speech.toggle", descriptionKey: "speech.toggleDescription", keywords: ["enable", "microphone", "开启", "麦克风"] },
  { id: "speech.pack", section: "speech", labelKey: "speech.packTitle", descriptionKey: "speech.packDescription", keywords: ["onnx", "model", "download", "模型", "下载"] },
  { id: "speech.manual", section: "speech", labelKey: "speech.manualTitle", descriptionKey: "speech.manualDescription", keywords: ["onnx", "drag", "offline", "手动", "拖入", "导入"] },
  { id: "speech.location", section: "speech", labelKey: "speech.locationTitle", descriptionKey: "speech.locationDescription", keywords: ["folder", "storage", "路径", "文件夹"] },

  { id: "automations", section: "automations", labelKey: "automations.title", descriptionKey: "automations.description", keywords: ["schedule", "cron", "rrule", "定时", "计划"] },
  { id: "automations.new", section: "automations", labelKey: "automations.new", descriptionKey: "automations.description", keywords: ["create", "repeat", "新建", "重复"] },
  { id: "automations.notifications", section: "automations", labelKey: "automations.notifications", descriptionKey: "automations.description", keywords: ["notify", "failed", "通知", "失败"] },

  { id: "models", section: "models", labelKey: "common.models", descriptionKey: "settings.modelsDescription", keywords: ["provider", "api key", "oauth", "模型", "登录", "密钥"] },
  { id: "tools", section: "tools", labelKey: "projectTools.title", descriptionKey: "projectTools.description", keywords: ["tools", "project", "harmony", "工具", "项目", "鸿蒙"], requiresProject: true },
  { id: "capabilityBundles", section: "capabilityBundles", labelKey: "capabilityBundles.title", descriptionKey: "capabilityBundles.description", keywords: ["tools", "profile", "能力包", "工具"], requiresProject: true },
  { id: "extensions", section: "extensions", labelKey: "settings.extensions", descriptionKey: "settings.manageExtensionsDescription", keywords: ["extension", "tools", "扩展", "工具"], requiresProject: true },
  { id: "skills", section: "skills", labelKey: "common.skills", descriptionKey: "settings.skillsDescription", keywords: ["skill", "instruction", "技能", "说明"], requiresProject: true },
  { id: "plugins", section: "plugins", labelKey: "common.plugins", descriptionKey: "settings.pluginsDescription", keywords: ["plugin", "package", "marketplace", "插件", "包"], requiresProject: true },

  { id: "appearance", section: "appearance", labelKey: "appearance.title", descriptionKey: "appearance.description", keywords: ["ui", "style", "界面", "外观"] },
  { id: "appearance.theme", section: "appearance", labelKey: "appearance.theme", descriptionKey: "appearance.themeHint", keywords: ["light", "dark", "亮色", "深色", "主题"] },
  { id: "appearance.looks", section: "appearance", labelKey: "appearance.looks", descriptionKey: "appearance.looksHint", keywords: ["style", "preset", "风格", "配色"] },
  { id: "appearance.font", section: "appearance", labelKey: "appearance.font.title", descriptionKey: "appearance.font.hint", keywords: ["size", "family", "weight", "bold", "字体", "字号", "粗细", "加粗"] },
  { id: "appearance.background", section: "appearance", labelKey: "background.title", descriptionKey: "settings.appearanceDescription", keywords: ["wallpaper", "image", "背景", "图片"] },
  { id: "language", section: "language", labelKey: "common.language", descriptionKey: "settings.languageDescription", keywords: ["locale", "english", "chinese", "语言", "中文", "英文"] },

  { id: "companion", section: "companion", labelKey: "companion.settingsTitle", descriptionKey: "companion.settingsDescription", keywords: ["pet", "desktop pet", "宠物", "桌宠"] },
  { id: "companion.show", section: "companion", labelKey: "companion.showCompanion", descriptionKey: "companion.showCompanionDescription", keywords: ["show", "hide", "显示", "隐藏"] },
  { id: "companion.alwaysOnTop", section: "companion", labelKey: "companion.alwaysOnTop", descriptionKey: "companion.alwaysOnTopDescription", keywords: ["topmost", "置顶"] },
  { id: "companion.appearance", section: "companion", labelKey: "companion.petAppearance", descriptionKey: "companion.petAppearanceDescription", keywords: ["sprite", "avatar", "精灵图", "外观"] },
  { id: "companion.desktop", section: "companion", labelKey: "companion.desktopMode", descriptionKey: "companion.desktopModeDescription", keywords: ["window", "transparent", "独立窗口", "桌面"] },
  { id: "companion.idle", section: "companion", labelKey: "companion.idleTricks", descriptionKey: "companion.idleTricksDescription", keywords: ["hover", "idle", "悬浮", "挂机", "闲聊"] },
  { id: "companion.model", section: "companion", labelKey: "companion.model.title", descriptionKey: "companion.model.description", keywords: ["interaction", "model", "互动", "模型"] },

  { id: "remote", section: "remote", labelKey: "remote.title", descriptionKey: "remote.description", keywords: ["http", "sse", "token", "远程", "令牌"] },
  { id: "harmony", section: "harmony", labelKey: "harmonyStorage.title", descriptionKey: "harmonyStorage.description", keywords: ["openharmony", "screenshot", "recording", "鸿蒙", "截图", "录屏"] },
  { id: "harmony.screenshots", section: "harmony", labelKey: "harmonyStorage.screenshotDirectory", descriptionKey: "harmonyStorage.screenshotDescription", keywords: ["png", "folder", "截图", "文件夹"] },
  { id: "harmony.recordings", section: "harmony", labelKey: "harmonyStorage.recordingDirectory", descriptionKey: "harmonyStorage.recordingDescription", keywords: ["mp4", "folder", "录屏", "文件夹"] },
  { id: "usage", section: "usage", labelKey: "usage.title", descriptionKey: "usage.description", keywords: ["token", "statistics", "usage", "用量", "统计"] },
  { id: "archived", section: "archived", labelKey: "archive.title", descriptionKey: "archive.description", keywords: ["history", "restore", "archive", "归档", "恢复"] },
];

export function filterSettingsSearchItems(
  query: string,
  translate: (key: string) => string,
  options: { hasProject?: boolean; limit?: number } = {},
): SettingsSearchItem[] {
  const available = SETTINGS_SEARCH_ITEMS.filter((item) => !item.requiresProject || options.hasProject);
  const normalized = query.trim();
  if (!normalized) return available.filter((item) => item.id === item.section).slice(0, options.limit ?? 6);
  const indexed = available.map((item, index) => ({
    path: [translate(item.labelKey), item.descriptionKey ? translate(item.descriptionKey) : "", ...(item.keywords ?? [])].join(" "),
    isDir: false,
    index,
  }));
  return filterFileEntries(indexed, normalized, options.limit ?? 12)
    .map((match) => available[(match as typeof indexed[number]).index]);
}
