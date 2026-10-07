# unsigned 投屏组件的发行与私有签名门禁

Windows beta 不能继续携带旧 1.0.3 HAP，也不能给旧字节补写来源。tag workflow 必须在同一次 GitHub Actions run 中构建新的 public unsigned HAP，从完全相同的输入生成仅供验收的 private DevEco device-signed HAP，完成官方验签、真机验收和 provenance 记录，再把 unsigned HAP 与脱敏收据交给 GitHub-hosted Windows 打桌面包。私有签名 HAP 不进入 artifact 或安装包。

## 专用 runner

HAP job 只调度到带 `self-hosted`、`Windows`、`harmony-device`、`harmony-api26`、`ephemeral` 标签的 runner，并绑定 `harmony-hardware` environment 读取设备 secret。runner 必须：

- 使用一次性工作目录，安装完整 DevEco Studio API 26 SDK，并让 `DEVECO_SDK_HOME` 指向包含 `default` 目录的 SDK 根；可用 `DEVECO_STUDIO_HOME` 或 `HARMONY_*_PATH` 覆盖工具位置。
- 连接一台已解锁、已授权 HDC 且未预装 `com.ohos.scrcpy.server` 的开发手机；序列号只从 `HARMONY_DEVICE_SERIAL` environment secret 注入。门禁拒绝替换既有同包名应用。
- 使用已登录 DevEco 的 HarmonyOS 自动签名生成 `normal` / `hos_normal_app` debug profile，并确保 profile 的 UDID allow-list 包含上述验收手机。runner 进程通过 `PIORA_HARMONY_SIGNING_CONFIG_PATH` 指向其用户目录 `.ohos/config` 内、仅 runner 用户可读的描述文件；描述文件引用 DevEco 管理的 `.p12`、`.cer`、`.p7b` 和受保护密码。仓库、日志和 artifact 均不复制这些材料。

没有满足标签的 runner、设备 secret、当前有效的 Huawei 开发者证书/profile 或 API 26 SDK 时，beta 候选保持排队或失败。workflow 不回退到旧 HAP 或 OpenHarmony 示例签名。

## 同次 run 链

1. `build-harmony-mirror-release.mjs` 调用 prepare，在全新隔离目录记录仓库源码与 GitHub repository/commit/workflow/run/attempt。
2. SDK 自带 ohpm/Hvigor 生成 API 26 `release`、`debug:false`、arm64 的 `entry-default-unsigned.hap`。provenance 重新读取该文件的 API、权限、ABI、版本、SHA-256 和源码指纹，生成 `harmony-mirror-manifest.json`；这份已测量的 unsigned 字节是后续私有验收和桌面打包的共同输入。
3. 脚本读取 runner 私有的 DevEco descriptor，用受保护材料从上述 unsigned HAP 生成单独的 `OHScrcpyServer.acceptance.hap`。同一个 `hap-sign-tool.jar` 对私有副本执行 `verify-app` 和 `verify-profile`，要求 Huawei CBG Root CA G2 → Developer Relations CA G2 → Development leaf 的有效链，并验证 `app_gallery` debug profile、目标 bundle、`normal`、`hos_normal_app`、空 ACL/受限权限和有限的 UDID allow-list。
4. 构建步骤读取验收设备 secret，要求设备已经在 profile allow-list 中。`harmony-mirror-signature-verification.json` 同时绑定 public unsigned HAP 和 private acceptance HAP 的 SHA-256，并只保留证书指纹、散列、计数和有界元数据，不记录原始开发者或设备身份。
5. `verify-harmony-mirror-device.mjs` 以普通 install 把 private acceptance HAP 安装到指定手机，不使用 `-r`，然后回读版本、启动 EntryAbility，只点击新抓取 UI 树里的自有共享按钮和明确命名 Piora 的系统授权按钮。门禁要求真实 H.264 配置、至少 15 帧和一个关键帧，同时读取一张有效 PNG；最后移除自有 forward、停止并卸载 HAP，回读确认包不存在。
6. `stage-harmony-mirror-artifact.mjs` 只有在来源、官方验签、真机媒体和清理证据全部通过后，才复制 public `OHScrcpyServer.hap`、manifest、脱敏 receipt 和新 `SOURCE.md`。Windows builder 下载这个同 run artifact，并在打包前、解包后各核对一次。
7. workflow 的 `always()` 清理步骤删除隔离 workspace（包括 private acceptance HAP）和临时验签文件；runner 的 DevEco 私有配置从未进入该 workspace 或 staging。上传清单只列出四个公开文件，因此 device-signed HAP 不会上传或随桌面包分发。

## 桌面端显式初始化

随桌面包分发的 HAP 刻意保持 unsigned，不能直接发给 HDC 安装。只有用户明确点击“初始化投屏服务”时，Piora 才核对随包 HAP 与 release receipt 并读取连接手机的 UDID。若没有显式 `PIORA_HARMONY_SIGNING_CONFIG_PATH`，桌面端会在私有缓存复制随包最小签名工程，调用 DevEco CLI 自动生成或更新标准 `build-profile.json5`；证书、profile、keystore 和受保护密码仍由 DevEco 保存在 `.ohos/config`，不会上传。

Piora 为这台手机生成并官方验签私有缓存副本，确认 bundle、版本、证书、profile 和 device allow-list 均匹配。已装组件不匹配时先卸载并确认缺席，再执行普通 `hdc install`；初始化路径不使用 `-r`。DevEco 未登录、手机未连接或锁定、API 26 SDK 签名工具、有效 Profile 或目标手机绑定缺失时，操作在发送安装命令前失败，并提示运行 `devecocli auth login`、保持手机连接和解锁后重试。

被动预览不会触发签名、安装、启动、唤醒或解锁。运行时私有签名副本只保存在当前用户的 Piora 私有数据目录，不会替换安装包中的 unsigned 来源文件。

设备绑定签名只允许 `vX.Y.Z-beta.N` 预览标签。stable workflow 在取得并接入 AGC release 证书/profile 前保持失败关闭，不会把设备绑定 debug HAP 当作正式稳定版资源。

## beta 发布边界

`harmony-preview.yml` 只构建并上传已验证的 installer/portable，不创建 GitHub Release。下载这次 run 的桌面 artifact，用真正的 Piora 安装包和手机完成最终验收后，才可手动运行 `publish-preview.yml`，输入原 beta tag 和构建 run ID。发布 job 绑定 `preview-publish` environment；仓库必须为这个 environment 配置 required reviewers 后，才能依赖它提供人工批准门禁。job 还会核对 run 是该 tag 提交上成功完成的 `harmony-preview.yml`，并且只下载和发布那次 run 的字节。

这一拆分允许一次代码/tag 推送完成候选构建，同时避免 tag 一推送就公开尚未经过安装包实机验收的 beta。beta.12 的 tagged run `37246876120` 已全部通过，但同批安装包的最终 Piora 桌面端与真实手机完整验收尚未完成；beta.13 的 run `37269231476` 在等待专用 HAP runner 24 小时后取消，桌面构建未执行且没有制品。当前 beta.14 必须重新完成同次 run 的构建和验收链，不能沿用旧候选产物；没有对应 tagged run 和最终安装包验收记录时，不得写成 beta.14 已通过或已发布。

本地只能运行来源、receipt、运行时签名和 workflow 的单元测试；不得本地生成可发布的 HAP 或桌面包。进入 staging 的 public unsigned HAP 必须来自 tagged CI run，并由同一输入生成的私有 device-signed 副本完成上述真机门禁。
