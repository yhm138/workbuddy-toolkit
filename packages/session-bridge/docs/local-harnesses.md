# 本地其他 harness 的会话从哪来

会话桥原来只认 DSH 和 WorkBuddy。加上 Codex / Claude 之后，同一个"会话列表"背后是
三套完全不同的磁盘格式和一个宿主通道。这份文档记清楚各自的位置、字段和坑。

## 三套存储

| | 位置 | ID 长相 | 能发消息 |
| --- | --- | --- | --- |
| DSH | `~/.dsh/sessions/`（MCP 主、磁盘兜底） | `session-<uuid>` | 能（MCP `session_prompt`） |
| WorkBuddy 本机 | `~/.workbuddy/projects/<项目编码>/<uuid>.jsonl` | UUID | 能（宿主 `sendPrompt`） |
| WorkBuddy 云端 | `wb.http.get /console/as/conversations/` | 19 位数字 | 未验，只做复制/打开 |
| **Codex** | `~/.codex/sessions/<年>/<月>/<日>/rollout-<时间>-<uuid>.jsonl` | UUID | **不能**（只读） |
| **Claude** | `~/.claude/projects/<项目编码>/<uuid>.jsonl` | UUID | **不能**（只读） |

Codex 的归档在 `~/.codex/archived_sessions/*.jsonl.zst`（zstd 压缩），本期没纳入。

## Codex 的记录格式

每行一个 JSON，靠 `type` 分：

```jsonc
{"type":"session_meta","payload":{"id":"<线程ID>","cwd":"D:\\work","timestamp":"...","parent_thread_id":"<父线程>","agent_nickname":"Bacon","model_provider":"openai"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"..."}]}}
{"type":"response_item","payload":{"type":"reasoning"}}          // 推理，丢掉
{"type":"response_item","payload":{"type":"custom_tool_call"}}  // 工具调用，丢掉
{"type":"event_msg","payload":{"type":"token_count"}}           // 统计，丢掉
```

只取 `response_item` 里 `payload.type === "message"` 且 `role` 是 `user` / `assistant` 的。
`developer` 是提示词，不是对话。

**Codex 没有标题字段**，标题只能用第一句真人说的话。所以必须先滤掉注入，否则每条会话
的标题都会变成 `# AGENTS.md instructions` 或 `<environment_context>`：

| 开头 | 是什么 |
| --- | --- |
| `<environment_context>` | 当前目录/时间等环境上下文 |
| `# AGENTS.md instructions` / `<INSTRUCTIONS>` | 项目规则 |
| `# Files mentioned by the user` / `# Files pasted by the user` | 附件包装，**真问题在 `## My request:` 之后** |
| `<subagent_notification>` / `<send_user_message_question>` | 子 agent 通信 |
| `<recommended_plugins>` / `<external_codex_apps_open_page>` | 应用注入 |

**子 agent 线程**（`session_meta.payload.parent_thread_id` 有值）默认折叠：它们没有独立对话，
标题也基本是空的。实测这台机器 400 个 rollout 里 174 个是子 agent，不折叠的话主线会被埋掉。

## Claude 的记录格式

```jsonc
{"type":"custom-title","customTitle":"重构会话桥","sessionId":"..."}   // 标题来源
{"type":"user","isSidechain":false,"cwd":"D:/work","message":{"role":"user","content":"..."}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking"},{"type":"text","text":"..."}]}}
{"type":"user","message":{"content":[{"type":"tool_result"}]}}          // 工具结果，不是人说的
```

- 标题优先 `custom-title`，没有就取第一句用户消息；
- `message.content` 可能是字符串，也可能是块数组，只取 `type === "text"`（`thinking` 不能混进正文）；
- `isSidechain: true` 是子 agent 分支，跳过；
- 纯 `tool_result` 的 user 记录跳过；
- 注入开头：`<system-reminder>`、`<task-notification>`、`<local-command-*>`、`Another Claude session sent`。

## Claude Desktop 到底覆盖到哪

`~/AppData/Local/Claude` 里只有 `claude_desktop_config.json` 和 `logs/`，**没有会话库**——
桌面端的聊天记录不落盘（在服务端）。所以：

- **聊天（Chat）标签页**：本地拿不到，面板不显示；
- **Code 标签页**：跑的就是 Claude Code 运行时，记录写在 `~/.claude/projects`，**已覆盖**。

## 为什么只读

Codex / Claude 的写入通道是各自的私有 IPC（Codex 走 app-server，Claude 走 CLI 进程），
没有对外开放的注入接口。硬塞消息会打乱它们自己的会话状态，收益也不大——看得到、复制得了 ID
和恢复命令，就够把上下文接起来了。

「复制恢复命令」给的是：

```bash
codex resume <session-id>
claude --resume <session-id>
```

## 性能

- 只读文件头（96KB），不整份读；解析结果按 `(路径, size, mtime)` 缓存，刷新面板不重复解析；
- 列表是「边扫边收」：按 mtime 倒序扫，凑够 limit 条可见的就停，不会为了几条主线把 300 多个
  文件全解析一遍；
- 实测这台机器：Codex 20 条 180ms、Claude 8 条 23ms，`harnesses` 探测 266ms。

## 加一个新 harness 要动哪

1. `extension/server/harnesses.cjs` 里加一个适配器，实现 `available / count / list / read`；
2. 塞进 `ADAPTERS`；
3. `src/commands/installExtension.mjs` 的文件清单不用改（新适配器写在同一个文件里）。

面板的标签页、只读提示、恢复命令都是从适配器的 `label` / `readOnly` / `resumePrefix` 读的，
不用改 UI。
