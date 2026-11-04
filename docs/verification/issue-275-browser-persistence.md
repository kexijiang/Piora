# #275 桌面浏览器登录保持验证

2026-11-04，Windows 10.0.26340 / Electron 45.0.0 / Node 24.5.0，开发桌面，独立 worktree 和隔离 profile。未复制真实网站凭据，未调用模型。

命令：`npm run test:desktop:e2e -- --scenario browser-persistence --timeout-ms 900000 --step-timeout-ms 180000`。

| 运行目录（本地 .verification 下） | 结果 | 范围 |
| --- | --- | --- |
| desktop-e2e-qYR3Fb | 启动失败 | 依赖目录链接不被 Turbopack 接受，Electron 下载失败；无业务步骤通过，清理无错误 |
| desktop-e2e-5tsTRw | 启动失败 | 开发启动器替换 Electron 后连接关闭；无业务步骤通过，清理无错误 |
| desktop-e2e-TyCdd1 | 通过，213794 ms | 登录 A、切换 B、加密快照落盘、独立 profile 进程重启、重新登录态核对全部通过；页面错误与清理错误均为 0 |

另有一次在依赖复制尚未完成时的测试导入失败（playwright-core/lib/bootstrap 未就绪），没有进入场景，不计为功能结果。依赖复制完成后，运行器及夹具的 18 项定向测试通过。

通过运行在三个阶段都观察到 authenticated=true、local=retained、indexed=retained。站点登录由真实 UI 表单产生 HttpOnly 会话 cookie；localStorage 和 IndexedDB 由站点按钮写入。两条合成历史仅用于准备，UI 选中后检查实际 browser sessionId，分别导航不同路径避免错读上一条会话的浏览器页。

重启只终止该次运行拥有的开发进程树，并使用原隔离 profile 启动；不是模拟正常菜单退出、系统注销或断电。截图只辅助记录，主要证据是页面登录状态、会话绑定、存储核对和 result.json。原始产物留在本地，仓库仅提交不含凭据的摘要。

未复现原 issue 的具体网站失败，未覆盖企业 SSO、远端模型操作或安装包。本 PR 不重写 profile 或改变 cookie 策略，issue 保持打开。后续特定站点复现应记录是否为服务端过期、主动退出、身份策略或跨域限制，而不是直接认定客户端持久化失败。
