---
name: dsh-session-inspector
description: |
  把一次 DSH 会话导出成可读时间线：用户消息、助手回复、推理字数、工具调用与返回、交付物。
  当用户要复盘「这一轮到底做了什么」「为什么跑了这么久」「把过程整理成文档」时使用。
  对应 DSH 的 Inspector + 对话大纲面板，但输出是 Markdown，可归档、可 diff。
category: capability
version: "1.0.0"
tags: [dsh, session, timeline, inspector, report]
---

# 会话时间线导出

## 命令

```bash
# 打印到终端
node "$HOME/.workbuddy/dsh-skills/scripts/session-inspector.mjs" session-a1b2c3d4-0004-4a00-8000-000000000004

# 写文件（建议放 docs/ 或会话工作区）
node "$HOME/.workbuddy/dsh-skills/scripts/session-inspector.mjs" <session-id> --out ./session-review.md

# 只要结论，不要长正文
node "$HOME/.workbuddy/dsh-skills/scripts/session-inspector.mjs" <session-id> --max-text 200

# 机器可读
node "$HOME/.workbuddy/dsh-skills/scripts/session-inspector.mjs" <session-id> --json
```

也可以传会话目录或 `.zstd` 文件路径；ID 支持唯一前缀。

## 输出包含

- 标题、工作区、创建时间、日志文件
- 规模：轮次 / 步数 / 工具调用次数 / 用户消息数 / 工具异常数
- Token：请求数、输入、输出、缓存读（按 sessionId 关联用量账本）
- 高频工具 Top 5
- 时间线：每条用户消息、助手回复（可截断）、推理字数、工具名 + 参数摘要 + 返回大小、交付物列表

## 使用建议

- 复盘长任务时先看「高频工具」和「工具异常」，再定位到具体步骤。
- 需要给上级/同事看的版本，先 `--max-text 300` 生成，再手工删无关步骤；不要把整份时间线直接塞进聊天。
- 推理内容默认折叠成字数（`--full` 才展开）；需要研究模型思路时再开。
- 只读：不会改会话日志，也不会触发 DSH。
