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

自动化环境设置 `PIORA_DESKTOP_DEV_COMPILE_ONCE=1`，桌面代码仅在启动前编译一次，避免 TypeScript 监听中的目录变化在操作途中重启 Electron；Next 仍运行开发服务器。测试期间固定被测源码。普通 `npm run dev:desktop` 不设置此选项，继续提供桌面热重载。

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

### Intelligent UI 小程序

`npm run test:desktop:e2e -- --scenario intelligent-ui-mini-app` 在隔离配置中运行真实 Next/Electron、生产小程序扩展、QuickJS/WASM 和 iframe。模型服务是仅监听 loopback 的固定响应夹具，不复制用户凭据；此场景不代表 DeepSeek V4.1 的形式选择或生成质量验收。

被验证的操作通过 UI 完成：开启 Beta、发送请求、修改起始值、点击加一、保存、刷新、追问当前结果、关闭并重新开启 Beta。模型夹具根据生产上下文中的已确认结果回答，测试断言恢复后的值和追问结果，同时确认解释没有生成第二个界面。配置读取只核对开关是否持久化。

报告记录固定模型请求摘要、步骤、截图和清理结果。三维、持续模拟、多窗口恢复、迁移、安装包和其他平台不在此场景内。开发编译可能在主界面挂载前重启 Electron；启动器此时重新连接 CDP，进入场景后的重启仍按失败处理，不重放已执行步骤。

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

### 会话复制、导出与回收站组合（开发中）

2026-11-03 后续修复通过公共回答上下文协调生成及历史/状态同步期间的操作，保留界面与草稿，并暂停自动播放。生命周期场景最终 RV39D2 完成 11 步，包含最终追问完全收尾；修订与恢复场景 lJHHGD 完成 10 步。复测与失败记录见[对话边界报告](verification/intelligent-ui-phase3-conversation-boundary-2026-11-03.md)。Electron 的持久分区不能直接使用 Target 返回的 context ID 配置 Browser 下载行为；本场景使用 Page.setDownloadBehavior 指向隔离目录，并核对实际 HTML 文件的静态说明和确认值。CDP response.text() 在本机返回空内容，不用它代替真实文件检查。右键父会话会选中父会话，核对子会话保留草稿前需通过 UI 切回子会话。

`npm run test:desktop:e2e -- --scenario intelligent-ui-session-lifecycle` 复用独立开发桌面和确定性本地模型，通过真实 UI 串联复制、消息内分叉、历史 HTML 下载、子树回收与恢复。发送前返回 503 的传输夹具检查保存失败是否阻止后续操作，接口读取仅核对结果；保存失败后应验证保留的静态检查点，不应假定 iframe 仍可操作。HTML 下载通过 CDP 定向到隔离目录，不覆盖原生保存对话框。

2026-11-03 修复前运行 `.verification/desktop-e2e-me9R4C` 在追问后的保存收到 409，并因等待已保存超时失败；后续分叉、下载、回收与恢复没有执行。更早一轮曾执行分叉隔离及阻止导出，但实际下载返回 500；当时模块加载已调整，尚未通过完整桌面复测。所有历史失败与范围见[会话生命周期报告](verification/intelligent-ui-phase3-session-lifecycle-2026-11-03.md)，本批完整复测见上段，不能把场景的 coverage 声明当作通过记录。历史原始报告误继承其他场景的 transport 说明，本场景报告说明已修正，旧结果不覆盖。

### 原生窗口恢复场景（开发中）

2026-11-03 增加 Windows 启动层的遮挡计算兼容处理后，`y85I5f` 与 `FCn6fg` 两次完整五步通过，覆盖最小化、关闭隐藏、同实例恢复、保存、刷新及追问；未弱化可见性与输入释放断言。独立 Electron 回归 `node --test lib/desktop-window-visibility.test.mjs` 另外检查显式隐藏时停止帧交付，后台节流仍开启。首次 `sbTmee` 在保存环节失败，原因未确定，保留记录；场景现会采集状态、运行器及动作错误码并立即失败。处理会使被其他窗口遮住但未最小化/隐藏的窗口继续绘制。详见[本批报告](verification/intelligent-ui-phase3-native-window-2026-11-03.md)，并不代表全部恢复矩阵或其他平台完成。以下原生窗口记录为本次修复前的历史证据。

`npm run test:desktop:e2e -- --scenario intelligent-ui-window` 使用本机固定模型夹具，在 Windows 独立开发桌面检查持键操作、最小化、关闭隐藏、恢复及保存。PowerShell 7 辅助器仅操作本次 launcher 子进程中、调试端口及应用窗口标题匹配的 Electron 主窗口；不操作其他桌面实例。此场景通过 `noDefaults: true` 连接 CDP，避免 Playwright 的焦点模拟掩盖原生页面隐藏事件。

恢复使用相同隔离 profile 的第二实例激活生产单实例处理器，并核对原有进程和窗口身份；第二实例只有测试凭据，不使用服务器认证令牌。隐藏期间、恢复前即核对输入释放与暂停，再检查原生窗口、页面可见性和焦点。页面可见性不一致仍使场景失败，不能仅凭窗口重新出现判定通过。

2026-11-02 最近诊断仍失败：`.verification/desktop-e2e-T0AtUB/result.json` 中最小化时输入释放与暂停已观察到，但原生状态与页面可见性不一致；第二实例退出成功、原窗口恢复后，保存按钮等待稳定超时，未继续关闭隐藏、刷新及追问。当前提交重新保留诊断期间暂时移出的页面可见性断言，完整原生场景未复跑通过。历史 `.verification/desktop-e2e-yMysWr/result.json` 的关闭隐藏恢复失败也保留。不能直接归因于产品或 Electron；未验证托盘菜单、完整进程重启及发布包。详见[补充报告](verification/intelligent-ui-phase3-checkpoint-followup-2026-11-02.md)。

原始组件重放在精确标题内要求唯一可编辑控件，避免把同名失败预览当成已发布结果；不使用首个匹配规避歧义。小程序重放允许为文字输出提供正则断言，独立计算的保存状态仍精确核对，超时和语义问题分别保留。

新增 `npm run test:desktop:e2e -- --scenario intelligent-ui-recovery`，用确定性本地模型串联保存响应丢失、刷新查回执、取消候选后再次修订、过期确认拒绝、重新核对并迁移进度，以及刷新后的继续编辑和追问。响应丢失夹具必须保留 Electron 的真实认证请求，仅在生产保存完成后损坏返回数据；不直接注入检查点或回执。它不验证真实模型质量或原生窗口最小化。两视图保存冲突与旧版草稿导出另由实际 React/生产 API 浏览器测试覆盖。

该场景发现并验证了普通对话结束后旧小程序保存位置未刷新的问题；最终也检查追问后再次编辑能成功保存。夹具准备失败、修复前产品失败和修复后通过分别记录，见[恢复与修订交叉报告](verification/intelligent-ui-phase3-recovery-cross-2026-11-03.md)。

按需试算使用绑定顶层 `actionEvidenceMode: "on-demand"`。用例的 `expectInspection: false` 要求当前状态问题不调用工具；`true` 要求明确后果问题实际调用只读工具。`expectedInspectionActions` 指定必须核对的按钮，仍用 `actionChanges` / `fieldEffectPaths` 给出独立预期。运行器核对实际供应商请求包含当前策略、默认状态没有自动预演、工具调用与结果一一对应、没有重建界面或外部动作，并等待最终回答与状态同步结束后检查原快照和版本未改变。未请求的操作不执行，也不伪装为已覆盖。未指定此模式时保留历史验证行为。见[按需试算报告](verification/intelligent-ui-phase3-on-demand-2026-11-03.md)；功能断言通过不能代替整份回答的语义审阅。

预演 version 2 的绑定使用 `actionChanges`：按事件 ID 和 JSON Pointer 指定独立的 before/after 值。运行器核对真实请求中的变化；只有变化完整时，才允许用“没有该条变化”验证值不变。数组路径按位置解释，不推断稳定行身份。五份原始量杯/棋盘/排序的差异验证及语义问题见[差异复测报告](verification/intelligent-ui-phase3-action-changes-2026-11-03.md)。旧 `actionPreviews` 保留用于完整快照格式的历史验证，版本间不能直接混用断言。

可选 `fieldEffectPaths` 列出应出现在宿主字段表中的 JSON Pointer；运行器用相同 `actionChanges` 独立预期检查保留集合、新值和未知边界，不从模型文字生成预期。被省略字段不等于不变；这仍是证据传输检查。本批真实复测仍有明确错误解释，另发现原程序混淆历史达成与当前条件，见[字段影响报告](verification/intelligent-ui-phase3-field-effects-2026-11-03.md)。

状态目标的轨迹需要继续覆盖达成后的保留、失效、重置和刷新，而不是在首次成功时停止。三份新量杯的 63 项操作与当前状态追问见[当前条件报告](verification/intelligent-ui-phase3-current-condition-2026-11-03.md)。追加视觉采集时，先滚动外层卡片，再定位 iframe 内部；离屏 iframe 的稳定等待可能超时。元素截图仍受聊天滚动容器裁剪，采集命令成功不代表完整图片或视觉验收通过。

局部预演验证可在绑定中提供 `actionPreviews`，按事件 ID 指定独立预期路径和值。运行器检查真实模型请求里的来源、状态版本及每个结果，并在追问后重新读取检查点和版本，确认没有写入预演结果。2026-11-03 三份量杯的证据传输与状态保持通过，但两份回答仍有明确错误，另一份建议有歧义；机械链路通过不能改写为语义通过。详见[只读预演报告](verification/intelligent-ui-phase3-action-preview-2026-11-03.md)。

显式绑定入口 `node scripts/verify-recorded-mini-app-tasks.mjs --bindings <json>` 还支持原生键盘 `key`、选项 `select` 和指针 `drag`。拖动使用绑定声明的 SVG/Canvas 坐标空间，转换为实际鼠标位置；不直接写程序状态或派发合成 DOM 事件。独立预期同时核对画面文字和保存状态，原始生成记录的摘要前后保持一致。回放用例与真实模型回答分别审阅，不能把机械步骤的 passed 当成语义验收通过。

2026-11-02 空间与棋盘重放发现并修复 SVG 留白下的坐标偏移、原生按钮空格默认激活被拦截两个产品问题；同时修正量杯文字匹配空白和面积浮点显示两个测试问题，保留初次失败。独立 Electron 诊断在未加载 Piora、未连接 CDP、无 iframe 等对照下仍出现窗口与页面可见性不同步；这是定位证据，不是原生窗口场景通过。详见[本批报告](verification/intelligent-ui-phase3-spatial-2026-11-02.md)。

最初独立 PR 交付公共生命周期与一个非 Intelligent UI 桌面场景，不关闭 #247。后续增量按各自报告说明范围；通用权限/文件场景、trace、自动重连和平台矩阵仍待补齐。首次引导由运行器正常跳过；同一 profile 内的页面刷新不等于跨进程重启恢复已验收。

真实模型接入后需明确记录实际模型、请求和失败，并遵守场景指定的模型和预算。语义、原生系统、硬件和发布包分别验收。CI 集成按项目安排另行处理，本次不修改工作流，也不把这个入口加入每次默认全量运行。

## 原始 Intelligent UI 任务的桌面重放与真实追问

组件、小程序及非 UI 会话的入口选择、绑定说明、坐标精度与失败诊断见[原始任务复测说明](intelligent-ui-recorded-task-testing.md)。其中非 UI 入口只覆盖生产 SDK 会话，不计为桌面操作通过；运行真实开发桌面时保持 checkout 不变，避免热编译干扰保存请求。

`scripts/verify-recorded-ui-desktop.mjs` 显式读取已有生成批次，复制所选原始会话及已发布界面数据到隔离 profile，验证原始输出在当前代码上的操作、保存、刷新及新发起的真实模型追问。它不是新一轮生成评估，不应把这两类成功率混算，也不加入默认测试入口。

```powershell
node scripts/verify-recorded-ui-desktop.mjs --batch .verification/mini-app-evaluation-di2ENh/result.json
node scripts/verify-recorded-ui-desktop.mjs --batch .verification/mini-app-evaluation-di2ENh/result.json --cases sorting-1,sorting-2,sorting-3
```

运行前需具备对应批次引用的原始记录、已准备的小程序运行资源，以及已配置的 `deepseek/deepseek-flash`。入口支持原批次的出行、优惠与排序样本，以及显式批次中的 `shopping-list` 采购清单任务；不同任务需增加对应 UI 操作和独立预期结果，不能仅修改样本名。采购清单会编辑、勾选、排序、增删、保存、刷新，并核对实际追问请求中的行数据和顺序。使用本任务独立 worktree，不与同一 checkout 的其他开发桌面并行运行。

真实模型固定配置名称 DeepSeek V4.1 Flash、provider/id 为 `deepseek/deepseek-flash`；未回退到 Pro 或其他模型。服务返回的 `deepseek-flash` 只能证明返回 ID，不能独立证明版本号。入口最多允许 36 次模型请求，包括后台命名，单次等待最多 180 秒；不是 token 费用上限。`real-model-proxy.mjs` 在进程内读取现有凭据并仅用于指定上游，临时 profile 保存合成令牌；不复制原始认证配置。

测试通过 UI 改参数、点击、播放和发送追问；读取接口时使用桌面页面的同源上下文。追问断言匹配实际用户消息及当前确认的参数或摘要/tick，后台命名请求单独标记。报告保留原始 UI 文本、保存状态、实际模型 ID 和回答，源文件摘要用于核对原始记录未改变。原始输出不符合独立预期时保留失败，不替换程序或放宽断言。

结果位于 `.verification/desktop-e2e-*/recorded-tasks.json` 与公共 `result.json`；语义发现、失败、复测和清理分别记录。真实 UI 工作流完成不代表全部文字、颜色或公式正确；人工语义审阅保持独立。首批结果及局限见 [2026-11-02 报告](verification/intelligent-ui-phase3-recorded-desktop-2026-11-02.md)。

模型转发以 SSE 的 `[DONE]` 或 `finish_reason` 确认模型流结束，在转发终止块给客户端前记录结果；客户端读完后关闭 HTTP 不再误记为失败。终止块之后才出现的用量信息可能没有读取，报告 usage 可为空，不能据此报告零费用。真正的失败保留请求编号、阶段和安全错误类型，不保留服务端错误详情。测试报告中的非 200 结果不会计为通过。

### 自然语言三维任务入口

`node scripts/verify-spatial-ui-desktop.mjs` 在独立开发桌面提交飞机姿态任务，计划检查窗口环境上报、真实模型生成、改角度、选择对象、换镜头、保存刷新及真实追问。产物为 `spatial-task.json` 和公共报告。尚未走到的步骤不计为通过；本批真实生成仍有协议/纠错失败，详见[环境协商报告](verification/intelligent-ui-phase3-environment-2026-11-02.md)。

该入口保留本机 DeepSeek V4.1 Flash 模型的 reasoning/compat 元数据，默认 thinking level 为 off，记录实际请求的 thinking/maxTokens；仅更换为本地中继地址和临时令牌，测试输出上限为配置值与 32768 的较小者。把 reasoning 标为 false 不等于给供应方发送关闭思考参数，因此不要随意覆盖模型兼容配置。

中继分别限制总流量与生成增量为 8 Mi / 2 Mi 字符（JavaScript 字符串长度），避免重复 SSE 元数据占满原内容额度；两种超限、没有终止事件及供应端失败仍会记录失败。该调整仅用于测试中继，不改变产品执行预算或 UI 纠错次数。
