# 兼容性与证据

| 宿主/目标组合 | 软件证据 | 真机证据 | 发布声明 |
| --- | --- | --- | --- |
| Windows x64；未指定手机/OS | 单元、故障注入、worker、协议及浏览器回归 | 本次环境未连接设备，not-run | 实验性，逐设备探测和校准 |
| 本机 DevEco Studio 26.0.0.461 / CLI 1.3.3；fixture SDK 26.0.0 | production 和 debug 工程 ArkTS、lint 均通过 | 未安装/签名验证 | 仅代码检查通过 |
| 其他宿主或机型 | 按 CI 与 doctor 的实际输出记录 | 未验证 | 不声明通用商用支持 |

`declared` 表示代码注册，`probed` 表示只读帮助/系统信息可见，`verified` 需要实际动作或后置条件证据。显示 supported/probed 不意味着实体动作已实测。输出为 unknown、needs-calibration 或 unavailable 时按原因处理，不把跳过当通过。

贡献设备报告请使用 [硬件门禁](testing.md)，记录 OS/API/UiTest、driver、机型、次数、失败和证据 hash。不要上传未脱敏截图、录音、聊天或设备序列号。
