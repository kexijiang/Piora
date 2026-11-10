# README 截图清单

适用版本：`0.5.9-beta.8`。本次没有可供截取的 Piora 应用窗口，因此新增图位使用明确标注“截图待补”的 SVG，不冒充产品截图。README 中另外引用的三张旧图来自仓库已有测试/历史资料。

## 拍摄与替换

1. 用 beta.8 安装版和演示项目，建议窗口 1440 × 900 或 1600 × 1000、缩放 100%，统一主题。完整工作区推荐 16:10；窄菜单可以局部截图。
2. 保存为下表中的 PNG 路径（均相对仓库根目录）。保持可读，单张尽量小于 1.5 MB；无须把截图强行拉伸成占位图比例。
3. 在根 README 搜索 `<!-- SCREENSHOT: 编号-名称 -->`，把紧随的图片链接后缀从 `.svg` 改为 `.png`，去掉 alt 和图注里的“待补”，改成实际界面的操作说明。
4. 更新下表状态、拍摄版本和日期。真实图片就位后可删除同名 SVG；确认没有剩余引用再删除。补图前页面中的 SVG 都能正常显示，不会出现破图。
5. 用 Markdown 预览核对宽度、文字和链接，并确认图片没有 API Key、访问令牌、内网地址、真实账户、聊天、设备序列号或私人文件路径。

示例：

```markdown
<!-- SCREENSHOT: 01-workspace -->
![Piora 项目工作区：聊天与文件差异](docs/images/readme/01-workspace.png)
*左侧选择项目，中间查看任务，右侧核对文件改动。*
```

## 待拍清单

| 图位 | PNG 保存路径 | 状态 |
| --- | --- | --- |
| 01-workspace · 完整工作区 | `docs/images/readme/01-workspace.png` | 待拍 |
| 02-models · 模型配置 | `docs/images/readme/02-models.png` | 待拍 |
| 03-chat-permissions · 任务与权限 | `docs/images/readme/03-chat-permissions.png` | 待拍 |
| 04-files-git · 文件与 Git | `docs/images/readme/04-files-git.png` | 待拍 |
| 05-browser · 浏览器接管 | `docs/images/readme/05-browser.png` | 待拍 |
| 06-rooms · 多 Agent 协作 | `docs/images/readme/06-rooms.png` | 待拍 |
| 07-schedules · 定时任务 | `docs/images/readme/07-schedules.png` | 待拍 |
| 08-skills · 技能与扩展 | `docs/images/readme/08-skills.png` | 待拍 |
| 09-harmony · 鸿蒙设备工作台 | `docs/images/readme/09-harmony.png` | 待拍 |
| 10-companion · 随身舱 | `docs/images/readme/10-companion.png` | 待拍 |
| 11-vault · 本地凭据库 | `docs/images/readme/11-vault.png` | 待拍 |
| 12-updates · 版本与更新来源 | `docs/images/readme/12-updates.png` | 待拍 |

### 01-workspace 完整工作区

- 打开方法：打开一个无敏感信息的演示项目，完成一次文件整理任务，展开右侧文件面板。
- 构图重点：左侧项目与会话、中间回复、右侧文件预览三栏同屏。
- 当前占位：[01-workspace.svg](images/readme/01-workspace.svg)
- 拍摄版本 / 日期：待填写。

### 02-models 模型配置

- 打开方法：设置 → 模型配置，选一个演示服务商，展开模型列表；必要时分两张拍摄渠道排序和模型编辑。
- 构图重点：渠道名称、Base URL、API 格式、识别模型、连接测试入口；密钥遮盖。
- 当前占位：[02-models.svg](images/readme/02-models.svg)
- 拍摄版本 / 日期：待填写。

### 03-chat-permissions 任务与权限

- 打开方法：在演示项目完成一次只读任务，展开一个工具调用，再打开输入框权限菜单。
- 构图重点：请求批准、帮我批准、完全访问三个选项与任务状态。
- 当前占位：[03-chat-permissions.svg](images/readme/03-chat-permissions.svg)
- 拍摄版本 / 日期：待填写。

### 04-files-git 文件与 Git

- 打开方法：演示 Git 仓库修改一份 Markdown，打开右侧文件差异和 Git 审阅。
- 构图重点：增删行、上一处/下一处改动、文件树与暂存入口；不要为了截图提交或推送。
- 当前占位：[04-files-git.svg](images/readme/04-files-git.svg)
- 拍摄版本 / 日期：待填写。

### 05-browser 浏览器接管

- 打开方法：在安装版内置浏览器使用演示网站，让 Agent 在需要手动操作时等待。
- 构图重点：聊天等待卡片和右侧当前页面同时可见；不要使用真实登录表单内容。
- 当前占位：[05-browser.svg](images/readme/05-browser.svg)
- 拍摄版本 / 日期：待填写。

### 06-rooms 多 Agent 协作

- 打开方法：创建演示群聊，用虚构成员和角色完成一个简单协作任务。
- 构图重点：成员、实际响应模型、@ 入口、回复和可下载成果；不要展示业务对话。
- 当前占位：[06-rooms.svg](images/readme/06-rooms.svg)
- 拍摄版本 / 日期：待填写。

### 07-schedules 定时任务

- 打开方法：设置 → 定时任务，使用演示任务，展示周期和一次执行记录。
- 构图重点：任务名称、项目、启停状态与执行历史；拍摄后删除不需要的演示计划。
- 当前占位：[07-schedules.svg](images/readme/07-schedules.svg)
- 拍摄版本 / 日期：待填写。

### 08-skills 技能与扩展

- 打开方法：设置 → 技能，搜索公开示例技能，再查看已安装页；可补拍 MCP 配置作为附图。
- 构图重点：真实可用的来源与技能卡片；不要把测试离线结果当成正常市场截图。
- 当前占位：[08-skills.svg](images/readme/08-skills.svg)
- 拍摄版本 / 日期：待填写。

### 09-harmony 鸿蒙设备工作台

- 打开方法：连接真实兼容设备，进入设备面板，保持手机为无隐私的演示页面并展开工具抽屉。
- 构图重点：完整手机画面、目标设备和工具入口；记录设备型号与系统版本，不显示序列号。
- 当前占位：[09-harmony.svg](images/readme/09-harmony.svg)
- 拍摄版本 / 日期：待填写。

### 10-companion 随身舱

- 打开方法：打开随身舱，添加虚构待办，在中转站打开示例 Markdown。
- 构图重点：窗口控制栏、待办或专注状态、文档编辑；不要展示个人剪贴板历史。
- 当前占位：[10-companion.svg](images/readme/10-companion.svg)
- 拍摄版本 / 日期：待填写。

### 11-vault 本地凭据库

- 打开方法：设置 → 数据 → 本地凭据库，使用空列表或专用演示账户。
- 构图重点：账户管理和备份入口；保持敏感字段遮盖，不为截图启用自动填写。
- 当前占位：[11-vault.svg](images/readme/11-vault.svg)
- 拍摄版本 / 日期：待填写。

### 12-updates 版本与更新来源

- 打开方法：在 beta.8 安装版中搜索设置“更新来源”，展示当前版本和来源选择。
- 构图重点：版本 0.5.9-beta.8、GitHub/内源选择和检查入口；内网截图须来自已配置的内网版。
- 当前占位：[12-updates.svg](images/readme/12-updates.svg)
- 拍摄版本 / 日期：待填写。


## 已有历史截图

以下图片已经检查内容，只放在 README 的折叠区内作为参考，不能用作 beta.8 新截图或实机验收证据：

| 图片 | 来源与边界 |
| --- | --- |
| `docs/images/settings-wallpaper/models.png` | 模型设置测试界面，使用虚构地址和模型；不演示当前渠道排序。 |
| `docs/assets/ssh-multihost-wide.png` | 回环地址的 SSH 测试环境，终端有测试提示；可后续换成无报错演示环境。 |
| `docs/images/dsh-pet/settings.png` | 历史桌面扩展设置，拍摄早于 DSH Meme 加入。 |

更新相应章节的截图后，可移除不再需要的历史折叠图，保留文档原始来源文件供其他文档使用。
