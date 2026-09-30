---
name: loop
displayName: Repeat on a schedule
description: 按固定间隔重复执行同一件事；用原生 loop 工具启动受监控后台 shell，并在每次标记输出时唤醒当前会话。
priority: 500
tags: [workflow, automation, loop]
disable-model-invocation: true
---

# 循环执行（Loop）

用法：`/loop [间隔] <要重复做的事>`。

- 支持前置或后置间隔，如 `5m 查构建`、`查构建 every 5 minutes`。
- 单位统一为秒传给工具：`30s` → 30，`5m` → 300，`2h` → 7200。
- 没写间隔时，根据结果值得再次检查的时间选择一个合理间隔，并明确告知用户。
- prompt 为空时显示 `Usage: /loop [间隔] <prompt>`。

## 启动

1. 用真实工具立即执行 prompt 一次；不要先等待。
2. 调用 `loop_create`，传入自包含的 `prompt` 与正整数 `intervalSeconds`。
3. 告知用户：首轮已经执行、循环间隔、loop id，以及它会持续到调用 `loop_stop` 或宿主退出。

`loop_create` 会启动独立的受监控后台 shell。每次到点时，shell 输出标记，运行时据此唤醒当前会话并再次执行 prompt。不要自己在当前回合里 `sleep`，不要用 `task_run` 模拟循环，也不要创建重复 loop。

## 查看与停止

- 用户要求查看时调用 `loop_list`。
- 用户要求停止时，先用 `loop_list` 找到当前会话中匹配的 loop，再调用 `loop_stop`。
- 多个 loop 都可能匹配且无法确定时，列出候选并询问用户。
- 停止后不要再创建替代 loop。
