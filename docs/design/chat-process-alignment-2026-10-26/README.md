# 主对话执行过程竖线对齐

竖线与同一聊天列的正文左边缘对齐，保留竖线内侧的层级缩进。宽窗口和 390 px 窄窗口共用起点。

`activity-types.png` 来自真实 ChatHistory / MessageView 组件与生产 CSS 的浏览器夹具，命令和文件内容为模拟数据。`components/CompactProcess.browser.test.mjs` 同时检查竖线与正文边缘的实际坐标，误差不超过 1 CSS 像素，并保留展开、复制、文件打开、过程折叠与滚动位置回归。
