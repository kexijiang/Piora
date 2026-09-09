# 约尔 3D 桌宠（本地同人原型）

来源：用户指定角色约尔，Tripo v2.5 使用本地参考图生成；个人非商业使用。
任务：`32a9b5ad-760b-4538-a260-b1b0ac42c32b`。

## 本地文件

- `local-pets/anime-v2/yor-v25-4k.glb`：官方免费导出原件，13,053,344 字节，371,166 三角面，三张 4096×4096 贴图。
- `yor-v25-source.blend`：原件导入 Blender 5.2.1 后保存。
- `yor-studio.blend`：材质与摄影棚灯光工程。
- `yor-companion.blend`：简易骨骼和动作工程。
- `model.glb` / `pet.json` / `preview.png`：安装到 `~/.pi/agent/piora/pets-3d/yor-v25-3d` 的桌宠资产。
- `yor-front-4k.png`、`yor-three-quarter-4k.png`：2160×3840 Cycles 渲染。
- `yor-side.png`：1080×1920 侧面；`yor-face.png`：1600×1600 近景。

源资产仅在本机保存，未打包为公共分发内容。无购买或订阅。

## 互动范围与限制

Tripo 自动绑定没有成功受理，基础骨骼与动作在 Blender 制作。提供待机、点头、歪头、困倦、庆祝轻跳、提起轻摇和移动轻摇。GLB 中为了兼容现有运行时，点头沿用 `Wave` 动作名，移动轻摇沿用 `Walk`；它们不是抬手挥手或完整步行动画。

长裙和手臂原始网格存在粘连/权重混杂风险，因此移除大幅抬手动作。没有独立手指、面部表情或布料物理。脸部贴图偏软、眼睛不完全对称，饰品边缘存在生成痕迹；高分辨率文件不能消除这些问题。本版是可继续修改的原型，尚非精修角色。

预览入口：`http://127.0.0.1:30141/companion-3d`。页面默认展示约尔，支持角色切换和设为桌宠。渲染器降低环境光、增加色调映射，并保留 DPR 上限和 30 FPS 限制。

## 复现

脚本在 `local-pets/anime-v2/`：`prepare-yor.py` 调整材质，`rig-yor.py` 输出桌宠动作，`render-final.py` 输出效果图。

使用本机 Blender CLI 的 `--background --factory-startup --disable-autoexec --python` 运行脚本；未运行 Next.js 生产构建。

## 实测结果

2026-09-09：预览页面 GLB 加载状态为 ready，点头切换到 Wave，滚轮转身已通过截图确认，按钮显示“已设为桌宠”。TypeScript 全量检查及两处修改组件的 ESLint 均通过。首次 TypeScript 运行与 Next 开发类型重建重叠，产生临时文件缺失；重建完成后重跑通过。

网页截图发现 Blender 的 Map Range 粗糙度节点未被 glTF 正确保留，已用 `fix-export-roughness.py` 将调整烘焙进 4K 纹理并重新导出。运行模型现为 16,944,104 字节，已通过 GLB 校验并更新安装副本。

## 精修版 v3（当前安装版本）

当前运行资产已更新为 `local-pets/anime-v2/refined-v3/` 下的文件；旧版仍完整保存在上级目录。新工程为 `yor-refined.blend`，完成独立面部 UV/贴图、立体玫瑰发饰和发箍、分材质粗糙度处理，保留七个兼容动作。使用内置 image_gen 制作面部贴图中间素材，最终图片均为真实 Blender 渲染。

新图：`yor-face-refined.png`（1600×1600）、`yor-front-refined-4k.png`（2160×3840）、`yor-angle-refined.png`、`yor-nod-check.png`。完整修改、提示词和限制记录在该目录的 `refinement-notes.md`；导出统计在 `export-validation.json`。原颈饰和服装边缘仍需精修，不宣称已完成全面重拓扑。

## v4 表情与实时观感（当前版本）

当前资产目录为 `local-pets/anime-v2/alive-v4/`，工程 `yor-alive.blend`。保留 v3 身体和原有动作，加入闭眼表情、随机眨眼、休息时闭眼、渐进视线跟随与近看模式。清除旧自定义法线后，浏览器面部明暗分块有所改善。颈部重建试验未通过，当前仍保留原颈饰，整体精修目标尚未完成。

本轮验证与限制见该目录的 `progress-and-qa.md`，贴图生成方式与完整提示词亦记于其中。
# 约尔精修版 v5

当前可编辑工程：`yor-final.blend`。桌宠文件：`model.glb`、`pet.json`、`preview.png`。

为解决 Tripo 网格中颈部、衣饰、头发粘连的结构问题，本版换用了免费的完整约尔底稿。原 Tripo v2.5 和 v4 桌宠保留，未覆盖。

来源：VR Avatars / BlenderKit，Character Model - Yor Forger。
https://www.blenderkit.com/asset-gallery-detail/01f13039-6a8b-4b7e-8085-ce3ce97d893c/
官方元数据标记 isFree=true、license=royalty_free；元数据存放于 source/asset-metadata.json。本地用途仍限定为约尔角色同人、个人非商业桌宠；没有新增付费购买或 Tripo 消耗。

本版工作：
- 清理重叠眼周与鼻部覆盖面，保留真正的眼皮形变，并补充闭眼睫毛线。
- 将原卡通专用节点转为标准材质，区分皮肤、黑色衣料和金属花饰。
- 以原蒙皮权重重建桌宠骨骼，移除编辑控制器和循环约束；头发统一跟随头部，避免低头时发束分离。
- 移除两层不能正确导出、会变成白色的覆盖网格。原服装的细颈带因此没有保留。
- 制作 Idle、Wave、Think、Sleep、Celebrate、Drag、Walk 动作；Walk 当前是轻摇，并非步行动画。
- WebGL 使用 alpha mask，避免衣服透明排序错误；衣料颜色系数通过 runtime-materials.cjs 显式保存。

导出验证见 export-validation.json：所有贴图嵌入，约 20.5 MB，92,474 三角形，7 个动作，2 个 Blink 网格。

安装位置：~/.pi/agent/piora/pets-3d/yor-clean-3d/。
预览地址：http://127.0.0.1:30141/companion-3d 。

最终检查：实际浏览器显示完整模型、清理后的衣料和眼周；观察到挥手中间姿态、Sleep 闭眼及动作时间推进。Blender 另存 1600×1600 近景、1200×1200 闭眼图、2160×3840 全身图。网页实时灯光与 Cycles 灯光不同，因此以实际预览为准。

这是结构和动作明显改进的动漫精修版，未宣称达到照片级真人效果。发丝仍是实体发片，表情控制仍有限。源文件中的部分纹理会触发 Cycles 空图片警告；最后一轮渲染已完成且退出正常，所有交付 PNG 已实际打开检查。

后续重导出：从 yor-final.blend 运行 sync-export.py，再运行 runtime-materials.cjs，然后复制三个桌宠文件。不要从早期 inspect/refine 实验脚本覆盖最终工程。


## v6 面部与衣饰精修（2026-09-09）

当前工程为 `local-pets/yor-lifelike-v6/yor-v6.blend`，已替换本机 `yor-clean-3d` 的模型、元数据和预览图，v5 工程仍保留。详细来源、复现步骤及限制见该目录 README.md。

精修红眸、唇色、肤色和黑发反光，排除闭眼皮肤上的刘海残影；增加带细金边的黑色挂脖衣片，遮盖底稿胸前重叠身体层的异常。没有把底稿身体层完整重建，也未采用试验网格细分。

最终 GLB：21,345,992 字节、93,980 三角形、7 个动作、2 个 Blink 网格，所有 48 张图片嵌入。源模型与安装模型 SHA256 均为 89C9800DD71A03CCA898E05FA6EC42318D748CF3FB0333B48F0B778CBD20AE2E。

验证：Blender 最终近景、闭眼和 2160×3840 全身渲染完成且退出正常，均已打开查看。浏览器确认新衣片与眼睛出现、Sleep 闭眼、Wave 手臂动作；动作时间从 0.29 推进到 1.65 秒。页面仍显示“已设为桌宠”。本轮没有修改应用代码。

该版仍偏动漫手办质感，未宣称达到照片级真人效果。

## v7 光影与视线

基于 v6 模型补充闭眼和微笑的法线形变；本机运行模型更新为 v7。应用端加入双眼跟随、眼睛先于头部转动、空闲短暂移开视线及轻微微笑，并调整约尔的正面补光。每帧叠加视线前恢复动画姿态，避免没有动画轨道的骨骼不断累积旋转。睡眠和减少动态效果模式回归中性视线。

最终 GLB 约 21.4 MB，93,980 三角形、7 动作、2 Blink 网格，所有资源嵌入；两个 Blink 网格均导出 NORMAL 形变。实际浏览器识别到两个眼睛控制节点，视线状态随交互变化，困倦闭眼正常。角色仍为动漫造型，未宣称达到照片级真人。

3D 渲染、导入和表情代码纳入 beta.10；本地角色素材遵循仓库本地数据排除规则，不随公共安装包分发。
