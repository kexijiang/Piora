# 金克斯 3D 桌宠初版

本机模型来自 Abhay Pratap 的 **Jinx Anime Style (Fully rigged)**，是动漫风格同人模型。通过 Blender 5.2.1 整理、减面、统一 UV、调整 PBR 材质并制作七组骨骼动画，再导出供 Three.js 使用的自包含 GLB。

## 本机使用

- 开发预览：`http://127.0.0.1:30141/companion-3d`，可切换动作、滚轮转身、设为桌宠。
- 桌宠设置中选择 **金克斯 · Jinx 3D**，已有的桌面独立窗口会使用 3D 渲染器。
- 可编辑工程：`local-pets/jinx-3d/jinx-companion.blend`。
- 运行模型：`local-pets/jinx-3d/model.glb`；静态预览：`local-pets/jinx-3d/preview.png`。
- 本机安装位置：`<agentDir>/piora/pets-3d/jinx-3d/`。默认 agentDir 为 `~/.pi/agent`，遵循 `PI_CODING_AGENT_DIR`。
- 当前开发服务器用 `node node_modules/next/dist/bin/next dev --webpack -H 127.0.0.1 -p 30141`；没有运行生产构建。

## 已实现

`Idle`（待机）、`Walk`（散步）、`Wave`（挥手）、`Celebrate`（庆祝）、`Sleep`（困倦）、`Drag`（被提起）、`Think`（思考）。运行时任务状态、完成事件和鼠标互动切换动画；实体桌面移动时播放散步，拖动时播放被提起动作。困倦表现为低头呼吸，当前资源没有面部表情骨骼。

渲染器最高 30 FPS、设备像素比上限 1.5。隐藏/不可见时暂停；减少动态效果时降低刷新并冻结动作。桌面点击区域每 250 ms 读取渲染 alpha 边界，复用已有原生窗口命中检测桥接。WebGL 不可用时显示静态预览与提示。角色列表使用静态预览，避免为每个缩略图创建 WebGL 上下文。

这版还没有布料/辫子物理、换装、抓取部位区分或专门的面部动画。辫子跟随头部骨骼，使用幅度较小的动作；不是影视级动画。

## 验证情况

TypeScript 检查及本次修改文件的 ESLint 检查通过；相关测试 36 项通过，1 项因 Windows 符号链接权限不足跳过。浏览器中已实际验证互动预览、选择为当前桌宠和 `/desktop-pet` 独立入口的 WebGL 渲染，未出现渲染错误。原生 Electron 窗口的跨屏拖动和鼠标穿透仍需在桌面应用内实测。

## 重建与安装

原资源保存在 `local-pets/jinx-3d/source/jinx-anime-1k.blend`，采用 Blendkit 提供的 1K 贴图版本。重建：

```powershell
& 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe' --background --factory-startup --disable-autoexec --python-exit-code 1 --python scripts/prepare-jinx-companion.py
node scripts/install-companion-model.mjs local-pets/jinx-3d
```

安装脚本保留已有同名角色，不会覆盖。模型包包含 `pet.json`、`model.glb`、`preview.png`；GLB 必须内嵌所有纹理与 buffer。通用 ZIP 导入仍用于原有精灵图宠物。

模型来源：

- [作者资源页](https://www.blendkit.com/get-blendkit/9b97ef56-bc11-4eb5-b1de-13aa2bce4be8/)
- Asset base ID：`9b97ef56-bc11-4eb5-b1de-13aa2bce4be8`
- 作者：Abhay Pratap；资源许可标注为 `royalty_free`。
- [Blendkit 许可说明](https://www.blendkit.com/docs/licenses/licensing-faq/)

原模型、处理后的 GLB 与 Blender 工程都作为用户本地资源保存，不纳入 Piora 的 MIT 代码许可或公共安装包。角色设计权利属于原权利方。代码仓库仅包含加载器、处理脚本与说明。

## Tripo

已从 [Tripo 官方仓库](https://github.com/VAST-AI-Research/tripo-3d-for-blender) 下载并在本机 Blender 5.2 中启用 **Tripo 3D 0.7.7**。安装包 SHA-256：`a553e068fdb87f100f32d3a3b7a11ed7dff0d0635db661760bc2514b3012ca43`。

入口：Blender 的 3D 视图右侧 Sidebar → Tripo 3D。使用在线生成前需配置用户自己的 Tripo API Key。本次金克斯使用现成模型，未调用 Tripo 生成，也未购买额度。
