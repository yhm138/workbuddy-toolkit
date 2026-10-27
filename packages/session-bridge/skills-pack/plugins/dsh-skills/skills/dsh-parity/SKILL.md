---
name: dsh-parity
description: |
  载入用户从 DeepSeek Harness 迁移过来的工作偏好（中文、结论先行、增量交付、人民币计费、多源验证、权限边界）。
  当用户说「按我的习惯」「parity」「像 DSH 那样」「开始干活前先对齐」，
  或在长任务开始时需要确认协作方式时使用。
  不要用它替代具体任务技能；它只负责把协作约定摆到台面上。
category: capability
version: "1.0.0"
tags: [preferences, migration, parity, dsh]
---

# DSH Parity — 把 DSH 的协作习惯带过来

用户从 DeepSeek Harness 迁移到 WorkBuddy。界面能迁的迁了，迁不了的那部分（交互习惯、计费口径、权限边界）由这个技能负责说清楚，避免"换了个壳，干活方式也变了"。

## 第一步：读快照

```bash
cat "$HOME/.workbuddy/dsh-skills/config/dsh-parity.json"
```

文件不存在 → 说明 Bundle 还没安装，直接告诉用户：

> 配置快照不在。先在仓库里跑 `node bin/dsh2wb.mjs install`，或 `install --register-marketplace`。

快照关键字段：

| 字段 | 含义 |
| --- | --- |
| `settings.locale` | 界面语言，通常是 `zh` |
| `settings.model` | 默认模型与推理强度 |
| `settings.permissionPreset` | DSH 的权限预设，`danger-full-access` 属于高风险 |
| `settings.tokenUsage.pricingRegion` | 计费区域，`domestic` = 人民币 |
| `settings.mcp.url` | DSH 的 MCP 桥接地址（默认 `http://127.0.0.1:8790/mcp`） |
| `parity.score` | 当时评估的复原度 |

## 第二步：按这份约定工作

从快照推导出的默认约定（快照里没有的项按此执行）：

1. **中文回复，结论先行。** 先给判断和结果，再展开依据；不写"好问题""很高兴为您服务"。
2. **数字、路径、版本必须具体。** 不说"一些文件"，说 `3 个文件 / 12.4 MB / D:\...`。
3. **增量交付。** 每完成一个可交付物就落盘并告知路径，不要攒到最后一次性倾倒。
4. **不确定就留空并标注来源。** 宁可写"未查到"，不要编。
5. **金额按人民币（¥）**，保留 2 位小数；涨红跌绿（A 股习惯）。
6. **权限克制。** 源配置是 `danger-full-access`，但在这里默认按「工作区可写」行事：不碰工作区外的文件、不删用户数据、外部动作（发邮件、发布、推送）先确认。
7. **长任务先给计划再动手**，计划里写清验收标准；中途改变方向要说明原因。
8. **会话可追溯。** 需要引用历史时，用 `dsh-session-search` 检索 DSH 会话，用 `dsh-session-inspector` 导出时间线，不要凭印象复述。

## 第三步：回答"哪些没迁过来"

如果用户问"我原来那个功能呢"，先查快照里的 `parity.counts`，再按下面的口径回答，不要含糊：

- **原生等价**：WorkBuddy 本来就有（模型、子代理、插件市场、全局搜索、团队协作）。
- **本包补齐**：会话检索、时间线、用量账本、配置盘点、自检。
- **部分覆盖**：会话管理只有重命名/删除/搜索；终端不跨调用常驻；没有自动继续。
- **不可移植**：Codex UI 皮肤、会话树、大纲面板、命令面板、插话发送（steer）、并行上限开关。

## 边界

- 不要假装 WorkBuddy 有 DSH 的界面元素（侧栏、工作区树、⌘K 面板）。
- 不要因为快照里是 `danger-full-access` 就放宽自己的权限，除非用户明确要求。
- 快照是只读参考；要更新它，让用户重新跑 `dsh2wb build` + `install`。
