# 安装 · 卸载 · 回滚 · 排错

## 0. 一键安装（推荐，普通用户看这里）

去 [Releases](https://github.com/yhm138/workbuddy-toolkit/releases) 下载 zip，解压，
双击 `一键安装.cmd`。装完会自己验证扩展服务能不能 `ping` 通，然后告诉你去哪里用它。

不需要装 Node.js：`.cmd` 找到 `WorkBuddy.exe` 后设 `ELECTRON_RUN_AS_NODE=1`，WorkBuddy 自带的
Node 22 直接跑安装脚本。这也是为什么安装器能做成双击——用户机器上有 WorkBuddy 就有运行时。

| 脚本 | 干什么 |
| --- | --- |
| `一键安装.cmd` | 装 / 修复。重复跑安全，旧版本备份成 `*.bak-<时间戳>` |
| `检查状态.cmd` | 逐项检查：安装目录、客户端在不在跑、面板版本、技能数量、服务是否在线 |
| `一键卸载.cmd` | 按 `~/.workbuddy/dsh-skills/install.json` 的记录删，只删自己装的东西 |
| `dsh2wb.cmd` | 命令行工具，等同 `node bin/dsh2wb.mjs` |

手动参数：`install.cmd --root "D:\你的\WorkBuddy"`、`--no-skills`（只装面板）、
`--no-restart`、`--restart`、`--yes`。

安装器实际做的四步（对应 `bin/setup.mjs`）：

1. 把 `extension/` 拷到 `<WorkBuddy>/resources/app.asar.unpacked/resources/extensions/dsh-session-bridge/`
2. 把 `skills-pack/plugins/dsh-skills/skills/*` 拷到 `~/.workbuddy/skills/`，脚本拷到 `~/.workbuddy/dsh-skills/scripts/`
3. 重启客户端（交互式才问；非交互一律不动用户的窗口）
4. 轮询 `ping` 最多 90 秒，通了才打印「装好了」

卸载只删这两处 + `install.json` 自己；`~/.dsh/`、`~/.workbuddy/projects/`、`mcp.json` 一概不动。

---

## 0.1 手动安装（开发者）

下面的步骤是一键安装器内部做的事，想自己控制每一步时用。

```bash
node bin/setup.mjs            # 等价于一键安装
node bin/setup.mjs --status
node bin/setup.mjs --uninstall
```

更细粒度的旧路径仍然可用：

```bash
node bin/dsh2wb.mjs build ./dsh-config-export     # 生成配置快照
node bin/dsh2wb.mjs install                       # 技能 + mcp.json（不改面板）
node bin/dsh2wb.mjs install-extension             # 只装侧栏扩展
```

## 1. 前置检查

```bash
node -v                      # ≥ 20.10；解析 zstd 需 ≥ 22
echo ~/.dsh/dsh-as-mcp/token # 存在，说明 dsh-as-mcp 至少跑过一次
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8790/mcp   # 401 也算通（说明在监听）
```

DSH 侧要开着 `dsh-as-mcp`（`cordis.patch.yml` 里 `dsh-as-mcp.config.http.port: 8790`）。它没开时：技能只剩读盘能力，面板会显示"离线"。

## 1. 三步入库

```bash
node bin/dsh2wb.mjs build ./dsh-config-export     # 生成 skills-pack/plugins/dsh-skills/config/dsh-parity.json
node bin/dsh2wb.mjs install                       # 技能 + mcp.json
node bin/dsh2wb.mjs install-extension             # 侧栏扩展
```

`build` 必须先于 `install`：`install` 会校验配置快照存在，缺了就报「还没有配置快照」。

## 2. `install` 到底改了哪些文件

| 路径 | 动作 | 备份位置 |
| --- | --- | --- |
| `~/.workbuddy/dsh-skills/` | 整目录写入（脚本、快照、agents、`cli/` 副本、`install-manifest.json`） | `~/.workbuddy/dsh-skills.bak/<stamp>/` |
| `~/.workbuddy/skills/<skill>/` × 7 | 整目录覆盖 | `~/.workbuddy/dsh-skills/backups/skill-<name>-<stamp>/` |
| `~/.workbuddy/mcp.json` | 只动 `mcpServers.dsh_local`，其它 server 保留 | `~/.workbuddy/mcp.json.bak-<stamp>` |

`--register-marketplace` 另写：`~/.workbuddy/plugins/marketplaces/dsh-skills/`、`plugins/known_marketplaces.json`、`plugins/installed_plugins.json`、`settings.json` 的 `enabledPlugins`。

先看计划不落盘：

```bash
node bin/dsh2wb.mjs install --dry-run
```

## 3. `install-extension` 的目标目录

探测顺序：

1. `--workbuddy-root <dir>`
2. 环境变量 `WORKBUDDY_ROOT`
3. `D:/Your/WorkBuddy`、`%LOCALAPPDATA%/Programs/WorkBuddy`、`%ProgramFiles%/WorkBuddy`
4. `/Applications/WorkBuddy.app/Contents`
5. PowerShell 取 `WorkBuddy` 进程的 `Path` 再取父目录

判定标准：存在 `resources/app.asar.unpacked/resources/extensions` 才算命中。

写入前会校验 `extension.json` 与 `distribution.json` 的 `id` / `extensionId` / `version` 三者一致；装完会复查必需文件，并确认 `ui/index.html` 含 `wb:boundary:guest-ready`。

**装完必须重启客户端**：托盘右键 → 退出 WorkBuddy → 重新打开。只关窗口不够，扩展清单是启动时读的。

## 4. 自检

```bash
node bin/dsh2wb.mjs doctor
```

会逐项报：

* 7 个技能的 `SKILL.md` 是否存在
* 配置快照与 `~/.dsh/profiles/desktop` 是否漂移（DSH 侧改过配置就需要重新 `build`）
* `mcp.json` 的 `dsh_local`、`Authorization`、端口连通性、token 文件
* 用 MCP `tools/list` 校验 5 个会话工具是否都在
* 侧栏扩展清单一致性与目标目录
* 剩余手工项（默认模型、默认权限、语言）

## 5. 卸载

```bash
# 技能与运行时
rm -rf ~/.workbuddy/skills/dsh-parity ~/.workbuddy/skills/dsh-config-port \
       ~/.workbuddy/skills/dsh-session-ops ~/.workbuddy/skills/dsh-token-usage \
       ~/.workbuddy/skills/dsh-session-search ~/.workbuddy/skills/dsh-session-inspector \
       ~/.workbuddy/skills/wb-parity-doctor
rm -rf ~/.workbuddy/dsh-skills ~/.workbuddy/dsh-skills.bak

# 扩展（路径按实际安装目录）
rm -rf "<WorkBuddy>/resources/app.asar.unpacked/resources/extensions/dsh-session-bridge"

# mcp.json 里删掉 mcpServers.dsh_local
```

`mcp.json` 建议手改，不要把整个文件删掉——里面还有你别的 MCP。

## 6. 排错

**侧栏没有「会话桥」**

1. 确认目录在 `resources/app.asar.unpacked/resources/extensions/` 下（不是 `resources/extensions/`）。
2. 确认 `distribution.json` 的 `kind: "builtin"`、`status: "active"`。
3. 托盘退出再启动。启动日志里搜 `dsh-session-bridge`。

**面板报「插件加载失败 / Guest Ready timed out after 10000ms」**

iframe 里的桥没在 10 秒内用 port 回 `wb:boundary:guest-ready`。常见原因：桥代码放在 `DOMContentLoaded` 之后、桥代码抛异常、或者你在顶层用 `file://` 直接打开 `ui/index.html` 测试（拿不到 port，必然超时）。用 `python test/panel_test.py` 的假宿主验证。

**面板能开但列表空、状态灯红**

```bash
node bin/dsh2wb.mjs doctor          # 先看端口与 5 个工具
```

* `ECONNREFUSED` → DSH 没开或 `dsh-as-mcp` 没启用；面板此时应自动退回磁盘历史（列表仍有内容，标示"离线"）。
* `401 / UNAUTHORIZED` → token 变了。重新读 `~/.dsh/dsh-as-mcp/token` 并更新 `mcp.json`，或直接重跑 `install`（会备份原文件）。

**调用报 `PERMISSION_DENIED` / `EXTENSION_CONTEXT_STALE`**

Local RPC 票据过期或上下文变了。面板会自动"清票 → 重新 resolve → 重试一次"；仍失败说明宿主侧权限没给（`grantedPermissions`）或扩展被重载过，重启客户端。

**`EXTENSION_LOCAL_RPC_BUSY`**

上一调用还没回来。不要循环重试——检查是不是 `session_prompt` 用了 `wait:true` 且 DSH 那轮很长。本仓库新建会话固定 `wait:false`，就是为了避开这个。

**`INVALID_ARGUMENT` 且信息很含糊**

方法签名写反了。service 侧是 `(context, payload)`，context 在前。

**复制 ID 没反应**

service 走平台剪贴板命令。Linux 需要 `wl-copy` / `xclip` / `xsel` 之一；WSL 走 `/mnt/c/Windows/System32/clip.exe`。`doctor` 不检查剪贴板，直接看面板底部诊断区的 `copyText` 返回值（`{ok, method, length}`）。

**技能里 `dsh-token-usage` 显示 ¥0**

该模型的 `modelId` 不在 `~/.dsh/pricing.ccsa.json` 里。未定价按 0 计，不猜价格。`deepseek-flash` 是 `deepseek-v4.1-flash` 的别名，检查 `aliases` 是否被改过。

**会话时间线里工作区显示 `—`**

`session` 事件的 `cwd` / `createdAt` 在顶层而不是 `data` 下。脚本已兼容（`sessionEvent?.data ?? sessionEvent`）；如果你改了脚本别把这个 fallback 删掉。
