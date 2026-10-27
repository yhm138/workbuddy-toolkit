# DSH → WorkBuddy 能力对照矩阵

> 这张表是工具内置的映射定义，不依赖某个具体 profile。
> 对照版本：WorkBuddy 5.9.0 / DSH 0.2.1-rc.2（2026-10-24 校验）。

图例：✅ 原生等价 · 📦 本包补齐 · 🟡 部分覆盖 · ✍️ 需手动设置 · ⛔ 不可移植

## 插件层

| DSH bundle | 类型 | 结果 | WorkBuddy 侧 | 说明 |
| --- | --- | --- | --- | --- |
| `@deepseek-ai/dsh-base` | 内置核心 | ✅ 原生等价 | WorkBuddy 内核（Agent 循环、会话、工具、存储、模型接入） | 形态不同，能力对应。 |
| `@deepseek-ai/dsh-web-app` | 内置核心 | ✅ 原生等价 | WorkBuddy 桌面端 / Web 工作台 | 无需迁移。 |
| `dsh-conversation-navigator` | 第三方 | 🟡 部分覆盖 | 无对话大纲面板；`dsh-session-inspector` 可把任一轮次导出成大纲 | UI 面板无法移植，用技能补“看结构”的能力。 |
| `dsh-sessions-manager` | 第三方（本地构建） | 🟡 部分覆盖 | 任务列表原生支持重命名 / 删除 / 搜索；归档、回收站、标签、收藏没有 | 高频操作可继续在 DSH 内完成，WorkBuddy 侧负责干活。 |
| `@deepseek-ai/dsh-experimental-inspector-profile` | 内置实验 | 📦 本包补齐 | `dsh-session-inspector`：session.v4.jsonl.zstd → 时间线 Markdown / HTML | 按用户/助手/工具调用还原一轮到底发生了什么。 |
| `@deepseek-ai/dsh-subagent-codex` | 第三方 | ✅ 原生等价 | WorkBuddy 子代理（Agent 工具，可并行、可指定模型） | 子代理模型不同，编排语义一致。 |
| `@deepseek-ai/dsh-experimental-plugin-market-bundle` | 内置实验 | ✅ 原生等价 | 插件市场（插件 = 技能 + 连接 + 指令 + Hooks + Agents） | 自定义市场索引不可配；本地目录市场可用。 |
| `@deepseek-ai/dsh-experimental-session-search` | 内置实验 | 📦 本包补齐 | `dsh-session-search`：跨工作区检索 DSH 历史会话（支持中文、正则、时间过滤） | WorkBuddy 的会话检索只覆盖自己的会话，故补齐 DSH 侧。 |
| `@deepseek-ai/dsh-experimental-terminal-bundle` | 内置实验 | 🟡 部分覆盖 | Bash / PowerShell 工具在单次任务内可复用工作目录 | 没有跨工具调用的常驻终端与 pwsh 会话。 |
| `@hyzyn/dsh-search` | 第三方 | ✅ 原生等价 | 侧栏全局搜索 / 命令面板 | 入口位置不同，能力对等。 |
| `dsh-as-mcp` | 第三方 | 📦 本包补齐 | `mcp.json` 写入 `dsh_local`（streamable-http + Bearer token），直接暴露 session_create/list/prompt/messages/cancel | WorkBuddy 作为 MCP client 反向驱动 DSH 的工作区/会话工具。 |
| `@michengai/dsh-codex-ui` | 第三方 | ⛔ 不可移植 | — | 侧栏/会话树/皮肤属于宿主 UI，插件无法注入 WorkBuddy 前端。 |
| `@laoyuehanni/dsh-token-usage` | 第三方 | 📦 本包补齐 | `dsh-token-usage`：读取 ~/.dsh/token-usage，按天/模型/人民币出账 | 保留国内定价口径与历史数据，不重新估算。 |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | 内置实验 | ✅ 原生等价 | 多人多 Agent 协作 / 团队任务面板 | 成员上限与消息大小由 WorkBuddy 决定。 |
| `dsh-client-auto-continue` | 第三方 | 🟡 部分覆盖 | 无“中断自动继续”开关；可用定时任务或手动“继续” | 属于运行时行为，插件层无法拦截重试。 |

## 设置层

| 设置 | 结果 | WorkBuddy 做法 |
| --- | --- | --- |
| 界面语言：中文（zh） | ✅ 原生等价 | 设置 → 外观/语言，确认为简体中文 |
| 默认模型：deepseek-flash · 推理强度 max | ✍️ 需手动设置 | 在模型菜单选择 DeepSeek 对应模型；高强度推理任务手动拉满 |
| 默认权限：danger-full-access + 审批 never | ✍️ 需手动设置 | 设置 → 默认权限与安全沙箱；建议改为「工作区可写 + 审批」，不要照搬 danger-full-access |
| 单轮并行工具 20 / 活跃子代理 16 | ✅ 原生等价 | 无需处理 |
| 繁忙时 Enter：插话发送（steer），Ctrl+Enter 排队 | ⛔ 不可移植 | 无对应设置，忽略 |
| 聊天记录：详细；性能/用量：详细 | 🟡 部分覆盖 | 需要过程细节时用 `dsh-session-inspector` 看原始时间线 |
| 插件市场索引 3 个（jsdelivr / bruc3van / awesome-dsh-plugin） | ⛔ 不可移植 | 无对应设置，忽略 |
| dsh-as-mcp：127.0.0.1:8790/mcp，开放工作区+会话 | 📦 本包补齐 | 运行 `dsh2wb install` 自动写入；DSH 需在运行 |
| Token 用量：国内人民币定价、记录压缩调用、供应商配额 | 📦 本包补齐 | 直接问「这个月 DSH 花了多少钱」 |
| 自动继续：开启（宽限 30s、最多 30 次、自主循环关闭） | 🟡 部分覆盖 | 长任务用定时任务兜底，或手动继续 |
| 引导问卷：开发用途 / 标准流程 / 详细用量 / 开发者工具开 | 🟡 部分覆盖 | 用本包的 `dsh-parity` 技能载入同样的工作偏好 |

## 为什么有些东西迁不过去

- **宿主 UI**：侧栏皮肤、会话树、大纲面板、命令面板属于 Electron 前端，插件只能加技能/工具，不能改界面。
- **运行时行为**：插话发送、自动继续、并行上限由 Agent 循环实现，WorkBuddy 不开放对应开关。
- **账号凭据**：`~/.dsh/.credentials.yaml` 与 MCP token 属于敏感信息，任何迁移包都不应包含，重装后重新登录/生成。

