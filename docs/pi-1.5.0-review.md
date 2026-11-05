# Pi 1.5.0 升级与回归验证

日期：2026-11-05。环境：Windows、Node.js 24.5.0、npm 11.9.0。

## 改动范围

五个直接 Pi 依赖从 1.4.0 统一升级到 1.5.0；锁文件中的 `pi-codemode`、
`pi-telemetry` 和新增的 `pi-schema` 同样为 1.5.0。安装使用官方 npm registry。
显式固定 `typebox@1.3.27`，将第一方扩展、Harmony 参数契约、Shell Agent 和相关
测试的 `Type` 导入改为 `typebox`；保留现有 JSON Schema 定义和授权逻辑。

上游参考：

- [Pi 1.5.0 发布说明](https://github.com/earendil-works/pi/releases/tag/v1.5.0)
- [pi-ai 参数校验及流式解析变更](https://github.com/earendil-works/pi/blob/v1.5.0/packages/ai/CHANGELOG.md)
- [官方 npm 制品元数据](https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.5.0)

Pi 1.5 不再从 `pi-ai` 主入口导出 TypeBox，运行时工具参数由 `pi-schema` 校验。
新增测试同时验证 TypeBox 和普通 JSON Schema：无效参数不进入授权，数值字符串和
单个数组元素经校验转换后，仍须获得授权才能执行。既有测试继续覆盖扩展修改后的
最终参数、嵌套调用、拒绝即停止、过期授权和取消，不改变权限策略。
另外通过真实 SDK 扩展加载器验证第三方扩展的旧 `Type`、`Static`、`StringEnum`
导入兼容入口。此兼容不扩展到上游已经移除的非 JSON Schema 验证特性。

之前的模板选择器、隐藏聊天冻结、历史展示结果复用和滚动位置优化全部保留。
升级后的浏览器测试重新覆盖这些行为。添加本轮更新说明前，已将原有已跟踪文件的
渲染改动与升级前保存的 diff 逐字节对照，一致。历史分页不在本轮范围内。

## 制品完整性与 Windows 补丁

先下载未经 postinstall 修改的官方 tarball，核对 SHA-512，再使用既有
`piTreeCommitment()` 计算完整源码树。审查值保存于
`scripts/pi-source-profile-1.5.0.json`，旧证书保留供历史文档追溯。

| 项目 | 1.5.0 审查值 |
| --- | --- |
| package.json SHA-256 | `990aac3caff17b717294fa792b4e3f60b991d274d9f4ab6977d6aa42aa43c95e` |
| 非 bundle 的 dist 文件 | 1021 |
| 非 bundle 的 dist SHA-256 | `6c91c13da9ceb79ecaff0754bfc30bf7f786f04c4e17fef78b5bdc59fbfa6e3f` |
| 原始 bundle 文件 | 82 |
| 原始 bundle SHA-256 | `cd4500c9221e2fda63bdcd33f3af25cad02356e45f11aee9711b77b0f2c6dc2f` |
| 上游声明及实际解析的 Undici | 8.12.3 |

官方 `dist/core/tools/bash.js` 与 1.4.0 原始文件逐字节一致，SHA-256 仍为
`f32e87a42f66276b2eafaaf0848babf52523d37ab0fd448439586376747f03c4`。
因此继续使用原有 Windows MSYS 子进程取消补丁，没有放宽哈希、补丁逆向、
符号链接或额外文件检查。postinstall 成功应用新证书和原有补丁。

## 验证与证据

详细运行日志位于本地 `.verification/pi-1.5.0/`。测试使用独立临时配置和工作目录，
模型回复来自受控夹具，不调用收费模型或修改用户真实会话。

| 分组 | 结果 | 本地日志 |
| --- | --- | --- |
| SDK 会话生命周期、版本对齐、工具权限及独立模型审查 | 30 通过 | `sdk-first-pass.log` |
| 大参数 HTTP/SSE、流式取消、TypeBox / JSON Schema 授权 | 4 通过 | `streaming-schema.log` |
| 第三方扩展旧 TypeBox 导入 | 1 通过 | `legacy-extension.log` |
| Windows Bash、模型取消、消息恢复、群聊隔离与路由 | 72 通过 | `cancel-recovery-rooms.log` |
| 聊天渲染、设置切换、浏览器恢复、滚动位置 | 108 通过 | `rendering-recovery-browser.log` |
| 扩展加载、发送存档、群聊请求卡片与持久化 | 34 通过 | `extension-receipts.log` |
| MCP、独立源码依赖闭包、压缩、启动和 Shell Agent | 58 通过 | `integration-packaging.log` |

以上累计 307 项通过，最终结果无失败、取消或跳过。新增兼容测试前四项和最后一项
分开运行，分别保留日志，不重复累计中间复测。

新增的 `lib/pi-1.5-compatibility.test.mjs` 使用真实本地 HTTP/SSE 服务、安装后的
Anthropic 协议解析器、真实 AgentSessionWrapper 与 SessionManager：

- 工具参数包含超过 500 KiB 的中文、emoji、转义字符和换行，拆成数千个小片段。
  统计增量解析器实际收到的字符总数，断言恰好等于完整参数长度，防止重复解析前缀。
  同时检查早期参数快照不可变、工具只执行一次、实际文件内容和磁盘恢复内容一致，
  历史不含原始 `partialJson` / `partialArgs`，恢复不重放已完成工具。
- 参数尚未完整到达时取消：HTTP 连接关闭，工具不执行，原始用户消息及
  `clientPromptId` 已落盘，后续请求不会执行残留工具。
- 授权前校验与转换、旧扩展导入分别独立验证。

真实 Windows Bash 测试覆盖主动取消、超时、嵌套管道、exec 和嵌套 exec，检查
子进程在操作结束时已经退出，同时保持无关 sleep 进程存活。Shell Agent 的测试使用
真实终端执行边界，模型回复受控。群聊测试覆盖私有历史隔离、跨群归属、转交轮次、
重连、成员替换以及相同请求 ID 的独立响应；不等同于在线多模型群聊验收。

类型检查 `node_modules/.bin/tsc --noEmit --incremental false` 通过。改动文件定向
ESLint、许可证生成与一致性检查通过。许可证清单包含 1269 个去重包。
运行时依赖审计通过项目的 high 阈值，没有高危/严重项，但存在 6 项 moderate
告警，位于既有 `hypium-driver -> archiver/archiver-utils/zip-stream -> glob/minimatch`
依赖链。已与升级前锁文件逐项比较，这些记录完全未变；本轮未执行 `audit fix --force`
建议的 Hypium 降级。详见 `audit.log`。

首次新增测试发现的是夹具问题：授权回复应使用 `extension_ui_response`，旧扩展
参数校验应传入完整 ToolCall；修正后断言保留。大参数 HTTP 场景在初始 10 秒等待
期限内仍持续接收分片，后将该场景的功能等待期限调整为 30 秒，保持内容、次数、
快照和解析量断言不变，复测通过。此项不作为 CPU、内存或耗时基准结果。
首次失败和中间复测日志保留在 `*-initial.log`、`streaming-schema-timing.log`。

发布准备阶段同步主线 `c39a8bc9` 的 Alpha 版本记录，统一为 `0.5.10-beta.1`，
保留两组功能代码。追加发布相关检查共 12 项，其中 11 项首次通过，适配器启动
测试首次触及既有 15 秒子进程超时，单独复测通过，未修改超时或断言。
版本元数据、发布说明生成、许可证和发布树卫生检查通过。日志位于
`.verification/release-0.5.10-beta1/`。上述结果不重复计入前面的 307 项。

## 验收边界

本地没有运行 `next build` 或构建发布安装包。本记录描述发布前的本地验证；
后续 `v0.5.10-beta.1` 的构建、安装包验证与发布由 GitHub Actions 执行，实际结果以
对应提交的工作流为准。尚未进行真实供应商模型、物理鸿蒙设备或其他操作系统的本地验收。
独立依赖闭包验证的是 SDK、CLI/RPC、codemode WASM 和本地 MCP 运行能力，
不能代替完整 Electron 发布安装包验证。当前安装版不会因工作区依赖修改而自动升级。
