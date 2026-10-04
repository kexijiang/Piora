# Harmony 输入测试工程

此目录是独立测试 App 的源模板，不是用户工程。生成到一个尚不存在的目录：

```sh
npm run harmony:fixture:prepare -- production /absolute/new/production-project
npm run harmony:fixture:prepare -- debug /absolute/new/debug-project
```

两种工程都提供文本输入、长列表和真实麦克风录音入口；录音需要用户授予麦克风权限。仅 debug 工程包含 `test-only/` 的 PCM 注入源、配对界面和 Want 接收器。production 的源代码完全不包含桥接入口。不要把测试接收器复制进业务工程。

Debug 应用在被明确启动时生成合成 SQLite 数据（中文、超出 JS 安全整数范围的整数、BLOB、视图和索引），通过系统 `RdbStore.backup()` 制作一致副本并复制到应用 `filesDir`；页面显示准备状态及实际导出路径，也可点击按钮重新生成。准备失败显示实际错误码与原因，前台测试窗口通过 `setWindowKeepScreenOn(true)` 保持亮屏。Piora 数据库页应自动发现这些文件并归属该应用，用户无需填写数据库路径；API 26 实机中 `filesDir` 位于模块的 `base/haps/entry/files`，不应仅检查应用级 `base/files`。仍在写入的 `piora-atlas-live.db` 若有 WAL，应明确拒绝直接采集，选择已完成备份进行查看。也可从文件页下载到已获准工作区做独立只读检查。该入口和数据不进入 production 工程，数据库扫描本身不启动此应用。

在 debug App 中输入工作台展示的控制者 ID，再点击配对。将手机显示的 JSON 填入工作台，选择 50–250 ms、单声道 16 kHz PCM16 WAV。令牌绑定本次 run 和此 App 实例，两分钟失效且只能使用一次。手机接收 PCM 后返回实际字节的 SHA-256；这条测试路径不覆盖真实麦克风或语音识别。

DevEco CLI 可对生成工程进行 ArkTS 和 lint 检查。签名、HAP 构建和安装需要受控环境提供有效 SDK 与签名材料。生产 HAP 必须在 CI 构建后执行：

```sh
npm run harmony:fixture:verify-hap -- /absolute/production.hap
```

该检查拒绝测试桥接符号和入口。源码排除测试也在 `lib/harmony-app-test.test.mjs` 中运行；源码或 CLI 检查通过不等于生产 HAP 检查或实机安装通过。

## 为真机验收生成调试签名

先在本机执行 `devecocli auth login`，按浏览器中的流程登录华为开发者账号，再用 `devecocli auth status` 核对。登录成功并不代表任意 HAP 都能安装：调试签名需要与应用包名及已连接的测试设备匹配。

进入上面生成的独立 debug 工程目录，连接并授权测试手机后执行：

```sh
devecocli signature generate --product default
devecocli build --build-mode debug --product default
```

只选择生成的 `entry/build/default/outputs/default/entry-default-signed.hap` 做安装验收，不能选择 `*-unsigned.hap`。从 Piora 的“应用”页预览安装包，核对包名、版本和目标设备，再安装并检查设备版本回读。此处构建的是专用调试样本；Piora 的 beta/stable 发布包仍只在 GitHub Actions 构建。

如果登录命令报 `Invalid proxy authorization` 或网络错误，先核对该进程的代理配置。此类失败不能用来断言账号未登录；必要时在独立命令进程中临时排除错误的代理配置再核对，不修改系统代理或其它应用的环境。签名生成的密钥、密码及授权文件留在本机隔离目录，不提交到仓库、不随 Piora 分发。

参见[语音输入](../../docs/harmony/voice-input.md)和[验证说明](../../docs/harmony/testing.md)。

## 调试样本的横竖屏和亮屏验收

仅 debug 样本包含 `atlas-landscape`、`atlas-portrait` 及 `atlas-orientation-status`。按钮请求当前主窗口方向；状态文字只表示请求回执，验收仍需核对实际手机截图尺寸、实时视频内容及恢复后的方向。每次输入前重新读取样本按钮与坐标，结束时恢复竖屏。生产样本不带这些入口。

明确启动的调试样本主窗口请求保持亮屏。长期验收还必须独立检查 ScreenlockService 的亮屏与未锁定状态，不能只把超时设置成功当作未锁屏证明。维护输入只可作用于新观察到的自有样本无操作标题；自有页面不再可见时停止，让出手机。维护与独占桌面验收不能同时派发设备输入；不自动输入锁屏密码。

## 连续操作与加密数据库样本

仅 debug 页面提供 `atlas-action-increment` 和 `atlas-action-count`，每次点击前者使后者的计数加一。连续操作验收须经过产品的动作调度接口，并核对实际计数、每步结果及新观察；直接执行 HDC 点击不能代替 AI 动作链路验收。

`atlas-encrypted-prepare` 在明确点击后使用系统 `RdbStore` 的 `encrypt: true` 创建合成数据库，完成状态由 `atlas-encrypted-status` 显示。该数据库不由扫描过程创建，不包含用户数据。Piora 应在所属应用下自动发现候选文件，无法读取加密文件时显示具体原因，不能展示伪造的空表或旧快照。页面采用可滚动布局，确保新增测试控件不会遮挡原有入口。这些入口和数据均不进入 production 工程，生产 HAP 检查同时拒绝已知测试标识。
