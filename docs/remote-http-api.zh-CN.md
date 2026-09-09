# Piora 独立扩展 HTTP API

独立运行的程序通过 `http://127.0.0.1:<Piora 端口>/api/remote/v1` 与 Piora 通信。基础地址和令牌可在 **设置 → 远程控制** 中取得。令牌只显示一次；服务端只保存其 SHA-256 摘要。

## 鉴权与安全边界

每个请求都要携带：

```http
Authorization: Bearer <能力令牌>
```

令牌同时受作用域和 Session 白名单约束。具有 `session.create` 的令牌创建 Session 后，Piora 会自动把新 Session 加入该令牌的白名单。创建接口不能覆盖进程的 `runtimeProfile`，浏览器与鸿蒙扩展按当前 Piora 运行配置尽力加载，不会因它们加载失败而拒绝创建 Session。

`session.create` 能让外部程序在请求的 `cwd` 内启动具备工具能力的智能体，因此应只签发给可信的本机程序。Piora 默认监听回环地址；不要将端口直接暴露到公网。

## 推荐调用流程

### 1. 发现当前令牌能力

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:30141/api/remote/v1/capabilities
```

### 2. 幂等创建 Session

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-extension-task-001" \
  -d '{"cwd":"F:\\\\workspace","name":"外部扩展任务","thinkingLevel":"high"}' \
  http://127.0.0.1:30141/api/remote/v1/sessions
```

成功时首次返回 `201`，相同令牌与幂等键重试返回同一个 Session 和 `200`。响应包含 `sessionId` 与后续接口链接。也可同时传入成对的 `provider`、`modelId`；省略时使用 Piora 默认模型。

### 3. 发送消息

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: my-extension-message-001" \
  -d '{"content":"检查项目并报告问题"}' \
  http://127.0.0.1:30141/api/remote/v1/sessions/<sessionId>/messages
```

返回 `202` 和 `commandId`。通过事件流监听生命周期，通过命令接口查询最终状态：

```text
GET /api/remote/v1/sessions/<sessionId>/events
GET /api/remote/v1/commands/<commandId>
```

## 已开放接口

| 方法 | 路径 | 作用域 | 用途 |
|---|---|---|---|
| GET | `/capabilities` | `capabilities.read` | 发现令牌实际可调用的接口 |
| GET | `/sessions` | `session.state.read` | 列出令牌获准访问的 Session |
| POST | `/sessions` | `session.create` | 幂等创建并自动获得新 Session 权限 |
| GET | `/sessions/:id/state` | `session.state.read` | 读取运行、队列和待处理状态 |
| GET | `/sessions/:id/history` | `session.history.read` | 读取当前分支对话历史；默认省略工具结果中的 Base64 图片 |
| GET | `/sessions/:id/history?includeMedia=true` | `session.history.read` | 包含历史中的内联媒体，响应可能很大 |
| GET | `/sessions/:id/tools` | `session.tools.read` | 读取工具描述、激活状态以及扩展命令/技能命令 |
| POST | `/sessions/:id/messages` | `session.message.send` | 投递下一轮消息，需要幂等键 |
| POST | `/sessions/:id/steer` | `session.steer` | 引导正在运行的 Session |
| POST | `/sessions/:id/abort` | `session.abort` | 中止运行 |
| GET | `/sessions/:id/events` | `session.events.read` | SSE 生命周期和命令事件流 |
| GET | `/commands/:id` | `session.messages.read` | 查询命令状态与失败信息 |

所有写入请求使用 JSON；单次远程 JSON 请求上限为 256 KiB。Session 创建和消息投递都应使用稳定、可重试的 `Idempotency-Key`。

## 令牌记录管理

设置 → 远程控制默认显示有效令牌，已撤销或已过期令牌归入默认收起的“已撤销记录”。撤销立即使令牌失效，但保留记录。展开历史区后可选择“删除记录”，二次确认后永久清除令牌及其会话创建幂等记录，不会删除会话本身。有效令牌必须先撤销，才能删除记录。

管理接口 `DELETE /api/remote/tokens/<id>` 保持撤销语义；添加 `?permanent=true` 才会永久删除失效记录。有效令牌返回 `409`，不存在的记录返回 `404`。

### 界面预览

![远程控制令牌创建表单](assets/remote-control-settings.png)
