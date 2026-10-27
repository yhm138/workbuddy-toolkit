# AGENTS.md

## 最高优先级：跨会话发消息默认走 WorkBuddy 原生会话，不要默认打 DSH

用户说「**在此 Project 下新建一个 Session 并通信**」「让两个会话对一下」「把这个任务
交给另一个会话」「告诉那个会话……」时：

- 目标**默认是 WorkBuddy 原生会话**，用本仓库的会话桥：
  - 新建 + 两轮往返：`node bin/dsh2wb.mjs bridge-test`
  - 指定内容：`wb-call createWb` → `wb-call promptWb`
  - 读回复：`wb-call requestsWb`
- **不要**用 `dsh_local` 的 `session_create` / `session_prompt`。那是用户自己的 DSH
  实例，真在跑：会真改文件、跑命令，还会占掉他当前的 DSH 轮次。
- 只有用户**明确点名**「DSH」「dsh_local」「dsh-as-mcp」「那个 harness」时才走 MCP。
- 拿不准就问一句「发 WorkBuddy 还是 DSH」，不要猜。

前提：扩展 service 在线（客户端启动时 fork，改了代码不会自动重建）。先
`node bin/dsh2wb.mjs wb-call ping`；不通就点开侧栏「会话桥」面板，或托盘退出重开客户端。

细节见技能 `dsh-session-ops` 与 `docs/bridge-demo.md`。

## 这个仓库是什么

把 DeepSeek Harness 的用法搬到 WorkBuddy：宿主内扩展（service + 面板）、
命令行（`bin/dsh2wb.mjs`）、技能包（`skills-pack/`）。

## 常用命令

```bash
node bin/dsh2wb.mjs bridge-test        # 新建 WorkBuddy 会话并做双向通信验收
node bin/dsh2wb.mjs wb-call ping       # service 是否在线
node bin/dsh2wb.mjs wb-session <ID>    # 回放某个 WorkBuddy 会话
node bin/dsh2wb.mjs copy-id            # 复制当前会话 ID（读 CODEBUDDY_SESSION_ID）
node bin/dsh2wb.mjs install-extension  # 把 extension/ 装进客户端（改 service 后必须）
```

## 约定

- 单元测试：`node --test test/*.test.mjs`；面板 E2E 用 `py test/panel_test.py`
  （`python` 是内置 3.13，没装 playwright）。
- `.probe/` 是本地探针产物（bridge-test 结果、截图），不入库。
- 改 `extension/server/*.cjs` → `install-extension` + 托盘退出重启客户端才生效；
  改 `extension/ui/index.html` 只需重开面板。
- `.cmd` 一律纯 ASCII，中文提示放 Node 脚本（cmd.exe 按 GBK 解析，UTF-8 中文会被
  拆成非法命令）。
