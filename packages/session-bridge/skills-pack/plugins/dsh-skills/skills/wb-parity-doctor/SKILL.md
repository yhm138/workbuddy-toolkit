---
name: wb-parity-doctor
description: |
  自检 DSH → WorkBuddy 的迁移状态：技能是否装好、MCP 桥是否连通、会话工具是否可用、
  DSH 配置是否发生漂移，并列出仍需要手动处理的客户端设置。
  当用户问「还差什么没迁」「会话桥怎么不工作」「检查一下环境」时使用。
category: capability
version: "1.0.0"
tags: [dsh, doctor, diagnostics, parity, mcp]
---

# 迁移自检

## 一键检查

```bash
node "$HOME/.workbuddy/dsh-skills/cli/bin/dsh2wb.mjs" doctor
node "$HOME/.workbuddy/dsh-skills/cli/bin/dsh2wb.mjs" doctor --json
```

## 检查项与含义

| 检查 | 期望 | 不通过怎么办 |
| --- | --- | --- |
| 技能 `dsh-*` | 7 个目录都有 `SKILL.md` | 重跑 `dsh2wb install` |
| 配置快照 | `~/.workbuddy/dsh-skills/config/dsh-parity.json` 存在 | 跑 `dsh2wb build <profile>` 再 install |
| MCP 桥 `dsh_local` | `~/.workbuddy/mcp.json` 里有条目 | install 会自动写；token 缺失时先启动一次 DSH |
| MCP 令牌 | 条目里有 `Authorization` | token 轮换后重新 install |
| DSH 服务 | `127.0.0.1:8790` 可连接 | 启动 DeepSeek Harness（dsh-as-mcp 才会监听） |
| 会话工具 | `session_create/list/prompt/messages/cancel` | DSH 版本过低或 MCP 配置没开 session 工具 |
| 配置漂移 | 快照与本机 `cordis.patch.yml` 一致 | DSH 改过配置后重跑 build + install |
| 扩展 | `会话桥` 出现在侧栏 | 见下 |

## 侧栏扩展没出现

1. 文件是否在 `<WorkBuddy>/resources/app.asar.unpacked/resources/extensions/dsh-session-bridge/`；
2. `extension.json` 与 `distribution.json` 的 `id/version` 是否一致；
3. **必须托盘退出 WorkBuddy 再启动**（清单是启动时快照的，热更会「插件加载失败」）；
4. 面板显示「插件加载失败」多半是 guest-ready 超时，不是网络问题。

## 诊断顺序

先看 `doctor`，再看面板底部「诊断」（service 版本、通道 port/ipc、最近错误），最后才看 DSH 日志。不要一上来就重装。
