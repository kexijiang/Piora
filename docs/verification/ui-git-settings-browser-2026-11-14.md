# Git 图标、数据设置与浏览器菜单验证

日期：2026-11-14（Asia/Shanghai）。代码基于 `8c913c9c`；本次修改留在本地，未提交或发布。

## 实现

- Git 工具采用统一的 16px SVG 网格，重新绘制分支、文件更改和推送图标，统一行高、间距和视觉中心。工作树列表图标对齐分支名称；窄窗口的工具按钮保持内容宽度。
- “数据与诊断”移除完整备份与迁移、旧版界面偏好、本地凭据库、组织统计四个区块，以及已失效的设置搜索项。更新中文、英文说明、README 和相关使用文档。浏览器模式隐藏已无可用控件的数据页，旧入口回退至应用行为。
- 右侧工具菜单打开时，通过现有 BrowserPanel `active` 状态立即隐藏原生 WebContentsView。组件和网页保持存活，关闭菜单恢复视图；切换工具或收起面板关闭菜单，Esc 返回触发按钮。菜单定位改在绘制前完成。

## 验证

| 检查 | 结果与范围 |
| --- | --- |
| `lib/settings-search.test.mjs`、`components/SettingsPortabilityCard.test.mjs` | 12 项通过；旧入口不可搜索、数据页保留有效项目，底层旧版导入逻辑原有断言保留。 |
| `components/ConversationSettings.browser.test.mjs` | 复测通过；真实 SettingsDialog，注入桌面桥和 API 夹具，验证四个区块与搜索结果消失、目录/日志仍可访问且不触发旧卡片请求。 |
| `components/SidebarDisclosure.browser.test.mjs`、`components/AppShellSessionSelection.browser.test.mjs` | 2 项通过；包含中英文、主题/字号下的 Git 工具对齐和工作树交互。 |
| `components/workspace/RightPanel.browser.test.mjs` | 复测通过；真实 RightPanel、BrowserPanel 和 viewport 队列，注入原生桥、其他工具使用空组件。验证中英文菜单、延迟 resize 回复、窗口缩放、网页状态更新、Esc、外部点击、重复开关、切换工具与收起/恢复面板。 |
| `components/workspace/RightPanel.test.mjs`、`lib/browser-viewport-sync.test.mjs`、`lib/desktop-browser-visibility.test.mjs`、`lib/browser-extension.test.mjs` | 45 项通过；包括原生视图管理器的脱离/恢复与网页保留，Electron 对象为测试夹具。 |
| 修改的 TS/TSX 与测试、脚本定向 ESLint | 通过。 |
| `git diff --check`、`node scripts/changelog-fragments.mjs check` | 通过。 |

Git 视觉预览使用实际 React 组件、CSS、打包的 Inter 和 Windows 字体，工作树接口为夹具。共核对 11 张截图：浅色/深色/天空主题与 14/16/18 字号、展开列表及 390px 窄窗口。产物：`.verification/git-icon-alignment-20261114/final-*.png`。设置截图：`.verification/chat-settings/data-diagnostics.png`；菜单截图：`.verification/tool-menu/zh-CN.png`、`en.png`。

首轮设置测试因页面和导航均显示相同的空搜索提示而定位歧义，限定到主内容后通过。菜单测试最初使用了错误按钮名称，修正为实际“打开工具”后，在修改前稳定复现菜单打开但原生视图仍可见；修复后再次暴露初始化语言切换会调用两次 `set_session` 的夹具假设，改为比较菜单操作前后的完整调用记录，复测通过，仍严格要求菜单操作不增加任何导航/重载调用。

未运行完整 CI、整仓类型检查、真实开发 Electron 或安装包验收；未执行 `next build` 或本地发布包构建。`scripts/test-organization-analytics-ui.mjs` 已同步新设置页断言，本轮未运行该独立桌面场景。

## Pi 版本核对（未升级）

项目五个直接依赖 `pi-agent-core`、`pi-ai`、`pi-coding-agent`、`pi-mcp`、`pi-tui` 的声明、锁文件和本机安装均为 **1.5.0**。官方 npm registry 的最新正式版均为 **1.5.2**。要求 Node.js `>=22.19.0`；本机 `v24.5.0` 满足要求。

- [Pi 1.5.2 发布说明](https://github.com/earendil-works/pi/releases/tag/v1.5.2)：缺失工作目录时的会话派生/导入修复，Anthropic OAuth 客户端版本修复。
- [Pi 1.5.1 发布说明](https://github.com/earendil-works/pi/releases/tag/v1.5.1)：包含 Windows 文件查找/PowerShell、OAuth 刷新、工具读写等修复；同时改变默认空闲缓存预热、空 tools 字段行为，并弃用 GrepOperations 的上下文 readFile 回调。项目源码未发现自定义 GrepOperations/readFile 适配，但供应商与缓存预热行为仍需升级回归。
- `scripts/pi-source-profile.mjs` 显式加载 `pi-source-profile-1.5.0.json`，检查官方 package.json、源码树和 bundle 摘要。升级须先校验 1.5.2 官方制品、更新证书、复核 Windows Bash 取消补丁，并同步锁文件与许可证清单；不能只改依赖版本后继续沿用 1.5.0 校验记录。

结论：有可用正式更新，运行环境满足要求；本轮完成版本和升级边界核对，依赖尚未升级，也未把 1.5.2 写成已通过兼容性验收。

后续已按新的升级请求完成工作区适配，见 [Pi 1.5.2 升级与回归验证](../pi-1.5.2-review.md)；上文保留当次版本核对时的状态。
