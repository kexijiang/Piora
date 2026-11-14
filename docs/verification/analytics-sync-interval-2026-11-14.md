# 可配置组织统计同步间隔

原实现同时在客户端、后台表单和 API 契约固定了 25/35/120 分钟的边界。现在表单允许任意正整数分钟；客户端与 API 接受正整数秒，校验顺序、安全数值及可表示的截止时间。默认建议仍为 25–35 分钟，已保存的组织范围才是执行值。

客户端每次请求声明 `X-Piora-Capabilities: configurable-sync-interval`。后端对旧客户端返回原实现可接受的兼容范围；升级后的请求会取得管理员原始策略，不要求重置安装或重新登记。超过单个 Node 定时器范围的等待分段计时，保留原截止时间。

本地验证：

- `node --test lib/analytics-sync-policy.test.mjs lib/analytics-telemetry.test.mjs`：17 项通过。包含短于 25 分钟、长于 120 分钟、反向/非正/非法时间范围、5–15 分钟策略请求头/ACK/下一轮调度，以及 60 天截止时间的分段等待且不提前联网。
- `node scripts/prepare-branding.mjs` 后 `node_modules/.bin/tsc --noEmit -p desktop/tsconfig.json` 通过。首次检查因全新 worktree 缺少忽略的 generated/brand 模块失败；生成后复测通过。
- 后端独立合成数据库 HTTP 回归通过，覆盖策略保存/读取、注册重放与上报中的新旧能力协商、跨范围更新，以及非正与倒置范围拒绝。
- 后台真实浏览器回归通过，覆盖 5–15、180–1440、1–1 分钟保存，刷新恢复、已保存提示与未保存输入分离、倒置范围提示。PG 测试使用专用空库，浏览器 API 端口与本机联调服务隔离。

没有在开发目录执行 next build 或本地构建安装包；当前安装版 beta.5 仍属于旧客户端。GitHub CI 与新版安装包结果以其实际工作流为准，不能由本地夹具结果代替。
