# Piora 图标与构建配置

当前只维护 Piora 发行版。旧的 XiaoYiHarness 品牌及官网源码已移除；`PIORA_BRAND` 仅接受 `piora`（默认值），其他值直接报错，避免旧环境配置继续生成停用品牌。

## 配置图标

编辑 `branding/piora/branding.json`，保留现有身份和更新渠道字段，可添加相对素材路径：

```json
{
  "id": "piora",
  "displayName": "Piora",
  "artifactPrefix": "Piora",
  "updateChannels": { "stable": "latest", "preview": "beta" },
  "icon": "icon.svg",
  "trayIcon": "tray.png"
}
```

素材放在 `branding/piora/` 内。`icon` 接受自包含 SVG，`trayIcon` 接受 PNG；禁止路径越界、脚本和外部 SVG 引用。未配置时沿用默认 Piora 主图标，托盘默认复用主图标。

运行 `npm run brand:prepare` 生成资源，无需打包。主图标生成桌面 PNG/多尺寸 ICO、网页 favicon、PWA 192/512 图标和 Apple touch icon；独立托盘 PNG 同时生成 Windows 托盘 ICO。生成的主图标也供静态启动页使用。

还可配置 `startupVideo`（MP4）、`startupPoster`（JPG）、`portableSplash`（BMP），路径规则相同；未配置时保留默认启动素材。资源生成前执行格式与路径校验，重新生成会清理已知旧启动素材。不要手动编辑 `.branding/` 或生成的品牌常量。

## 发行约束

- 应用、安装身份及数据路径保持 Piora；更换图标不会改变更新渠道或数据目录。
- 正式版使用 `latest.yml`，预览版使用 `beta.yml`；发布汇总只接受 Piora 产物。
- 发布包仅由 GitHub Actions 构建，本地不运行发布打包或 `next build`。
- 图标测试在临时目录验证自定义图标、托盘各尺寸、默认资源恢复、配置安全与打包资源一致性，不生成发行包。
