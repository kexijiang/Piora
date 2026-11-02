# Intelligent UI 动态列表

动态列表属于独立小程序运行时，沿用 Intelligent UI 的 Beta 开关、能力清单、检查点与输出适配。列表、已编辑值和顺序由程序的显式状态保存。普通聊天无需理解模板或直接维护列表项。

## 模板与数据

HTML 中声明一个 `data-repeat` 容器，里面的一个根元素是行模板。宿主编译模板，程序只返回数据，运行中不接收 HTML 字符串。

```html
<ul data-repeat="tasks">
  <li>
    <input data-field="done" type="checkbox" aria-label="完成">
    <input data-field="title" type="text" maxlength="80" aria-label="事项名称">
    <button data-event="up">上移</button>
    <button data-event="remove">删除</button>
  </li>
</ul>
```

```js
// project 返回的帧；每个已声明列表都必须出现，空列表用 []。
{
  summary: "当前准备事项",
  bindings: {},
  repeats: {
    tasks: [
      { key: "task1", bindings: { title: "带充电器", done: false } },
      { key: "task2", bindings: { title: "订票", done: true } }
    ]
  }
}
```

`key` 使用现有 ID 语法，是对象身份，不能用当前数组位置代替。行内 `data-text`、SVG `data-bind` 和 `data-field` 都读取该行的 `bindings`；全局绑定仍从帧顶层读取。新增、删除和重排通过修改显式状态后重新投影完成。

当前支持平面列表，不支持嵌套 repeat。行模板不使用全局 `id`、`for`、`aria-describedby`、`data-input` 或 viewport；标签可直接包裹控件，并提供清楚的 `aria-label`。重复 key、缺失绑定或非法值会返回错误，不截断或静默丢弃用户数据。

## 编辑与事件

行字段支持 text、checkbox、number、range 和 select。文字可声明 `maxlength`，上限 2000；数字需要有限的 min/max 和正 step；select 使用唯一的静态 option 值。字段值来自绑定，HTML 不设置 value、checked 或 disabled。

```js
// reduce 收到经过宿主核对的业务事件。
{ type: "item-input", repeat: "tasks", key: "task1", id: "title", value: "带电脑和充电器" }
{ type: "item-click", repeat: "tasks", key: "task1", id: "up" }
```

程序按 key 查找对象后更新状态。行编辑不修改 `ctx.inputs`；后者仍用于顶层参数。宿主另外校验显示帧、事件序号和对象代次，不把这些实现细节交给模型程序。

同一个仍存在的对象可接收已排队的连续输入；删除、删除后复用 key、未知帧或超出历史窗口的事件被拒绝。拒绝与输入确认按队列顺序处理，避免后一个错误回执提前覆盖尚未计算的输入。

宿主移动既有行节点，重排后保留焦点和文字选区；删除聚焦行时优先移到相邻行的同一控件，列表为空则移到容器。输入确认序号防止较旧的计算帧覆盖用户刚输入的新文字。上移、下移和删除应提供可键盘操作的按钮。

## 保存、追问与兼容

列表数据保存在原有检查点中。生产状态服务重新投影并验证后写盘，恢复时从保存的状态重建行。后续模型上下文包含当前行值、稳定 key 和原显示位置；每个小程序的列表摘录限 3000 字符，并明确记录总行数和省略行数。省略表示未知，不能推断为空、未完成或初始值。静态导出保留已保存的行数据。

使用 repeat 或新增的原生 type 选择器、列表样式时，计划选择 `mini-app-1.3`。未使用新语法的历史计划继续沿用其原 runtimeVersion；注释中出现新语法名称不会改变身份。

每个列表最多 50 行；实际展开仍共享 400 个节点、64000 字符和 128 个交互目标的预算，最多 8 个非嵌套列表。模型应按模板复杂度选择容量并告知用户；50 是宿主上限，并不表示任意模板都能展示 50 项。示例清单容量为 16 项。

允许用 `[data-repeat]`、`[data-field]` 和原生 `input[type=text]` 等有限类型选择器编写样式。列表标记只支持 none、disc、circle、square、decimal 及 inside/outside 位置；外部资源、自定义计数器和任意属性选择器不开放。

## 验证入口

```powershell
node scripts/verify-mini-app-capabilities.mjs
node --test lib/desktop-e2e-model-proxy.test.mjs
node scripts/probe-mini-app-generation.mjs shopping-list 8192 --prompt-file tests/fixtures/intelligent-ui/phase3-repeat-prompt.txt
```

能力验证入口覆盖协议、真实 QuickJS、浏览器输入/焦点、生产状态保存及后续上下文。真实模型探测单独记录，不加入默认本地门禁。探测使用明确的开发提示文件，不改变原先八题的基线或封存样本。

`scripts/verify-recorded-ui-desktop.mjs` 可通过显式批次的 `shopping-list` 条目重放已经生成的采购清单，检查真实桌面操作、保存、刷新及固定 DeepSeek 模型追问。批次中的 result 指向原始探测结果；不得改写原始程序使其通过。相关报告见 [本批记录](verification/intelligent-ui-phase3-repeat-2026-11-02.md)。
