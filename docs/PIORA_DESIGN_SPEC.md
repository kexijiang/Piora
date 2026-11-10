# Piora 桌面端产品设计规格（Design Spec）

> 版本：v1.0
> 基线代码：`b8d7e69`（branch `codex/release-v0.1.0`）
> 编写日期：2026-08-07
> 目标读者：产品决策者 + 实施 Agent（GPT / Codex / Claude）
> 配套文档：`docs/PIORA_GPT_DEV_GUIDE.md`（可执行任务包）

---

## 0. 产品定位

### 0.1 一句话

Piora = **Pi Agent（本地 coding agent 内核） + pi-web（Next.js 工作台） + Electron 外壳**，做成一个体验对齐 OpenAI Codex 桌面端、但内核完全本地可控、并带有人格化差异点（桌宠 / 外观）的开发者工作台。

### 0.2 三条产品原则（用于所有取舍）

| 原则 | 含义 | 反例 |
|---|---|---|
| **P1 任务为中心，不是资源为中心** | 用户心智单位是"一个任务跑得怎么样"，不是"哪个 jsonl 文件" | 左栏当成文件树 + 会话树的混合体 |
| **P2 交付闭环高于对话完整** | Agent 写了代码，用户必须能在同一个窗口审阅、接受、提交 | 只能只读看 diff，改动要回 VS Code |
| **P3 只暴露真实存在的能力** | 没接通的功能不放按钮 | 放一个点了没反应的 "Pull Requests" |

### 0.3 与 Codex 的关系

**要对齐的**：信息架构、任务状态语言、审阅闭环、命令面板、终端、权限分级、键盘路径。
**不追的**：云端任务队列、GitHub 深度集成、多人协作、Codex 专有模型路由。
**要超过的**：本地模型/多 Provider 自由度、Skills/Plugins 生态、中文一等公民、人格化陪伴。

---

## 1. 现状盘点（Ground Truth）

### 1.1 技术栈与规模

| 层 | 技术 | 规模 |
|---|---|---|
| Agent 内核 | `@earendil-works/pi-agent-core` / `pi-ai` / `pi-coding-agent` / `pi-tui` @ 0.83.0 | 外部依赖 |
| Web 层 | Next.js 16.2.12 (App Router) + React 19.2 | 44 个 API route |
| 前端组件 | `components/` 30 个 tsx | ~22,000 行 |
| Hooks | `hooks/` 14 个 | `useAgentSession.ts` 1804 行 |
| 服务端库 | `lib/` ~70 个模块 + 同名 `.test.mjs` | 测试覆盖较密 |
| 样式 | `app/globals.css` 2835 行 + CSS Modules + `app/theme-packs/` | 单文件偏大 |
| i18n | `lib/i18n/messages/{en,zh-CN}.ts` | 各 775 行 |
| 桌面壳 | Electron 43.2 + electron-builder 26.15，`desktop/src/` 1392 行 | Windows x64 portable |
| CI | `.github/workflows/{ci,release}.yml` | ubuntu + windows 双矩阵 |

### 1.2 运行架构（已稳定，不要重构）

```
Browser / Electron WebContents
   │
   ├─ GET  /api/sessions            → 读 ~/.pi/agent/sessions/**/*.jsonl（只读，不建 AgentSession）
   ├─ POST /api/agent/new           → startRpcSession() → createAgentSession()
   ├─ POST /api/agent/[id]          → session.send(cmd)
   ├─ GET  /api/agent/[id]/events   → SSE ← session.subscribe()
   └─ GET  /api/agent/running       → 运行中 session id 快照（2.5s 轮询）
                    │
        lib/rpc-manager.ts：globalThis.__piSessions 注册表，10 分钟 idle 超时
```

关键约束（详见 `AGENTS.md`，**任何改动都必须遵守**）：
- AgentSession 实例挂在 `globalThis`，热重载才不会丢；
- `fork()` 会**原地改写** wrapper 内部状态，fork 后必须立刻 `destroy()`；
- ToolCall 字段名在文件格式和内部类型间不一致，统一走 `lib/normalize.ts`；
- 开发期**绝不能跑 `next build`**，会污染 `.next/` 导致 `npm run dev` 崩。

### 1.3 已经做好的（不要重做）

✅ 会话流式输出、SSE 断线重连、run id 防串扰
✅ Fork / in-session branch 双分支模型 + BranchNavigator
✅ Steer / Queue（发送中插话、排队）——**这是超过 Codex 的地方**
✅ 多 Provider 模型配置、OAuth/device-code/API Key 三种登录、models.json 编辑器
✅ Skills 安装/搜索/开关、Plugins 包管理
✅ Git worktree 创建/删除/分组
✅ 文件浏览器（筛选框、Ctrl+P、右键菜单、Git 状态标记）
✅ 设置中心（页面式，非模态）
✅ 项目栏（固定项目、重命名、项目菜单、真实任务/运行数）
✅ 桌宠（Codex 宠物包导入、ZIP 安全校验、独立桌宠窗口）
✅ i18n 双语框架、focus-visible、reduced-motion、safe-area、44px 触控
✅ TabBar 已具备 `role=tablist/tab` 语义
✅ 顶栏已完成一轮瘦身（现为：项目身份 / 信任警告 / 历史 / 右栏开关）
✅ Electron 打包链路：standalone 打包 → 许可证清单 → 包内容校验 → 便携 EXE 冒烟

### 1.4 仍然缺失的（本文档的主战场）

| # | 缺口 | 证据 | 影响 |
|---|---|---|---|
| G1 | **任务状态只有两态** | `SessionSidebar.tsx:787` `attentionSessionIds` 是 `Set<string>`，= running ∪ unread | 用户看不出"在跑 / 等我确认 / 跑完了 / 挂了" |
| G2 | **无 Review 面板，Diff 只读** | `app/api/git/` 只有 `diff`、`status`；无 stage/revert/commit | 交付不闭环（违反 P2） |
| G3 | **两套 Diff 渲染，未抽公共组件** | `FileViewer.tsx` 与 `MessageView.tsx` 各一套 | 样式/行为长期不一致 |
| G4 | **无终端** | `app/api/` 下无 terminal 路由；仅 Composer 内 `!` 一次性命令 | 用户必须切外部终端 |
| G5 | **无命令面板** | 全库无 CommandPalette | 键盘路径断裂 |
| G6 | **无权限/审批模型** | pi SDK 0.83 未导出 permission/sandbox；仅有 Project Trust + 三档工具预设 | 高危操作无分级拦截 |
| G7 | **无新会话空态引导** | `ChatWindow.tsx` 无 starter | 冷启动无从下手 |
| G8 | **工具调用显示原始名** | `MessageView.tsx` 直接渲染 `toolName` | 过程不可读 |
| G9 | **无会话搜索 / Pin / Archive** | 左栏仅 worktree 过滤框 | 长期使用后会话不可管理 |
| G10 | **Shift+Click 免确认永久删除** | `SessionSidebar.tsx:1923` | 数据安全隐患 |
| G11 | **弱文本对比度不达标** | `globals.css:63` `--text-dim:#a49a97` on `#fffdfc` = 2.71:1；`:152` `#6b7280` on `#1a1a1a` = 3.60:1 | WCAG 不合规 |
| G12 | **`html lang` 硬编码 en** | `app/layout.tsx:57` | 无障碍 + 浏览器行为错误 |
| G13 | **Changes 挂在左栏，不是右栏一等公民** | `FileExplorer.tsx:1090` 仅回传 count | 审阅入口层级过深 |
| G14 | **无任务头（Task Header）** | 顶栏直接接聊天流 | 状态/环境/变更数无处安放 |
| G15 | **Electron 壳能力单薄** | `desktop/src/main.ts` 无 Tray / 全局快捷键 / 深链 / 自动更新 | 不像"桌面应用" |
| G16 | **无全局搜索** | 无 ripgrep/正文搜索接口 | 大仓库不可用 |

### 1.5 需要警惕的偏离

2026-08 的界面审查指出：**皮肤对齐了 Codex，骨架还是 Pi 的控制台**。桌宠 + 背景图 + 外观风格 + Dream Skin 的代码量，超过了当时全部 P0 修复之和。

本设计规格的硬性要求：**装饰层（外观/桌宠/主题包）进入功能冻结，除 bugfix 外不新增，直到 G1–G6 全部完成。**

---

### 1.6 能力归属矩阵 ★（**本项目不给 pi Agent 加功能**）

本节回答唯一一个前置问题：**这些功能到底该由谁提供？** 全部结论基于 `@earendil-works/pi-coding-agent@0.83.0` 的 `.d.ts` 实测，不是推测。

#### 归属分类

| 类别 | 定义 | 做法 |
|---|---|---|
| **【接线】** | pi Agent 原生已有，GUI 只需订阅/调用/渲染 | 找到 SDK 符号，接上，**不要自己实现一遍** |
| **【GUI】** | 工作台自身的能力，与 agent 内核无关 | GUI 自由实现，不碰 pi |
| **【降级】** | pi 的模型不支持原设想，按 pi 的特性重新定义 | 改需求，不改 pi |

#### 逐项归属

| 功能 | 归属 | pi 侧依据（已实测） |
|---|---|---|
| 任务状态模型 | **【接线】** | `agent_start` / `agent_end` / **`agent_settled`**（注释：fully settled, no retry/compaction/queued continuation）/ `turn_start` / `turn_end` / `tool_execution_start·update·end` |
| 工具调用人话化 | **【接线】** | 类型化事件 `BashToolCallEvent` 等 + 类型守卫 `isBashToolResult` / `isEditToolResult` / `isReadToolResult` / `isWriteToolResult` / `isGrepToolResult` / `isFindToolResult` / `isLsToolResult` |
| Diff 渲染数据 | **【接线】** | `generateUnifiedPatch()` / `generateDiffString()` / `computeEditDiff()` / `computeEditsDiff()`（edit 工具的 diff 本来就是 SDK 算的） |
| 审批 / 权限档位 | **【接线】** | `tool_call` 事件 + `ToolCallEventResult{block,reason}` + `ctx.ui.confirm()` + `tools`/`excludeTools`/`noTools` |
| 斜杠命令 | **【接线】** | `registerCommand` / `RegisteredCommand` / `ResolvedCommand` / `SlashCommandInfo` / `SlashCommandSource` —— **`/` 菜单必须列 pi 的真实命令，不能自己造一套** |
| 项目信任 | **【接线】**（已完成） | `ProjectTrustStore` / `project_trust` 事件 / `hasTrustRequiringProjectResources` |
| Skills / Plugins | **【接线】**（已完成） | `DefaultResourceLoader` / `DefaultPackageManager` / `SettingsManager` |
| 模型作用域 | **【接线】**（已完成） | `resolveModelScopeWithDiagnostics` |
| 扩展 UI 对话 | **【接线】**（已完成） | `ExtensionUIContext.confirm/select/input/notify` ↔ pi-web 的 `extension_ui_request` |
| 上下文用量 | **【接线】** | `ContextUsage` / `context` 事件 / `calculateContextTokens` / `shouldCompact` |
| 未来沙箱挂载点 | **【接线】** | `BashToolOptions.spawnHook`（可改 command/cwd/env）/ `BashOperations` 可整体替换 |
| —— | —— | —— |
| 左栏 / 任务头 / 三栏布局 | **【GUI】** | pi 不关心 UI |
| Pin / Archive / 会话搜索 | **【GUI】** | 本地元数据，pi 不感知 |
| Review 面板 + git stage/revert/commit | **【GUI】** | pi 不提供 git 写操作，这是工作台能力，GUI 直接调 git |
| 命令面板（⌘K）壳层 | **【GUI】** | 但命令内容要来自 pi 的注册表（见上） |
| 空态 starter | **【GUI】** | 只是往输入框填文本 |
| 对比度 / focus trap / 树语义 / lang | **【GUI】** | 纯前端 |
| Electron 壳（Tray/单实例/窗口恢复） | **【GUI】** | 与 agent 无关 |
| 工作区全文搜索 | **【GUI】** | pi 的 grep/find 是给 LLM 用的工具，不是给用户的搜索界面 |
| —— | —— | —— |
| **PTY 终端** | **【降级】** | `BashOperations.exec` 只有 `onData` 输出流，**没有 stdin**。pi 的模型是一次性命令 + 流式输出 + 可中断。改做「命令运行面板」，对齐 `!` / `!!`（`UserBashEvent.excludeFromContext`） |

#### 由此得出的三条硬规则

1. **凡是【接线】的，禁止自造实现。** 尤其是：不要写自定义工具风险分类器（用 pi 的类型化事件）、不要写 diff 计算（用 `generateUnifiedPatch`）、不要写自定义审批网关（用 `tool_call` + `block`）。
2. **审批逻辑以 pi 扩展形式分发，不写进 `rpc-manager.ts`。** `loadExtensionFromFactory` 未在包的 `exports` 中暴露（只有 `.` 和 `./rpc-entry`），所以正确做法是随应用打包一个扩展文件，通过 pi 的扩展发现机制加载 —— 这本来就是 pi 用户扩展 pi 的标准方式。
3. **【降级】项必须在 UI 里如实说明限制**，不做假的能力暗示。

> 净效果：原 22 个任务包里，**6 个从"自己实现"降级为"接线"**（工作量大幅下降且更稳），**1 个（PTY 终端）改变需求**，其余 15 个本来就是 GUI 自己的活。**没有一项需要修改 pi Agent。**

---

## 2. 目标信息架构

### 2.1 整体布局（桌面 ≥1440px）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [☰] Piora / project-name / task-title        [⌘K]  [状态徽标]  [⋯]  [▤]      │  ← 顶栏 40px
├────────────┬─────────────────────────────────────────────┬───────────────────┤
│            │ ┌─ 任务头 ────────────────────────────────┐ │  Review │Files│Term│  ← 右栏 tabs
│  ①         │ │ ● Running · Local · main · +142 −18     │ │                   │
│  左栏      │ └─────────────────────────────────────────┘ │  ③ 右侧工作面板    │
│  260px     │                                             │  360–560px        │
│            │  ② 会话流（中央，最小 640px）                │  可折叠/可覆盖     │
│  Projects  │                                             │                   │
│  Tasks     │                                             │                   │
│  Activity  │  ┌─ Composer ────────────────────────────┐  │                   │
│            │  │ [附件][上下文环][模型▾]        [发送] │  │                   │
│  ─────     │  └───────────────────────────────────────┘  │                   │
│  Settings  │                                             │                   │
└────────────┴─────────────────────────────────────────────┴───────────────────┘
```

### 2.2 断点策略

| 宽度 | 左栏 | 中央 | 右栏 |
|---|---|---|---|
| ≥1440px | 常驻 260px | ≥640px 弹性 | 常驻 360–560px |
| 1280–1439px | 常驻 260px | **≥640px 保底** | **改为覆盖层**（overlay），与左栏互斥 |
| 960–1279px | 可折叠 | 主体 | 覆盖层 |
| <960px | 抽屉 | 全屏 | 全屏切换 |

> 现状问题：1280px 下中央仅剩约 480px（260 侧栏 + clamp≈538 右栏）。必须给 `.workspace-main` 加 CSS 层 `min-width` 兜底，不能只靠拖拽时的 `lib/panel-layout.ts` clamp。

### 2.3 完成度标尺定义（全文通用）

| 级别 | 含义 |
|---|---|
| **L0** | 不存在 |
| **L1** | 能跑通 happy path，UI 粗糙，无键盘/无错误态 |
| **L2** | **发布门槛**：完整交互 + 键盘路径 + 错误态 + i18n + 无障碍语义 + 单元测试 |
| **L3** | 打磨态：虚拟化/性能、动效、边缘场景、跨平台细节 |

> **v1.0 的目标：所有 P0 功能区达到 L2。L3 只在 G1–G6 完成后再投入。**

---

## 3. 逐功能区规格

---

### 区域 A｜左栏导航（Projects / Tasks / Activity）

#### A.1 现状
- `components/SessionSidebar.tsx`（2164 行）承担了：项目列表 + worktree 切换 + 会话树 + FileExplorer + Git Changes + 上传 + 设置入口。
- 会话状态只有 `attentionSessionIds`（running ∪ unread）两态。
- 无搜索、无 Pin、无 Archive。删除支持 Shift+Click 跳过确认（`:1923`）。

#### A.2 目标功能清单

**A.2.1 三段式结构**
```
┌ 品牌区 ────────────────────┐
│ Piora            [⌘K] [⚙] │
├ 主导航 ────────────────────┤
│ ▸ Projects        (3)      │   ← 项目 + worktree（可展开）
│ ▸ Tasks          (12·2▶)  │   ← 跨项目的任务列表（默认按更新时间）
│ ▸ Activity                 │   ← 时间线：完成/失败/需确认（可选 P2）
├ 当前项目 ──────────────────┤
│ 📌 Piora                   │   ← Pin 区
│    ├ ● 修复 diff 渲染       │   ← 任务行（带状态点 + 状态词）
│    ├ ⏸ 等待确认: rm -rf     │
│    └ ✓ 补充 i18n            │
├ ───────────────────────────┤
│ 账户 / 设置 / 版本          │
└────────────────────────────┘
```

**A.2.2 任务行必备信息**（单行，不换行，悬停不抖动）
- 状态点（4 色）+ 状态词（needs_input 时必须有文字）
- 任务标题（自动命名或用户命名）
- 相对时间 / 变更数徽标
- 悬停操作区：固定宽度占位，显隐不参与排版

**A.2.3 会话管理**
| 能力 | 规格 |
|---|---|
| 搜索 | 输入框过滤 title + cwd + 最近消息片段；`Ctrl+Shift+F` 聚焦 |
| Pin | 置顶到当前项目上方，本地持久化 |
| Archive | 软删除，移入 Archived 折叠区，可 Undo |
| Delete | **必须二次确认，移除 Shift 跳过**；删除后 5 秒 Undo toast |
| 重命名 | 双击行内编辑 |
| 右键菜单 | Pin / Rename / Archive / Duplicate(fork) / Copy path / Reveal in Explorer / Delete |

**A.2.4 文件树迁移**
FileExplorer 与 Git Changes **从左栏迁到右栏**（见区域 E）。左栏只保留 Projects / Tasks / Activity。

#### A.3 开发方式

1. **拆分 `SessionSidebar.tsx`**（2164 行 → 4 个文件）：
   - `components/sidebar/SidebarShell.tsx`（骨架 + 主导航）
   - `components/sidebar/ProjectList.tsx`
   - `components/sidebar/TaskList.tsx` + `TaskRow.tsx`
   - `components/sidebar/SidebarFooter.tsx`
2. 任务状态从 `lib/task-status.ts`（新建）统一派生，见第 4 章。
3. Pin/Archive 存储：`lib/session-flags.ts`（新建），写 `~/.pi/agent/piora/session-flags.json`，用 `lib/atomic-file.ts` 原子写。
4. 搜索走前端过滤（会话列表已全量在内存），正文搜索留到 P2。

#### A.4 完成到什么程度才好

| 级别 | 判定 |
|---|---|
| L1 | 四态状态点显示正确；搜索框可过滤 |
| **L2（必须达到）** | 拆分完成 + Pin/Archive/Undo 全通 + 键盘上下键遍历 + 右键菜单不溢出视口 + 悬停零抖动 + 中英文文案齐全 + `SessionSidebar` 相关 `.test.mjs` 通过 |
| L3 | >500 会话虚拟化；Activity 时间线；跨项目搜索高亮 |

---

### 区域 B｜顶栏 + 任务头（Task Header）

#### B.1 现状
- 顶栏已瘦身：侧栏开关 / 项目身份（面包屑 + 项目菜单）/ 信任警告 / 历史 / 右栏开关。
- **没有任务头**，顶栏下面直接是聊天流。
- token/cost/上下文占用曾常驻顶栏，需确认是否已收进 Composer。

#### B.2 目标功能清单

**B.2.1 顶栏（40px，固定）**
```
[☰]  Piora / project ▾ / task-title        [⌘K]     [⋯]  [▤]
```
只允许 6 个控件：侧栏开关、面包屑（项目菜单）、命令面板入口、溢出菜单、右栏开关、（可选）桌宠。
**外观 / 语言 / 自动命名 / System Prompt / 分支导航 / 工具预设 / 通知 → 全部进溢出菜单或设置中心，禁止双入口。**

**B.2.2 任务头（新建，48px，仅在有任务时显示）**
```
● Running · 3m12s     Local · Piora · main ⎇     +142 −18 (7 files)     [Stop] [⋯]
```
| 槽位 | 内容 | 点击行为 |
|---|---|---|
| 状态 | 四态徽标 + 状态词 + 运行时长 | 跳到最新活动 |
| 环境 | Local / Worktree 徽标 + 项目名 + 分支 | 打开 worktree 切换器 |
| 变更 | `+N −M (K files)` | 打开右栏 Review tab |
| 操作 | Stop / Steer / 溢出（Fork、导出、重命名、删除） | — |

> 任务头是 G14 + G1 + G13 的**汇聚点**，是本轮最高性价比的单个组件。

#### B.3 开发方式
- 新建 `components/TaskHeader.tsx`，从 `AppShell.tsx` 抽出相关状态。
- 变更数复用 `lib/git-changes.ts`，数据来自 `/api/git/status`；改为按当前任务 cwd 轮询（run 中 3s，idle 停）。
- 环境徽标读 `lib/worktree.ts` 的解析结果。

#### B.4 完成到什么程度才好

| 级别 | 判定 |
|---|---|
| L1 | 任务头渲染四态 + 分支名 |
| **L2** | 四槽位全部可点击且行为正确 + 顶栏控件收敛到 6 个 + 消除全部双入口 + 窄窗口下槽位按优先级降级（变更数 → 环境 → 时长）+ 无横向溢出 |
| L3 | 状态切换动效；运行时长秒级平滑；多任务并行时的迷你切换器 |

---

### 区域 C｜中央会话流

#### C.1 现状
`components/ChatWindow.tsx`(1263) + `MessageView.tsx`(1498) + `MarkdownBody.tsx` + `ChatMinimap.tsx`。
流式、滚动稳定、回到最新按钮、Mermaid、KaTeX、代码高亮均已就绪。
**缺**：空态 starter（G7）、工具调用人话化（G8）、统一 DiffView（G3）。

#### C.2 目标功能清单

**C.2.1 新会话空态**
```
在 Piora 中开始一个任务

  ▸ 解释这个仓库的架构
  ▸ 找出并修复一个 bug
  ▸ 为 <最近改动的文件> 补测试
  ▸ 审阅当前未提交的改动
  ▸ 升级依赖并跑通检查

[附件] [模型 ▾]                              [发送]
```
- Starter 由 `lib/starters.ts` 根据项目信号生成：有无 git 变更、有无测试目录、有无 README、最近改动文件。
- 点击填入 Composer（**不直接发送**），用户可编辑。

**C.2.2 工具调用人话化**
| 原始 | 显示 |
|---|---|
| `read_file {path}` | 读取 `lib/rpc-manager.ts` |
| `edit_file {path}` | 编辑 `components/TabBar.tsx` · +12 −3 |
| `bash {cmd}` | 运行命令 `npm test` · 退出码 0 · 3.2s |
| `grep {pattern}` | 搜索 `attentionSessionIds` · 5 个结果 |
| 未知工具 | 工具名原样 + 参数摘要 |

- 摘要器：`lib/tool-summary.ts`（新建，纯函数，易测）
- 原始 payload 折叠进 "Diagnostics" 二级展开，默认收起。
- 折叠态高度固定 28px，展开不影响上方滚动位置。

**C.2.3 统一 DiffView**
抽 `components/DiffView.tsx`，同时被 `MessageView`（消息内的补丁）和 `FileViewer`（右栏审阅）使用。
必备：行号、增删着色、折叠未变更区（±3 行上下文）、语法高亮、复制、跳到文件、**行级操作插槽**（为 Review 预留）。

#### C.3 开发方式
1. 先抽 `DiffView`（纯前端重构，无后端依赖，风险最低）→ 替换 `FileViewer` → 替换 `MessageView`。
2. `tool-summary.ts` 先写测试再写实现（工具名 → 摘要的映射表 + 兜底）。
3. Starter 走 `/api/project-info` 已有数据 + 新增少量字段，避免新接口。

#### C.4 完成到什么程度才好

| 级别 | 判定 |
|---|---|
| L1 | Starter 显示；常见 6 个工具有摘要；DiffView 抽出但只用于一处 |
| **L2** | 两处 Diff 全部切到 DiffView 且视觉一致 + 全部内置工具有摘要 + 未知工具优雅降级 + Diagnostics 折叠 + starter 按项目信号变化 + `tool-summary.test.mjs` / `diff-view.test.mjs` 通过 |
| L3 | 消息虚拟化（>2000 条不卡）；diff 大文件分块渲染；折叠区惰性求值 |

---

### 区域 D｜Composer（输入区）

#### D.1 现状
`components/ChatInput.tsx`（2041 行）。已有：附件、统计、上下文环、模型下拉（含推理档位、Compact）、发送、`!` 一次性命令、`@` 文件引用、草稿持久化、Steer/Queue。**常驻控件 5 项，已达标。**

#### D.2 目标增量（克制）

| 能力 | 规格 | 优先级 |
|---|---|---|
| `/` 斜杠命令 | 复用命令面板的命令注册表，输入 `/` 唤起子集（compact、fork、new、model、terminal…） | P1 |
| 权限档位选择器 | 与 G6 联动，模型下拉旁增加 Approval 档位（Read-only / Auto-edit / Full） | P1（依赖 G6） |
| 图片粘贴 | 已有 `lib/image-attachments.ts`，确认 Ctrl+V 路径完整 | P1 |
| 多行编辑器增强 | Shift+Enter 换行、Ctrl+Enter 发送、历史上翻（↑ 复原上条） | P1 |

**明确不加**：更多常驻按钮。任何新能力必须进 `/` 命令或模型下拉。

#### D.3 开发方式
- `ChatInput.tsx` 已 2041 行，**先拆再加**：抽 `components/composer/ModelPicker.tsx`、`AttachmentBar.tsx`、`SlashMenu.tsx`。
- 斜杠命令与 `⌘K` 共用 `lib/commands.ts` 注册表（见区域 H），避免两套定义。

#### D.4 完成到什么程度才好

| 级别 | 判定 |
|---|---|
| L1 | `/` 能唤起菜单并执行 3 个命令 |
| **L2** | 拆分完成 + `/` 命令与 ⌘K 共享注册表 + 键盘全流程（↑↓ 选择、Esc 关闭、Tab 补全）+ 禁用命令显示原因 + 已有 `ChatInput.test.mjs` 全绿 |
| L3 | 命令模糊排序按使用频次；命令参数补全 |

---

### 区域 E｜右侧工作面板（Review / Files / Terminal）

> **这是 v1.0 的最大工程量，也是 P2 原则的落地点。**

#### E.1 现状
右栏 = `FileViewer.tsx`（1768 行）单一用途，Git Changes 挂在左栏 `FileExplorer` 里，只读。

#### E.2 目标结构

```
┌─ Review │ Files │ Terminal ──────────────── [⤢][✕] ┐
│                                                     │
│  Review tab:                                        │
│  ┌ 变更列表 ──────────────┐  ┌ Diff ─────────────┐  │
│  │ ☑ M components/A.tsx  │  │  统一 DiffView     │  │
│  │ ☐ A lib/b.ts          │  │  逐块 [接受][撤销] │  │
│  │ ☑ D old.css           │  │                   │  │
│  └───────────────────────┘  └───────────────────┘  │
│  [Stage All] [Revert Selected] [Commit…]            │
└─────────────────────────────────────────────────────┘
```

#### E.3 Review tab 功能清单

| 能力 | 规格 | 后端 |
|---|---|---|
| 变更列表 | 按状态分组（Staged / Unstaged / Untracked），显示 +N −M | `GET /api/git/status`（已有） |
| Diff 查看 | 统一 DiffView，按文件导航（`Alt+↑/↓`） | `GET /api/git/diff`（已有） |
| Stage / Unstage | 文件级 + 块级 | **新增** `POST /api/git/stage` |
| Revert | 文件级 + 块级，**必须二次确认** | **新增** `POST /api/git/revert` |
| Commit | 消息输入 + amend 选项 + 预览 | **新增** `POST /api/git/commit` |
| 冲突提示 | 检测到 conflict 时禁用写操作并给出说明 | status 扩展 |

**安全要求（不可协商）**：
- 所有 git 写操作路由必须走 `lib/allowed-roots.ts` + `lib/path-security.ts` 校验；
- 必须走 `lib/bounded-json.ts` 限制请求体；
- **禁止**实现 `push` / `force` / `reset --hard` / `clean -fdx`；
- Revert 前必须要求前端传当前 diff 的 hash，服务端比对，防止「看到的和撤销的不是同一份」。

#### E.4 Files tab
把现有 `FileExplorer` + `FileViewer` 迁进来，保留全部已有能力（筛选、Ctrl+P、右键菜单、Git 标记）。左栏不再有文件树。

#### E.5 命令面板 tab（原「Terminal」，**已按 pi 特性下调**）

**核实结论：pi Agent 没有 PTY，也不应该为它加一个。**

```ts
// pi-coding-agent/dist/core/tools/bash.d.ts:26
exec: (command, cwd, options: { onData: (data: Buffer) => void; signal?; timeout?; env? })
        => Promise<{ exitCode: number | null }>
```
只有单向输出流，**没有 stdin**。pi 的 bash 模型就是「一次性命令 + 流式输出 + 可中断」。

因此本 tab 的正确形态不是终端模拟器，而是 **命令运行面板**，对齐 pi 已有的 `!command` 语义：

| 能力 | 规格 | pi 侧依据 |
|---|---|---|
| 执行 | 一次性命令，流式输出，可 Abort | `BashOperations.exec` + `signal` |
| 上下文 | `!cmd` 进 LLM 上下文；`!!cmd` 不进 | `UserBashEvent.excludeFromContext` |
| 历史 | 命令历史 + 重跑 + 复制输出 | GUI 侧 |
| 渲染 | 复用 `lib/ansi.ts`（已有 ANSI 解析） | — |
| 安全 | 只在已 Trust 的项目开放；Web/LAN 模式默认关闭 | `ProjectTrustStore` |

**必须在 UI 中说明**：交互式命令（`vim`、`ssh`、需要输入密码的命令）不可用。这不是缺陷，是 pi 的执行模型。

> 若将来确实需要真终端，那是**给 GUI 加一个独立于 pi Agent 的功能**（Electron 主进程起 node-pty），而不是 pi 的能力。按当前定位：**不做**。

> 优先级：排在 Review 之后。Review 是交付闭环（P2），命令面板是便利性。

#### E.6 开发方式与顺序

```
E-1  抽 DiffView（区域 C 已列）           ← 无后端依赖
E-2  右栏改 tabs 骨架 + Files 迁移         ← 纯前端
E-3  Review tab 只读版（列表 + diff 导航）  ← 用已有 API
E-4  git 写 API（stage / revert / commit）  ← 后端 + 严格安全测试
E-5  Review tab 可操作版（块级操作）
E-6  Terminal
```

#### E.7 完成到什么程度才好

| 级别 | 判定 |
|---|---|
| L1 | 右栏三 tab 切换；Review 能看变更列表和 diff |
| **L2** | Stage/Unstage/Revert/Commit 文件级全通 + 二次确认 + 错误态（冲突、锁、权限）+ 路径安全测试 + 按文件键盘导航 + Terminal 能跑交互命令并正确处理 Ctrl+C |
| L3 | 块级 stage/revert；行内评论；大 diff 虚拟化；Terminal 多标签 + 分屏 |

---

### 区域 F｜命令面板（⌘K / Ctrl+K）

#### F.1 现状：不存在（G5）。快捷键仅 `hooks/useKeyboardShortcuts.ts` 的 Esc / Ctrl+Alt+N。

#### F.2 目标功能清单

| 分类 | 命令示例 |
|---|---|
| 导航 | 跳到任务、跳到项目、打开文件（模糊）、切 worktree |
| 会话 | 新任务、Fork、重命名、导出 HTML、Compact、停止 |
| 模型 | 切换模型、切换推理档位、切换权限档位 |
| 面板 | 切 Review/Files/Terminal、开关左右栏 |
| 设置 | 打开模型配置、技能、插件、外观、语言 |
| Git | 打开 Review、Commit… |

**规格**：
- 模糊搜索（复用 `lib/file-fuzzy.ts` 的算法）；
- 分组 + 最近使用置顶（本地持久化）；
- 禁用命令**显示原因**（如「无活动任务」），不隐藏；
- 键盘全流程：↑↓ 选择、Enter 执行、Esc 关闭、Tab 进入子命令；
- 打开时 focus trap，关闭后焦点返回触发元素。

#### F.3 开发方式
- `lib/commands.ts`：`Command { id, group, title, keywords, run(ctx), enabled(ctx): true | {reason} }`
- `components/CommandPalette.tsx`：纯展示 + 键盘。
- Context 通过 React Context 注入（当前任务、项目、面板状态）。
- **与 `/` 斜杠命令共用同一注册表。**

#### F.4 完成到什么程度才好

| 级别 | 判定 |
|---|---|
| L1 | ⌘K 打开，能搜索并执行 10 个命令 |
| **L2** | 覆盖全部上表分类 + 最近使用 + 禁用原因 + focus trap + 焦点返回 + `commands.test.mjs`（注册表纯函数测试）+ 中英文 |
| L3 | 命令参数化（`>commit 消息`）；插件可注册命令 |

---

### 区域 G｜权限与审批（已取消）

> **2026-08-10 产品决策：此区域已退役。** Piora 遵循 Pi 的直接工具调用原则，不提供 Read-only / Auto-edit / Full-access 档位，不安装工具审批拦截扩展，也不在任务头展示权限徽标。下方内容仅保留为历史调研记录，不得据此恢复权限 UI。

#### G.1 现状（2026-08-07 重新核实，**推翻本文档初稿的错误判断**）

初稿写「pi SDK 未导出 permission / approval API」是错的 —— 只 grep 了 `pi-agent-core`，而扩展系统在 `pi-coding-agent`。实际情况：

**pi Agent 原生提供完整的工具调用拦截能力**，位于 `@earendil-works/pi-coding-agent`：

```ts
// node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:778
export interface ToolCallEventResult {
  /** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
  block?: boolean;
  reason?: string;
}

// :885
on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;

// :851 —— handler 可以是 async，因此可以 await 用户决策
export type ExtensionHandler<E, R> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;
```

配套能力：
- **类型化的工具事件**：`BashToolCallEvent` / `EditToolCallEvent` / `WriteToolCallEvent` / `ReadToolCallEvent` / `GrepToolCallEvent` / `FindToolCallEvent` / `LsToolCallEvent` / `CustomToolCallEvent`，各自带强类型 `input`（`BashToolInput` 等）。**不需要自己写工具分类器去猜。**
- **参数改写**：注释明确说明「mutate `event.input` in place」可以改参数，不只是放行/拦截。
- **用户 bash 拦截**：`user_bash` 事件 + `UserBashEventResult { operations?, result? }`，可替换执行后端或直接接管执行。
- **工具集即权限**：`createReadOnlyTools()` / `createCodingTools()` / `createBashTool` 等；`createAgentSession` 接受 `tools` 白名单、`excludeTools` 黑名单、`noTools: "all" | "builtin"`。
- **询问 UI 已经通了**：`ctx.ui.confirm(title, message)` 走 pi 的 `ExtensionUIContext`，而 pi-web **已经**把 `extension_ui_request` / `extension_ui_response` 全链路接通了（`lib/rpc-manager.ts:214,584,676…` + `hooks/useAgentSession.ts:722,1129`）。

#### G.2 修正后的实现路线

**不写自定义网关。改为随应用分发一个 pi 扩展。**

```
Piora 打包内置扩展  ~/.pi/agent/extensions/piora-approval.ts
   │
   ├─ api.on("tool_call", async (event, ctx) => {
   │      const risk = classify(event);              // 用 event.toolName + 强类型 input
   │      if (allowedByTier(risk, tier)) return;     // 放行
   │      const ok = await ctx.ui.confirm(...);      // ← 走 pi 原生 UI 通道
   │      return ok ? undefined : { block: true, reason: "用户拒绝" };
   │   })
   │
   └─ pi-web 已有的 extension_ui_request 渲染层 → 换成 ApprovalCard 样式即可
```

**三个档位直接映射到 pi 原生概念，不发明新东西：**

| 档位 | pi 侧实现 |
|---|---|
| Read-only | `tools: ["read","grep","find","ls"]`（= `createReadOnlyTools` 的集合） |
| Auto-edit（默认） | 默认工具集 + 扩展只对 `bash` 类调用询问 |
| Full-access | 默认工具集 + 扩展不拦截（选中需二次确认 + 任务头徽标） |

> 前两项是 pi 原生的 `tools` 参数，pi-web 的 `lib/tool-presets.ts`（NONE / DEFAULT / FULL）**已经是这个模型的雏形**，只需要重命名成权限语义并补上第三层（bash 命令级审批）。

**沙箱**：pi 确实没有 sandbox（`BashOperations.exec` 就是本地 shell）。**在真沙箱落地前，UI 不得出现 "Sandboxed" 字样。** 但要注意 `BashToolOptions.spawnHook` 可以改写 command/cwd/env，`BashOperations` 可整体替换 —— 这是未来接沙箱的原生挂载点，不需要改 SDK。

#### G.3 完成到什么程度才好

| 级别 | 判定 |
|---|---|
| L1 | 三档位可选；bash 调用会弹审批卡 |
| **L2** | 工具分类表完整 + 危险命令模式库（`rm -rf`、`format`、`curl \| sh`、`git push --force` 等）+ 「允许本任务」记忆 + 拒绝后 Agent 收到明确错误并能继续 + Full-access 二次确认 + 任务头徽标 + `tool-risk.test.mjs` |
| L3 | 真沙箱；按目录白名单；网络域名白名单 |

---

### 区域 H｜设置中心

#### H.1 现状
`components/SettingsDialog.tsx`(316) 已聚合 Models / Skills / Plugins / 外观 / 语言，且已改为页面式（非模态）。
子页面偏大：`ModelsConfig.tsx` 2560 行、`SkillsConfig.tsx` 1328 行、`PluginsConfig.tsx` 1049 行。

#### H.2 目标结构

```
Settings
├ General      语言、启动行为、默认 cwd、通知
├ Appearance   主题、字体、背景、外观风格、桌宠     ← 装饰能力全部收此
├ Models       Provider 登录、models.json、模型作用域、测试
├ Permissions  默认审批档位、危险命令库、Trust 管理  ← 新增（依赖 G）
├ Skills       已加载 / 搜索 / 安装 / 开关
├ Plugins      包管理
├ Advanced     诊断日志、会话目录、导出、重置
└ About        版本、许可证、第三方声明
```

#### H.3 开发方式
- 拆 `ModelsConfig.tsx`：`ProviderList` / `ModelTable` / `ModelEditor` / `ModelTester` 四文件。
- 设置页统一 `SettingsSection` / `SettingsRow` 两个原子组件，消除各页面样式漂移。
- **消除双入口**：外观 / 语言从顶栏移除，只留设置中心（+ 命令面板可达）。

#### H.4 完成到什么程度才好

| 级别 | 判定 |
|---|---|
| L1 | 八个分区存在且可导航 |
| **L2** | 全部拆分完成 + 统一原子组件 + 无双入口 + 每项设置有说明文案（中英）+ 错误态（如 API Key 无效）+ 已有 `ModelsConfig.test.mjs` 全绿 |
| L3 | 设置搜索；导入/导出配置；配置差异对比 |

---

### 区域 I｜模型、账号与 Provider

#### I.1 现状：**这是本项目最成熟的部分，也是超越 Codex 的差异点。**
- 多 Provider、OAuth / device-code / manual-code / API Key 全通；
- `lib/provider-listing.ts` 能力驱动分类（不是 id 驱动），双认证 Provider 不重复不漏；
- `lib/model-scope.ts` 委托 SDK 的 `resolveModelScopeWithDiagnostics()`，与 TUI 一致；
- models.dev 价格目录、上游模型发现、模型连通性测试齐备。

#### I.2 目标增量（小）
| 能力 | 规格 |
|---|---|
| 用量与成本 | 按任务 / 按天聚合，设置中心可查；超阈值提醒 |
| 模型健康 | 记录最近失败率与延迟，选择器中标注 |
| 快速切换 | 命令面板 `>model` 直达 |

#### I.3 完成到什么程度才好
**L2 已基本达成，本轮只需保持不回归。** 增量做到 L1 即可，不要在这里投入 L3。

---

### 区域 J｜Skills / Plugins / 扩展

#### J.1 现状
`/api/skills*`（5 个路由）+ `/api/plugins`，走 pi 的 `DefaultResourceLoader` / `SettingsManager` / `DefaultPackageManager`。安装通过 `npx skills add --agent pi`。

#### J.2 目标增量
| 能力 | 规格 | 优先级 |
|---|---|---|
| 扩展 UI 请求可视化 | `extension_ui_request` 的 10 种方法（confirm / select / input …）在会话流中渲染成卡片 | P1 |
| 安装进度与失败诊断 | npx 输出流式展示，失败给可复制命令 | P1 |
| MCP Server 管理 | 若 SDK 支持则接入；**不支持就不做入口**（P3 原则） | P2（先调研） |
| Skill 更新提醒 | `lib/skill-updates.ts` 已有基础，接 UI | P2 |

#### J.3 完成到什么程度才好

| 级别 | 判定 |
|---|---|
| L1 | 扩展 confirm 能弹卡片 |
| **L2** | 10 种 extension_ui 方法全部有对应 UI + 超时/取消处理 + 安装失败可诊断 + 不阻塞会话流 |
| L3 | MCP 管理；扩展市场 |

---

### 区域 K｜桌宠与外观（差异化，但**冻结**）

#### K.1 现状
`CompanionPet.tsx` + `CompanionSettingsDialog.tsx` + `DesktopCompanionWindow.tsx` + `BackgroundSettings.tsx` + `AppearanceLooks.tsx` + `FontSettings.tsx` + `theme-packs/codex-dream-skin.css`。
Codex 宠物包导入、ZIP 安全校验（大小/条目/路径穿越/图集几何）、独立桌宠窗口均已完成。

#### K.2 唯一必须做的事
**把桌宠已有的四态状态点（running / waiting / review / failed，`AppShell.tsx` 附近）反哺到任务行和任务头。** 状态语言已经设计好了，却只呈现在装饰组件上 —— 这是当前最讽刺的一处。

#### K.3 冻结规则
- 不新增主题包、不新增桌宠动作、不新增背景能力，直到 G1–G6 全部 L2；
- 只接受：bugfix、无障碍修复、性能修复、把状态语言反哺主界面。

#### K.4 完成度：**保持现状（已 L2）**，不投入。

---

### 区域 L｜Electron 桌面壳

#### L.1 现状
`desktop/src/main.ts`(829) + `server-supervisor.ts`(299) + `preload.ts`(41)。
已有：Next standalone 托管、窗口样式与标题栏拖拽、原生通知（同源 + 主 frame IPC 桥）、菜单、便携首次运行清理、包内容校验、隔离用户目录冒烟。
**无**：Tray、全局快捷键、深链协议、自动更新、多窗口、窗口状态恢复（部分在 `desktop-state.ts`）。

#### L.2 目标功能清单

| 能力 | 规格 | 优先级 |
|---|---|---|
| 窗口状态恢复 | 位置/尺寸/最大化/显示器，多显示器安全兜底 | P1 |
| Tray | 托盘图标 + 运行中任务数徽标 + 快捷菜单（新任务 / 显示 / 退出） | P1 |
| 全局快捷键 | `Ctrl+Alt+Space` 唤起窗口并聚焦 Composer（可关闭） | P2 |
| 单实例锁 | 第二次启动聚焦已有窗口 | P1 |
| 深链 | `piora://task/<id>` | P2 |
| 拖入文件 | 拖到窗口 = 添加为附件 / 打开 | P1 |
| 自动更新 | 需要签名与更新服务器，**先不做**，只做「有新版本」提示 | P3 |
| 系统右键菜单 | 输入框/选中文本的原生上下文菜单（复制/粘贴/全选） | P1 |

**安全底线（已有，不得放松）**：`contextIsolation: true`、`nodeIntegration: false`、preload 白名单 IPC、仅同源、仅主 frame。任何新 IPC 必须在 `preload.ts` 显式白名单，且参数在主进程二次校验。

#### L.3 完成到什么程度才好

| 级别 | 判定 |
|---|---|
| L1 | 单实例 + 窗口状态恢复 |
| **L2** | 上表 P1 全部完成 + 多显示器/DPI 变化不丢窗口 + 拔掉显示器后窗口回到可见区 + 便携 EXE 冒烟通过 + `desktop-window-style.test.mjs` 等全绿 |
| L3 | 自动更新；深链；多窗口 |

---

### 区域 M｜i18n / 无障碍 / 性能（横切）

#### M.1 i18n
- 现状：en + zh-CN 各 775 行，`lib/i18n/registry.ts` + `format.ts` + 测试。
- **必修**：`app/layout.tsx:57` 的 `lang="en"` 改为跟随当前语言（G12）。
- 规范：任何新 UI 文案必须同时加 en + zh-CN；缺 key 在开发模式下必须报错（加测试守卫）。
- 日期/数字走 `Intl`，不手写格式。

#### M.2 无障碍
| 项 | 现状 | 目标 |
|---|---|---|
| focus-visible | ✅ 全局 | 保持 |
| TabBar 语义 | ✅ tablist | 保持 |
| 文件树语义 | ❌ div | `role=tree/treeitem` + `aria-expanded` + roving tabindex |
| focus trap | ❌ 无 | 统一 `hooks/useFocusTrap.ts`，所有弹层接入 |
| 焦点返回 | 🟡 零散 | 关闭弹层后焦点回到触发元素 |
| 对比度 | ❌ 不达标 | `--text-dim` Light 压到 ≈`#6f6663`，Dark 提到 ≈`#8b93a1`，双主题 ≥4.5:1（G11） |
| 屏幕阅读器 | 未验证 | 关键流程用 NVDA 走一遍 |

#### M.3 性能预算（硬指标）

| 场景 | 预算 |
|---|---|
| 冷启动到可交互（便携 EXE） | ≤ 3.5s |
| 切换任务（含 500 条消息） | ≤ 400ms |
| 流式输出时主线程长任务 | 无 >50ms 的连续帧丢失 |
| 打开 5000 文件目录 | ≤ 800ms（需虚拟化） |
| 内存（空闲 1 任务） | ≤ 600MB |

#### M.4 完成到什么程度才好
**L2 = 对比度达标 + focus trap 全覆盖 + 文件树语义 + lang 跟随 + 性能预算全部满足且有测量脚本。**

---

## 4. 数据模型扩展：任务状态（G1，本轮核心）

### 4.1 现状问题
`attention = running ∪ unread` 是**两个正交维度被压成一个集合**，导致「在跑」和「跑完没看」无法区分，「等我确认」和「挂了」完全不可见。

### 4.2 目标：三轴模型

```ts
// lib/task-status.ts（新建）
type Lifecycle  = "draft" | "active" | "archived";
type Runtime    = "idle" | "running" | "compacting" | "stopping";
type Attention  = "none" | "needs_input" | "needs_approval" | "failed" | "unread";

interface TaskStatus {
  lifecycle: Lifecycle;
  runtime: Runtime;
  attention: Attention;
}
```

### 4.3 派生规则（纯函数，必须可测）

| 来源 | 产出 |
|---|---|
| `/api/agent/running` 含该 id | `runtime = running` |
| SSE `compaction_start/end` | `runtime = compacting` |
| SSE 收到 `extension_ui_request` 未响应 | `attention = needs_approval` |
| 审批网关（区域 G）挂起 | `attention = needs_approval` |
| SSE `prompt_done` 且最后一条是错误 | `attention = failed` |
| `prompt_done` 且用户未查看 | `attention = unread` |
| 用户打开该任务 | `attention = none` |

### 4.4 展示映射（全局唯一，禁止各处自定义颜色）

| 状态 | 点色 | 文字（zh / en） |
|---|---|---|
| running | 蓝 `--status-running` | 运行中 / Running |
| needs_approval | 橙 `--status-attention` | 等待确认 / Needs approval |
| needs_input | 橙 | 等待输入 / Needs input |
| failed | 红 `--status-failed` | 失败 / Failed |
| unread | 绿点空心 | 有新结果 / Ready |
| none | 无 | — |

### 4.5 服务端配合
- `/api/agent/running` 扩展返回 `{ id, runtime, pendingApproval: boolean }`；
- 新增 `/api/agent/running/events` 已存在（SSE），把上述结构一并推送；
- 失败态需要 `rpc-manager` 记录最后一次 prompt 的终态。

### 4.6 完成度
**L2 = 三轴模型落地 + 派生纯函数有测试 + 任务行/任务头/桌宠三处共用同一映射 + 状态变化实时（≤1s）。**

---

## 5. 路线图

### 阶段 0：地基清理（1 周，全部纯前端 / 低风险）
| # | 任务 | 缺口 |
|---|---|---|
| 0.1 | 移除 Shift+Click 免确认删除 + 加 Undo | G10 |
| 0.2 | 修 `--text-dim` 双主题对比度 | G11 |
| 0.3 | `html lang` 跟随 i18n | G12 |
| 0.4 | 抽 `hooks/useFocusTrap.ts` 并接入全部弹层 | M2 |
| 0.5 | 文件树 `role=tree/treeitem` | M2 |
| 0.6 | 中央区 CSS 层 `min-width:640px` 兜底 + 1280–1439 右栏改覆盖层 | 2.2 |

### 阶段 1：骨架（3–4 周，本轮重点）
| # | 任务 | 缺口 |
|---|---|---|
| 1.1 | `lib/task-status.ts` 三轴模型 + 服务端事件源 | G1 |
| 1.2 | `components/TaskHeader.tsx` | G14 |
| 1.3 | 拆分 `SessionSidebar` → Projects/Tasks/Activity | G9 |
| 1.4 | Pin / Archive / 搜索 | G9 |
| 1.5 | 抽 `components/DiffView.tsx` 并统一两处 | G3 |
| 1.6 | `lib/tool-summary.ts` 工具人话化 + Diagnostics 折叠 | G8 |
| 1.7 | 空态 starter | G7 |

### 阶段 2：闭环（3–4 周）
| # | 任务 | 缺口 |
|---|---|---|
| 2.1 | 右栏三 tab 骨架 + Files 迁移 | G13 |
| 2.2 | Review tab（只读） | G2 |
| 2.3 | git 写 API（stage / revert / commit）+ 安全测试 | G2 |
| 2.4 | Review tab（可操作） | G2 |
| 2.5 | `lib/commands.ts` + 命令面板 + `/` 斜杠命令 | G5 |

### 阶段 3：能力（3–4 周）
| # | 任务 | 缺口 |
|---|---|---|
| 3.1 | `lib/tool-risk.ts` + 审批网关 + 三档位 | G6 |
| 3.2 | Terminal tab（PTY） | G4 |
| 3.3 | Electron P1 能力（Tray / 单实例 / 窗口恢复 / 拖入 / 原生右键） | G15 |
| 3.4 | 工作区全文搜索 | G16 |

### 阶段 4：打磨（持续）
虚拟化、性能预算达标、NVDA 走查、多显示器、动效、L3 项。

### 冻结清单（阶段 0–3 期间）
桌宠新能力、新主题包、新背景能力、新外观风格。

---

## 6. 验收与质量门槛

### 6.1 每个 PR 必过
```bash
npm run typecheck      # web + desktop 双 tsconfig
npm run lint
npm test               # node --test components/ hooks/ lib/ lib/i18n/
```
- 无新增浏览器控制台错误；
- 新 UI 文案 en + zh-CN 齐全；
- 新 API 路由有路径安全 + 请求体限制测试；
- **开发期不得运行 `next build`**。

### 6.2 每个阶段结束必过
```bash
npm run build:app
npm run verify:package
npm run verify:release
npm run verify:hygiene
npm run smoke:portable
npm run licenses:check
```
- 停掉 dev server 后再构建；
- 用真实便携 EXE 手动验证：悬停零抖动、滚动、右键菜单、设置页、任务状态、审阅流程；
- 中英文各截一轮关键界面回归图。

### 6.3 定量门槛
- 第 3.M.3 节性能预算全部达标；
- 双主题全部文本对比度 ≥4.5:1（10–11px 文本尤其）；
- 键盘可完成的核心流程：新建任务 → 发消息 → 审批 → 审阅 diff → commit，**全程不碰鼠标**。

---

## 7. 明确不做

| 不做 | 原因 |
|---|---|
| 云端任务队列 / 远程执行 | 本地定位，且引入巨大安全面 |
| 多人协作 / 共享会话 | 超出 v1 定位 |
| 自动更新（v1.0） | 需要代码签名 + 更新服务器，成本高于收益 |
| xterm.js（除非 `lib/ansi.ts` 明确不够） | 体积 + 第三方许可证审查成本 |
| 假的 "Sandboxed" 标签 | 违反 P3；没有真沙箱就不写 |
| GitHub PR / Sites / Scheduled tasks 入口 | 未接通，违反 P3 |
| 更多主题包 / 桌宠动作 | 冻结期 |

---

## 附录 A：新增文件清单（供实施 Agent 对照）

```
lib/
  task-status.ts          三轴任务状态派生（纯函数 + 测试）
  tool-summary.ts         工具调用人话化（纯函数 + 测试）
  tool-risk.ts            工具风险分类 + 危险命令模式库（纯函数 + 测试）
  commands.ts             命令注册表（⌘K 与 / 共用）
  session-flags.ts        Pin / Archive 持久化
  starters.ts             空态 starter 生成
  git-write.ts            stage / revert / commit 的服务端封装

components/
  TaskHeader.tsx
  DiffView.tsx
  CommandPalette.tsx
  ApprovalCard.tsx
  sidebar/{SidebarShell,ProjectList,TaskList,TaskRow,SidebarFooter}.tsx
  workspace/{RightPanel,ReviewPanel,ChangeList,TerminalPanel}.tsx
  composer/{ModelPicker,AttachmentBar,SlashMenu}.tsx
  settings/{SettingsSection,SettingsRow}.tsx

hooks/
  useFocusTrap.ts
  useTaskStatus.ts
  useCommands.ts

app/api/
  git/stage/route.ts
  git/revert/route.ts
  git/commit/route.ts
  terminal/[id]/route.ts        （阶段 3）
  search/route.ts               （阶段 3）
```

## 附录 B：现有关键文件（改动落点速查）

| 文件 | 行数 | 本轮角色 |
|---|---|---|
| `components/SessionSidebar.tsx` | 2164 | **拆分** → sidebar/* |
| `components/AppShell.tsx` | 2243 | 抽出 TaskHeader、顶栏收敛 |
| `components/ChatInput.tsx` | 2041 | **拆分** → composer/* |
| `components/ModelsConfig.tsx` | 2560 | **拆分** → settings/models/* |
| `components/FileViewer.tsx` | 1768 | 迁入右栏 Files，Diff 换 DiffView |
| `components/MessageView.tsx` | 1498 | Diff 换 DiffView，工具人话化 |
| `components/FileExplorer.tsx` | 1344 | 迁入右栏 Files，树语义 |
| `components/ChatWindow.tsx` | 1263 | 空态 starter |
| `hooks/useAgentSession.ts` | 1804 | 接三轴状态、审批事件 |
| `lib/rpc-manager.ts` | 1254 | 审批网关、失败态记录 |
| `app/globals.css` | 2835 | 对比度 token、布局兜底；建议按区域拆分 |
| `desktop/src/main.ts` | 829 | Tray / 单实例 / 窗口恢复 |
