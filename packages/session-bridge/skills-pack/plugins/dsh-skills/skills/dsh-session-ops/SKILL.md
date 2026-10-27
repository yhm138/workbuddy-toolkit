---
name: dsh-session-ops
description: |
  跨会话操作（复制 Session ID / 新建会话 / 给另一个会话发消息）的统一入口。
  听到「在此 Project 下新建一个 Session 并通信」「让两个会话对一下」「把这个任务交给
  另一个会话」「复制 Session ID」就走这里。
  默认目标是 WorkBuddy 原生会话（`bridge-test` / `wb-call promptWb`）；
  不要默认用 `dsh_local` 往用户的 DSH 发消息，只有用户明确点名「DSH」「dsh_local」
  「dsh-as-mcp」时才走 MCP。不确定就先查再问，别猜。
category: capability
version: "2.1.0"
tags: [dsh, workbuddy, session, mcp, cross-session, clipboard, steering]
---

# 跨会话操作（复制 ID / 新建 / 发消息）

## 「在此 Project 下新建一个 Session 并通信」= 一条命令

这是最常被触发的请求。**它指的是在 WorkBuddy 里新开一个会话、和当前会话通信，
跟 DSH 一点关系都没有。**

```bash
node bin/dsh2wb.mjs bridge-test --wait 20000 --timeout 150000
```

它会：在当前项目（`CODEBUDDY_PROJECT_DIR`）新建一个 **WorkBuddy** 会话 → 投递第 1 轮
问题 → 等**完整**回复 → 把新会话 ID 喂回去要求原样回显 → 再等回复。两轮都完整才算通。
明细落 `.probe/bridge-test.json`，回放用 `wb-session <新会话ID>`。

跑完向用户汇报三件事：新会话 ID、两轮问答的实到内容、结论（双向是否成立）。
如果 service 不在线，命令会直接告诉你怎么唤醒，**不要因此改道 DSH**。

**这个请求下不要做的事**：`dsh_local session_create`、`dsh_local session_prompt`、
往 `127.0.0.1:8790` 发任何请求。那些是用户 DSH 里的会话，会真开跑、真改文件。

想发给指定内容而不是自检问题，用下面的 `createWb` + `promptWb` 两步。

## 先选通道（选错会往用户的 DSH 里灌消息）

| 要做的事 | 用哪条 | 命令 |
| --- | --- | --- |
| **在此 Project 新建会话并通信** | `bridge-test` | 见上一节 |
| 给某个 **WorkBuddy** 会话发一句话（默认） | 原生会话桥 | `wb-call promptWb` |
| 新建一个 **WorkBuddy** 会话并交代任务（默认） | 原生会话桥 | `wb-call createWb` → `promptWb` |
| 用户**点名** DSH | dsh_local MCP | `session_prompt` |

判断顺序，从上到下：

1. 用户说了「DSH」「dsh_local」「dsh-as-mcp」「那个 harness」→ 走 **DSH**。
2. 目标会话能在 `dsh_local` 的 `session_list` 里查到 → 走 **DSH**。
3. 其余一律按 **WorkBuddy 原生会话**处理（含「新建一个 Session 并通信」）。
4. 拿不准就问一句「发到 WorkBuddy 会话还是 DSH 会话」，**不要猜**。

为什么默认不是 DSH：DSH 那边是真在跑的 agent，`session_prompt` 等于远程给它派活，
它会真的改文件、跑命令，还会占用用户当前的 DSH 轮次。用户多数时候只是想让
「另一个 WorkBuddy 会话」知道件事，根本不想惊动 DSH。

## WorkBuddy 原生会话桥（默认通道）

前提：扩展 service 在线。它由 WorkBuddy 客户端启动时 fork，**改代码不会自动重建**。

```bash
node bin/dsh2wb.mjs wb-call ping            # 不通 → 点开侧栏「会话桥」面板，或托盘退出重开客户端
```

命令（在 dsh2wb 仓库根目录执行）：

```bash
# 新建并交代任务
node bin/dsh2wb.mjs wb-call createWb --payload '{"cwd":"D:/绝对/路径"}'
node bin/dsh2wb.mjs wb-call promptWb --payload '{"conversationId":"<id>","text":"...","delivery":"steer"}'

# 看它回了什么（limit ≤ 100）
node bin/dsh2wb.mjs wb-call requestsWb --payload '{"conversationId":"<id>","limit":50}'

# 双向往返验收：新建 + 两轮 + 回放
node bin/dsh2wb.mjs bridge-test --wait 20000 --timeout 150000
node bin/dsh2wb.mjs wb-session <会话ID>
```

三个必须知道的点：

1. **`delivery` 决定投递方式**。`"steer"`（默认）把消息插进正在跑的轮次，对方界面上
   当场冒出一个对话气泡；传 `"queue"` 则会堆到输入框上方，等本轮结束后才处理。
2. **agent 看不到自己的会话 ID**，所以要它自报 ID 一定是 `null`——ID 只在宿主和本地
   `~/.workbuddy/projects/<项目>/<会话>.jsonl` 里，需要由桥喂给它。
3. **别拿半截回复当回复**。`requestsWb` 里 `pending:true` 的 assistantMessage 是流式
   中间态，判断「收到回复」只能看完整条数有没有增加。

## 复制 Session ID

宿主会把当前会话 ID 注入到 Bash 子进程的环境变量 `CODEBUDDY_SESSION_ID`，
所以**不需要服务、不需要扫文件、不需要问用户**：

```bash
node bin/dsh2wb.mjs copy-id            # 复制当前会话，附带标题/项目/轮次便于核对
node bin/dsh2wb.mjs copy-id --print    # 只打印，不写剪贴板
node bin/dsh2wb.mjs copy-id --sid <ID> # 复制指定会话
```

**任何目录都能用**（独立脚本，同样读环境变量）：

```bash
node "$HOME/.workbuddy/dsh-skills/scripts/session-id.mjs"
```

**不想敲命令**：侧栏「会话桥」面板里，会话行右键 →「复制会话 ID」；
装了菜单注入的话，WorkBuddy 原生会话菜单里也有「复制 Session ID」。

> 面板是全局的，宿主不告诉它你正在看哪个会话，所以要从面板拿「当前会话」不可靠；
> 精确拿当前会话只在会话里跑命令读环境变量。

## DSH 会话（只在点名时用）

`dsh-as-mcp` 把会话工具暴露在 `127.0.0.1:8790/mcp`，WorkBuddy 作为 MCP client 调用。
先确认 `dsh_local` 出现在 MCP 列表里、8790 在监听。

| 工具 | 必填 | 作用 |
| --- | --- | --- |
| `session_list` | — | 列出存活会话，最近更新在前（`limit` ≤ 200） |
| `session_create` | `cwd` 或 `workspaceId` | 新建 DSH 会话，返回 `sessionId`；可选 `agentPreset` |
| `session_prompt` | `sessionId`, `prompt` | 给会话下发一条消息。`mode`: `queue`（新轮次）/ `steer`（插进当前轮）；`wait`: 是否等本轮结束 |
| `session_messages` | `sessionId` | 读最近消息（`limit` ≤ 500） |
| `session_cancel` | `sessionId` | 让 agent 停下当前这一轮，队列保留 |
| `workspace_list` / `workspace_create` | — / 名称 | 工作区枚举与创建 |

`wait: false` 先返回，后续用 `session_messages` 轮询——别把一次工具调用挂几分钟。

## DSH 没开时

MCP 连不上（`ECONNREFUSED`）时只能做只读操作：

```bash
node "$HOME/.workbuddy/dsh-skills/scripts/session-search.mjs" "关键词" --max-sessions 50
node "$HOME/.workbuddy/dsh-skills/scripts/session-inspector.mjs" <session-id>
```

能列 ID、能复制、能读历史；不能新建或发消息。

## 安全边界

- **不确定目标是谁，就别发。** 往 DSH 发一条消息的成本远高于多发一句「发到哪」。
- 别给多个会话同时下发互相冲突的任务，它们会并行改同一批文件。
- `danger-full-access` 的 DSH 实例里，`session_prompt` 等于远程执行；只对可信会话用。
- 复制出去的 Session ID 本身不是凭据，但配合本机 MCP token 才能操作，别把 token 贴进聊天。
