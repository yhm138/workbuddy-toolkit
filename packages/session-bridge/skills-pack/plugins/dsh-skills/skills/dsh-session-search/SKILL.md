---
name: dsh-session-search
description: |
  在 DeepSeek Harness 的历史会话里全文检索（中文、正则、按工作区/时间过滤），
  用于回答「上次那个方案是哪次会话说的」「找一下之前讨论 X 的记录」。
  WorkBuddy 只能搜自己的会话，这个技能补 DSH 那一侧。
category: capability
version: "1.0.0"
tags: [dsh, session, search, history]
---

# 检索 DSH 历史会话

DSH 的会话日志是 `~/.dsh/sessions/<工作区编码>/<会话>/session.v4.jsonl.zstd`，**多帧 zstd 追加写**。脚本已经处理多帧解码，不需要先解压。

## 命令

```bash
# 基本检索（默认只搜用户消息与助手正文，不搜推理）
node "$HOME/.workbuddy/dsh-skills/scripts/session-search.mjs" "迁移包"

# 限定工作区 / 时间
node "$HOME/.workbuddy/dsh-skills/scripts/session-search.mjs" "评分" --cwd "收题任务" --since 2026-10-20

# 正则 + 连推理一起搜
node "$HOME/.workbuddy/dsh-skills/scripts/session-search.mjs" "DeepSeek[ -]?Harness" --regex --include-reasoning

# 只看某一侧 / 更多结果
node "$HOME/.workbuddy/dsh-skills/scripts/session-search.mjs" "回滚" --role user --limit 20
```

参数：`--cwd` 路径片段、`--since YYYY-MM-DD`、`--role user|assistant`、`--limit`（会话数）、`--max-sessions`（扫描上限，默认 150，按最近修改倒序）、`--snippets`、`--json`。

## 结果怎么用

每条命中给：会话标题、`session-id`、时间、工作区、命中次数与片段。拿到 ID 后：

- 需要完整上下文 → `dsh-session-inspector` 导出时间线；
- 需要继续干活 → `dsh-session-ops` 用 `session_prompt` 给那个会话发消息；
- 只是引用 → 在回答里写清「来自 session-xxx，2026-10-20」。

## 性能与边界

- 216 个会话 / 232 MB 的库，扫 30 个约 2 秒；默认上限 150 个，避免一次扫全库。
- 只索引文本：图片、附件内容、工具返回的大段输出不在检索范围。
- 不修改任何会话文件，只读。
