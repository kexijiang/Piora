# DSH Meme 桌面扩展

在 **设置 → 桌面扩展 → DSH Meme → 图库与设置** 安装 `dsh-meme@0.1.76`，然后启动。聊天输入框的笑脸按钮也可打开控制与选图面板。选图只插入草稿，点击发送后进入聊天；不会直接对外发消息。

## 固定版本与运行方式

- 原始 npm 发布归档固定为 0.1.76，校验 SHA-512；安装工具固定 npm 11.6.2 并校验归档，sharp 固定 0.35.5，其他传递依赖仍按 npm 解析。本次不提供自动升级。
- 复用 DSH Pet 的下载器、隔离环境、CA 合并、目录删除边界；安装使用 `--ignore-scripts --legacy-peer-deps`，不需要用户安装 npm。
- 插件在独立 Node/Electron Node 子进程中执行原版 `apply(ctx, config)`。Piora 提供这一个版本实际使用的 `tools`、HTTP 注册、事件/清理、模型和附件服务。`@deepseek-ai/dsh-tools` 只实现该版本所需的声明式 `defineTool` 接口，不安装完整 DSH/Cordis。
- 插件端口仅监听回环地址，所有请求必须携带随机令牌。桌面进程持有令牌，不返回网页或模型；管理窗口启用沙箱、上下文隔离，不注入 Piora preload。子进程 IPC 断开时退出，应用退出和数据目录迁移前停止插件。
- 独立管理面板复用上游 `panel.html`，补充频率、发送方式、图库切换/启用、ZIP 导入导出及 AI 识图入口，数据操作全部调用原版 HTTP API。没有加载依赖 DSH DOM 的 `client.js`，没有引入通用插件宿主或 QQ 平台服务。

## 内网安装

registry 优先级：`PIORA_DSH_MEME_REGISTRY` → `npm_config_registry`（支持大写）→ 用户 `.npmrc` 的 registry → npm 官方源。不会继承 `PIORA_DSH_PET_REGISTRY`；两个扩展可使用不同镜像。镜像需要提供固定包及传递依赖。

网络策略与 DSH Pet 共用：Piora 手动/直连代理优先，系统模式读取 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY 和 npmrc 的代理配置；支持 Basic 代理认证。合并操作系统证书、Node 默认 CA、NODE_EXTRA_CA_CERTS、npm cafile，写入私有 `trusted-ca.pem`，归档下载、npm 和插件网络请求均使用同一证书集合。插件 fetch 显式走 undici 环境代理，避免依赖 Electron 是否支持 NODE_USE_ENV_PROXY。保持 TLS 校验，不继承模型密钥、npm token 或任意 NODE_OPTIONS。PAC、NTLM/Kerberos 仍需系统外提供适配代理，与 DSH Pet 边界一致。

修改代理或 CA 后，停止并重启插件。安装失败可重试，过程中可取消，暂存文件清理后保留已有数据。不会自动修改系统信任证书或用户 npm 配置。

## 数据与历史

根目录为 `<所选 Pi agent 数据目录>/piora/desktop-extensions/dsh-meme`：

- `installed`：固定版本插件、依赖及安装标记。
- `home/.dsh`：上游配置与导入图库。
- `home/bundled-memes`：内置图库的持久副本。针对固定版本检查源码锚点，将 `bundledPacksDir()` 指向此处；首次复制，后续保留修改。
- `trusted-ca.pem`、npm 配置、缓存和安装暂存均在该扩展私有根下。

卸载只删除程序目录。已选择或模型返回的图片保存为 `<Pi 数据目录>/piora/memes/<SHA-256>` 不可变副本，用稳定 Markdown 地址显示，因此停止/卸载插件或修改图库后，历史聊天仍能显示图片。这只是会话图片缓存，Piora 不再维护一套可编辑图库索引。

不读取或修改用户现有 `~/.dsh` 插件列表与配置；迁移旧图库可在管理面板导入 ZIP。内置大肥鱼素材 manifest 为 personal，按用户主动安装下载，不随 Piora 发行包分发。上游 MIT 源码和许可证保留在安装目录。

## 模型与权限

`meme_list`、`send_meme`、`learn_meme`、`meme_update` 转发到原版工具，通过现有 Piora 工具权限门。发送候选中的精确 `[表情: 描述]` 转换为持久图片 Markdown；纯文字模式不生成图片。关闭主动发送遵从上游语义，用户明确要图仍可发。

AI 学图只在用户要求收藏时调用。附件只转发当前调用所需的最近一张用户图；识图经桌面进程回到 Piora 模型 API，插件不拿到凭据。工具调用使用当前会话模型，管理面板使用默认可见模型；不支持图片或未配置模型时明确报错，也可手动填分类上传。不传递其他聊天正文。

## 验证

快速测试：`node --test lib/dsh-meme.test.mjs lib/meme-store.test.mjs lib/dsh-pet-network.test.mjs lib/dsh-pet-ca.test.mjs`。

原版插件 smoke：先用 `node node_modules/typescript/bin/tsc6 -p desktop/tsconfig.json --outDir .verification/meme-desktop` 编译测试夹具，再运行 `node scripts/verify-dsh-meme.mjs`。首次会真实联网安装，运行目录固定为本 checkout 的 `.verification/dsh-meme-runtime`；原版工具和浏览器面板真实执行，识图模型使用确定性夹具。图片和 ZIP 截图/产物保存在 `.verification`。这不等于真实模型或发布包验收。
