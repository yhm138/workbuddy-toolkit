# 会话菜单注入：在右键菜单里加「复制 Session ID」

WorkBuddy 桌面端的会话列表，右键（或 hover 后的 `...`）会弹出一个菜单：置顶 / 重命名 / 分享任务 / 在独立窗口中打开 / 打开文件夹 / 批量操作 / 归档 / 删除任务。

这个扩展能往这个菜单里补一项 **复制 Session ID**。

---

## 一、为什么不用扩展点

宿主读扩展 `extension.json` 的 `ui` 字段，能识别的贡献点只有这 11 个：

```
entry  pickers  modals  settings  messageCards  artifactCards
artifactPreviews  chatInputFileSelectors  artifactUploadTargets
contentBlocks  deepLinks
```

**没有 `menus` / `contextMenu` / `commands`。**

而会话菜单在宿主源码里是运行时拼的硬编码数组：

```js
Oe = ae && !a ? [{ label: H('contextMenu.shareTask'), onClick: handleCachedShare }] : []
Ae = e.cwd && isAbsolutePath(e.cwd) && z?.openFolder
     ? [{ label: H('contextMenu.openFolder'), onClick: ... }] : []
Ee = { label: H('contextMenu.deleteTask'), onClick: handleCachedDelete, danger: true }
```

没有任何插槽能往里面塞东西。所以只能从外面注入。

---

## 二、唯一一条被官方留了口子的路

宿主主进程启动时（`main/index.js`）：

```js
let n = process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT;
if (n && /^\d+$/.test(n)) {
  app.commandLine.appendSwitch('remote-debugging-port', n);
  app.commandLine.appendSwitch('remote-allow-origins', `http://127.0.0.1,http://localhost,...`);
}
```

设了这个环境变量，客户端就会开 CDP 调试端口——它本来是给自动化测试用的，我们借用它注入脚本。

### 但这条路不可靠（实测踩过）

同一个环境变量，第一次重启端口开了，第二次重启没开。原因在这段代码的执行时机：

```js
function applyCliCommandLineSwitches(e) {      // ← 在 JS 启动流程里被调用
  app.commandLine.appendSwitch('remote-debugging-port', n)
}
```

Chromium 的调试服务器在主进程初始化时就已经读完命令行参数了。这个补加**只对之后创建的子进程生效**——实测同样的时刻，渲染进程命令行里有 `--remote-debugging-port=9222`，浏览器主进程命令行里没有，端口自然没绑上。而宿主自己还会打一行 `CDP remote debugging enabled on port 9222`，看着像成功。

改成**把参数写进快捷方式**就没有这个竞态：参数在进程创建时就定了。

---

## 三、怎么开

### 方式一：跑一次 enable（它会自己挑能走通的那条路）

```bat
bin\enable-context-menu.cmd
```

它会动**三处**：

| 动哪里 | 给谁看 | 作用 |
|---|---|---|
| 快捷方式的启动参数 `--remote-debugging-port=9333` | 客户端 | 启动时就把 CDP 端口绑上，没有竞态 |
| `~/.workbuddy/dsh-skills/menu-inject.json` | 会话桥 service | 告诉它去连哪个端口 |
| `HKCU\Environment\WORKBUDDY_REMOTE_DEBUGGING_PORT` | 客户端 | 兜底：快捷方式改不动时靠它开端口 |

**开端口有两条路，二选一，绝不能同时留**：

1. **快捷方式参数**（首选）。WorkBuddy 的快捷方式在 `C:\Users\Public\Desktop` 和
   `C:\ProgramData\Microsoft\Windows\Start Menu\Programs` 下，普通权限改不了（`EPERM`），
   得**右键 `enable-context-menu.cmd` → 以管理员身份运行**。
2. **环境变量兜底**（不需要管理员）。宿主主进程启动时会读
   `WORKBUDDY_REMOTE_DEBUGGING_PORT` 再 `appendSwitch`，效果和启动参数一样。
   代价是对所有启动方式都生效，不能只针对某个快捷方式。

`enable` 的判断：

- 所有快捷方式都改成功 → 走参数，**顺手清掉环境变量**（留着会被 `appendSwitch` 反覆盖）。
- 有任何快捷方式改不动 → 走环境变量兜底，并明确告诉你走的是哪条。

> **这里踩过一个坑**：旧版 `enable` 不管快捷方式改没改成就把环境变量删掉。
> 在没有管理员权限的机器上，于是「参数没写进去 + 变量被删掉了」——三条路一起断，
> 客户端重启后端口直接消失、菜单项也跟着没了（2026-10-25 实见）。
> 现在这条约束写死在代码里：**只有 `changed.length > 0 && failed.length === 0` 才清变量。**

改快捷方式之前会原样备份到 `~/.workbuddy/dsh-skills/backups/shortcuts/<时间戳>/`。

写完**从托盘退出 WorkBuddy，再重新打开**——正在跑的进程改不了启动参数。

关掉（会自动还原快捷方式）：

```bat
bin\disable-context-menu.cmd
```

### 方式二：只这一次（不改快捷方式）

```bat
bin\launch-with-copy-id.cmd
```

需要先退出正在跑的客户端（客户端是单例，先起来那个说了算）。

### 方式三：手动

两种都行，选一种。

右键快捷方式 → 属性 → 目标末尾加一个空格再加：

```
--remote-debugging-port=9333
```

或者（不需要管理员权限）：

```bat
setx WORKBUDDY_REMOTE_DEBUGGING_PORT 9333
```

两种都要托盘退出重开才生效。**别同时用**：宿主会 `appendSwitch` 环境变量里的值，
把快捷方式参数盖掉，之后就分不清端口到底是谁开的了。

### 先看看现在是什么状态

```bat
node bin\context-menu.mjs status
```

会分别报告：配置文件、每个快捷方式的启动参数、环境变量设没设、客户端在不在跑、
端口开没开、以及**端口上那个进程到底是不是 WorkBuddy**，最后给一句结论告诉你缺哪一步。

排查顺序：**先看「快捷方式」那几行**。参数没写进去，后面全白搭。

### 换端口

9333 一般不会撞车，但要是被占了（`status` 会直接说「被别的程序占用」），换一个：

```bat
node bin\context-menu.mjs enable 9444
```

它会同时改快捷方式和配置文件，然后重新备份。

---

## 3.5 为什么 .cmd 里一个中文都没有

`bin\*.cmd` 是纯 ASCII，所有中文提示都在 `bin\context-menu.mjs` 里。不是偷懒：

cmd.exe 按**当前代码页**（简中系统是 GBK/936）逐字节解析批处理文件。UTF-8 编码的中文一个字符占 3 字节，其中很容易出现 `0x7C`(`|`)、`0x3C`(`<`)、`0x3E`(`>`)、`0x26`(`&`) —— 这些在 cmd 里是管道、重定向和控制符。解析器一旦在这些字节处断开，后面的行就被拼成非法命令，报出这种莫名其妙的错：

```
'm' is not recognized as an internal or external command
'errorlevel' is not recognized as an internal or external command
```

修法只有两个：把 .cmd 转成 GBK（改一行就重新踩坑，且 git diff 变成乱码），或者让 .cmd 只说 ASCII、中文交给 Node。我们选后者——Node 在 TTY 下走 `WriteConsoleW`，输出中文跟代码页无关。

---

## 四、怎么确认生效

1. 打开侧栏的「会话桥」面板，右上角会出现徽标：
   - `右键菜单 ✓` — 已注入
   - `右键菜单 …` — 端口开了但还没连上主窗口（鼠标悬停看原因）
   - 徽标不出现 — 配置文件和端口都没有，注入器整体休眠
2. 日志：`~/.workbuddy/dsh-skills/menu-inject.log`
3. 命令行：

```bash
node bin/dsh2wb.mjs wb-call menuInject
```

---

## 五、原理

```
WorkBuddy 主进程（带 --remote-debugging-port=9333）
        ▲  CDP over WebSocket
        │
会话桥 service（宿主 fork 的 Node 进程）
        │  ① GET  http://127.0.0.1:9333/json/list      找 page target
        │  ② Page.enable
        │  ③ Runtime.evaluate(source)                   当前页面立即注入
        │  ④ Page.addScriptToEvaluateOnNewDocument      以后每次加载都注入
        ▼
渲染进程
        └─ extension/inject/session-menu.js
             ⑤ capture 阶段记下这次右键的 [data-conversation-id]
             ⑥ 开一个 1.2 秒的短窗口，80ms 查一次 .conversation-context-menu
             ⑦ 找到就克隆「单个 menuitem 按钮」（不是容器）→ 换图标 → 改文案 → 插到「重命名」后
             ⑧ 点击 → workbuddyDesktop.clipboard.writeText → 关菜单 → 弹提示
```

实测结构（WorkBuddy 5.9.2）：

```html
<div class="wb-popover-compact _menu_xxx conversation-context-menu" role="menu">
  <button class="_item_xxx" role="menuitem"><span class="_itemIcon_xxx"><svg…></span>重命名</button>
  <div class="_divider_xxx cb-context-menu-divide"></div>
  …
</div>
```

菜单优先认 `.conversation-context-menu`（宿主自己的语义类名，比哈希类名稳），
认不到再退到 `[role="menu"]` + 文案特征，所以类名改名不至于整条失效。

### 为什么不用 MutationObserver

第一版是全局 `MutationObserver` + 全量扫描，结果把客户端卡住。原因很直接：宿主聊天是流式的，
每秒成百上千次 DOM 变动，每次变动都触发一轮 `document.querySelectorAll('[class*="popover"] …')`，
主线程直接被吃满。

现在是**事件驱动 + 短窗口**：只有右键会话行之后才开始观察，1.2 秒内每 80ms 查一次，命中或超时立刻停表。
空闲时零开销。测试里用静态断言钉住了这一条（`test/inject-script.test.mjs`）。

### 为什么只克隆单个按钮

第一版按「找祖先行」的思路写，`anchor.closest('li') || anchor.parentElement` 在真实结构里
解析成了**整个菜单容器**，于是每次都在克隆整份菜单；而标记又落在菜单外面，
菜单里永远查不到标记，下一轮又克隆一次——节点数一路涨，最后把界面卡死。

现在：只克隆那颗 `<button role="menuitem">`，并且子节点过多（>8）直接放弃，另外有 `MAX_MARKS` 上限兜底。

---

## 六、风险与边界

| 项 | 说明 |
|---|---|
| **端口暴露** | 端口只绑 `127.0.0.1`，但本机上任何进程都能连上来控制工作台。不需要时请关掉。 |
| **升级失效** | 宿主改菜单结构或文案，注入项可能不出现。改 `extension/inject/session-menu.js` 里的 `HINTS` 即可。 |
| **不影响宿主** | 注入脚本全程 try/catch，找不到目标就什么都不做；service 连不上就静默重试。 |
| **不影响其它功能** | 配置文件和端口都没有时，注入器一次网络请求都不发。 |
| **一键止血** | 环境变量 `WORKBUDDY_MENU_INJECT=off` 可硬关注入（优先于其它配置）；运行中也可以执行 `window.__dshCopySessionMenu.stop()` 停掉并清掉已插入的项。 |

---

## 七、排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 徽标一直没有 | 配置文件没写 | `node bin\context-menu.mjs status` 先看「配置文件」那一行；没有就重跑 enable |
| **面板一直显示「等主窗口…（ECONNREFUSED 127.0.0.1:9333）」** | 客户端启动时没开调试端口：快捷方式没参数、环境变量又被删了 | 跑 `status` 看「快捷方式 / 环境变量」两段；两条路都空就重跑 enable（会自动落到环境变量兜底），然后托盘退出重开 |
| 重启后菜单项消失 | 同上，端口没开 → 注入器连不上 | 同上；现在 enable 不会再制造这个状态 |
| **改了代码、也重启了，行为一点没变** | 只改了仓库，没 `install-extension`；service 读的是安装副本 | 跑 `install-extension`，再托盘退出重开。核对副本 `mtime` 和内容（见上一节） |
| 菜单里没有这一项，徽标却是 `✓` | 注入发生在页面重载之前 | 重开一次客户端；或重新右键一次会话（注入脚本按需触发） |
| 徽标显示 `…` | 端口开了但 service 没连上 | 先跑 `node bin\context-menu.mjs status` 看端口是不是被别的程序占了；再看日志的「但不是 WorkBuddy」 |
| 端口被占用 | 9333 被别的程序抢了 | `node bin\context-menu.mjs enable 9444` 换端口（启动方式与配置文件会一起改），再重启客户端 |
| 界面卡顿 / 卡死 | 旧版注入脚本无限克隆菜单（已修） | 升级到当前版本；旧进程里可执行 `window.__dshCopySessionMenu.stop()` 立刻止血 |
| 复制报「复制失败」 | 剪贴板通道都没通 | 看 service 日志；`workbuddyDesktop.clipboard` 若改名，需在 `copyText` 里换通道 |
| **提示「已复制」但剪贴板是空的** | 旧版把 `__wbInvoke('workbuddy:clipboard:writeText')` 排第一，而该通道不存在时 IPC **不 reject**，只 resolve 一个 `{__wbError:true,code:4001}` | 已修：先用 `workbuddyDesktop.clipboard.writeText`，裸 IPC 分支必须判 `__wbError` |

> **这个坑值得单独记一笔**：宿主的 `__wbInvoke` 在「没有对应 handler」时走的是
> resolve 一个 `{__wbError:true, code:4001, message:'No handler for "…"'}`，
> 而不是 reject。所以 `try { await api(channel, ...) } catch {}` 这种写法**永远不会
> 进 catch**，会把失败当成成功——后面的兜底一次都不跑，用户看到成功提示、剪贴板却
> 是空的。凡是拿 `__wbInvoke` 返回值的地方都得先看一眼 `__wbError`。


日志位置：`~/.workbuddy/dsh-skills/menu-inject.log`（超过 256KB 自动清空）。

### 手动改注入脚本后

**改 `extension/inject/session-menu.js` 之后必须重装扩展**，否则改了等于没改：

```bash
node bin/dsh2wb.mjs install-extension
```

原因：service 跑的是**安装副本**，不是仓库里的文件。

```
仓库        extension/inject/session-menu.js
                     ↓ install-extension 复制
安装副本    <WorkBuddy>/resources/app.asar.unpacked/resources/extensions/dsh-session-bridge/inject/session-menu.js
                     ↓ menu-inject.cjs 的 loadSource() 读的是这个
注入内容 ──→ 渲染进程
```

`loadSource()` 里的路径是 `path.join(__dirname, "..", "inject", "session-menu.js")`，
`__dirname` 指向安装副本的 `server/`。所以光改仓库、只重启客户端，注入进去的还是旧代码。

> **2026-10-25 就在这上面栽过**：改完复制逻辑、提示「已复制」还是不进剪贴板。
> 查了半天，安装副本的 mtime 停在前一晚 00:11，`__wbInvoke` 那段旧代码原样在那儿。
> 症状极具迷惑性——「我明明改了，也重启了，行为一点没变」。

所以完整流程是：

| 改了什么 | 要做什么 |
|---|---|
| `extension/inject/session-menu.js` | `install-extension` → 托盘退出重开客户端 |
| `extension/server/*.cjs` | `install-extension` → 托盘退出重开客户端 |
| `extension/ui/index.html` | 不用装，重开面板即可 |

装完必须让 service 重新读文件（它是启动时 `loadSource()` 读进内存的），
所以还是得托盘退出重开——重启的是 service，不只是窗口。

急着手动验一次、不想重启：用 CDP 把仓库里的文件直接 `Runtime.evaluate` 进当前页面。
`.probe/clip-diag.mjs` 就是这么写的（改改端口就能用），它会顺带打印
`window.__dshCopySessionMenu.state`——`pendingId` 有没有记上、菜单几项、
`lastReject` 卡在哪一步，一眼就能看到。这只在本次页面存活期有效，正式路径仍是 service 注入。

---

## 八、为什么没做「置顶空间」

一起提的另一个需求是给空间（Workspace）菜单加「置顶空间」。

查遍了宿主代码：**没有这个能力**。只有会话置顶（`conversation.section.pinned`）、同事置顶、技能置顶，搜不到 `pinWorkspace` / `workspacePin` 之类的接口，空间分组的排序是按活跃时间算的。

硬做只能是我们本地存一份置顶名单 → 注入 CSS `order` 强行重排。但：

- 空间分组不是 flex/grid 容器，`order` 未必生效
- 宿主自己会按活跃度重排，两边打架
- 宿主升级一次就可能全乱

所以没做。真要做，更靠谱的方向是给宿主提需求，而不是在客户端外面改 DOM。
