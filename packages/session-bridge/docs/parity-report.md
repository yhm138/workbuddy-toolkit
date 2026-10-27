# DSH → WorkBuddy 迁移差异报告

> 由 `dsh2wb inspect` 生成，可重复执行。
> 源 profile：`<HOME>\Documents\deepseek-harness\default-workspace\dsh-config-export\profile\desktop`
> DSH 桌面版：0.2.1-rc.2 · WorkBuddy 对照版本：5.9.0
> 生成时间：2026-10-24T02:38:16.338Z

## 总览

- 已启用 DSH bundle：**15** 个
- 迁移结果：原生等价 **8** · 本包补齐 **6** · 部分覆盖 **7** · 需手动 **2** · 不可移植 **3**
- 复原度评分：**67/100**（原生与本包计满分，部分覆盖计半分）

## 一、插件层对照

| # | DSH bundle | 版本 | 类型 | 迁移结果 | WorkBuddy 侧 | 说明 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `@deepseek-ai/dsh-base` | 内置 | 内置核心 | ✅ 原生等价 | WorkBuddy 内核（Agent 循环、会话、工具、存储、模型接入） | 形态不同，能力对应。 |
| 2 | `@deepseek-ai/dsh-web-app` | 内置 | 内置核心 | ✅ 原生等价 | WorkBuddy 桌面端 / Web 工作台 | 无需迁移。 |
| 3 | `dsh-conversation-navigator` | 0.2.11 | 第三方 | 🟡 部分覆盖 | 无对话大纲面板；`dsh-session-inspector` 可把任一轮次导出成大纲 | UI 面板无法移植，用技能补“看结构”的能力。 |
| 4 | `dsh-sessions-manager` | file:vendor/dsh-sessions-manager-3.7.7-desktop021.1.tgz | 第三方（本地构建） | 🟡 部分覆盖 | 任务列表原生支持重命名 / 删除 / 搜索；归档、回收站、标签、收藏没有 | 高频操作可继续在 DSH 内完成，WorkBuddy 侧负责干活。 |
| 5 | `@deepseek-ai/dsh-experimental-inspector-profile` | 内置 | 内置实验 | 📦 本包补齐 | `dsh-session-inspector`：session.v4.jsonl.zstd → 时间线 Markdown / HTML | 按用户/助手/工具调用还原一轮到底发生了什么。 |
| 6 | `@deepseek-ai/dsh-subagent-codex` | 0.2.1-rc.2 | 第三方 | ✅ 原生等价 | WorkBuddy 子代理（Agent 工具，可并行、可指定模型） | 子代理模型不同，编排语义一致。 |
| 7 | `@deepseek-ai/dsh-experimental-plugin-market-bundle` | 内置 | 内置实验 | ✅ 原生等价 | 插件市场（插件 = 技能 + 连接 + 指令 + Hooks + Agents） | 自定义市场索引不可配；本地目录市场可用。 |
| 8 | `@deepseek-ai/dsh-experimental-session-search` | 内置 | 内置实验 | 📦 本包补齐 | `dsh-session-search`：跨工作区检索 DSH 历史会话（支持中文、正则、时间过滤） | WorkBuddy 的会话检索只覆盖自己的会话，故补齐 DSH 侧。 |
| 9 | `@deepseek-ai/dsh-experimental-terminal-bundle` | 内置 | 内置实验 | 🟡 部分覆盖 | Bash / PowerShell 工具在单次任务内可复用工作目录 | 没有跨工具调用的常驻终端与 pwsh 会话。 |
| 10 | `@hyzyn/dsh-search` | 0.4.11 | 第三方 | ✅ 原生等价 | 侧栏全局搜索 / 命令面板 | 入口位置不同，能力对等。 |
| 11 | `dsh-as-mcp` | 0.1.5 | 第三方 | 📦 本包补齐 | `mcp.json` 写入 `dsh_local`（streamable-http + Bearer token），直接暴露 session_create/list/prompt/messages/cancel | WorkBuddy 作为 MCP client 反向驱动 DSH 的工作区/会话工具。 |
| 12 | `@michengai/dsh-codex-ui` | 1.1.43 | 第三方 | ⛔ 不可移植 | — | 侧栏/会话树/皮肤属于宿主 UI，插件无法注入 WorkBuddy 前端。 |
| 13 | `@laoyuehanni/dsh-token-usage` | 0.4.7 | 第三方 | 📦 本包补齐 | `dsh-token-usage`：读取 ~/.dsh/token-usage，按天/模型/人民币出账 | 保留国内定价口径与历史数据，不重新估算。 |
| 14 | `@deepseek-ai/dsh-experimental-agent-team-profile` | 内置 | 内置实验 | ✅ 原生等价 | 多人多 Agent 协作 / 团队任务面板 | 成员上限与消息大小由 WorkBuddy 决定。 |
| 15 | `dsh-client-auto-continue` | 0.15.0 | 第三方 | 🟡 部分覆盖 | 无“中断自动继续”开关；可用定时任务或手动“继续” | 属于运行时行为，插件层无法拦截重试。 |

## 二、设置层对照

| 设置 | DSH 当前值 | 迁移结果 | WorkBuddy 做法 |
| --- | --- | --- | --- |
| 界面语言：中文（zh） | `zh` | ✅ 原生等价 | 设置 → 外观/语言，确认为简体中文 |
| 默认模型：deepseek-flash · 推理强度 max | `deepseek-account/deepseek-flash · max` | ✍️ 需手动设置 | 在模型菜单选择 DeepSeek 对应模型；高强度推理任务手动拉满 |
| 默认权限：danger-full-access + 审批 never | `danger-full-access` | ✍️ 需手动设置 | 设置 → 默认权限与安全沙箱；建议改为「工作区可写 + 审批」，不要照搬 danger-full-access |
| 单轮并行工具 20 / 活跃子代理 16 | `20 / 16` | ✅ 原生等价 | 无需处理 |
| 繁忙时 Enter：插话发送（steer），Ctrl+Enter 排队 | `steer` | ⛔ 不可移植 | 无对应设置，忽略 |
| 聊天记录：详细；性能/用量：详细 | `detailed / detailed` | 🟡 部分覆盖 | 需要过程细节时用 `dsh-session-inspector` 看原始时间线 |
| 插件市场索引 3 个（jsdelivr / bruc3van / awesome-dsh-plugin） | `3` | ⛔ 不可移植 | 无对应设置，忽略 |
| dsh-as-mcp：127.0.0.1:8790/mcp，开放工作区+会话 | `127.0.0.1:8790/mcp` | 📦 本包补齐 | 运行 `dsh2wb install` 自动写入；DSH 需在运行 |
| Token 用量：国内人民币定价、记录压缩调用、供应商配额 | `domestic` | 📦 本包补齐 | 直接问「这个月 DSH 花了多少钱」 |
| 自动继续：开启（宽限 30s、最多 30 次、自主循环关闭） | `开启` | 🟡 部分覆盖 | 长任务用定时任务兜底，或手动继续 |
| 引导问卷：开发用途 / 标准流程 / 详细用量 / 开发者工具开 | `development` | 🟡 部分覆盖 | 用本包的 `dsh-parity` 技能载入同样的工作偏好 |

## 三、本包补齐的能力

| 技能 | 触发场景 | 对应 DSH 能力 |
| --- | --- | --- |
| `dsh-parity` | 任何任务开始前载入你的 DSH 工作偏好 | 界面/交互/计费口径 |
| `dsh-config-port` | 盘点配置、生成跨机迁移包、校验安装 | profile bundles + patch 层 |
| `dsh-session-ops` | 复制 Session ID、跨会话发消息、新建会话 | dsh-as-mcp 的 session_* 工具 |
| `dsh-token-usage` | 「这个月花了多少钱 / 哪个模型最贵」 | @laoyuehanni/dsh-token-usage |
| `dsh-session-search` | 「上次那个方案在哪次会话里」 | experimental-session-search |
| `dsh-session-inspector` | 「这一轮到底调了什么工具」 | inspector + conversation-navigator |
| `wb-parity-doctor` | 「还差什么没迁」 | 安装后的自检 |

另外，侧栏扩展 **会话桥** 提供图形化入口：列表、一键复制 ID、新建会话、给会话发消息、查看回复。

## 四、仍需你手动处理

1. **默认模型：deepseek-flash · 推理强度 max**
   - 当前值：`deepseek-account/deepseek-flash · max`
   - 操作：在模型菜单选择 DeepSeek 对应模型；高强度推理任务手动拉满
2. **默认权限：danger-full-access + 审批 never**
   - 当前值：`danger-full-access`
   - 操作：设置 → 默认权限与安全沙箱；建议改为「工作区可写 + 审批」，不要照搬 danger-full-access
   - ⚠️ 高风险：DSH 里是 `danger-full-access` + 不审批。WorkBuddy 侧建议用「工作区可写 + 审批」，不要直接照搬。

## 五、下一步

```bash
# 1) 生成迁移计划（只读，不改任何文件）
node bin/dsh2wb.mjs inspect "<DSH_PROFILE>";

# 2) 安装技能与 MCP 桥接（会自动备份）
node bin/dsh2wb.mjs install

# 3) 自检
node bin/dsh2wb.mjs doctor
```

> 权限、模型、语言三项属于 WorkBuddy 客户端设置，命令行无法代改，按上表手动处理。

