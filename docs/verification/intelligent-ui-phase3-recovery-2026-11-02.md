# 第三阶段：草稿分页与输入生命周期

2026-11-02 | 3B / 3C 实施报告 | 第三阶段尚未完成

## 1. 已实现与本批验证

恢复列表现在可以继续读取首批 20 条之后的检查点；输入中断会释放按键与拖动，停止前排空操作，恢复时清理旧手势。本批接续并审查工作区已有的分页/输入释放增量，新增生命周期浏览器回归，修复测试夹具的就绪竞态，完成相关合并验证。

| 改动 | 用户可见行为 |
| --- | --- |
| 游标分页与作用域校验 | 恢复区增加“加载更多检查点”和“刷新检查点列表”，可以找到后续记录，不混入其他会话输出 |
| 读取与刷新状态 | 加载中避免重复请求；较旧分页不能覆盖刷新结果，失败保留已读列表与本机副本并允许重试 |
| 逐条恢复与确认 | 可以导出、恢复第 20 条之后的记录；只清除对应已确认版本，其余草稿继续保留 |
| 失焦与页面隐藏 | 暂停播放并有序释放按键/指针，先送出最后一次移动，防止对象持续运动 |
| 保存与停止 | 输入冻结前释放按键和捕获；正式 Surface 的停止先取得一致检查点，再停止并保存 |
| 恢复检查点 | 清理之前的按住/拖动状态，保留业务位置、随机源和逻辑时钟；有清理变化就进入待保存流程 |

草稿使用现有 IndexedDB 表和 scope 索引，按索引与主键游标翻页，不引入数据库迁移。删除上一页末项后仍能读取正确的下一页；刷新使旧分页请求失效。刷新列表不等于删除本机副本，选用服务端状态后也保留待处理草稿。

输入释放通过 iframe 的同一消息通道先发送待处理移动，再发送 blur；保存屏障等待队列排空。新建输入环境默认暂停。已有程序的 blur 若改变 state，其结果成为新的待保存检查点，不重写原始发布记录；没有变化则不因恢复而新增修改。

### 用户可以这样试

- 用可持续移动的界面按住方向键，再切到别的控件；回到原控件后，它应等待新的按键操作。
- 拖动对象时切开焦点，再点停止；恢复后对象应停在最后位置，不能继续跟随旧手势。
- 在有保留草稿的恢复区加载更多，恢复其中一项，再刷新；已确认的那项消失，其他记录仍可找到。

超过 20 条的草稿本批由夹具准备，无需用户手工制造。真实模型输出仍须正确处理约定事件；本批没有证明任意生成程序都会遵守该契约。

<!-- pagebreak -->

## 2. 实际证据与失败记录

| 验证项 | 实际结果与范围 |
| --- | --- |
| 相关合并回归 | 30/30 Node 测试项通过，包含父测试及子测试；不是 30 个自然语言任务 |
| 草稿列表 | 45 条当前作用域、2 条其他作用域；实际 React UI 加载 20 / 40 / 45 条，其他作用域不出现 |
| 深页恢复 | 实际导出第 45 条，检查值 47；恢复后磁盘值及追问状态为 47，刷新后保留另外 44 条 |
| 分页边界与异常 | 删除上页末项后不跳行；拒绝其他 scope 游标；刷新胜过旧读取；注入读取失败后重试成功 |
| 原生键鼠事件 | 真实浏览器按键、Tab、拖动和焦点切换；验证重复 keydown 不恢复旧按住状态，停止恢复保留最终位置 |
| 恢复旧输入 | 夹具准备 x=77、held/drag=true、tick=42、rng=123456；恢复清理两个标记但保留其余字段，并通知待保存；再次恢复不重复标脏 |
| 隐藏事件分支 | 保持 iframe 焦点和实际按键，夹具注入 document.hidden 与 visibilitychange；验证释放、暂停和重新可见后不自动播放 |
| TypeScript / lint | tsc --noEmit 通过；相关 9 文件 lint 通过，随后修改的测试文件再次 lint 通过 |

浏览器使用无头 Edge。生命周期测试使用真实 Controller、Worker、QuickJS 和隔离 renderer；宿主按钮是测试夹具，没有运行 Electron。客户端测试使用实际 React Surface、IndexedDB、生产保存路由及隔离会话磁盘；模型计划是确定性夹具。注入隐藏事件不等于操作系统窗口最小化或真实后台标签验证。

### 保留失败，说明复测

第一次生命周期单独检查 5/5 通过。加强隐藏分支后，首次合并检查为 28/30：一个子测试及其父测试失败，原因为夹具创建新 Controller 时仍暴露旧 snapshot；测试误判新实例就绪，继续发起恢复并短暂生成两个 iframe。

修复将夹具的旧 host 引用在创建开始时清空，状态先置 loading，snapshot 在新实例就绪前返回空。保留“单个 iframe”、键鼠释放、检查点字段和暂停等原断言，没有改用 first() 隐藏重复实例。相同合并命令复测 30/30，失败与复测日志分别保留。[R1]

该失败指向本测试夹具的并发等待问题，不据此宣称生产桌面存在同样的重复实例缺陷。本轮没有运行真实模型、完整 CI、原生桌面窗口、安装包或其他平台验证。

<!-- pagebreak -->

## 3. 范围、下一步与追溯

本批完成草稿分页和输入生命周期这部分的相关检查，**不等于第三阶段完成**，也不替代完整恢复矩阵。新版设计 v3.7 已输出独立 7 页 PDF 并逐页检查；当前计划继续保留 3A 至 3E 和全部复杂任务范围。[R2]

| 尚待完成 | 下一步证据 |
| --- | --- |
| 通用能力清单与开放条件 | 提示、接纳和环境检查读取同一 manifest；能力依赖变化使相关证据失效 |
| 首批真实模型完整任务 | 八例各三次逐份完成操作、结果、保存、刷新和追问；生成失败也在分母中 |
| 恢复、修订与动作 | 完整异常组合、迁移确认、跨组件/小程序修订、登记动作及外部回执 |
| 复杂交互 | 动态列表、持续模拟/游戏、完整三维拾取与相机；同时验证语义、外观、键盘与资源 |
| 最终验收 | 三阶段开发后执行完整 CI、封存集与人工语义判断，模型按用户要求使用 DeepSeek V4.1 配置，不用 V4 Pro |

没有把本批确定性夹具结果计入真实模型生成质量，也未将无头浏览器检查写成 Windows 桌面实机通过。当前模型服务身份限制沿用既有报告；本轮未调用任何模型。

### 文件与命令

实现涉及 lib/mini-app/drafts.ts、client-state.ts、controller.ts、frame-host.ts、renderer-runtime.ts 和 components/mini-app/MiniAppSurface.tsx；验证位于 lib/mini-app-client-browser.test.mjs、mini-app-controller-browser.test.mjs、mini-app-fixtures.mjs。

```text
node --test lib/mini-app-controller-browser.test.mjs
  lib/mini-app-client-browser.test.mjs lib/mini-app-frame.test.mjs
  lib/mini-app-state.test.mjs lib/mini-app-route.test.mjs
node_modules/.bin/tsc.cmd --noEmit
node_modules/.bin/eslint.cmd <本批相关文件>
```

上面测试文件列表属于同一条命令，换行仅为排版。完整命令、源码摘要、日志摘要、失败和复测状态见同名 JSON。[R3]

- [R1] .verification/phase3-recovery-lifecycle-initial.log、phase3-recovery-integration.log、phase3-recovery-integration-retest.log；类型及 lint 日志分别记录，未合并覆盖失败。
- [R2] docs/intelligent-ui-phase3-design-v3.7.md 与对应 PDF；历史成果继续保留自己的验证范围。
- [R3] docs/verification/intelligent-ui-phase3-recovery-2026-11-02.json，记录实际源文件内容指纹，不只引用提交号。

工作区 C:/Users/shengjiajun/.codex/worktrees/intelligent-ui/Piora，分支 codex/intelligent-ui；本批未提交或推送。后续发布包继续交由 GitHub Actions 构建。

[R1]: ../../.verification/phase3-recovery-integration-retest.log
[R2]: ../intelligent-ui-phase3-design-v3.7.md
[R3]: intelligent-ui-phase3-recovery-2026-11-02.json
