# 参与开发

## 环境

- Node.js ≥ 20.10（技能里的 zstd 帧解析需要 **22+**）
- DSH 桌面端可选：跑 `dsh-as-mcp`（`127.0.0.1:8790`）才能测 MCP 那条链路；
  没开时扩展会降级读磁盘会话，多数功能仍可用

项目本身**没有运行时依赖**，不用 `npm install`。

## 测试

```bash
node --test test/*.test.mjs        # 单元测试（55 例）
python test/panel_test.py          # 面板 E2E（内置 Python 3.13）
```

跑单元测试建议带上硬关开关：

```bash
WORKBUDDY_MENU_INJECT=off node --test test/*.test.mjs
```

否则测试进程可能通过环境变量拿到本机端口，连上你正在用的客户端去改真实菜单。

## 改完代码怎么生效

| 改了什么 | 要做什么 |
| --- | --- |
| `extension/server/*.cjs`、`extension/inject/*` | `node bin/dsh2wb.mjs install-extension` → 托盘退出重开客户端 |
| `extension/ui/index.html` | 不用装，重开面板即可 |
| `src/`、`bin/` | 直接重跑 |
| `skills-pack/` | 复制到 `~/.workbuddy/skills/` 或重新装插件 |

**为什么必须 `install-extension`**：service 跑的是**安装副本**
（`<WorkBuddy>/resources/app.asar.unpacked/resources/extensions/dsh-session-bridge/`），
不是仓库里的文件。只改仓库、只重启客户端，注入进去的仍是旧代码。

判断依据：比对两边的 mtime，或者 `grep` 一个只在新版里出现的字符串。

## 常识边界

- **`.cmd` 一律纯 ASCII**。`cmd.exe` 按 GBK 逐字节解析批处理，UTF-8 中文会被拆成
  非法命令，夹带 `|` `<` `>` 时还会把后续行拼成一条乱命令。中文提示放 Node 脚本。
- **service 侧零第三方依赖**。装进 `app.asar.unpacked` 后没有 `node_modules`，
  任何 `require("ws")` 都会在 fork 出来的进程里直接失败。
- **`.probe/`、`.workbuddy/` 不入库**。前者是本地探针产物（bridge-test 结果、截图），
  后者是工作记忆。
- **凡是拿 `__wbInvoke` 返回值的地方，先判 `__wbError`**。它在通道不存在时不抛异常，
  而是 resolve 一个错误对象——`try/catch` 抓不到。

## 提交信息

```
类型(范围): 做了什么

为什么这么做。根因、取舍、验证方式。
```

类型：`feat` / `fix` / `docs` / `refactor` / `test` / `chore`。

这个项目的提交历史里，正文写得比标题长是常态——尤其是「看起来是 A，其实是 B」
那种问题，根因值得留下来。

## 目录

```
extension/      侧栏扩展「会话桥」：面板 + fork 出来的 Node service
  inject/       会话菜单注入脚本（跑在渲染进程）
  server/       service：MCP 客户端、会话读写、菜单注入器、CDP
  ui/           面板（iframe）
skills-pack/    7 个技能 + 本地插件市场清单
src/            dsh2wb CLI 的实现
bin/            入口与 .cmd 转发器
docs/           见 docs/ 下的文档
test/           单测 + 面板 E2E
```

## 与另一个项目的关系

会话菜单注入那部分已经抽成独立项目
[workbuddy-session-menu](https://github.com/yhm138/workbuddy-toolkit)。
两边代码有重叠，改注入逻辑时两边都要跟；独立项目里的那份带更完整的文档
（PROTOCOL / REVERSE-ENGINEERING / TROUBLESHOOTING）。
