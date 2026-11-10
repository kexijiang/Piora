# 浏览器登录、会话精简与过程展示验证（2026-11-10）

## 修改范围

- 桌面内置浏览器登录等待自动展开当前会话浏览器，聊天区不展示登录卡片；固定的只读检测连续两次确认可见登录状态后，继续原来的工具调用。取消、停止、超时和被替换的等待均不会被迟到结果恢复；等待 5 分钟仍未识别时提供可手动继续的单行轻提示。支付等非登录接手仍为明确的业务确认。
- 删除输入框的批准模式、新会话默认模式存储、人工工具批准门禁、独立模型审批与审批历史接口。旧权限文件不会影响新旧会话。普通扩展业务提问、工具参数校验、扩展工具调用处理和停止语义继续由 SDK 管理。
- 删除设置中的能力包菜单、搜索项及加载入口。删除新会话介绍段落和快捷卡片及其 Git/项目信息请求，保留项目与模型选择、附件、恢复草稿和发送。
- 同一用户轮次的思考、工具调用和中途说明共用一个过程区，完成时整体收起，正式回答在外部显示；生成中的思考自动展开，文本或工具开始后折叠。可再次展开完整过程和具体工具详情。
- #376：使用 57 个 Material Icon Theme 上游 SVG 的本地精简子集，合并后的 sprite 约 39 KB；文件类型、特殊目录和目录展开状态有不同图形与配色，浅色 TOML 变体跟随应用主题。附完整 MIT 许可证、固定提交和逐源哈希。
- 暂时隐藏“设计转鸿蒙”的右侧工作区和命令入口，旧保存标签不再恢复到设计面板；面板、命令动作、API 和转换实现均保留。

## 参考与来源

- [Material Icon Theme 固定来源](https://github.com/material-extensions/vscode-material-icon-theme/tree/ced21b9b5241c1efa502a8c46ec7363a690a7058)，完整图标来源与转换说明见 `public/file-icons/SOURCE.md`。
- [PI Desktop 的整轮过程折叠实现讨论与修改](https://github.com/vastsa/PI-Desktop/pull/1793)：参考其过程与正式回答分层及嵌套展开的交互。Piora 的实现沿用现有消息投影、虚拟列表和披露组件。

## 本地检查

| 检查 | 结果 |
| --- | --- |
| 直接相关单元与集成回归 | 291 项通过，见 `.verification/targeted-tests-final.log` |
| 输入恢复与真实 Pi 1.5 参数/流式/取消兼容性 | 17 项通过，见 `.verification/approval-compatibility-final.log` |
| 浏览器等待、控制器、序列化与 preload 回归 | 60 项通过，见 `.verification/browser-bridge-final.log`；包含实际 IPC 参数传递及普通确认等待 |
| 组件浏览器回归 | 5 项通过，见 `.verification/browser-tests-final.log`，包含统一折叠、实时思考展开/收起、新会话发送、图标和静默登录提示 |
| 登录超时轻提示补充回归 | 1 项通过，见 `.verification/login-fallback-final.log`；初始静默、5 分钟后手动继续及准确工具调用 ID |
| 同步 #378 后状态与等待回归 | 29 项通过，见 `.verification/post-sync-tests.log` |
| 右侧入口与命令回归 | 11 项通过，见 `.verification/hidden-design-entry.log`；设计面板实现保留，工作区、命令面板和旧标签恢复入口隐藏 |
| Web TypeScript / desktop TypeScript | 通过 |
| 修改文件 ESLint | 通过 |
| 许可证清单一致性 / git diff --check | 通过 |

图标截图：`.verification/file-icons/light.png`、`dark.png`；统一折叠截图：`.verification/automatic-process/completed-folded.png`。

## 原生桌面记录与边界

`browser-login` 场景使用真实 Electron 45.2.3、真实 SDK、本地确定性模型及 loopback 登录网站。发送、设置返回、登录和继续均经 UI，接口及只读页面状态用于核对；登录数据为合成数据。

- `.verification/desktop-e2e-e7qRis`：启动失败；共享依赖链接不在 Turbopack 根目录内。后续按锁文件安装本工作树依赖，未改生产构建配置。
- `.verification/desktop-e2e-2UPKKK`：夹具把全页设置当成对话框，未点击返回，导致输入框不可见；修正为点击真实“返回 Piora”。
- `.verification/desktop-e2e-rmVdXD`、`desktop-e2e-NHMX54`：原生验证发现等待类型在 preload 与服务端 IPC 字段名单中遗漏；补齐两端字段并增加真实序列化回归。
- `.verification/desktop-e2e-wV6vpV`：通过。自动展开浏览器、登录时没有卡片或继续按钮，通过原生页面登录后自动快照和回复；清理无错误。本轮末尾标题生成请求超出最初的浏览器模型夹具范围，日志中有捕获的标题错误；随后为夹具单独支持标题响应。
- `.verification/desktop-e2e-ztJFOM`：最终复测通过，39.5 秒完成；5 个阶段全部通过，浏览器场景依次执行 open → wait_for_user → snapshot → final；清理无错误，锁已释放。标题响应夹具已单独支持，最后验证阶段未触发额外标题请求。
- `.verification/desktop-e2e-YqX9RJ`：同步 #378 后复测通过，63.8 秒完成；5 个阶段全部通过，原生登录自动恢复，清理无错误，锁已释放。模型夹具包含多次 final 响应，未发生重复浏览器操作。

这些结果不代表真实账号、第三方 SSO、后台 Playwright 接手、其他平台或发布安装包验收。无法识别登录成功控件的网站会继续等待，不能仅凭跳转或关闭登录框判断成功。本任务没有运行 next build 或本地发布包构建。

## 远端同步

提交前同步了主分支 `46ab5de3`（#378 模型能力开关与停滞等待提示）；保留其 ChatWindow 状态展示变更，并补跑对应状态回归与最终原生登录场景。
