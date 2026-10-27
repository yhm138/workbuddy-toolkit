---
name: dsh-config-port
description: |
  盘点 DeepSeek Harness 的 profile 配置（bundle 列表、patch 覆盖项、权限/模型/MCP 设置），
  生成跨机器可迁移的清单与差异报告。当用户说「导出我的 DSH 配置」「换电脑怎么搬」
  「看看我现在开了哪些插件」「迁移到另一台机器」时使用。
  只读分析，不修改 DSH 安装目录。
category: capability
version: "1.0.0"
tags: [dsh, migration, config, inventory]
---

# DSH 配置盘点与跨机迁移

DSH 的配置由三层叠加：`package.json` 里的 `dsh.profile.bundles` → 各 bundle 的 patch → 用户的 `cordis.patch.yml`。直接抄文件容易漏，按下面的流程读"合成后的结果"。

## 输入从哪来

按优先级找 profile：

1. 用户指定的目录（导出包解压目录、`.../dsh-config-export`、或 `~/.dsh/profiles/desktop`）
2. 本机 `~/.dsh/profiles/desktop`

一个合法 profile 目录必须同时有 `package.json` 和 `cordis.patch.yml`。
导出包的布局是 `<root>/profile/desktop/`，工具会自动下钻。

## 命令

运行时在 `$HOME/.workbuddy/dsh-skills/cli/`：

```bash
# 1) 只读盘点：插件、设置、复原度、剩余手工项
node "$HOME/.workbuddy/dsh-skills/cli/bin/dsh2wb.mjs" inspect "<profile 或导出目录>"

# 2) 生成报告（markdown + json）并刷新本包配置快照
node "$HOME/.workbuddy/dsh-skills/cli/bin/dsh2wb.mjs" build "<profile 或导出目录>"

# 3) 安装/更新本机 WorkBuddy 侧（会先备份）
node "$HOME/.workbuddy/dsh-skills/cli/bin/dsh2wb.mjs" install

# 4) 自检
node "$HOME/.workbuddy/dsh-skills/cli/bin/dsh2wb.mjs" doctor
```

没有导出包、只有一台在用 DSH 的机器时，第 1 步直接省略参数即可。

## 输出怎么读

`inspect` 会打印两类对照：

- **插件层**：每个 bundle 一行，`native / bundle / partial / manual / none`。
- **设置层**：模型、权限、语言、并发、MCP、自动继续等，给出 DSH 当前值和 WorkBuddy 的做法。

`build` 额外写：

- `docs/parity-report.md` — 面向人的差异报告（路径已脱敏，可直接进 Git）
- `docs/capability-matrix.md` — 全量映射表，不依赖具体 profile
- `bundle/plugins/dsh-skills/config/dsh-parity.json` — 机器读的配置快照

## 迁移到另一台机器（DSH 侧）

本包负责 WorkBuddy 侧；如果用户还要在新机器上复原 **DSH 本身**，用原有的迁移包流程：

1. 在新机器安装**同版本** DSH（版本不一致时插件 peer 依赖会拒绝加载）。
2. 完全退出 DSH，运行导出包里的 `scripts/install-config.ps1`（会备份现有 profile）。
3. 启动、登录，按导出包里的验证清单逐项核对。
4. 不要把 `.credentials.yaml`、`dsh-as-mcp/token` 放进任何 Git 仓库或网盘。

如果导出包丢了，可以只带走这几个文件重建 profile：
`package.json`、`cordis.patch.yml`、`cordis.yml`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`vendor/*.tgz`。

## 注意事项

- **只读**：`inspect` / `build` 不会改 DSH 目录；`install` 只改 `~/.workbuddy`。
- **路径脱敏**：报告会把 `C:\Users\<你>` 换成 `<USERPROFILE>`，可以安全提交。
- **版本敏感**：报告里会记录导出时的 DSH 版本；DSH 升级后建议重跑一次 `build`。
- **不要复制凭据**：账号 token、MCP Bearer token 都不进迁移包。
