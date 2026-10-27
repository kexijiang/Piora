# 验证和发布

软件门禁：`npm test`、`npm run lint`、`npm run typecheck`、`npm run harmony:docs:check`、`npm run verify:hygiene`、`npm run licenses:check`、`npm run perf:check`。Harmony 测试包含无效观察、失效引用、租约撤销、几何、连接后直接操作、worker/跨进程互斥、文本和语音后置条件、debug token 与共享 JSON 模板。浏览器回归保留 `components/HarmonyPanel.browser.test.mjs`。

本地只编译 TypeScript worker 与测试 fixture。禁止在开发环境运行 Next release build，禁止在本地生成可发布的 HAP 或桌面安装包。GitHub Actions 保留现有 Windows/Linux 分片、性能、许可证、hygiene 与打包隔离运行验证。

可选的真实设备验收使用受控 self-hosted Windows runner 和明确设备序列号，运行 `node scripts/verify-harmony-device.mjs --serial <serial>`；没有目标设备输出 blocked/not-run 并返回非零。带 `--plan <json>` 只运行显式选择的测试场景，普通输入需 `PIORA_HARMONY_TEST_CONTROL=1`；危险操作仍走审批。仓库的 `tests/harmony-device-plan.json` 是启动、中文输入与只读检查点的最小方案，引用与 UI/Agent 相同的模板；它不覆盖真实识音、实体键、横竖屏或断连，需受控设备提供额外校准方案。CI 的手动 `run_hardware` 默认关闭。

fixture 可通过 `npm run harmony:fixture:prepare -- debug <新目录>` 或 production 生成。DevEco CLI 检查通过不等于 HAP 已签名或已安装。生产 HAP 在受控 CI 构建后用 `npm run harmony:fixture:verify-hap -- <生产HAP>` 扫描测试入口。签名材料由环境提供，不提交私钥或修改用户签名配置。

投屏组件随包分发仓库内审阅过的固定副本，tagged 打包全程使用 GitHub 托管 runner，不需要专用 runner 或真机。若需生成新的投屏组件，维护者可手工运行 `build-harmony-mirror-release.mjs`：先生成 public unsigned release-mode HAP，再从完全相同的字节生成独立的 private DevEco device-signed acceptance HAP；官方工具核对应用证书、debug Profile、bundle、普通权限和目标手机 allow-list 后，`verify-harmony-mirror-device.mjs` 仅对私有副本执行普通安装（不使用 `-r`）、版本回读、启动、明确授权、真实视频包、截图及卸载缺席门禁。

手工生成并验收新的投屏组件时，真机检查通过后 staging 只保留 public unsigned HAP、manifest、脱敏 receipt 与 `SOURCE.md`。workflow 的无条件清理会删除 private acceptance HAP 和临时验签文件，上传清单不包含任何 device-signed HAP。这份 receipt 证明相同 unsigned 输入曾生成私有验收副本，不把公开 HAP 描述成已签名；普通版本发布使用仓库内固定副本，不依赖该手工流程。

运行时签名另行覆盖：只有用户明确初始化投屏服务时，桌面端才会读取显式配置的本机 DevEco 私有 descriptor，或在 descriptor 缺失时复制随包最小工程并调用 DevEco CLI 自动生成标准配置；两条路径最终都要为连接手机生成并官方验签私有缓存副本。单测应使用注入执行器验证 CLI 的固定参数、私有工程目录、材料路径边界与密码/UDID 不进入命令参数，不调用真实云端签名。实机测试应断言 DevEco 未登录、API 26 签名工具、有效 Profile 或手机绑定缺失时得到可操作错误且 HDC install 未发送；已有组件不匹配时先卸载并确认缺席，随后只允许普通 install，不得出现 `-r`。

beta 构建 workflow 不直接发布；验收真正的 installer/portable 后，`publish-preview.yml` 才按 tag 与原 run ID 发布同批字节。stable workflow 在接入同一 bundle 的 AGC release certificate/profile 前必须失败关闭，不能上传 unsigned HAP 或复用 device debug 身份。鸿蒙手机验收按需进行，不作为 beta 发布门禁；未执行的设备测试必须如实标记为未验证。

发布需同步根/桌面版本、lockfile、README、许可证和带日期 CHANGELOG；提交前与推送前 fetch。新标签触发 GitHub Actions，安装包和更新元数据必须含同一份更新说明。构建中、失败、已发布分别报告，标签存在不代表安装包已发布。
