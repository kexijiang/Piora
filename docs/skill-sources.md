# 技能来源与发现

设置 → 技能包含“发现”“已安装”“来源管理”。添加或启用来源只让它参与浏览和搜索，不会自动安装其中的技能。第一版不新增聊天工具。

## 默认来源

| 来源 | 默认能力 |
| --- | --- |
| skills.sh | 现有匿名搜索及官方 CLI 回退；没有认证时不展示需要认证的新版榜单 |
| 腾讯 SkillHub | 内置但默认停用；配置部署者 API Key 后启用 |
| ClawHub | 公共技能目录、搜索及下载 |
| Anthropic Skills / Vercel Agent Skills | 按需读取精选 Git 仓库 |

skills.sh 官方 v1 目录 API 使用 Vercel OIDC；其短期 Token 过期后需要由部署者刷新。SkillHub 正式产品接入需要按提供商文档联系平台。Piora 不内置公共共享密钥。市场运营方与技能发布者是不同概念，收录在市场中不等于官方技能。

参考：[skills.sh API](https://www.skills.sh/docs/api)、[SkillHub API](https://github.com/Tencent/skillhub/blob/main/docs/api/README.md)、[ClawHub API](https://github.com/openclaw/clawhub/blob/main/docs/http-api.md)。

## 添加自定义来源

- **Git**：填写 HTTPS 或 SSH 地址，也接受 GitHub `owner/repo` 简写；可选分支、标签、完整提交 ID 与子目录。私有仓库复用运行 Piora 的机器上的 Git credential helper、SSH 配置及 agent。后台不打开登录提示；首次 SSH 连接应先在终端验证并保存主机指纹。GitHub HTTPS 无法连接时会尝试同一仓库的 SSH 地址。
- **自建市场**：选择 skills.sh v1、SkillHub 或 ClawHub 协议，填写 HTTP(S) 服务根地址与可选凭据。兼容服务必须提供所选协议的响应格式，普通网页地址不能当作市场。HTTP 仅适用于自己控制的内网服务；公开服务使用 HTTPS。
- 启用的来源保存前测试连接。API Key 通过 SkillHub 的 `X-API-Key` 发送，另外两类市场通过 Bearer 发送。自建来源不会回退到公共市场。

来源在项目间共享。变更地址、协议、Git ref 或子目录会创建新的来源标识；之前的安装不会切换更新目标。停用或删除来源保留已安装技能。内置来源可以停用或恢复默认，自定义来源可以移除。

## 安装和更新

发现页按来源独立加载。搜索与浏览结果缓存 15 分钟，刷新失败时展示已有缓存及时间；只有打开技能页或主动操作才会联网。详情显示原始 `SKILL.md`、文件列表和声明的运行依赖，安装不会执行其中的脚本或自动装依赖。

默认全局安装到 `<agentDir>/skills/<name>`；选择有效项目后也可以安装到 `<cwd>/.pi/skills/<name>`。同一作用范围的同名技能会阻止覆盖。全局和项目有同名内容时保留 SDK 资源优先级。新会话可以加载安装结果；已有会话在空闲后执行 `/reload`。

Git 安装保存实际提交；分支跟踪后续变化，标签及完整提交固定版本。市场安装保存解析版本。更新保留“对模型可见”设置，其他本地编辑会阻止覆盖。安装与更新先写入暂存目录；落盘或记录失败时回滚。旧 `skills` CLI 锁文件仍用于历史技能，不会被新的安装记录改写。

来源配置位于 `<agentDir>/piora/skill-sources/`，凭据保存在单独的私有文件，接口不会返回原值。全局安装记录位于 `<agentDir>/piora/skill-installs/installs.json`，项目安装记录位于 `<cwd>/.pi/piora/skill-installs/installs.json`。缓存与凭据不应提交到项目仓库。

只支持标准技能目录；OpenClaw 代码插件、完整 Agent 包及平台专属功能不会自动变成 Piora 扩展。技能声明的工具、系统和环境变量依赖仍须在本机满足。

## 验证

```sh
node --test lib/skill-sources.test.mjs lib/skill-lock.test.mjs lib/skill-updates.test.mjs components/SkillsConfig.browser.test.mjs
node scripts/verify-skill-sources.mjs
```

第二条为主动联网的冒烟检查，在临时用户目录中验证公共市场、精选仓库以及完整 Git 技能安装，结束后清理。它不读取真实 SkillHub 凭据；腾讯真实下载及用户私有仓库应在配置好相应凭据后另行验证。
