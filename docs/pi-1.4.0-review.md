# Pi 1.4.0 升级与源码证书审查

## 官方制品与完整性边界

本次将五个直接依赖与两个传递依赖（`pi-codemode`、`pi-telemetry`）统一锁定到
1.4.0。审查来源为 [Pi v1.4.0 发布记录](https://github.com/earendil-works/pi/releases/tag/v1.4.0)、
[官方 npm 元数据](https://registry.npmjs.org/@earendil-works/pi-coding-agent/1.4.0)
及其 `dist.tarball` 指定的原始压缩包；不是已执行 postinstall 的 `node_modules`。

先以 npm 元数据及锁文件共同记录的 SHA-512 校验压缩包，再用现有
`piTreeCommitment()` 按路径排序、提交每个文件的精确字节，得到：

| 项目 | 1.4.0 审查值 |
| --- | --- |
| `package.json` SHA-256 | `df6883685382d6a914e5797232744c26579fe7db5576ea0e9c859d018ca2d54e` |
| 非 bundle 的 dist 文件 | 1013 |
| 非 bundle 的 dist SHA-256 | `795a9d57a5dd53d1b5936b50b3fb076838e1909622b63a9efca0db50bf53040a` |
| 官方原始 bundle 文件 | 81 |
| 官方原始 bundle SHA-256 | `62384add82b4421ecea892459621e35f0c4d612b82ace719c846d4b4abf23b02` |

完整 tarball 地址和 SHA-512 写入 `scripts/pi-source-profile-1.4.0.json`。
本次只替换证书版本和审查值；验证器的清单、源码树、原始 bundle、精确启动器、
真实目录及符号链接拒绝逻辑不变。旧版证书明确拒绝新版 manifest 正是原 PR
安装失败的原因，不能通过放松校验修复。

官方包仍声明 Undici 8.10.2；Piora 继续使用已审核的 8.12.3，并从 Pi 的实际
解析位置核验该版本。官方未捆绑 SDK 源码保持原样，三个 bundle 入口继续由
精确启动器导向这些源码，以免旧的内嵌依赖绕开锁文件覆盖。此项是
`docs/undici-8.12.3-review.md` 所记录的 1.3.0 基线之后独立审核的 SDK 升级，
不是将未审核 bundle 重新标记为安全。

七个 Pi 包、新增的 `marked-cjk-friendly@0.1.2` 和原有 `quickjs-wasi@3.6.2`
均与官方 registry 元数据逐项核对完整性；这九项制品地址统一为
`registry.npmjs.org`，不修改完整性值。许可证清单由最终锁文件重新生成。

## API 与行为核对

对官方 1.3.0 / 1.4.0 压缩包内的声明及实现做了对比：公共 `index.d.ts`
及扩展接口声明未改变；AgentSession 的声明变化仅涉及内部恢复工具结果处理。
`createAgentSessionServices` / `createAgentSessionFromServices`、异步 steer/followUp、
取消、扩展工具和嵌套审批接入继续使用既有接口，不新增 SDK 私有补丁。

需要明确核验的行为变化是摘要：

- `shouldCompact` 仍以严格大于 `contextWindow - reserveTokens` 判定；Piora 保存的
  全局预留量继续通过真实 SettingsManager 生效，关闭自动压缩时不触发。
- `generateSummary` / `generateSummaryWithUsage` 保留参数位置，但预留量参数改为
  `number | undefined` 且不再限制输出；摘要请求不提供人为 `maxTokens`，由模型的
  输出上限控制。此项不改变 Piora 的压缩触发阈值设置。
- 分支摘要同样移除固定输出限制；其 `reserveTokens` 仍参与输入预算，不应误写成
  在所有摘要流程中都完全忽略该参数。
- 分段 turn 仅有新前缀、没有新历史时也必须保留 `/compact` 自定义指令。
  输出达到 token cap 的不完整摘要仍必须被拒绝，不允许成为持久化检查点。

`lib/pi-compaction-compatibility.test.mjs` 调用安装后的真实 SDK 公共函数，注入
受控模型流并观察实际请求、usage 与失败结果，不用字符串匹配源码代替运行行为。
`lib/pi-source-profile.test.mjs` 保留独立依赖闭包、CLI/RPC 启动器、codemode WASM、
本地 MCP、嵌套管线验证，并增加 manifest 精确字节、额外/缺失源码和源码链接拒绝。
`lib/pi-version-alignment.test.mjs` 同时核对七个实际安装包、锁文件及当前证书。

## 验证范围

按仓库 CI 使用 Linux x64、Node.js 22.19.0。完整本地命令和结果记录在本次 PR
验证说明中；历史环境的测试通过不计入本次结果。浏览器沙箱限制及 Windows
原生/安装包验证由用户授权交给最终提交的 GitHub CI 补齐；跳过不记为通过。
不运行本地 `next build`，不生成本地发布包，不宣称真实设备或 Windows 已验收。
