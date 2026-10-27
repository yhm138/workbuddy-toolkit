# 协议与事实清单

照着改代码时看这篇。所有条目都是实测过的，不是推断。

> 实测环境：WorkBuddy 5.9.2 桌面端 / Electron 37.10.3 / Chrome 138 / Node 22 / Windows 11。
> 宿主升级后这些都可能变，变了就来改这里，并同步改代码里的选择器。

---

## 1. 调试端口

| 项 | 值 |
| --- | --- |
| 打开方式 A | 启动参数 `--remote-debugging-port=<n>` |
| 打开方式 B | 环境变量 `WORKBUDDY_REMOTE_DEBUGGING_PORT=<n>`，宿主 `appendSwitch` |
| 绑定地址 | 仅 `127.0.0.1` |
| 默认约定端口 | 9333（避开 Chromium 惯用的 9222） |
| 生效时机 | **进程启动时**。运行中的进程改不了 |

**两者同时存在时，环境变量赢**（`appendSwitch` 覆盖命令行参数）。
所以配置只能留一条，否则会出现「写成 9333、实际监听 9222」。

### 端点

```
GET  http://127.0.0.1:<port>/json/version   浏览器版本
GET  http://127.0.0.1:<port>/json/list      页面 target 列表
WS   ws://127.0.0.1:<port>/devtools/page/<targetId>
```

`/json/list` 里每个 target 的关键字段：

```json
{ "id": "…", "type": "page", "title": "WorkBuddy", "url": "file:///…/app.asar/renderer/index.html", "webSocketDebuggerUrl": "ws://…" }
```

### 认出「是不是 WorkBuddy 的窗口」

```js
/app\.asar/i.test(url)                              // 打包后的渲染进程
|| (/^file:\/\//i.test(url) && /\/resources\//i.test(url))
|| /workbuddy/i.test(url) || /workbuddy/i.test(title)
```

**必须过滤**。9222/9333 上经常还挂着用户自己的 Chrome 或残留的 Playwright，
往那些页面注入脚本等于污染别人的会话。

---

## 2. CDP 用法

只要四个方法：

| 方法 | 用途 |
| --- | --- |
| `Page.enable` | 让页面事件可用 |
| `Runtime.evaluate` | 立即把脚本注入当前页面 |
| `Page.addScriptToEvaluateOnNewDocument` | 以后每次页面加载都注入 |
| `Input.dispatchMouseEvent` | 测试时模拟真实鼠标事件 |

`Runtime.evaluate` 的参数：

```js
{ expression, awaitPromise, returnByValue, allowUnsafeEvalBlockedByCSP: true }
```

`allowUnsafeEvalBlockedByCSP` 不能少——宿主页面有 CSP，不加这个参数脚本会被拒。

### 两个必须知道的坑

**① 合成事件 React 不认**

```js
document.dispatchEvent(new MouseEvent('contextmenu'))   // ❌ 菜单不会出现
```

React 只信任 `isTrusted === true` 的事件。测试要用 `Input.dispatchMouseEvent`
从浏览器层面派发：

```js
{ type: "mousePressed",  x, y, button: "right", clickCount: 1, buttons: 2 }
{ type: "mouseReleased", x, y, button: "right", buttons: 0 }
```

**② 连上多个 target 要各自 evaluate**

一个窗口一个 WebSocket。新开窗口、崩溃恢复、页面重载后都要重新注入，
所以 `MenuInjector` 是按 targetId 维护连接表的。

---

## 3. 会话行 DOM

```html
<div data-conversation-id="ed759364-535d-4a14-a131-0527eedf9e68" class="…">
  …标题、时间、操作按钮…
</div>
```

- `data-conversation-id` 的值就是完整 UUID，和
  `~/.workbuddy/projects/<项目>/<会话>.jsonl` 的文件名一致
- 同一个 ID 可能在 DOM 里出现**两次**（外层容器 + 内层行），取任意一个都行，
  值相同
- 该属性只出现在会话行上，分组标题、空间节点都没有

---

## 4. 会话右键菜单 DOM

```html
<div class="wb-popover-compact _menu_xxx conversation-context-menu" role="menu">
  <button class="_item_xxx" role="menuitem">
    <span class="_itemIcon_xxx"><svg …></span>重命名
  </button>
  <div class="_divider_xxx cb-context-menu-divide"></div>
  …
</div>
```

要点：

- 容器有**语义类名** `.conversation-context-menu`，比哈希类名稳，优先用它；
  兜底 `[role="menu"]` + 文案含「重命名」
- 菜单项是 `<button role="menuitem">`，**没有 `<li>` 父级**
- 文案是中文（`重命名`）或英文（`Rename`），锚点匹配两者
- 每项结构是「图标 `span>svg` + 直接文本节点」，改文案要改**按钮自己的文本节点**，
  别碰 svg 里的东西

### 插入方式

克隆「重命名」那颗按钮，然后：

```js
clone.setAttribute('data-dsh-copy-session', '1')   // 标记，防重复
clone.removeAttribute('aria-checked')
clone.removeAttribute('data-state')
// 替换 svg 内容、把直接文本节点改成「复制 Session ID」
anchor.parentElement.insertBefore(clone, anchor.nextSibling)
```

**不要克隆菜单容器**。容器克隆出去之后再插入，等于每次都在复制整份菜单，
而标记又落在菜单外面查不到，于是每轮 DOM 变动都再插一次——节点无限增长，
客户端直接卡死。

---

## 5. 剪贴板

渲染进程里可用的接口，按可靠性排序：

| 接口 | 需要焦点 | 备注 |
| --- | --- | --- |
| `window.workbuddyDesktop.clipboard.writeText(text)` | 否 | **首选**。host preload 暴露，resolve `undefined` |
| `window.__wbInvoke('workbuddy:clipboard:writeText', text)` | 否 | 通道**不存在**，见下 |
| `navigator.clipboard.writeText(text)` | 是 | 窗口没焦点会抛 `Document is not focused` |
| `textarea + document.execCommand('copy')` | 是 | 最后兜底 |

`workbuddyDesktop.clipboard` 的成员：

```
readText · writeText · readImage · writeImage · write
```

`write` 接受字符串（`write({text})` 会报 `Desktop clipboard text must be a string`）。

### `__wbError` 这条坑

宿主的本地 RPC 在**找不到 handler 时不 reject**，而是 resolve：

```js
{ __wbError: true, code: 4001, message: 'No handler for "workbuddy:clipboard:writeText"' }
```

于是这种写法会把失败当成功：

```js
try { await window.__wbInvoke(ch, text); return true } catch { /* 永远进不来 */ }
```

**凡是拿 `__wbInvoke` 返回值的地方，都得先看 `__wbError`。**

---

## 6. 宿主扩展激活协议

`extension.json`：

```json
{
  "id": "workbuddy-session-menu",
  "ui":    { "entry": { "title": "…", "icon": "./icon.svg", "url": "./ui/index.html",
                        "placement": "sidebar", "openInWindow": false, "keepAlive": true } },
  "service": { "entry": "./server/index.cjs", "process": "fork" }
}
```

`distribution.json` 关键字段：

```json
{ "kind": "builtin", "processPolicy": { "server": "fork", "renderer": "iframe" } }
```

- `kind` 必须是 `builtin`，否则不会出现在侧栏
- `keepAlive: true` 让面板切走后 service 继续活着

### service 入口

```js
module.exports = {
  activate() { return { methods: { … }, dispose() { … } } }
};
```

方法签名 `(context, payload)`，返回值必须可结构化克隆（不能是函数、Symbol、循环引用）。

### 面板怎么调方法（两跳）

```js
// 1) 拿票据
wb.__BRIDGE__.invoke("wb:extensions:$resolveLocalRpc", [EXT_ID, "ping"], 20000)
// → { fallbackToken, methods: [...] }

// 2) 调方法
wb.__BRIDGE__.invoke("wb:extensions:$invokeLocalRpcFallback",
                     [EXT_ID, "status", {}, token], 20000)
```

抢票/调用之前必须先完成 Guest 握手，否则拿到的是「宿主通道未建立」。

### 握手时序

```
iframe load
  ← 宿主推 { type: "__wb_port_init__", readyToken } + MessagePort
  → guest 在 10s 内回 wb:invoke:request(channel="wb:boundary:guest-ready")
    否则界面显示「插件加载失败」，日志是 Guest Ready timed out after 10000ms
```

所以握手代码必须放在 `<head>` 里尽早执行，不能等 `DOMContentLoaded`。

### service 什么时候启动

**面板第一次被打开时**才 fork，之后 `keepAlive` 常驻。

这条直接影响排查：扩展装好了但面板没打开过 → service 不存在 → 端口不会有人去连
→ 日志里连一行都不会有。

---

## 7. 配置与路径

| 用途 | 路径 |
| --- | --- |
| 端口配置（service 与命令行共用） | `~/.workbuddy/session-menu/menu-inject.json` |
| 注入器日志 | `~/.workbuddy/session-menu/menu-inject.log` |
| 快捷方式备份 | `~/.workbuddy/session-menu/backups/shortcuts/<时间戳>/` |
| 扩展安装位置 | `<WorkBuddy>/resources/app.asar.unpacked/resources/extensions/workbuddy-session-menu/` |
| 会话记录 | `~/.workbuddy/projects/<项目>/<会话ID>.jsonl` |

`WORKBUDDY_HOME` 可覆盖前三条的根目录（测试里用）。

---

## 8. 环境变量

| 变量 | 作用 | 谁读 |
| --- | --- | --- |
| `WORKBUDDY_REMOTE_DEBUGGING_PORT` | 让客户端开 CDP 端口 | 客户端主进程 |
| `WORKBUDDY_MENU_INJECT=off` | 硬关注入器（优先于一切配置） | service |
| `WORKBUDDY_HOME` | 改数据目录 | 本项目 |
| `WORKBUDDY_EXE` | 指定 WorkBuddy.exe 路径（`launch` 用） | 本项目 |

`WORKBUDDY_MENU_INJECT=off` 在跑测试时是必须的：否则 `node --test` 会连上本机
真实客户端，把测试窗口里的菜单改掉，还会挂到超时。
