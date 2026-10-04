# 验证和发布

软件门禁：`npm test`、`npm run lint`、`npm run typecheck`、`npm run harmony:docs:check`、`npm run verify:hygiene`、`npm run licenses:check`、`npm run perf:check`。Harmony 测试包含无效观察、失效引用、租约撤销、几何、连接后直接操作、worker/跨进程互斥、文本和语音后置条件、debug token 与共享 JSON 模板。浏览器回归保留 `components/HarmonyPanel.browser.test.mjs`。

本地只编译 TypeScript worker 与测试 fixture。禁止在开发环境运行 Next release build，禁止在本地生成可发布的 release HAP 或桌面安装包。GitHub Actions 保留现有 Windows/Linux 分片、性能、许可证、hygiene 与打包隔离运行验证。

真实设备门禁使用受控 self-hosted Windows runner 和明确设备序列号，运行 `node scripts/verify-harmony-device.mjs --serial <serial>`；没有目标设备输出 blocked/not-run 并返回非零。带 `--plan <json>` 只运行显式选择的测试场景，普通输入需 `PIORA_HARMONY_TEST_CONTROL=1`；危险操作仍走审批。仓库的 `tests/harmony-device-plan.json` 是启动、中文输入与只读检查点的最小方案，引用与 UI/Agent 相同的模板；它不覆盖真实识音、实体键、横竖屏或断连，需受控设备提供额外校准方案。CI 的手动 `run_hardware` 默认关闭。

fixture 可通过 `npm run harmony:fixture:prepare -- debug <新目录>` 或 production 生成。DevEco CLI 检查通过不等于 HAP 已签名或已安装。生产 HAP 在受控 CI 构建后用 `npm run harmony:fixture:verify-hap -- <生产HAP>` 扫描测试入口。签名材料由环境提供，不提交私钥或改用户签名配置。

发行投屏 HAP 使用 tagged run 的 `[self-hosted, Windows, harmony-device, harmony-api26, ephemeral]` runner。`build-harmony-mirror-release.mjs` 完成 release 构建、OpenHarmony SDK 示例 release 签名和官方验签；`verify-harmony-mirror-device.mjs` 对相同字节执行安装、版本回读、启动、明确授权、真实视频包、截图及卸载缺席门禁。验收 receipt 不保存序列号和截图。GitHub-hosted Windows 只下载通过门禁的同 run artifact 后打包。beta 构建 workflow 不直接发布；安装真正的 installer/portable 并完成手机验收后，`publish-preview.yml` 才按 tag 与原 run ID 发布同批字节。

发布需同步根/桌面版本、lockfile、README、许可证和带日期 CHANGELOG；提交前与推送前 fetch。新标签触发 GitHub Actions，安装包和更新元数据必须含同一份更新说明。构建中、失败、已发布分别报告，标签存在不代表安装包已发布。
