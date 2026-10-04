# 普通投屏组件的发行门禁

Windows beta/stable 不能继续携带旧 1.0.3 HAP，也不能给旧字节补写来源。tag workflow 必须在同一次 GitHub Actions run 中构建新组件、签名、官方验签、真机验收、记录 provenance，再把同批资源交给 GitHub-hosted Windows 打桌面包。任一步缺失都会失败。

## 专用 runner

HAP job 只调度到带 `self-hosted`、`Windows`、`harmony-device`、`harmony-api26`、`ephemeral` 标签的 runner，并绑定 `harmony-hardware` environment 读取设备 secret。runner 必须：

- 使用一次性工作目录，安装完整 DevEco Studio API 26 SDK，并让 `DEVECO_SDK_HOME` 指向包含 `default` 目录的 SDK 根；可用 `DEVECO_STUDIO_HOME` 或 `HARMONY_*_PATH` 覆盖工具位置。
- 连接一台已解锁、已授权 HDC 且未预装 `com.ohos.scrcpy.server` 的开发手机；序列号只从 `HARMONY_DEVICE_SERIAL` environment secret 注入。门禁拒绝替换既有同包名应用。
- 具备官方 SDK 自带的 `OpenHarmony.p12`、`OpenHarmonyProfileRelease.pem`、`UnsgnedReleasedProfileTemplate.json` 和 `hap-sign-tool.jar`。仓库不复制这些材料，也不读取用户 debug 签名目录。

没有满足标签的 runner、设备 secret 或 API 26 SDK 时，release 保持排队或失败。workflow 不回退到旧 HAP，也不使用用户的 debug profile。

## 同次 run 链

1. `build-harmony-mirror-release.mjs` 调用 prepare，在全新隔离目录记录仓库源码与 GitHub repository/commit/workflow/run/attempt。
2. SDK 自带 ohpm/Hvigor 生成 API 26 `release`、`debug:false`、arm64 的 unsigned HAP。测量后的源码不能改；新生成的两个明确 ohpm lock 文件单独记录。
3. 脚本从 SDK 公开 release 示例证书构造仅含 `normal`、`hos_normal_app`、目标 bundle 且 ACL 为空的当前有效 profile；用 SDK 示例 release key 的 `localSign` 对 profile 和 HAP 签名。公开示例密码不是项目凭据，命令失败输出仍会脱敏。
4. 同一个 `hap-sign-tool.jar` 对签后 HAP 执行 `verify-app`，再对取出的 profile 执行 `verify-profile`。脚本核对 leaf 证书与 profile 中 distribution certificate 完全一致、证书和 profile 当前有效、bundle 正确且没有 ACL、受限权限或 privilege capability。
5. provenance 重新读取实际 HAP 的 API、release/debug、权限、ABI、版本、SHA-256 和源码指纹，生成 `harmony-mirror-manifest.json`。manifest 的 `signature: unverified` 仍只描述来源接口本身；独立的 `harmony-mirror-signature-verification.json` 保存非敏感的官方验签 receipt。
6. `verify-harmony-mirror-device.mjs` 把同一 HAP 安装到指定手机，回读版本、启动 EntryAbility，只点击新抓取 UI 树里的自有共享按钮和明确命名 Piora 的系统授权按钮。门禁要求真实 H.264 配置、至少 15 帧和一个关键帧，同时读取一张有效 PNG；最后移除自有 forward、停止并卸载 HAP，回读确认包不存在。receipt 只保存设备序列号 SHA-256，不保存序列号、截图或手机内容。
7. `stage-harmony-mirror-artifact.mjs` 只有在来源、验签、真机媒体和清理证据全部通过后，才复制 `OHScrcpyServer.hap`、两个 receipt/manifest 和新 `SOURCE.md`。Windows builder 下载这个同 run artifact，覆盖四个对应资源，同时保留仓库里的 HDC/libusb 和许可证，再在打包前、解包后各核对一次。

SDK 的 OpenHarmony release 示例身份适用于通过本门禁实际安装成功的 HDC 开发设备，不是 AppGallery 发行身份。每个 tagged run 都重新安装并验证，因此不能只根据证书名称推断兼容。

## beta 发布边界

`harmony-preview.yml` 只构建并上传已验证的 installer/portable，不创建 GitHub Release。下载这次 run 的桌面 artifact，用真正的 Piora 安装包和手机完成最终验收后，才可手动运行 `publish-preview.yml`，输入原 beta tag 和构建 run ID。发布 job 绑定 `preview-publish` environment；仓库必须为这个 environment 配置 required reviewers 后，才能依赖它提供人工批准门禁。job 还会核对 run 是该 tag 提交上成功完成的 `harmony-preview.yml`，并且只下载和发布那次 run 的字节。

这一拆分允许一次代码/tag 推送完成构建，同时避免 tag 一推送就公开尚未经过安装包实机验收的 beta。stable workflow 仍在发布前强制执行相同 HAP 构建、验签和手机门禁。

本地只能运行来源、receipt 和 workflow 的单元测试；不得本地生成可发布的 release HAP 或桌面包。私有 debug HAP 仍可按项目说明用于开发测试，但不能进入上述 staging。
