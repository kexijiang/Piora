/** Bundled artwork identities; no provider, prompt or agent settings are changed. */
export const CHARACTER_THEME_GROUPS = [
  {
    "id": "whale",
    "zh": "鲸鱼娘",
    "en": "DeepSeek"
  },
  {
    "id": "gpt",
    "zh": "GPT 娘",
    "en": "GPT"
  },
  {
    "id": "claude",
    "zh": "Claude 娘",
    "en": "Claude"
  },
  {
    "id": "kitty",
    "zh": "Kitty 娘",
    "en": "Kitty"
  },
  {
    "id": "glm",
    "zh": "GLM 娘",
    "en": "GLM"
  },
  {
    "id": "ernie",
    "zh": "文心娘",
    "en": "ERNIE"
  },
  {
    "id": "qwen",
    "zh": "Qwen 娘",
    "en": "Qwen"
  },
  {
    "id": "kimi",
    "zh": "Kimi 娘",
    "en": "Kimi"
  },
  {
    "id": "seed",
    "zh": "豆包娘",
    "en": "Doubao"
  },
  {
    "id": "minimax",
    "zh": "MiniMax 娘",
    "en": "MiniMax"
  },
  {
    "id": "grok",
    "zh": "Grok 娘",
    "en": "Grok"
  },
  {
    "id": "gemini",
    "zh": "Gemini 娘",
    "en": "Gemini"
  }
] as const;

export const CHARACTER_THEMES = [
  {
    "id": "character-glm-ink",
    "group": "glm",
    "nameZh": "GLM 娘 · 墨夜狐语",
    "nameEn": "GLM · Ink Fox",
    "isDark": true,
    "asset": "/themes/character-backgrounds/glm-ink.webp",
    "colors": {
      "bg": "#171D29",
      "panel": "#232D3B",
      "accent": "#92B0D8",
      "text": "#ECF1FA"
    },
    "overlay": 62,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-gpt-ivory",
    "group": "gpt",
    "nameZh": "GPT 娘 · 白龙云庭",
    "nameEn": "GPT · Ivory Dragon",
    "isDark": false,
    "asset": "/themes/character-backgrounds/gpt-ivory.webp",
    "colors": {
      "bg": "#F5F3FC",
      "panel": "#FFFFFF",
      "accent": "#716995",
      "text": "#37344C"
    },
    "overlay": 64,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-whale-tide",
    "group": "whale",
    "nameZh": "鲸鱼娘 · 晴汐",
    "nameEn": "DeepSeek · Morning Tide",
    "isDark": false,
    "asset": "/themes/character-backgrounds/whale-tide.webp",
    "colors": {
      "bg": "#F1FAFF",
      "panel": "#FFFFFF",
      "accent": "#2b71ad",
      "text": "#243C55"
    },
    "overlay": 64,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-ernie-garden",
    "group": "ernie",
    "nameZh": "文心娘 · 晴窗花园",
    "nameEn": "ERNIE · Sunlit Garden",
    "isDark": false,
    "asset": "/themes/character-backgrounds/ernie-garden.webp",
    "colors": {
      "bg": "#F1F6FF",
      "panel": "#FFFFFF",
      "accent": "#4f69b9",
      "text": "#35435F"
    },
    "overlay": 64,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-qwen-porcelain",
    "group": "qwen",
    "nameZh": "Qwen 娘 · 青瓷问雅",
    "nameEn": "Qwen · Porcelain Pavilion",
    "isDark": false,
    "asset": "/themes/character-backgrounds/qwen-porcelain.webp",
    "colors": {
      "bg": "#F3F2FB",
      "panel": "#FFFDFC",
      "accent": "#6b68a8",
      "text": "#42405B"
    },
    "overlay": 64,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-kimi-moon",
    "group": "kimi",
    "nameZh": "Kimi 娘 · 月下笛语",
    "nameEn": "Kimi · Moonlit Flute",
    "isDark": true,
    "asset": "/themes/character-backgrounds/kimi-moon.webp",
    "colors": {
      "bg": "#13192F",
      "panel": "#202B44",
      "accent": "#AFBDEB",
      "text": "#EBEFFF"
    },
    "overlay": 62,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-seed-scarf",
    "group": "seed",
    "nameZh": "豆包娘 · 红围巾发呆",
    "nameEn": "Doubao · Red Scarf Daydream",
    "isDark": false,
    "asset": "/themes/character-backgrounds/seed-scarf.webp",
    "colors": {
      "bg": "#F1F6FA",
      "panel": "#FFFFFF",
      "accent": "#AA3541",
      "text": "#303C49"
    },
    "overlay": 64,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-seed-soda",
    "group": "seed",
    "nameZh": "豆包娘 · 紫苏气泡",
    "nameEn": "Doubao · Violet Soda",
    "isDark": false,
    "asset": "/themes/character-backgrounds/seed-soda.webp",
    "colors": {
      "bg": "#F2F3FF",
      "panel": "#FFFFFF",
      "accent": "#6f62b9",
      "text": "#3D3E60"
    },
    "overlay": 64,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-minimax-coral",
    "group": "minimax",
    "nameZh": "MiniMax 娘 · 珊瑚电台",
    "nameEn": "MiniMax · Coral Radio",
    "isDark": false,
    "asset": "/themes/character-backgrounds/minimax-coral.webp",
    "colors": {
      "bg": "#FFF4ED",
      "panel": "#FFFCF8",
      "accent": "#9b5f56",
      "text": "#59423D"
    },
    "overlay": 64,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-grok-eclipse",
    "group": "grok",
    "nameZh": "Grok 娘 · 黑金月蚀",
    "nameEn": "Grok · Golden Eclipse",
    "isDark": true,
    "asset": "/themes/character-backgrounds/grok-eclipse.webp",
    "colors": {
      "bg": "#1B1820",
      "panel": "#2A232D",
      "accent": "#D2AC70",
      "text": "#F4EADD"
    },
    "overlay": 62,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-gemini-prism",
    "group": "gemini",
    "nameZh": "Gemini 娘 · 星棱幻彩",
    "nameEn": "Gemini · Star Prism",
    "isDark": true,
    "asset": "/themes/character-backgrounds/gemini-prism.webp",
    "colors": {
      "bg": "#1B1B39",
      "panel": "#2A2C50",
      "accent": "#B7A3F4",
      "text": "#F0EDFF"
    },
    "overlay": 62,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-claude-paper",
    "group": "claude",
    "nameZh": "Claude 娘 · 杏纸书房",
    "nameEn": "Claude · Paper Study",
    "isDark": false,
    "asset": "/themes/character-backgrounds/claude-paper.webp",
    "colors": {
      "bg": "#FAF4E9",
      "panel": "#FFFCF6",
      "accent": "#9a5f47",
      "text": "#443930"
    },
    "overlay": 64,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-gpt-orbit",
    "group": "gpt",
    "nameZh": "GPT 娘 · 星环龙庭",
    "nameEn": "GPT · Dragon Observatory",
    "isDark": true,
    "asset": "/themes/character-backgrounds/gpt-orbit.webp",
    "colors": {
      "bg": "#171C2D",
      "panel": "#242D43",
      "accent": "#A9BCEB",
      "text": "#EBF1FF"
    },
    "overlay": 62,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-gpt-cloud",
    "group": "gpt",
    "nameZh": "GPT 娘 · 云端灵感",
    "nameEn": "GPT · Cloud Inspiration",
    "isDark": false,
    "asset": "/themes/character-backgrounds/gpt-cloud.webp",
    "colors": {
      "bg": "#F1F7F5",
      "panel": "#FFFFFF",
      "accent": "#52756e",
      "text": "#344B48"
    },
    "overlay": 64,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-whale-abyss",
    "group": "whale",
    "nameZh": "鲸鱼娘 · 深海夜航",
    "nameEn": "DeepSeek · Ocean Night",
    "isDark": true,
    "asset": "/themes/character-backgrounds/whale-abyss.webp",
    "colors": {
      "bg": "#091A2C",
      "panel": "#10273D",
      "accent": "#56CDE0",
      "text": "#E3F4FF"
    },
    "overlay": 62,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-whale-rice",
    "group": "whale",
    "nameZh": "鲸鱼娘 · 摸鱼饭点",
    "nameEn": "DeepSeek · Rice Break",
    "isDark": false,
    "asset": "/themes/character-backgrounds/whale-rice.webp",
    "colors": {
      "bg": "#FFF8ED",
      "panel": "#FFFCF6",
      "accent": "#4675a4",
      "text": "#4C4951"
    },
    "overlay": 64,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-claude-lamp",
    "group": "claude",
    "nameZh": "Claude 娘 · 琥珀夜读",
    "nameEn": "Claude · Amber Reading",
    "isDark": true,
    "asset": "/themes/character-backgrounds/claude-lamp.webp",
    "colors": {
      "bg": "#231D1B",
      "panel": "#302722",
      "accent": "#D89A6D",
      "text": "#F4E7D6"
    },
    "overlay": 62,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-claude-autumn",
    "group": "claude",
    "nameZh": "Claude 娘 · 秋日手记",
    "nameEn": "Claude · Autumn Journal",
    "isDark": false,
    "asset": "/themes/character-backgrounds/claude-autumn.webp",
    "colors": {
      "bg": "#F7F3EA",
      "panel": "#FFFDF7",
      "accent": "#856443",
      "text": "#464339"
    },
    "overlay": 64,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-kitty-ribbon",
    "group": "kitty",
    "nameZh": "Kitty 娘 · 红结奶油",
    "nameEn": "Kitty · Cream Ribbon",
    "isDark": false,
    "asset": "/themes/character-backgrounds/kitty-ribbon.webp",
    "colors": {
      "bg": "#FFF8F3",
      "panel": "#FFFFFF",
      "accent": "#bb4a58",
      "text": "#553C42"
    },
    "overlay": 64,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-kitty-strawberry",
    "group": "kitty",
    "nameZh": "Kitty 娘 · 草莓午茶",
    "nameEn": "Kitty · Strawberry Tea",
    "isDark": false,
    "asset": "/themes/character-backgrounds/kitty-strawberry.webp",
    "colors": {
      "bg": "#FFF2F5",
      "panel": "#FFFBFC",
      "accent": "#a85770",
      "text": "#633E50"
    },
    "overlay": 64,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  },
  {
    "id": "character-kitty-moon",
    "group": "kitty",
    "nameZh": "Kitty 娘 · 月光晚安",
    "nameEn": "Kitty · Goodnight Moon",
    "isDark": true,
    "asset": "/themes/character-backgrounds/kitty-moon.webp",
    "colors": {
      "bg": "#211C35",
      "panel": "#302943",
      "accent": "#CE9FC7",
      "text": "#F7ECFA"
    },
    "overlay": 62,
    "sidebarOverlay": 36,
    "filePanelOverlay": 42,
    "blur": 0
  }
] as const;

export type CharacterThemeId = (typeof CHARACTER_THEMES)[number]["id"];
export type CharacterThemeGroup = (typeof CHARACTER_THEME_GROUPS)[number]["id"];
