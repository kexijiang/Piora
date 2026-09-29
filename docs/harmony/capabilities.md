# 动作与参数目录

由 `npm run harmony:docs` 从动作注册表生成。注册动作不等于当前设备支持；请先查看工作台 doctor 返回的状态和证据级别。完整机器可读参数见 [actions.json](actions.json)。

| 动作 | 入口 | 风险 | 含义 |
| --- | --- | --- | --- |
| `tap` | direct, scenario | control | Tap one fresh semantic target or an explicit geometry point |
| `double_tap` | direct, scenario | control | Double tap a target |
| `long_press` | direct, scenario | control | Provider-defined short long press; not continuous touch hold |
| `tap_ref` | direct | control | Revalidate a retained reference against a fresh complete tree |
| `input_text` | direct, scenario | control | Set or append semantic text and verify exact readback |
| `clear_text` | scenario | control | Clear semantic text and verify empty readback |
| `scroll_find` | scenario | control | Find within a bounded directional swipe budget |
| `swipe` | direct, scenario | control | Bounded swipe |
| `fling` | direct, scenario | control | Fling using an explicit provider |
| `drag` | direct | control | Drag between geometry points |
| `press_key` | direct, scenario | control | Press a supported logical key |
| `key_hold` | direct | control | Hold an exact calibrated physical key duration with bounded release |
| `open_assistant` | direct | control | Use a device-bound power-key profile and verify its calibrated assistant postcondition |
| `touch_hold` | direct | control | Continuous calibrated touch with geometry and focus monitoring |
| `voice_input` | direct, scenario | control | Play an immutable asset over a calibrated acoustic route and verify the phone transcript |
| `geometry_assert` | scenario | read | Verify native display rotation against a newly captured screenshot |
| `launch_app` | direct, scenario | control | Launch a bundle and optional ability |
| `stop_app` | direct, scenario | control | Stop the selected application |
| `clear_app_data` | direct, scenario | control | Clear data of the selected application |
| `clear_app_cache` | direct | control | Clear cache of the selected application for the active user |
| `uninstall_app` | direct, scenario | control | Uninstall the selected application |
| `enable_app` | direct | control | Enable an app for the active user on a root device build |
| `disable_app` | direct | control | Disable an app for the active user on a root device build |
| `install_app` | direct, scenario | control | Install an integrity-checked immutable HAP |
| `upload_file` | direct | control | Upload an immutable local file into a writable device path |
| `create_directory` | direct | control | Create one device directory without creating parents |
| `delete_path` | direct | control | Delete one regular device file or empty directory |
| `rename_path` | direct | control | Rename one device file or directory without overwriting |
| `chmod_path` | direct | control | Set three-digit octal permissions on one regular device file or directory |
| `initialize_mirror` | direct | control | Initialize the capture component on request; never unlock |
| `wait_for` | scenario | read | Wait for a valid semantic observation |
| `assert` | scenario | read | Assert a valid semantic observation |
| `wait_idle` | scenario | read | Report driver idle or explicitly bounded delay |
| `checkpoint` | scenario | read | Persist an explicit execution boundary |
| `stop_device` | direct | control | Fence and stop only the selected device |
| `emergency_stop` | direct | control | Fence and stop all devices |

所有写入在实际发送前复核租约和策略。已发送或效果不明的写入不自动重放。物理按键、保持和声学路线必须校准；未验证机型见 [兼容矩阵](compatibility.md)。

## 场景模板

- [启动应用并验证](../../lib/harmony/scenario/templates/launch-and-verify.json)（流程版本 1）
- [中文输入与精确核对](../../lib/harmony/scenario/templates/chinese-input.json)（流程版本 1）
- [有界长列表查找](../../lib/harmony/scenario/templates/long-list.json)（流程版本 1）
- [横竖屏原生几何验证](../../lib/harmony/scenario/templates/orientation.json)（流程版本 1）
- [按住说话并核对手机识音](../../lib/harmony/scenario/templates/push-to-talk.json)（流程版本 1）
- [断连后安全恢复](../../lib/harmony/scenario/templates/safe-recovery.json)（流程版本 1）
