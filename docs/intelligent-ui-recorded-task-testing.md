# Intelligent UI 原始任务复测

这些入口重放已经生成的合成开发样本，用独立预期核对操作和后续回答。它们不替代新生成评估、封存集或人工语义验收，也不加入默认全量测试。

## 选择入口

| 内容 | 入口 | 验证边界 |
|---|---|---|
| 计算、比较组件 | `scripts/verify-recorded-component-tasks.mjs --bindings <json>` | 独立开发桌面的实际输入、保存、刷新和真实模型追问 |
| 有任务状态的小程序 | `scripts/verify-recorded-mini-app-tasks.mjs --bindings <json>` | 实际点击、键盘、拖动、播放、保存、刷新和真实模型追问 |
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
