# Intelligent UI 原始任务复测

这些入口重放已经生成的合成开发样本，用独立预期核对操作和后续回答。它们不替代新生成评估、封存集或人工语义验收，也不加入默认全量测试。

## 选择入口

| 内容 | 入口 | 验证边界 |
|---|---|---|
| 计算、比较组件 | `scripts/verify-recorded-component-tasks.mjs --bindings <json>` | 独立开发桌面的实际输入、保存、刷新和真实模型追问 |
| 有任务状态的小程序 | `scripts/verify-recorded-mini-app-tasks.mjs --bindings <json>` | 实际点击、键盘、拖动、播放、保存、刷新和真实模型追问 |
| 小程序自然语言修订 | `scripts/verify-recorded-mini-app-revisions.mjs --bindings <json>` | 量杯提示修订、取消、过期核对、进度迁移、保存、刷新和真实追问 |
| 直接回答、先澄清再计算 | `scripts/verify-recorded-text-tasks.mjs --bindings <json>` | 复制原始会话后使用生产 SDK、会话包装器及扩展；不启动桌面 |

在本聊天独立 worktree 中运行。桌面重放期间保持 checkout 不变，不同时运行同一 checkout 的交互式 dev launcher，也不要写入其他脚本或文档触发开发服务编译。先等待公共 `result.json` 和进程退出，再继续编辑。临时结果缺失不代表进程已停止。

原始记录及对应的 `agent/sessions`、已发布界面存储必须存在。运行器复制开发夹具到隔离目录，检查原始结果 SHA-256；不要使用私人会话作为公开测试材料。仓库中的脱敏报告不包含完整夹具，不能直接拿报告 JSON 作为运行绑定。

## 普通回答和澄清后的追问

```powershell
node scripts/verify-recorded-text-tasks.mjs --bindings .verification/text-bindings.json
```

绑定格式如下；`source` 和 `sha256` 需要换成自己的真实生成记录与摘要，不能复制示例值作为证据。

```json
{
  "version": 1,
  "thinking": "enabled",
  "cases": [{
    "id": "direct-1",
    "source": ".verification/mini-app-live-EXAMPLE/result.json",
    "sha256": "REPLACE_WITH_SHA256_OF_SOURCE",
    "followup": "如果变成八个人呢？只给结果。",
    "expectedNumber": 60
  }]
}
```

例子的前文是总额 480 元、6 人平分。`expectedNumber` 仅保存在报告中供独立审阅，不发送给模型，也不以“回答中出现该数字”冒充语义正确。脚本要求原始记录为 `completed`、形式为 `non-ui`；测试用例 ID 唯一，追问非空且不超过 4000 字符。

运行器在进程内使用已配置的 `deepseek/deepseek-flash`，要求配置名称含 V4.1；任务请求必须是 `thinking=enabled`，不回退。它核对实际请求模型、思考参数及流中返回的模型 ID，拒绝 Pro 返回。供应商返回别名仍不能独立证明内部模型修订。认证文件不复制到临时 profile。

每例最多 4 次模型调用，单次 SDK 超时 120 秒，禁止自动重试和自动压缩；发送后的轮询截止时间为 150 秒，不能当作包含所有初始化与清理的整例硬期限。UI 工具仍对模型可见，但这组明确要求普通计算的追问必须不调用工具。输出在 `.verification/phase3-text-replay-*/result.json`。

`completed` 仅表示机械检查完成；必须继续检查原始回答和追问中的全部结论、上下文继承及多余建议。开发审阅和独立人工验收分别记录。

## 小程序误差与失败诊断

普通 `expected` 仍做精确比较；刷新 `sameAs` 仍要求整个快照相同。仅当实际输入存在可解释的坐标量化时，可为特定数值路径声明绝对误差：

```json
{
  "approximate": {
    "snapshot.state.ax": {
      "value": 85,
      "tolerance": 0.01,
      "reason": "实际鼠标坐标经过 SVG 缩放后存在亚像素量化"
    }
  }
}
```

预期值、实际值和容差必须是有限数，容差必须为正且说明不能为空。报告保存实际值、差值和容差。不要为业务计算、计数或无法解释的错误统一放宽精度；本批仅放宽平移坐标，底、高、面积和保存恢复仍保持原断言。原始失败记录不覆盖。

运行器记录当前操作编号、宿主运行/状态/动作错误码，并最多保存 50 条相关请求失败或 HTTP 错误的时间、方法和路径；不保存请求头、请求体或凭据。网络记录帮助定位，不能仅凭时间接近就断言根因。

公共场景 step 的 `passed` 只表示该回调走完。若 `task-replay.json` 的样本为 `semantic-failed`，或整批为 `failed`，仍必须按失败报告。预声明的文字问题、实际文本不符、机械中断和复测分别保留。

本轮 24 个原始样本的逐项状态、失败反例与范围见[任务矩阵报告](verification/intelligent-ui-phase3-task-matrix-2026-11-03.md)及其脱敏 JSON。桌面生命周期和隔离配置见[自动化测试说明](desktop-automated-testing.md)。

## 真实模型修订与迁移

```powershell
node scripts/verify-recorded-mini-app-revisions.mjs --bindings .verification/revision-bindings.json
```

```json
{
  "version": 1,
  "thinking": "enabled",
  "scenario": "jug-no-op-revision",
  "source": ".verification/mini-app-live-EXAMPLE/result.json",
  "sha256": "REPLACE_WITH_SHA256_OF_SOURCE",
  "cancelFirst": true,
  "staleReview": true
}
```

此入口明确绑定原始合成量杯样本，不能直接用于任意小程序。样本须使用 `j3/j5/steps/next/note/history` 状态和 `fill3/fill5/pour3to5/pour5to3/empty3/empty5/reset` 操作；预期原程序两杯为空时错误提示目标杯已满。新生成结构或状态重构应独立审阅绑定，不能修改业务预期以迎合生成结果。

运行器复制会话和界面存储到隔离 profile，先通过 UI 达到 3/4 升、6 步，再用自然语言要求修复两个方向的无效提示并保留进度。模型固定为配置名称含 V4.1 的 `deepseek/deepseek-flash`，任务开启思考、无 Pro/回退；后台标题请求单独记录。源文件摘要和 sidecar 身份在模型调用前校验，原始生成记录不改写。

两个可选开关默认不启用。`cancelFirst` 取消第一份候选、刷新并再次请求真实修订；`staleReview` 在保持核对面板挂载时，通过第二个应用视图将旧版改为 3/5 升、7 步，要求旧确认返回 409、刷新核对后迁移最新进度。第二视图由测试临时挂载为同源 iframe，使用同一个 Electron profile 内的独立 React 客户端，操作和保存通过 UI 完成；它不代表两个原生窗口验收。聊天虚拟列表会卸载屏外行，因此定位绑定会话条目并通过真实滚动寻找，不依赖第一张卡片。

随后检查四种空杯/满杯无效操作、重置、达成与失去当前目标、完整快照刷新恢复和真实模型追问。API 和存储仅用于准备与结果核对。总场景期限 15 分钟、步骤期限 4 分钟；不能将机械 `completed` 视作语义通过。原始回答、候选说明与追问仍需独立审阅，双人人工验收另行安排。

修订确认现在先执行宿主的“预演所选变化”：核对来源摘要和实际数据变化，证明预演不修改旧版。过期场景先保留一次成功预演，再从另一视图编辑来源；刷新核对后再次预演并确认。运行器记录两次预演的结果与截图，确认仍必须满足原来的 409/200、保留最新进度和完整刷新断言。不能用重新生成预演来跳过过期确认测试。

输出位于 `.verification/desktop-e2e-*/revision-replay.json` 和公共 `result.json`，含本地合成会话内容，发布前应提取脱敏摘要；不要提交模型配置、认证、完整请求或私人会话。本轮成功、三次夹具失败及复测边界见[真实修订报告](verification/intelligent-ui-phase3-real-revision-2026-11-03.md)。
