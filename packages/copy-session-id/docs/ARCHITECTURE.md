# 架构

四层，一条单向链路。第三层有两种实现，装的时候二选一。

```
① 命令行 bin/*.mjs          安装 / 开关：写端口配置、改启动方式、查状态
        │  ~/.workbuddy/session-menu/menu-inject.json
        ▼
② 客户端主进程              读环境变量或启动参数 → 开 CDP 端口 127.0.0.1:9333
        │
        ▼
③ 注入器（二选一）
     ├─ 便携版 bin/daemon.mjs        常驻进程，开机自启（默认）
     └─ 扩展版 extension/server/     宿主 fork 的 service（--with-panel）
        │  Runtime.evaluate + Page.addScriptToEvaluateOnNewDocument
        ▼
④ 渲染进程注入脚本          记会话 ID → 等菜单出现 → 插一项 → 点击写剪贴板
```

①决定②开不开端口，②决定③连不连得上，③决定④装不装得上。
**任何一环断了，表现都是「右键菜单里没有这一项」**——这也是排查时要从下往上、
而不是从上往下的原因。

③之所以有两种，是因为扩展 service 必须**侧栏面板被打开过**才会被 fork，
这一步没法用命令行代劳；便携版绕开了它，代价是要自己管一个常驻进程。

---

## 各部件职责

### ① 命令行（`bin/`）

| 文件 | 职责 |
| --- | --- |
| `setup.mjs` | 一键安装 / 卸载 / 状态。用户双击 `一键安装.cmd` 走的就是它 |
| `daemon.mjs` | 便携版常驻注入器（抢 PID 锁 + 跑 `MenuInjector`） |
| `pid.mjs` | 只读的 PID 工具（`isAlive` / `readPid`），给安装器用 |
| `wb.mjs` | 找 WorkBuddy 装在哪、在不在跑、版本号 |
| `context-menu.mjs` | 老的四个子命令：`enable` / `disable` / `status` / `launch` |
| `shortcut.mjs` | 读写 Windows `.lnk`（纯 Node，自己拼 MS-SHLLINK 字节） |
| `install.mjs` | 把 `extension/` 复制进 WorkBuddy 的 bundled 扩展目录（扩展版用） |
| `enable-context-menu.cmd` 等 | 纯 ASCII 转发器，只负责找到 node 再调上面的 mjs |

`setup.mjs` 不能 import `daemon.mjs`：后者一被加载就会抢锁并起一个注入器。
读 PID 走 `pid.mjs`，这是纯读的。`test/setup.test.mjs` 盯着这条约束。

为什么 `.cmd` 必须纯 ASCII：`cmd.exe` 按 GBK 逐字节解析批处理文件，UTF-8 中文会被
拆成非法命令，而且夹带 `|` `<` `>` 时会把后续行拼成一条乱命令。所有中文提示都放在
Node 脚本里。

为什么自己拼 `.lnk`：沙箱/受限环境里 `WScript.Shell` 这类 COM 调用常被禁用，
而 `.lnk` 的二进制格式是公开的（MS-SHLLINK），字段固定、够用。

**为什么用 WorkBuddy.exe 当 Node 跑脚本**：`ELECTRON_RUN_AS_NODE=1` 会让 Electron
二进制退化成纯 Node（实测 v22.21.1）。用户机器上有 WorkBuddy，就一定有 Node 运行时，
不用为了跑一个安装脚本去装 Node.js。`.cmd` 里那六行 `if exist ...` 就是在找它。

### ② 客户端主进程

宿主启动时执行 `applyCliCommandLineSwitches()`：读
`WORKBUDDY_REMOTE_DEBUGGING_PORT` → `appendSwitch('remote-debugging-port', n)`。

这带来两个必须知道的事实：

- **环境变量对主进程有效**，所以它是「快捷方式改不动」时的兜底。
- **`appendSwitch` 会覆盖命令行参数**，所以两条路只能留一条，否则会出现
  「明明写成 9333，实际却监听 9222」。

### ③ 扩展 service（`extension/server/`）

| 文件 | 职责 |
| --- | --- |
| `index.cjs` | `activate()` 返回方法表；起停注入器；给面板 `status` / `reload` |
| `menu-inject.cjs` | `MenuInjector`：轮询 target、连接、注入、重连、日志 |
| `cdp.cjs` | 手写 RFC6455 WebSocket + CDP 请求/事件收发 |

`cdp.cjs` 不引第三方库。原因：扩展装进 `app.asar.unpacked` 之后没有 `node_modules`，
任何 `require("ws")` 都会在客户端的 fork 进程里直接失败。

`MenuInjector` 的几个行为约定：

| 情况 | 行为 |
| --- | --- |
| 没配置端口 | 整体休眠，**一次网络请求都不发** |
| 端口开了但连不上 | 静默重试，只在状态翻转时记一行日志 |
| 端口上有页面但不是 WorkBuddy | 记一条 warn，**绝不往里注入** |
| 窗口刷新 / 关闭 | 断开、重连、重新注入 |
| `WORKBUDDY_MENU_INJECT=off` | 硬关，优先于任何配置（跑测试时用） |

只认 WorkBuddy target 这条很重要：9222/9333 是 Chromium 的常见调试端口，
本机上很可能还开着自己的 Chrome 或残留的 Playwright。往里塞脚本会污染别人的会话。

### ③-b 便携版注入器（`bin/daemon.mjs`）

同一个 `MenuInjector`，换了个壳：

| 项 | 做法 | 为什么 |
| --- | --- | --- |
| 谁拉起它 | 启动目录里的 `.vbs`（登录时 wscript 执行） | `.cmd` 会留黑窗口，`.vbs` 的 `Run(...,0,False)` 不会 |
| 环境变量怎么给 | `sh.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"` | 环境变量只对该子进程生效，不污染系统 |
| 文件编码 | UTF-16LE + BOM | wscript 默认按 ANSI 读脚本，中文用户名会读错路径 |
| 重复启动 | `daemon.pid` 独占创建（`wx` 标志） | 开机自启和手动启动撞车时只能有一份 |
| 装在哪 | `~/.workbuddy/session-menu/app/` | 不写 WorkBuddy 安装目录 → 普通权限就够 |
| 日志 | 与扩展版同一个文件 | 两种模式可以无缝切换，看日志不用换路径 |

自愈逻辑在安装器这边：`--status` 发现「有配置但没 PID」就重新拉起一次。

### ④ 注入脚本（`extension/inject/session-menu.js`）

跑在宿主主窗口的渲染进程里（主世界）。它做四件事：

1. **记**：capture 阶段监听 `contextmenu` / `pointerdown`，从
   `[data-conversation-id]` 上取会话 UUID。
2. **等**：开一个 2.6 秒的短窗口，每 80ms 找一次 `.conversation-context-menu`。
3. **插**：克隆「重命名」那颗按钮，换图标改文案，插到它后面。
4. **写**：点击时 `workbuddyDesktop.clipboard.writeText(uuid)`，关菜单，弹提示。

---

## 为什么是「短窗口 + 轮询」

第一版用的是全局 `MutationObserver`，结果把客户端拖到卡死。原因很直接：
宿主聊天是**流式**的，每个 token 都会触发 DOM 变动，观察器在每次变动里全量扫描菜单，
还会和 React 的渲染互相踩。

现在这条路径的空闲开销是零——没有右键就没有任何定时器。

关键约束（违反任何一条都会重演那次卡死）：

| 约束 | 违反后果 |
| --- | --- |
| 只克隆**单个 menuitem 按钮** | 克隆到菜单容器 → 每轮都在复制整份菜单，节点无限增长 |
| 单次注入项数有上限（`MAX_MARKS`） | 同一菜单反复插入 |
| 窗口结束必须 `clearInterval` | 定时器泄漏 |
| 卸载时自己删掉插入的节点 | 等 React 收拾 = 等不到 |

判断「克隆到的是不是容器」，本质依据是**克隆体里还套着 `[role="menuitem"]`**，
不是子节点个数。按个数卡会把图标节点多的正常条目挡掉——实测让注入晚到 1 秒，
而观察窗口只有 1.2 秒，于是「有时能出现、有时不出现」。

---

## 状态与可观测性

注入脚本在 `window.__dshCopySessionMenu` 上挂了两个东西：

```js
window.__dshCopySessionMenu.marks    // 当前插入了几个（正常 0 或 1）
window.__dshCopySessionMenu.state    // 只读快照，排查用
window.__dshCopySessionMenu.stop()   // 立刻停掉并清理
```

`state` 的字段：

| 字段 | 含义 |
| --- | --- |
| `pendingId` | 这次右键记到的会话 UUID（空 = 没记到） |
| `armRemainMs` | 观察窗口还剩多少毫秒 |
| `timerAlive` | 定时器还在不在 |
| `marks` | 已插入的菜单项数 |
| `menuOpen` / `menuItems` | 现在菜单开着吗、几项 |
| `lastReject` | 上一次注入被挡的原因（没 menuitem / 克隆到容器 / 克隆体太大） |

排查口诀：`pendingId` 空 → 右键目标不对；`lastReject` 有值 → 卡在 DOM 判断；
都有值且 `marks=1` → 注入成功，问题在剪贴板。

---

## 目录

```
一键安装.cmd / install.cmd    用户双击的入口（ASCII 转发 → WorkBuddy.exe → setup.mjs）
一键卸载.cmd / 检查状态.cmd    同上，带参数
bin/                    命令行（安装 + 开关 + .lnk 读写）
  setup.mjs             一键安装器：找客户端、放运行时、开端口、设自启、自检
  daemon.mjs            便携版常驻注入器
  pid.mjs               只读 PID 工具
  wb.mjs                定位 WorkBuddy / 判断是否在跑
extension/
  extension.json        扩展清单（id / ui.entry / service.entry）
  distribution.json     分发类型（kind=builtin、fork、iframe）
  icon.svg              侧栏图标
  inject/session-menu.js  注入脚本（渲染进程，两种模式共用）
  server/index.cjs      扩展版 service 入口（activate）
  server/menu-inject.cjs  注入器核心（两种模式共用）
  server/cdp.cjs        WebSocket + CDP
  ui/index.html         面板（状态 + 重新载入）
tools/pack.mjs          打发布 zip
tools/release-notes.mjs 生成 Release 正文
tools/verify.mjs        真机验收（CDP 热替换 + 真实右键点击 + 读剪贴板）
test/                   node --test，不依赖宿主
```
