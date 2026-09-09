# Piora · 北极星探索启动动画

当前方案采用用户提供的 `piora_intro.py`：2076 年、北极星方向的虚构冰岩世界、PX-06 无人六轮探测车，保留行驶、车身标识特写、减速扫描和品牌片尾。整段 8 秒、30 fps、1920 × 1080、无音轨。车型、地形、三维文字、材质与特效均由脚本生成，不依赖外部模型或贴图。

脚本已在 **Blender 5.2.1 LTS / Windows** 实际生成场景并渲染。Blender 4.5 兼容分支保留，但本机没有执行 4.5 验证。`polaris-rover.py` 是 beta.5 使用的旧版风格化场景。

## 先检查一帧

```powershell
blender -b -t 6 --python-exit-code 1 --python scripts/blender/piora_intro.py -- --mode FRAME --quality PREVIEW --out .verification/piora-intro
```

也可以在 Blender 的 Scripting 工作区打开脚本并运行。默认 `PREVIEW + BUILD` 只生成并保存场景，F12 渲染当前镜头。需要使用 Blender 可执行文件的完整路径时，将命令中的 `blender` 替换为该路径。

每次运行创建独立的 `run_时间戳` 目录，不覆盖已有输出，也不删除当前工程中的其他场景。工程中同时嵌入了生成脚本，运动烘焙为普通关键帧，不要求开启自动执行 Python。

## 正式出片

```powershell
blender -b -t 6 --python-exit-code 1 --python scripts/blender/piora_intro.py -- --mode ANIMATION --quality FINAL --format PNG_SEQUENCE --out .verification/piora-intro
node scripts/encode-startup-video.mjs <ffmpeg路径> <上一步的run目录>
```

编码器检查全部 240 张 PNG 的尺寸，生成 H.264/yuv420p、fast-start MP4，并以车身标识镜头生成静态封面。它把视频、封面、可编辑 `.blend` 和哈希清单放到 `desktop/build/startup`。可在命令末尾追加输出目录，进行预览而不替换应用资源。

脚本也支持 `--format MP4` 直接使用 Blender 编码；项目发布采用 PNG 序列加 FFmpeg，便于逐帧检查并保留渲染中间结果。

## 验证

```powershell
python scripts/blender/test_numerics.py
blender -b <run目录>/piora_polaris_2076.blend --python-exit-code 1 --python scripts/blender/verify_intro.py
node --test lib/desktop-startup-visual.test.mjs lib/startup-media-assets.test.mjs
```

- 原有 8 项数值检查：路线、地表插值、净空、取景等。
- Blender 实际场景检查：240 帧的 1,440 次轮心接地检查、9 个镜头位置的实际车体包围盒、停车状态、品牌片尾透明度，以及车身标识与序列号不重叠。
- 最终仍需查看视频，检查动作、光照、字幕与淡入淡出的观感。上述数值检查不是完整车辆物理仿真，也不能代替视觉验收。

## 本次兼容修复

- Blender 5.2 的视频输出使用 `image_settings.media_type = "VIDEO"`；单帧渲染切回 `IMAGE` 后正确恢复原设置。
- 适配辉光节点的 Type/Quality 输入、混合与数值节点的新名称，以及 Alpha Over 的具名插槽。
- 缩小并上移车身主标识，与下方序列号分开；三维文字仍可编辑。
- 工程以压缩副本保存。原始 ZIP 不作修改。

启动页按视频原比例显示完整画面，不叠加大标题；保留跳过、静音、减少动态效果的静态回退和超时保护。片尾自然结束后进入应用，媒体加载异常最多等待 10 秒。
