# 桌面自动化测试

本入口是 [#247](https://github.com/kexijiang/Piora/issues/247) 的首批基础设施：复用 Piora Dev 启动器，以 Playwright/CDP 操作真实 Electron 主窗口，并记录断言、截图和清理结果。它独立于 Intelligent UI。

默认 `settings-theme` 场景通过设置按钮打开外观界面，点击深色主题，核对实际页面主题与持久设置，刷新后再次核对，再切换浅色并重复验证。它没有模型调用，不需要供应商凭据，也不直接写入主题状态。另有 Windows 专用的 `stop-shell` / `stop-bash` 停止场景，使用本地模型响应夹具和真实 shell 进程，见下文。

## 运行

在专用 worktree 安装锁文件依赖，使用 Node.js 22.19.0 或仓库支持的更新版本：

```powershell
npm ci
npm run test:desktop:e2e
```

命令会打开可见的 Piora Dev 窗口。不要在测试期间手动操作这个窗口。首次启动可能需要下载仓库指定版本的 Electron，并等待 Next 冷编译；默认整次运行期限为 10 分钟。这里编译的是开发所需的 worker 和桌面代码，不运行 `next build`，不生成发布安装包。

```powershell
npm run test:desktop:e2e -- --list
npm run test:desktop:e2e -- --scenario settings-theme --timeout-ms 600000 --step-timeout-ms 30000
```

默认从操作系统分配空闲应用与 CDP 端口。需要固定端口时使用 `--port 30241 --debug-port 9322`，占用时失败，不接管已有服务。`--timeout-ms` 覆盖准备、启动和场景；`--step-timeout-ms` 控制常规定位、导航和条件等待。超时后还会执行有界清理，因此进程总耗时可能略超期限。

当前支持中英文界面；原生系统对话框、其他语言、真实模型及发布包不在本场景范围内。Windows 实机结果和尚未执行的平台范围应在提交/PR 中如实记录。

首批实现的执行结果、首次下载失败及复测边界见 [2026-10-30 验证记录](verification/desktop-e2e-2026-10-30.md)。

## 隔离与退出

每次运行创建 `.verification/desktop-e2e-<随机编号>/`，其中包含独立的 Electron profile、Pi agent 目录、Next 输出和临时 tsconfig。不会复制本机模型配置、认证文件或个人会话；子进程环境只继承运行所需的系统变量，不继承供应商密钥、Node 注入选项及外部 Pi 路径覆盖。没有联网模型模式，也不宣称应用所有后台网络均被拦截。

同一 checkout 的测试运行器使用独占锁，拒绝并行运行。桌面 TypeScript 输出及开发预处理仍由原启动器管理，因此**不要在同一 checkout 同时运行普通 `dev:desktop`**；多个开发任务分别使用 worktree。这一首版不承诺同一 checkout 内任意开发进程的并发隔离。

成功、失败及 Ctrl+C/SIGTERM 中断都会清理本次创建的进程与 CDP 连接，核对两个测试端口已关闭，清理全部成功后释放锁。清理失败使整次结果失败并保留锁，报告中记录 `lockRetained: true`；已完成的步骤不能覆盖这个失败。强制结束测试运行器、机器断电等无法执行 finally 的情况也可能留下锁或进程。此时先检查 `.verification/desktop-e2e.lock/owner.json` 中的 PID 与运行记录，确认所属进程已停止后再移除这个锁目录；不要关闭其他任务的进程。

测试 profile、合成数据和诊断结果保留在本机供排查，不自动提交或上传。新增场景只能使用可公开的测试数据；截图与页面错误也可能含业务内容，分享前应检查。

## 查看结果与验证失败路径

命令最后打印状态、结果目录和失败步骤。退出码：通过为 0，失败为 1，正常处理的用户中断为 130；清理失败仍为 1。每次运行使用新目录，不用重跑结果覆盖失败。

| 文件 | 用途 |
| --- | --- |
| `result.json` | 场景、平台、Node、Git 提交与工作树变更、范围、逐步耗时、失败、页面错误、清理结果 |
| `report.md` | 简短可读摘要，明确已覆盖与未覆盖范围 |
| `progress.json` | 当前执行步骤；运行尚未结束时可读取 |
| `desktop.log` | 开发准备、Next、桌面编译与 Electron 的输出 |
| `dark.png`、`light-restored.png` | 通过场景的关键截图 |
| `failure.png` | 已获得可用窗口时的失败截图；启动阶段可能无法截图 |

结果中的 `mode: no-model` 表示没有调用模型，不代表真实模型验收。页面截图只是证据之一，场景还核对 DOM、radio 选中状态和 localStorage；不能以截图生成、页面无异常或 HTTP 200 代替业务断言。

可故意在一个已执行的步骤后失败，以核对报告和清理：

```powershell
npm run test:desktop:e2e -- --fail-at theme-dark
```

此命令应非零退出，报告包含 `Intentional failure` 和失败截图；它是失败机制检查，不能作为功能通过记录。不存在的步骤名称也会失败。

## 增加场景

### DSH Pet 桌面扩展

`node scripts/run-desktop-e2e.mjs --scenario desktop-extensions` 验证独立设置入口、无项目时的安装入口、默认开关、受限 IPC 和桌面认证的任务快照接口，不下载插件、不调用模型。原版插件安装和原生窗口 smoke 使用 `node scripts/verify-dsh-pet.mjs`，详见 [DSH Pet](dsh-pet.md)。

### Shell 停止回归（Windows）

```powershell
npm run test:desktop:e2e -- --scenario stop-shell
npm run test:desktop:e2e -- --scenario stop-bash
```

`stop-shell` 使用 PowerShell `Start-Sleep -Seconds 30`，`stop-bash` 使用 Git Bash 的 `sleep 30`。两者在隔离目录配置仅监听 loopback 的模型响应夹具，不复制用户凭据；模型响应固定生成工具调用。聊天发送、真实 SDK shell 工具、Stop 点击、取消接口及进程终止均不 mock。报告明确标注 `local-model-fixture`，不代表真实模型服务验收。

测试等待 PID 标记后才点击 Stop，并在运行器清理之前观察实际进程。Bash 使用 Windows 原生 PID，另取发送前后的 `sleep.exe` 差集；必须恰好出现一个新 sleep 进程，否则失败而不猜测归属。因此运行该场景时不要并行启动其他 sleep 命令。测试不主动结束这些 PID，以免清理掩盖取消失败；命令自身限制为 30 秒。

`stop-evidence.json` 记录取消请求/回执、进程存活、按钮状态与服务端状态。如果发送按钮恢复后进程仍存活超过 3 秒，会额外保存 `false-idle.png` 和同期服务端快照。3 秒内未退出是失败，即使 30 秒后自然退出也不能算通过。Windows Bash 修复前后的结果见 [停止验证记录](verification/desktop-stop-243-2026-10-30.md)。

场景文件位于 `scripts/desktop-e2e/scenarios/`，通过 `scripts/run-desktop-e2e.mjs` 显式登记；不从外部路径加载任意脚本。参考 `settings-theme.mjs`：

```js
export const example = {
  id: 'example',
  scope: '说明真实执行的链路',
  coverage: ['被验证的操作和结果'],
  limits: ['没有覆盖的能力'],
  async run({ page, step, waitUntil, reload, screenshot, signal }) {
    await step('change-setting', async () => {
      signal.throwIfAborted();
      // 示例：已通过 UI 打开外观设置的英文界面。
      await page.getByRole('radio', { name: 'Dark', exact: true }).click();
      await waitUntil(async () => await page.locator('html').getAttribute('data-theme') === 'dark', '深色主题生效');
    });
    await step('restore', async () => {
      await reload();
      // 在这里断言恢复后的值，而不是只等待刷新完成。
      await screenshot('restored.png');
    });
  },
};
```

使用可访问角色、标签或已有稳定属性定位，避免依赖动态标题和层层 CSS 结构。通过可观察条件等待，避免固定 sleep。模型生成、保存、审批等各功能自己的流程与业务期望放在场景内，不放进通用生命周期。需要接口准备数据或读取落盘状态时，应在 `scope`、`coverage` 和报告中标清；正在验证的用户操作不能用直接调用接口替代。

快速生命周期检查：

```powershell
node --test lib/desktop-e2e.test.mjs
```

该文件覆盖环境过滤、锁与端口冲突、进程终止、超时、中断、断言失败、启动失败、延迟资源获取、清理失败和报告状态；其中的生命周期适配器是测试夹具，不计为真实 Electron 场景通过。

## 后续范围

当前 PR 仅交付公共生命周期与一个非 Intelligent UI 桌面场景，不关闭 #247。待后续补充通用聊天操作、可控模型响应夹具、按需真实模型模式及预算、更多权限/文件场景、trace、自动重连和平台矩阵。首次引导由运行器正常跳过；本场景中的刷新验证也覆盖同一 profile 已完成引导后的入口，不等于跨进程重启恢复已验收。

真实模型接入后需明确记录实际模型、请求和失败，并遵守场景指定的模型和预算。语义、原生系统、硬件和发布包分别验收。CI 集成按项目安排另行处理，本次不修改工作流，也不把这个入口加入每次默认全量运行。


### 浏览器跨对话与重启登录保持

`npm run test:desktop:e2e -- --scenario browser-persistence --step-timeout-ms 180000` 使用两条独立准备的合成会话和仅监听 loopback 的测试站点。选中对话、打开浏览器、地址导航、登录及保存站点数据均通过真实 UI 执行；读取存储和会话绑定仅用于核对结果。测试不调用模型，也不复制真实浏览器 profile 或网站凭据。

场景先在对话 A 登录并写入站点数据，然后在对话 B 核对 HttpOnly 会话 cookie、localStorage 和 IndexedDB。确认独立 profile 中的加密 cookie 快照已写入后，运行器终止本次拥有的开发进程树，保留隔离 profile 再启动，重新核对三个存储边界。该重启是受控进程终止，不代表正常菜单退出、系统注销或突然断电。

`browser-persistence-evidence.json` 记录各阶段的合成数据核对；`result.json` 记录启动和重启 PID、每一步及清理结果。首个启动失败、重测和通过分别保留；没有运行到的阶段不能算通过。本场景不验证原 issue #275 的特定网站、企业 SSO、远端模型操控或发布包。特定网站复现需要单独记录是否为服务端过期、主动注销或身份策略导致。
