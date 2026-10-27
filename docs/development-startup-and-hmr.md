# 开发启动与热更新验证

## 启动方式与边界

在仓库根目录使用 Node.js 22.19.0，按锁文件安装依赖后运行：

```powershell
npm ci
npm run dev          # 浏览器，127.0.0.1:30141
npm run dev:desktop  # Electron，不能与上一条同时占用同一个端口
```

`dev`、`dev:lan` 与 `dev:desktop` 使用 Turbopack。开发预处理比较品牌输入、
生成器及输出内容，未变化时复用资源；生成的 brand.ts 内容相同时不重写，
避免启动或类型检查平白触发一次全应用刷新。鸿蒙 worker 使用增量编译。
桌面开发仍显示加载窗口，但不读取、嵌入或等待发布版影片。
正式包与 Webpack 发布构建流程不变；不要在开发目录运行 `next build`。

## 与已发布版同时运行

正常启动已安装的 Piora，然后在仓库根目录运行 `npm run dev:desktop`。
开发窗口及托盘显示 `Piora Dev`，使用独立 Windows AppUserModelId。
Electron `userData` 在获取单实例锁之前已设为工作区内
`.piora-data/desktop-dev/`，不会向已发布版发送“第二实例”唤起请求。

开发版的 Pi 会话、模型配置与认证默认放在该目录的 `agent/` 中，Next 与
Electron 接收相同目录；剪贴板、浏览器缓存、设置与日志也独立。
不自动复制发布版凭据或会话，因此开发版初次需要单独配置模型。
开发版不注册系统级全局快捷键，避免抢占发布版；窗口内快捷键与菜单保留。
同一开发工作区仍保留单实例保护，并非允许多个进程同时写同一份数据。

发布版服务使用其自己的端口，开发版默认 `127.0.0.1:30141`。若该端口已
被其他服务占用，设置 `$env:PIORA_DESKTOP_DEV_PORT = "30142"` 后启动；
不会接管占用端口的服务。显式指定 `PI_CODING_AGENT_DIR` 可覆盖开发数据
目录，但指向发布版目录意味着主动共享数据，不再具备默认隔离。

### 开发输出异常或启动超时

先停止开发进程，再执行 `npm run dev:reset-cache`，然后重新运行
`npm run dev:desktop`。重置仅通过原子重命名保留 `.next/dev` 为
`.next/dev-stale-*`，不删除数据、不递归遍历 Next 的依赖目录链接；不要用
递归移动命令替代。缺失依赖时应先按锁文件恢复安装，不要同时在同一目录
运行多个安装任务。开发启动等待采用 10 分钟总上限，覆盖 Windows 冷编译
（2026-10-26 独立空缓存实测 HTML 约 194 秒，超出旧 180 秒上限），
不会每 60 秒取消仍在编译的单次请求；日志区分 `compiling-development-page` 与
`warming-development-assets`，超时给出具体页面或资源。

Windows 默认关闭 Turbopack 的**磁盘持久化开发缓存**，仍保留进程内增量
编译和热更新缓存。慢盘上的缓存快照校验可能比重新编译更慢；其他平台
保留 Next 默认持久化缓存。可用 `PIORA_DEV_FILESYSTEM_CACHE=1` 显式启用，
或用 `0` 禁用，不影响发布构建缓存。

三个与服务器共享的桌面剪贴板源文件来自 CommonJS 包，内部使用 Node16
的 `.js` 导入。`desktop-dev-loader.cjs` 将其转换为虚拟 ESM，两个别名定位
对应 TS 源码；不能只删除 `--webpack`，否则备份接口会编译失败。
该兼容层有真实 SQLite 及剪贴板归档往返测试，不替换桌面正式编译器。

## 首屏基准

```powershell
node scripts/verify-dev-startup.mjs --webpack  # 原有编译/预处理方式
node scripts/verify-dev-startup.mjs            # 优化后的开发方式
```

每次使用独立的空 Next 输出目录、独立 tsconfig 与 agent 目录；不覆盖正在
开发的 `.next`，不读取个人会话。Windows 需安装 Edge；其他系统需要
Playwright 可找到 Chromium。默认端口 30151，可用 `PIORA_BENCHMARK_PORT`
修改；结束时只清理本次启动的服务进程。
结果、首屏截图及日志保存在 `.verification/dev-startup-<bundler>-<id>/`。

`totalMs` 从预处理开始，直到浏览器中的 `.app-shell` 可见，包含服务启动、
浏览器启动和第一次编译；`readyMs` 仅是 Next CLI 的 Ready 提示。
首屏可见不等于全部后台接口或全部延迟加载工具都完成。

2026-10-23，Windows / Node.js 22.19.0 / 同一工作区，各独立空编译缓存一次：

| 指标 | 原 Webpack | Turbopack |
| --- | ---: | ---: |
| 预处理 | 0.96 秒 | 0.58 秒 |
| Next Ready | 1.12 秒 | 1.11 秒 |
| 首次页面请求至 DOMContentLoaded | 92.78 秒 | 19.82 秒 |
| 预处理开始至应用外壳可见 | 149.84 秒 | 25.00 秒 |

该次首屏总耗时减少约 83%，是单机单次观测，不是跨硬件保证。
原始结果目录后缀分别为 `webpack-42ad9c92-a060-4134-99fa-89fa85ac7bfb`
与 `turbopack-ebe8f5ab-4f43-4fdf-8523-53099046b790`。
品牌资源此前已生成；“空缓存”指 Next 编译缓存，不是全新依赖安装。

## 鸿蒙设备标签回归

实际启动 `npm run dev:desktop`，显式启用 loopback 调试端口后通过 CDP
连接 Electron 窗口。测试使用离线设备响应夹具，不安装、唤醒或操作真机。
调试接口具有完整窗口控制能力，仅测试时显式开启。

1. 打开「鸿蒙设备」与「文件」两个工具标签，记录鸿蒙面板根布局、设备头
   的 `display`、`padding` 并截图。
2. 修改 `HarmonyPanel.module.css` 中临时 CSS 变量，等待计算样式实际更新，
   连续切换「文件 → 鸿蒙设备」五次。逐次断言设备头为 `flex`，间距
   为 `8px 12px`；不是只等待编译日志。
3. 分别修改组件 JSX 的临时 data 属性、`app/globals.css` 临时变量，等待
   DOM/计算样式更新，重复切换和断言。定位工具标签使用 `role=tab`。
4. 删除所有临时标记，再次等待热更新、切换并截图。最终源码不保留探针。

修复前，在原 Webpack 开发页修改一次鸿蒙 CSS 后，设备头退化为 `block`、
间距 `0px`，切换标签无法恢复；未出现未捕获的 JS 异常，故仅检查异常不足以发现。
截图：`.verification/dev-hmr-before.png`。

修复后，在真实 Electron 44.9.0 窗口完成 6 轮模块 CSS、3 轮组件 JSX、
2 轮全局 CSS 更新，每轮 10 次标签切换（合计 110 次），样式断言全部通过。
额外检查当前组件状态及删除探针后的 20 次切换同样通过，页面异常监听为 0。
截图：`.verification/dev-hmr-after-six-rounds.png`、`dev-hmr-final.png`。
主进程优化触发实际 Electron 重启后，又完成一轮模块 CSS 更新及清理，
追加 30 次标签切换，最终累计 160 次，样式断言通过且无未捕获页面异常。
最终干净窗口截图：`.verification/dev-hmr-final-desktop.png`。
这是实际桌面开发渲染器验证，但设备数据使用夹具，不代表鸿蒙真机操作验收。

桌面主进程改为开发时跳过影片后，实际 watcher 重编译并重启 Electron，
其启动日志记录 ready 为 6.88 秒；该值使用已热编译的 Next 服务，不能与
上表的空缓存首屏时间直接比较。发布包仍加载影片，另有单元测试确保即使
遗留开发 URL 环境变量也不能绕过正式包影片。

## 2026-10-23 初次优化检查

平台为 Windows，Node.js 22.19.0。最终相关测试 94/94 通过：

```powershell
node --test --test-concurrency=2 lib/branding-preparation.test.mjs lib/brand-build-integrity.test.mjs lib/development-*.test.mjs lib/desktop-dev*.test.mjs lib/desktop-startup*.test.mjs lib/desktop-tray-startup.test.mjs lib/desktop-dev-relay.test.mjs lib/harmony-worker.test.mjs lib/app-backup.test.mjs lib/clipboard-app-backup.test.mjs lib/harmony-*-browser.test.mjs
npm run typecheck
node node_modules/eslint/bin/eslint.js . --ignore-pattern website/**
npm run harmony:docs:check
npm run verify:hygiene
npm run licenses:check
npm run verify:backgrounds
npm run perf:check
```

以上命令均退出 0。Lint 有 3 条现有警告，无错误；未将独立 `website/`
纳入本次应用 lint，网站没有修改，且其旧 React ESLint 插件与当前 ESLint
不兼容。测试包括真实 Windows Electron 启动/交接、共享剪贴板 SQLite
归档往返、品牌缓存失效与修复、worker 增量复用/源更新/缺失输出修复/
类型错误阻止启动，以及鸿蒙工作台浏览器交互。

不是全量 `npm test` 结果。Linux、鸿蒙真机、发布打包未运行；没有生产
构建或本地发布包。依赖与锁文件未变化，本次未重跑依赖审计或独立网站
构建。计时与截图输出、检查日志均保留在本地 `.verification/`，不提交
设备数据或生成的编译缓存。

## 2026-10-24 启动超时恢复与共存检查

保留上次优化修改，同步至 `0.5.5-beta.36` 的主线提交，再继续修复。
暂停同目录的另一安装任务后，使用 Node.js 22.19.0 / npm 10.9.3，按仓库
`legacy-peer-deps` 配置执行锁文件安装及项目 postinstall 补丁；未改依赖版本
或锁文件。Electron 44.9.0 使用其 `install.js` 恢复二进制。

在本次机器状态下，启用持久化开发缓存的空缓存启动花费约 176.7 秒
（桌面进程日志的 ready），随后缓存恢复重启仍明显停顿；禁用持久化
开发缓存后，页面资源预热 21.3 秒、桌面进程 ready 23.2 秒。
这是本次环境的实际排障观测，不是跨硬件保证，也不是上文独立浏览器
基准的同一计时口径。单独关闭缓存未在后续默认启动中稳定解决超时，
不能将 23.2 秒视作稳定保证。Windows 保留进程内开发缓存选项及显式覆盖；
其他系统默认值和发布构建缓存不变。

最终将本地就绪探针改为独立回环 HTTP 连接：不经全局 fetch、应用代理
分派或共享连接池，要求不压缩的完整页面与资源响应，不跟随重定向。
增加全局 fetch 不可用时仍可完成本地预热的回归测试。该改动后的桌面
热重启中，页面资源预热 5.4 秒完成；完整启动复核另记录在最终日志。
随后取消缓存/调试环境变量覆盖，用默认 `npm run dev:desktop` 完整重启：
页面资源预热 23.2 秒、桌面进程 ready 24.9 秒，首次尝试即成功。
日志：`.verification/readiness-direct-http-full-start.log`。该次未并行运行重检查。
随后启动原已发布版，确认发布版与 `Piora Dev` 两个主窗口及进程同时存在，
各自启动日志均到达 ready，开发调试端口未启用。两版数据目录保持分离。

真实 Electron 中修改鸿蒙设备头的 CSS 间距为 `9px 13px`，等待计算样式
确认更新后进行 10 次工具标签切换，再恢复 `8px 12px` 并重复 10 次切换；
布局始终为 flex，页面异常监听为 0。设备为离线响应夹具，不操作真机。
截图：`.verification/readiness-memory-cache-hmr.png`。

相关检查日志：`.verification/readiness-direct-http-final-checks.log`，包含
启动等待、缓存策略与目录链接保护、开发/发布隔离、剪贴板归档、桌面
启动交接、发布边界回归，以及类型检查、针对修改文件的 lint 和仓库卫生。
最终测试 61 项通过；另有 1 项因当前 Windows 账户不能创建文件符号链接而跳过；
目录 junction 的缓存保护测试通过。不是全量测试或发布包验收。
