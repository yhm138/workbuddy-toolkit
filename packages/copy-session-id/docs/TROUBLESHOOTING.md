# 排错

按症状查。每条都标了「怎么确认」，别靠猜。

> 普通用户只需要记住一件事：**双击 `检查状态.cmd`**。它逐项打勾，还会顺手修
> 能修的（注入器被结束了会自动拉起来）。下面那些命令是给改代码的人用的。

---

## 菜单里没有「复制 Session ID」

**先双击 `检查状态.cmd`**，按最后那句结论走。

| 它说 | 含义 | 处理 |
| --- | --- | --- |
| 还没装 | 配置文件不存在 | 双击 `一键安装.cmd` |
| 注入器 没在运行 | 后台进程没了 | `检查状态.cmd` 会自己拉起；拉不起来就重跑安装器 |
| 调试端口 未监听 | 客户端这次启动没开端口 | 托盘退出 → 从桌面图标重开 |
| 端口被别的程序占用 | 9333 撞车 | 重跑安装器，它会在 9333–9342 里挑一个空的 |
| 开端口方式 都是 ✗ | 快捷方式和环境变量都没设上 | 右键 `一键安装.cmd` → 以管理员身份运行 |
| 全部 ✓ 但菜单没有 | 页面是装之前打开的 | 关掉那个窗口重开，或 `Ctrl+R` |

### 端口通了但菜单里还是没有

分两种运行方式：

**便携版（默认）** —— 注入器是常驻进程：

```bash
cat ~/.workbuddy/session-menu/menu-inject.log
# 应该有「注入器启动」紧跟「已注入：WorkBuddy」
```

只有「启动」没有「已注入」→ 注入器连上了端口但没认出 WorkBuddy 的窗口，
看 [PROTOCOL.md](PROTOCOL.md) 里 `isWorkBuddyTarget` 的判据。

**扩展版（`--with-panel`）** —— 常见原因是 **service 没启动**：
宿主只在面板被打开过之后才 fork service。

**确认**：打开侧栏「会话菜单」面板，看顶部是不是「已就绪」「已连 N 个窗口」。

**处理**：点开一次面板；还不行就重启客户端。

> 这一步最反直觉：扩展装了、端口开了，但如果你从没打开过面板，
> service 可能根本没被 fork 过。这也是默认改成便携版的原因。

---

## 开机后菜单又没了 / 每次都要重装

自启项在：

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\WorkBuddy 会话菜单.vbs
```

**确认**：这个文件还在不在。不在就是被清理软件删了（安全软件常干这事），
重跑一次 `一键安装.cmd`。

**另一个可能**：安装时带了 `--no-autostart`。重跑安装器不带这个参数即可。

> 自启脚本是 UTF-16LE 带 BOM 的 `.vbs`，因为 wscript 默认按 ANSI 读脚本，
> 用户名是中文时路径会读错。

---

## 面板一直显示「等主窗口…（ECONNREFUSED 127.0.0.1:9333）」

这句话的意思是：**客户端启动时压根没开调试端口**。不是面板坏了。

**确认**：

```powershell
Get-CimInstance Win32_Process -Filter "Name='WorkBuddy.exe'" |
  Where-Object { $_.CommandLine -like '*remote-debugging*' } |
  ForEach-Object { ([regex]::Match($_.CommandLine,'--remote-debugging-port=\d+')).Value }
```

一行都不输出 = 没开。

**处理**：`node bin/setup.mjs` → 托盘退出 → 重开。

### 为什么会出现这种状态

有个自己把自己锁死的经典闭环，值得记一笔：

1. `enable` 去改快捷方式，`C:\Users\Public\Desktop` 和 `C:\ProgramData\...\Start Menu`
   下的 `.lnk` 要管理员权限，改失败（`EPERM`）
2. 但老版本 `enable` 的第三步「清掉旧的环境变量」**无条件执行**
3. 结果：参数没写进去、变量又被删了 —— 三条路一起断
4. 客户端重启后没有端口 → 注入器连不上 → 菜单项消失

现在的版本里这条约束写死在代码里：**只有所有快捷方式都改成功，才会清环境变量**；
改不动就反过来写环境变量兜底。

---

## 提示「已复制 Session ID」，但剪贴板是空的

两个已知原因。

### 原因一：IPC 通道名不存在，但失败被伪装成成功

宿主的 `__wbInvoke` 在「没有对应 handler」时**不 reject**，而是 resolve 一个错误对象：

```js
await window.__wbInvoke('workbuddy:clipboard:writeText', 'x')
// → {__wbError: true, message: 'No handler for "…"', code: 4001}
```

所以 `try { await api(ch, ...) } catch {}` 这种写法永远进不了 catch，
后面的兜底一次都不会跑。

**现在的实现**：优先用 preload 直接暴露的 `workbuddyDesktop.clipboard.writeText(text)`
（宿主自己封装的真通道，不需要页面焦点），裸 IPC 只作第二选择且必须判 `__wbError`。

**确认**：在任意窗口（打开 DevTools）执行

```js
window.workbuddyDesktop.clipboard.readText()
```

读到的是不是刚复制的 UUID。

### 原因二：右键的会话没带 `data-conversation-id`

注入脚本靠右键目标的 `data-conversation-id` 属性认会话。如果宿主改了结构、
右键到的是分组标题而不是会话行，记到的就是空值。

**确认**：读 `window.__dshCopySessionMenu.state.pendingId`。

- 有 UUID → 没问题
- 空字符串 → 右键目标不对，看 [PROTOCOL.md](PROTOCOL.md) 里的会话行结构

---

## 右键之后菜单要多等半秒才多出这一项

这是**观察窗口在重试**，说明前几次注入被挡了。

**确认**：读 `window.__dshCopySessionMenu.state.lastReject`。

| `lastReject` | 原因 |
| --- | --- |
| `菜单里还没有 menuitem` | 菜单容器先出现、条目后渲染，正常，会重试 |
| `克隆到了容器（内含 N 个 menuitem）` | 锚点选错，选到了菜单容器本身 |
| `克隆体太大（N 个节点）` | 上限 `MAX_CLONE_NODES=24` 太紧，或锚点确实是容器 |

如果稳定在 1 秒以上才出现，调大 `ARM_MS`（默认 2600ms）或放宽 `MAX_CLONE_NODES`。

---

## 右键之后客户端变卡 / 节点数暴涨

老版本的问题，已经修了。判断是不是老版本：

```js
window.__dshCopySessionMenu.state.marks   // 应该只有 0 或 1
document.querySelectorAll('[data-dsh-copy-session]').length   // 同上
```

数字一直在涨 = 还在跑老版本。

**立刻止血**（不用重启客户端）：

```js
window.__dshCopySessionMenu.stop()
```

**根治**：重跑 `一键安装.cmd`（会把新脚本复制进 `~/.workbuddy/session-menu/app/`），
再托盘退出重开。

---

## 改了代码、也重启了，行为一点没变

**最可能的错**：只改了仓库里的文件，没更新运行副本。

注入脚本被复制到两个地方，取决于用哪种运行方式：

```
仓库        extension/inject/session-menu.js
              │
              ├─ node bin/setup.mjs   → ~/.workbuddy/session-menu/app/extension/inject/   （便携版读这里）
              └─ node bin/install.mjs → <WorkBuddy>/resources/app.asar.unpacked/resources/extensions/workbuddy-session-menu/ （扩展版读这里）
```

**确认**：比对修改时间

```bash
ls -l extension/inject/session-menu.js
ls -l ~/.workbuddy/session-menu/app/extension/inject/session-menu.js
```

**处理**：重跑 `一键安装.cmd` → 托盘退出重开。

---

## 面板显示「插件加载失败」

宿主扩展清单是**启动时快照**的。装完/更新完扩展没重启客户端，就会看到这个。

托盘退出重开即可。

如果重启也不行，看面板底部诊断，常见原因：

- `service.entry` 路径写错（相对 `extension/` 目录）
- `index.cjs` 没导出 `activate`
- `cdp.cjs` 引了第三方库（扩展目录里没有 `node_modules`）

---

## 跑 `.cmd` 报一堆乱码 / `'m' is not recognized`

`cmd.exe` 按 **GBK** 逐字节解析批处理，UTF-8 中文会被拆成非法命令，夹带
`|` `<` `>` 时还会把后面几行拼成一条乱命令。

**处理**：`.cmd` 一律保持纯 ASCII，中文提示写到 Node 脚本里。
仓库里的 `.cmd` 都只有二十来行，只负责「找到 WorkBuddy，用它当 Node 转发参数」。
CI 里有一条专门卡这个。

---

## 日志在哪

```
~/.workbuddy/session-menu/menu-inject.log
```

超过 256KB 自动清空。记的是「启动 / 已注入 / 连接失败」这类状态翻转，
不是每条 tick——否则流式聊天时会写爆磁盘。

时间戳是 **UTC**。`2026-10-24T23:31:11Z` 是北京时间 10 月 25 日 07:31。

相关的还有：

| 文件 | 作用 |
| --- | --- |
| `~/.workbuddy/session-menu/menu-inject.json` | 端口配置，注入器读它 |
| `~/.workbuddy/session-menu/daemon.pid` | 注入器 PID，用来防重复启动 |
| `~/.workbuddy/session-menu/app/` | 运行副本，可随时删掉重装 |
