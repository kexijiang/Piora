# Harmony 输入测试工程

此目录是独立测试 App 的源模板，不是用户工程。生成到一个尚不存在的目录：

```sh
npm run harmony:fixture:prepare -- production /absolute/new/production-project
npm run harmony:fixture:prepare -- debug /absolute/new/debug-project
```

两种工程都提供文本输入、长列表和真实麦克风录音入口；录音需要用户授予麦克风权限。仅 debug 工程包含 `test-only/` 的 PCM 注入源、配对界面和 Want 接收器。production 的源代码完全不包含桥接入口。不要把测试接收器复制进业务工程。

Debug 页面还可生成合成 SQLite 数据（中文、超出 JS 安全整数范围的整数和 BLOB），通过系统 `RdbStore.backup()` 制作一致副本并复制到应用 `filesDir`。页面会显示实际导出路径；在 Piora 文件页选择该调试应用沙箱中的 `data/storage` 对应文件，下载到已获准工作区，再用只读 SQLite 查看器检查。不要用仍在写入的 `piora-atlas-live.db` 主文件代替备份。该入口和数据不进入 production 工程。

在 debug App 中输入工作台展示的控制者 ID，再点击配对。将手机显示的 JSON 填入工作台，选择 50–250 ms、单声道 16 kHz PCM16 WAV。令牌绑定本次 run 和此 App 实例，两分钟失效且只能使用一次。手机接收 PCM 后返回实际字节的 SHA-256；这条测试路径不覆盖真实麦克风或语音识别。

DevEco CLI 可对生成工程进行 ArkTS 和 lint 检查。签名、HAP 构建和安装需要受控环境提供有效 SDK 与签名材料。生产 HAP 必须在 CI 构建后执行：

```sh
npm run harmony:fixture:verify-hap -- /absolute/production.hap
```

该检查拒绝测试桥接符号和入口。源码排除测试也在 `lib/harmony-app-test.test.mjs` 中运行；源码或 CLI 检查通过不等于生产 HAP 检查或实机安装通过。

参见[语音输入](../../docs/harmony/voice-input.md)和[验证说明](../../docs/harmony/testing.md)。
