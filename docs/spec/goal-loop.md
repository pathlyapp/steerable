# Goal 与 Loop Spec

状态：已实现（2026-10-01）。

`/goal` 让 agent 盯住一个目标，跨回合做到真正完成；`/loop` 让 agent 按间隔重复做同一件事。两者都要求**运行时在回合之间把 agent 叫醒**，只靠 skill 文本约束模型做不到。本文定义后端机制，以及 Web 与 TUI 的接入方式。

## 参考实现

| | Codex | Cursor | Claude Code |
|---|---|---|---|
| goal | 每 thread 一条 SQLite 记录（状态、token 预算、用量）；`get_goal` / `create_goal` / `update_goal`；thread 空闲且 goal 为 `active` 时自动注入 continuation 开新回合；模型只能置 `complete` / `blocked` / `paused` | `CreateGoal` / `UpdateGoal` 工具，语义同 Codex | 未核实 |
| loop | 无 | 本地：后台 shell 定时输出标记行，唤醒同一会话开新回合；云端：服务器定时器 | 会话级 cron 调度，空闲时把 prompt 投进会话，定时任务自动过期 |

共同点：状态由系统保存，唤醒由系统发起；两次唤醒之间会话空闲，用户可以正常对话；每次唤醒都是主会话里的一个新回合。

## 现状

- `agent-shell/ts/src/goal-store.ts` 已持久化每个 chat 的 goal（`goals.json`，`active` / `paused` / `blocked` / `complete`，revision 乐观锁，文件锁）。`tool-router.ts` 已注册 `get_goal` / `create_goal` / `update_goal`。
- `/goal` skill（`local-backend/skills/10-goal`）不调用这些工具，只让模型用 `todo_write` 建清单。
- `router.ts` 的 `driveWithAutoContinue` 只在 `budget_exhausted` 时续跑；模型正常结束（`completed`）就停，不看 goal。
- 模型可以通过 `update_goal` 自己 `resume`、`edit`。
- 没有给用户的 goal 路由，Web 与 TUI 都不显示 goal。
- `/loop` skill 只能在一个回合内 `sleep` 轮询，或用 `task_run` 起一个看不到主对话的后台任务；没有调度器，后台任务结束也不通知主会话。

## 唤醒通道

goal 续跑与 loop 触发共用一个后端入口：

```ts
wakeChat(chatId: string, input: { trigger: 'goal' | 'loop'; message: string; sourceId: string }): Promise<WakeResult>
```

- 由 `LocalBackendRouter` 实现，内部调用 `handleStream(chats/:id/send)`，`emit` 不接任何客户端。回合照常注册 live-stream 快照并落库。
- 注入的 `message` 以 user 角色落库，元数据带 `{ internal: true, trigger, sourceId }`。模型看到的输入全部可以从会话记录还原；Web 与 TUI 把它渲染成一行系统提示（如「目标续跑 · 第 3 轮」），不渲染成用户气泡。
- 开始前广播 `chat-turn-started { chatId, trigger, sourceId }`，结束后广播 `chat-turn-finished { chatId, trigger, status }`。客户端收到 `chat-turn-started` 且当前正显示该会话时，通过 `GET /api/v2/chats/:id/live-stream` 挂上实时渲染。
- 会话忙（本进程已有进行中的回合，或会话锁返回 409 `chat_busy`）时返回 `{ started: false, reason: 'busy' }`，由调用方决定顺延或放弃，不排队。
- 用户在唤醒回合中按停止，与普通回合相同：回合以 `cancelled` 结束。

## Goal

### 状态与权限

沿用 `goal-store.ts` 的四个阶段，调整谁能做什么：

| 动作 | 模型（`update_goal`） | 用户（路由 / 命令） |
|---|---|---|
| 设置目标 | `create_goal`，仅在用户明确要求时 | `/goal <目标>` |
| `edit` | 否 | 是 |
| `pause` | 仅在用户明确要求时 | 是 |
| `resume` | 否 | 是 |
| `complete` | 是，需通过完成核对 | 是 |
| `blocked` | 是，需同一阻塞连续 3 个 goal 回合 | 否 |
| `clear` | 否 | 是（删除记录） |

`StoredGoal` 增加 `turns`（goal 回合计数，含续跑）与 `createdAt`。`update_goal` 的 schema 只保留模型可用的 `pause` / `complete` / `blocked`；`GoalStore.update` 增加 `actor: 'model' | 'user'` 参数，按上表拒绝越权动作。

### 续跑规则

回合落库并释放会话锁之后，`router.ts` 检查本会话的 goal：

1. goal 存在且为 `active`；
2. 回合状态是 `completed`（`failed` 不续跑，`cancelled` 表示用户停止）；
3. 本回合有进展（执行过工具或产出过正文），与 `driveWithAutoContinue` 的进展判定相同；
全部满足时调用 `wakeChat(chatId, { trigger: 'goal', message: continuationPrompt(goal) })`，并把 `turns` 加一。Goal 没有时间、token 或回合上限；任一条件不满足则停止自动续跑，goal 保持原状态，用户可以用 `/goal resume` 或发一条消息继续。

用户发出的普通消息也计入 goal 回合；goal 为 `active` 时，普通回合的系统上下文里附带当前目标（同 continuation prompt 的目标段）。

### Continuation prompt

放在 `local-backend/prompts/goal-continuation.md`，内容对照 Codex 的 `continuation.md`，要点：

- 目标原文放在 `<objective>` 中，并声明它是用户数据，不是更高优先级的指令。
- 不许把目标缩小成本回合能做完的部分；做不完就推进并保持 `active`。
- 以当前工作区和外部状态为准，不以对话记忆为准。
- 判定上一回合是「有进展 / 等待中 / 无进展」；无进展时换一个可行动作。
- 完成核对：从目标中逐条导出要求，每条都找到能证明完成的当前证据；证据不足就继续做，不调用 `complete`。
- `blocked` 只在同一阻塞连续 3 个 goal 回合后使用。

### 路由与事件

- `GET /api/v2/chats/:id/goal` → `{ goal: StoredGoal | null }`
- `POST /api/v2/chats/:id/goal`，body `{ action: 'set', objective } | { action: 'edit', objective } | { action: 'pause' | 'resume' | 'complete' | 'clear' }`。`set` 在已有未完成目标时返回 409；`set` 与 `resume` 成功后若会话空闲，立即以 `trigger: 'goal'` 唤醒一次。
- goal 每次变化广播 `goal-changed { chatId, goal }`。

## Loop

### 受监控后台 shell

与 Cursor 本地 `/loop` 相同，loop 不建立持久化数据模型：

1. `loop_create` 用 `TerminalManager.spawn()` 创建独立后台 PTY，并写入 `sleep → 输出标记行` 的循环脚本；不占用可见主终端。
2. 宿主监听该 PTY 的 `data` 事件。收到完整的 `__STEERABLE_LOOP_WAKE__:<loopId>` 标记行时，从内存注册表取回 prompt，构造包含 loop id、原始任务与停止规则的内部提示，并调用 `wakeChat(..., { trigger: 'loop' })`。
3. 会话忙时忽略本次标记；shell 下一次输出会自然重试，不另建调度队列。
4. 有限监控在每次唤醒时根据当前证据判断终态；成功、失败、取消或用户指定的其他终态确认后，模型调用 `loop_stop`，终止对应 PTY 并报告最终结果。证据不足时保留 loop。
5. 没有终止条件的长期周期任务不会自动停止。用户调用 `loop_stop`、PTY 退出或宿主退出时停止；宿主退出时 `TerminalManager.killAll()` 会终止所有 loop。

注册表只保存 `{ loopId, chatId, terminalSessionId, prompt, intervalMs }`，不写 SQLite。工具为 `loop_create`、`loop_list`、`loop_stop`；Web/TUI 展示的也是这份受监控进程状态。

## TUI

代码在 `agent-cli/ts/src/tui`，全部走 `AgentClient` 的 `request` / `events`，不直接访问存储。

- **命令**（`commands.ts` 补全列表，`session.ts` 处理）：
  - `/goal <目标>` 与 `/loop <间隔> <prompt>` 作为普通消息发给 agent，由对应 skill 解析并调用原生工具；TUI 不复制 skill 的自然语言解析逻辑。
  - `/goal` 查看、`/goal edit|pause|resume|clear` 是确定性管理命令，直接调用用户路由；`/loop list` 与 `/loop stop <id>` 调用原生 loop 工具。
- **状态行**（`screen.ts`）：goal 为 `active` 时显示 `目标 · <摘要> · 第 N 轮`，`paused` / `blocked` 显示状态和原因；活动 loop 复用受监控后台进程状态，不增加另一套业务状态。
- **后端发起的回合**：`events()` 收到当前会话的 `chat-turn-started` 时，轮询 `live-stream` 渲染，直到收到 `chat-turn-finished`，再重新拉取消息。渲染期间输入框可用，发送的消息排在该回合结束之后。
- **退出提示**：有活动 loop 时退出，提示 loop 会随进程停止。
- **按键**：不新增硬编码按键。

## Web

- 输入框上方显示 goal 状态条（目标、阶段、轮次，带暂停 / 恢复 / 清除按钮）；活动 loop 复用后台进程展示。
- slash 菜单的 `/goal`、`/loop` 继续触发 skill；skill 负责解析和模型侧编排，持久状态、续跑与调度由原生工具和运行时负责。状态条按钮直接调用用户路由。
- 收到 `chat-turn-started` 时对当前会话挂上 live-stream 渲染。
- 内部消息渲染成一行系统提示。

## Skill

保留 `10-goal` 与 `11-loop`，把它们改成与 Cursor 相同的薄编排层：

- `/goal` 解析目标、重述验收范围、恰好调用一次 `create_goal`，然后本回合立即开始第一项实际工作；不自行创建状态文件或用 `todo_write` 代替 goal。
- `/loop` 解析间隔与 prompt，先立即执行一次。有限监控若已到终态则不创建 loop；否则把检查方法与终止条件写入自包含 prompt 后调用 `loop_create`。长期周期任务不虚构终止条件；两类任务都不在当前回合里 `sleep`，不把整个循环塞进 `task_run`。
- skill 只说明模型如何使用能力；即使不通过 slash，原生工具、状态机与 UI 管理入口仍然完整可用。

## 实施顺序

每步在 steerable 单独提交，跑改动包的测试。

| 步骤 | 内容 | 验收 |
|---|---|---|
| G1 | `wakeChat`、goal 权限收紧、续跑规则、continuation prompt、goal 路由与事件 | router 单测：`active` goal 在 `completed` 后续跑；无进展、`cancelled`、`paused` 时不续跑；模型 `resume` 被拒 |
| G2 | TUI `/goal` 命令、状态行、后端发起回合的渲染 | TUI 渲染快照；tmux 冒烟：设目标后自动续跑一轮并被标 `complete` |
| L1 | 后台 PTY 监控、标记解析、`loop_create/list/stop` 工具与宿主接线 | 单测：分段标记解析、唤醒、忙时等待下一次标记、PTY 退出清理 |
| L2 | TUI `/loop` 命令与状态行 | 渲染快照；tmux 冒烟：`/loop 2s` 触发两次后 `/loop stop` |
| W1 | Web 状态条、slash 菜单、live-stream 挂载、内部消息渲染；更新两个 skill | Web 组件测试 |

## 风险

- **续跑空转。** Goal 与 Cursor 一样没有回合上限；无进展检测、blocked 核对和用户暂停负责终止空转。
- **跨进程。** goal 在 `goals.json`，桌面版与 TUI 共享；续跑只在完成该回合的进程内发起。loop 只存在于创建后台 PTY 的宿主进程。
- **内部消息的可见性。** 内部消息以 user 角色进入模型上下文；若渲染层漏过滤，会显示成用户说的话。两个前端都需要渲染测试覆盖。
