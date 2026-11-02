# Intelligent UI 第三阶段基础成果

3A 开发验证报告 / 3B 起步记录 | 2026-10-31 | v1.0

## 1. 当前结论

已经具备隔离计算和自由布局的小程序基础：生成 JavaScript 在 Worker 中的 QuickJS/WASM 运行；宿主编译 HTML/CSS/SVG，再由可信 iframe 渲染；Canvas 和 Three.js 接受有界数据。真实浏览器中已看到 Canvas 图形和可旋转的三维物体，并验证停止后宿主仍可操作。

第三阶段尚未开发完成。当前没有小程序生成工具、聊天入口、持久保存或完整交互控制，不能按最终用户功能验收。3B 的协议编译器与服务器隔离试运行已开始实现，后续仍按设计推进 3B 至 3E。

| 实际成果 | 作用与边界 |
| --- | --- |
| 通用 answer-output 适配器 | 输出识别、延迟渲染、生成生命周期、复制和快照通过内部登记表接入；现有组件模式回归通过 |
| Worker + QuickJS | 生成逻辑不能取得宿主 DOM、网络、Node 或 Electron；使用显式 JSON 状态、固定时间步与种子随机源 |
| 受限文档编译 | 语义 HTML、布局 CSS、SVG 与绑定经过解析和校验；拒绝脚本、事件属性、外链和超预算内容 |
| 可信 iframe | opaque origin、sandbox 仅 allow-scripts、固定脚本 hash CSP；消息通过专用握手与 MessagePort |
| Canvas / Three.js | 可信代码绘图、建模和释放资源；生成程序只提供有限几何、材质、相机与变换数据 |
| 3B 初步协议 | MiniAppPlan1、输入含义与约束、有限 JSON schema、帧和检查点校验；服务器 Worker 先运行初始化与一个固定时间步 |

专用 worktree：C:/Users/shengjiajun/.codex/worktrees/intelligent-ui/Piora。分支：codex/intelligent-ui。已同步 upstream/main f42f7814，当前 HEAD b41fa2ff；本报告描述未提交的第三阶段修改。没有推送或发布。

<!-- pagebreak -->

## 2. 已执行的验证

以下是本地开发证据，测试组之间存在覆盖重叠，不相加作为独立用例总数。

| 检查 | 实际结果 | 覆盖边界 |
| --- | --- | --- |
| mini-app 基础测试组 | 19/19 通过 | 真实 QuickJS、Node Worker、Edge Worker、iframe、Canvas、软件 WebGL、编译与资源限制 |
| 现有组件与通用输出回归 | 26/26 通过 | 组件浏览器交互、保存、重挂载、多窗口草稿、迁移、候选发布、取消、复制与导出 |
| 设置与输出基础组 | 17/17 通过 | 同步 main 后的设置索引，以及输出识别、API、复制与快照；与上一组部分重叠 |
| TypeScript | 通过 | 当前工作目录应用类型检查，未执行发布构建 |
| 修改模块 ESLint | 通过 | mini-app、新适配器、相关渲染组件/API/构建脚本；不是全仓库 lint |
| 运行时资源编译 | 通过 | 固定渲染脚本与服务器 Worker 资源，带内容摘要；不是 Next 或安装包构建 |
| 许可证清单 | 已重新生成 | 直接依赖及版本变化同步至 THIRD_PARTY_LICENSES.md，未运行发布包许可证校验 |

基础测试包括：死循环可中断；分配过多内存失败；WASM 实际 memory maximum 为 64 MiB；生成程序无法取得宿主 API；禁止隐藏全局状态和投影时修改状态；固定种子和检查点恢复一致；外部停止与取消不会替换最后确认的检查点。

渲染测试核对实际 Canvas 像素、Three.js 图像内容与旋转后的图像变化。一次提交 1000 个画面更新时，宿主合并中间帧并显示最终帧；1000 个伪造窗口消息不成为宿主动作。合成 input 事件不被认作真实用户操作。CSP 阻止向测试服务器读取额外资源，iframe 不能访问父页面地址和 localStorage。

测试环境：Windows、Node 24.5.0、已安装 Edge 的 headless 模式。Three.js 测试显式启用软件 SwiftShader；这不代表原生 GPU、真实桌面窗口、Linux/macOS 或发布包通过。结构和像素证据也不代表模型的数学、业务含义正确。

可复现入口：`node --test lib/mini-app-*.test.mjs`；现有组件组使用 `components/intelligent-ui-browser.test.mjs` 与 `lib/answer-output-generation*.test.mjs`、`lib/answer-output-route.test.mjs`、`lib/answer-output-server.test.mjs`。本机详细日志保存在 `.verification/phase3-foundations.log`、`phase3-existing-regression.log`、`phase3-typecheck.log` 和 `phase3-lint.log`。

<!-- pagebreak -->

## 3. 实现预算与修复记录

| 宿主策略 | 当前实现 |
| --- | --- |
| 计划 / 程序 / 状态 / 帧 | 256 KiB / 64 KiB / 256 KiB / 128 KiB |
| 计算内存 | QuickJS heap 32 MiB；WASM memory 上限 64 MiB；stack 256 KiB |
| 计算与停止 | 初始化 200 ms；单步 8 ms；滚动计算预算 200 ms/s；浏览器请求 watchdog 500 ms |
| 图形与交互 | 30 fps 调度上限；400 文档节点；2000 绘图命令；200 个 mesh；合计 50000 三角形 |
| 资源加载 | 读取过程中逐块限长，独立超时；不依赖 Content-Length 声明；固定资源摘要校验 |
| 固定依赖 | quickjs-wasi 3.6.2、three 0.186.1、parse5 7.3.0、postcss 8.5.31、acorn 8.16.0 |

这些是当前宿主限制，不是性能承诺。尚未测量目标设备的长期资源趋势或帧耗时分位数。

开发中发现并修复的问题：QuickJS 关闭 EVAL 会同时影响宿主编译入口，现改为一次性编译 VM 产出字节码，生成程序只在禁用动态编译的运行 VM 执行；Next 私有生产 minifier 不适合独立资源编译，改用带许可注释的受限大小资源；SVG 路径参数与 CSS 主题变量补充语义检查；资源读取改为流式限长；同步 main 后保留桌面扩展与 Beta 两组设置。

## 4. 未完成项与下一步

3B：接入新工具、同轮语义选择、跨工具共同预算、受控预览、候选发布和实际聊天渲染；当前服务器试运行只检查初始化、一个时间步或已保存状态的投影，不证明整个交互过程正确。

3C：磁盘确认、状态保存、未确认草稿、多窗口冲突、分支与 fork、程序或 schema 变更迁移、宿主动作权限与幂等。当前检查点恢复仅为运行时原型，不是产品持久化完成。

3D：播放/暂停/步进、拖动和键盘的完整交互、主题与无障碍、复杂模拟/教学/持续交互/三维案例，以及独立正确性核对。真实模型测试只使用约定的 DeepSeek V4.1（deepseek/deepseek-flash），本步没有调用模型，没有首次成功率或泛化结果。

3E：全部开发完成后，再处理用户此前推迟的 CI 和至少两位独立人工语义验收。当前既未通过综合验收，也未构建安装包或发布。发布仍通过 GitHub Actions。
