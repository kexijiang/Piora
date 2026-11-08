# 更新说明片段

开发 PR 各自新增文件，避免同时编辑 `CHANGELOG.md` 的 `Unreleased`。片段随代码接受评审；发布时才将这些输入汇总成正式版本说明。

## 开发 PR

新增 `<唯一标识>.<类型>.md`，例如 `363-changelog-fragments-a83f.internal.md`。唯一标识使用小写字母、数字和连字符，可含 issue 号和随机后缀；无需预先知道 PR 编号。不要编辑本 README 来记录更新。

| 类型 | 发布分类 |
| --- | --- |
| `feature` | 新增 |
| `fix` | 修复 |
| `change` | 改进 |
| `internal` | 工程 |
| `skip` | 不进入发布说明；必须写具体豁免理由，由评审确认 |

每行是一条非空 Markdown 列表项，可用空行分隔，不使用标题或换行续写：

```markdown
- 修复群聊列表请求失败后错误提示无法关闭的问题，并保留已加载的会话。
```

用中文说明实际变化；工程改动说明用途。测试是否通过写入提交/PR 的验证记录，不能把未运行的检查写成通过。纯文档错字等无需发布说明时可用 `.skip.md`，正文仍为列表项，理由至少 12 个字符，例如：

```markdown
- 仅修正文档中的拼写错误，不改变应用行为或开发发布流程。
```

同一 PR 的后续提交维护自己的片段即可；已合入的片段不可修改，更正另加片段。CI 要求相对目标分支的 merge-base 至少新增一份有效片段，或验证是汇总命令产生的发布变更。CI 不自动提交生成文件。

```powershell
npm run changelog:check
git fetch upstream
npm run changelog:check-pr -- upstream/main
```

`check-pr` 检查已提交的 HEAD；未提交内容用 `check` 验证。将示例远端替换为实际目标分支所在远端。已有 PR 迁移时，先同步目标分支，再仅把自己的 `Unreleased` 修改移入新片段，保留其他 PR 的内容。

## 发布汇总

在独立发布分支同步目标分支并提交所有说明输入。以下命令不构建发布包、不自动提交、不修改版本或锁文件：

```powershell
npm run changelog:release -- 1.2.3-beta.1 2026-11-08
npm run changelog:release -- 1.2.3-beta.1 2026-11-08 --write
```

不带 `--write` 时只输出预览。输入取自固定 HEAD，`CHANGELOG.md` 和 `changelog.d` 必须无未提交/未跟踪修改。写入时保留历史版本，将遗留 `Unreleased` 文字和片段按固定分类、文件名排序汇总到新版本，只删除该快照中已消费的片段（包括豁免记录），保留 README。片段仍可从 Git 历史追溯。已有版本、无有效说明、无效日期均拒绝，不能重复汇总同一版本。

将 CHANGELOG 和片段删除与版本、锁文件、README、许可证清单变更放入同一个发布 PR。发布 PR 可保留之后新合入的片段；打标签前必须重新核对并汇总，发布元数据校验会拒绝仍有待处理片段的源码。不要在脚本执行期间并发编辑发布工作树。若写入后中断，检查 Git diff，恢复本次 CHANGELOG 和片段删除后重新运行，不要手工丢弃尚未确认收录的说明。

正式发布的唯一说明来源仍是 `CHANGELOG.md` 对应版本。GitHub Release 与更新 YAML 的生成和一致性校验不变，详见 [发布流程](../docs/release.md)。
