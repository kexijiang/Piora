# 投屏控制链路与实机测量（2026-11-08）

## 本次修改

- 投屏去掉文字输入框，通过 ResizeObserver 报告实际窗口装饰高度，让画面等比例铺满悬浮窗宽度；普通音量、电源键不再走精确长按校准。
- `display_geometry` 走独立 Hypium worker 的持久 RPC，保留原始 displayId，仅接收主屏 0。方向前后读取必须一致；尺寸、方向非法则只读回退 HDC，方向竞争直接拒绝。输入失败不回放。
- 点击使用原生完整两点 PointerMatrix，两点同坐标，请求间隔 8ms。该请求值不代表物理触摸持续时间；不使用未释放的分段按下事件。
- 当前设备代际收到 250ms 内的完整视频帧时，在线校验不等待设备列表刷新。无帧、帧过期、连接关闭或离线时仍执行原有检查。

## 实机结果

USB HUAWEI Mate 60，1216×2688。命令：

```powershell
node scripts/verify-harmony-mirror-performance.mjs --hdc=<hdc.exe> --serial=<serial> --seconds=30 --phone=true --runtime=edge --headless=true --input=true --manager=true --output=<G盘目录>
```

最后有效一轮为 `accepted-device-run`：29 次点击，最小 142.723ms，中位数 203.976ms，P95 232.320ms，最大 235.045ms，0 次超时、0 个测量错误。绘制平均约 116 FPS，不等同于物理屏幕刷新率。

测量使用真实手机、原生视频、生产 Hybrid 后端及 DeviceManager 的租约、队列、代际、实时几何与帧新鲜度校验。起点是主机触发，终点是手机测试页响应后解码画面的颜色被观察并回传。未包含 React/HTTP 路由，也不是光学测量或安装版验收。**50ms 未达到，脚本性能门槛没有通过，不能把无漏点写成性能达标。**

早期阶段复用 RPC、普通点击的后端 P95 约 305ms；短点击后约 221ms，但它们不包含生产 manager，不能直接与最终结果作严格 A/B 比较。含 manager 的中间轮出现过最高约 1101ms 的列表刷新尖峰。本次有效复测最大约 235ms；不是全场景上限承诺。

其中一轮因机主切换到其他应用而作废。测量脚本已加入测试页可见性心跳与反馈超时中止，失去前台后停止继续注入。所有测试反向端口在结束时清理。安装包只交由 GitHub Actions 构建与验收。
