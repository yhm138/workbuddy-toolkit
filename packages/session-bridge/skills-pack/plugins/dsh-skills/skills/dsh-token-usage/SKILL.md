---
name: dsh-token-usage
description: |
  统计 DeepSeek Harness 的 Token 用量与人民币费用：按天、按模型、按会话出账，带缓存命中率。
  当用户问「这个月 DSH 花了多少钱」「哪个模型最贵」「昨天跑了多少 token」「用量明细」时使用。
  数据直接读 ~/.dsh/token-usage，按 DSH 自带的 pricing.ccsa.json 计价，不重新估算。
category: capability
version: "1.0.0"
tags: [dsh, token, cost, rmb, usage]
---

# DSH Token 用量账本

## 命令

```bash
# 按天（默认）
node "$HOME/.workbuddy/dsh-skills/scripts/token-usage.mjs"

# 最近几天 / 指定区间
node "$HOME/.workbuddy/dsh-skills/scripts/token-usage.mjs" --since 2026-10-22
node "$HOME/.workbuddy/dsh-skills/scripts/token-usage.mjs" --since 2026-10-01 --until 2026-10-15

# 按模型 / 按会话
node "$HOME/.workbuddy/dsh-skills/scripts/token-usage.mjs" --by model
node "$HOME/.workbuddy/dsh-skills/scripts/token-usage.mjs" --by session --top 20

# 机器可读
node "$HOME/.workbuddy/dsh-skills/scripts/token-usage.mjs" --json
```

输出列：`请求 / 输入 / 输出 / 缓存读 / 费用`，最后给合计与缓存命中率。

## 口径（必须一起说清）

- 币种 **人民币（¥）**，保留 2 位小数；`pricingRegion: domestic` 对应国内价。
- 价格来自 `~/.dsh/token-usage/pricing.ccsa.json`；模型别名会归一（例如 `deepseek-flash` → `deepseek-v4.1-flash`）。
- **只算基础价**：阶梯价、时段折扣不算，所以是保守估算，不是账单。
- 找不到价格的模型会单独列在「未定价模型」，按 0 计，不猜。
- 缓存命中率 = `缓存读 /(输入 + 缓存读)`；DSH 的缓存读通常远大于输入，99% 属正常。

## 数据从哪来

`~/.dsh/token-usage/usage-YYYY-MM-DD.jsonl`，每行一次请求：

```json
{"requestId":"…","time":1792771200272,"sessionId":"…","model":"deepseek-flash",
 "usage":{"inputTokens":1801,"outputTokens":958,"cacheReadTokens":97920,"cacheWriteTokens":0}}
```

文件按天切；`rollup.json` 是 DSH 自己的聚合，可用于交叉核对。数据缺失就直说「这台机器没有那天的记录」，不要用平均值补。
