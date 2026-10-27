# 这条路是怎么找到的

记录结论背后的过程：试过什么、为什么放弃、最后为什么是现在这个方案。

---

## 一、需求

会话 ID 在界面上没有入口。侧栏只有标题，想引用某个会话得去
`~/.workbuddy/projects/` 里翻 `.jsonl` 文件名——一堆 UUID，对不上哪个是哪个。

最自然的想法：**右键菜单里加一项「复制 Session ID」**。

---

## 二、先看官方有没有口子

查 `extension.json` 的 `ui` 字段，全部贡献点只有 11 个：

```
entry · pickers · modals · settings · messageCards · artifactCards
artifactPreviews · chatInputFileSelectors · artifactUploadTargets
contentBlocks · deepLinks
```

没有 `menus`，没有 `contextMenu`。

再看菜单是怎么渲染出来的。会话菜单在 `renderer/assets/contexts-*.js` 里，
是 React 组件的条件数组：

```js
[canRename && <MenuItem>重命名</MenuItem>, canPin && <MenuItem>置顶</MenuItem>, …]
```

**硬编码，没有插槽。** 社区常见的 `app.asar` 补丁（改 renderer 打包产物）能实现，
但侵入性太强：每次客户端升级都要重打一次，且改的是宿主自己的文件。

放弃这条路。

---

## 三、注意到宿主留了一个调试开关

翻 `main/index.js` 时看到：

```js
function applyCliCommandLineSwitches() {
  const port = Number(process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT || 0);
  if (port) app.commandLine.appendSwitch("remote-debugging-port", String(port));
}
```

这是给自动化测试留的口子。它意味着：**只要客户端带调试端口启动，本机就能用
Chrome DevTools Protocol 连上渲染进程**。

而 CDP 能做一件事：`Runtime.evaluate` —— 往页面里执行任意 JS。

于是方案定了：

> 不改宿主文件、不进主进程，只在渲染进程里补一个 DOM 节点。
> 页面重载即消失，卸载扩展即恢复。

---

## 四、第一个坑：环境变量有时灵、有时不灵

最早的做法是设 `WORKBUDDY_REMOTE_DEBUGGING_PORT=9222`，然后重启客户端。

结果很怪：**同一个变量，第一次重启端口开了，第二次重启没开。**

查下来是执行时机：

```js
app.commandLine.appendSwitch(...)   // 在 app.whenReady() 之后调用
```

`appendSwitch` 晚于 Chromium 初始化时，参数只对子进程生效，主进程的调试服务已经
起不来了。而这段代码放在 `whenReady` 之后，和初始化赛跑——有时赢有时输。

更坑的是：宿主自己还会打一行「debugging enabled on port 9222」的**假成功日志**。

**改走启动参数**：`--remote-debugging-port=9333` 在进程创建时就定了，没有竞态。

但由此留下一条必须守住的约束：**启动参数和环境变量只能留一个**，
因为 `appendSwitch` 会覆盖命令行参数，两个都在时实际监听哪个说不准。

---

## 五、第二个坑：把客户端卡死

第一版注入脚本用全局 `MutationObserver`，监听整个 body：

```js
new MutationObserver(scanAll).observe(document.body, { subtree: true, childList: true });
```

想法是「菜单一出现就补一项」。实际效果：**客户端直接卡死**。

原因是宿主聊天是**流式**的——每个 token 都触发一次 DOM 变动，观察器每次都全量扫描，
还要克隆节点。两个页面开着就卡到动不了。

第二版改成「右键后开短窗口」：

```
contextmenu 事件 → 记下会话 ID → 开 2.6 秒窗口，每 80ms 查一次 → 命中就停
```

空闲开销归零。

### 但第二版又踩了一个更隐蔽的

一开始用 `event.target.closest('li')` 当行容器，拿不到就退到 `parentElement`。
问题是：**菜单项没有 `<li>` 父级**，`parentElement` 直接就是菜单容器。

于是每轮都在克隆整份菜单；而防重复的标记落在菜单外面，`menu.querySelector(mark)`
永远找不到，判定「还没插过」，下一轮继续克隆。

节点数指数据涨，内存飙升。这就是那次「卡爆了」。

现在的三条硬约束就是从这里来的：

1. 只克隆**单个 `button[role="menuitem"]`**
2. 防重复靠菜单内可查的标记，不靠外部计数
3. 卸载时自己删节点，不等 React

---

## 六、第三个坑：假成功

菜单项终于出现了，点下去也弹「已复制 Session ID」。**但剪贴板是空的。**

查下来是宿主的本地 RPC 行为：

```js
await window.__wbInvoke('workbuddy:clipboard:writeText', uuid)
// resolve: { __wbError: true, code: 4001, message: 'No handler for "…"' }
```

**通道不存在时不 reject，而是 resolve 一个错误对象。**

原代码是：

```js
try { await api(channel, text); return true } catch { /* 换下一条 */ }
```

永远进不了 catch，于是「成功」返回，后面 `navigator.clipboard`、`execCommand`
两条兜底一次都没跑。

修法：改用 preload 直接暴露的 `workbuddyDesktop.clipboard.writeText()`——
宿主自己封装的真通道，不需要页面焦点；裸 IPC 降为备选且必须显式判 `__wbError`。

**通用教训**：把「没抛异常」当成「成功」，在 RPC 型接口上不成立。

---

## 七、第四个坑：改了代码，一点变化都没有

改完剪贴板逻辑、重启客户端，行为完全照旧。

查了两个小时才发现：**service 注入的是安装副本，不是仓库文件。**

```
仓库        extension/inject/session-menu.js          ← 我改的是这个
                 ↓ node bin/install.mjs
安装副本    <WorkBuddy>/…/extensions/workbuddy-session-menu/inject/session-menu.js
                 ↓ service 的 loadSource() 读这个
注入内容 ──→ 渲染进程
```

`loadSource()` 是 `path.join(__dirname, "..", "inject", "session-menu.js")`，
`__dirname` 指向安装副本的 `server/`。所以「改仓库 + 重启客户端」= 什么都没改。

判断依据：比对两边 mtime，或者 `grep` 一个只在新版里出现的字符串。

---

## 八、还有一次：注入项晚到 1 秒

菜单项有时出现、有时不出现。加日志后看到：右键后 700~1400ms 才插进去，
而观察窗口只有 1200ms。

原因是一行守卫：

```js
if (clone.querySelectorAll('*').length > 8) return false;   // 别克隆到容器
```

本意是「克隆体太大说明克隆到容器了」。但「重命名」那颗按钮的图标有多层节点，
子节点数本来就接近上限，于是前几次 tick 全被挡回，等 React 某些时机下结构变了才过。

**判据换成本质**：克隆体里还套着 `[role="menuitem"]` 才是容器。节点上限放宽到 24。
再加上「右键后先同步试一次，不等第一个 tick」。

实测 700~1400ms → **120ms**。

---

## 九、最后形成的判断

| 决策 | 理由 |
| --- | --- |
| 借 CDP，不改 `app.asar` | 升级不失效，卸载即恢复 |
| 用启动参数而不是环境变量 | 没有初始化竞态；两者只能留一个 |
| 短窗口轮询，不用全局观察器 | 流式聊天会让观察器在每个 token 上触发 |
| 只克隆单个 menuitem | 克隆容器会指数级增长 |
| 剪贴板走 preload 暴露的对象 | 裸 IPC 会把失败伪装成成功 |
| 改完代码必须重跑安装器 | 注入器读的是运行副本，不是仓库 |
| 给注入脚本挂 `state` 快照 | 排查从「猜」变成「读一个对象」 |
| 默认跑常驻进程，而不是扩展 service | 扩展 service 要面板被打开过才 fork，这一步没法自动化 |

### 关于最后一条的来龙去脉

第一版把注入器放在扩展的 service 里，逻辑上最干净：宿主会 fork，有面板看状态，
卸载就是删目录。但有个致命的使用体验问题——

**宿主只在「侧栏面板被打开过一次」之后才 fork service。**

这意味着装完之后必须教用户：重启客户端 → 找到侧栏那个图标 → 点开面板 → 之后才有菜单。
少一步就没反应，而且没有任何提示告诉用户少了这一步。

试过两条补救路线：

1. 找宿主的「随启动激活」开关 —— `extension.json` 里没有这种字段，
   `ui` 只认 11 个贡献点，`service` 只有 `entry` 和 `process`。
2. 让面板自己弹出来 —— 宿主没有开放这种 API。

于是换成常驻进程：不管宿主怎么想，我自己把注入器跑起来。代价是多一个后台进程，
收益是「双击 → 重启 → 完事」。扩展版作为可选形态保留下来（`--with-panel`），
因为它确实有个能看状态的界面。

---

## 十、如果你要照着做一个

这套方法不限于「复制 Session ID」。只要满足下面三条，都能用同样的路径补 UI：

1. 目标 UI 在**渲染进程**里（DOM 能表达）
2. 宿主没有对应的扩展贡献点
3. 能接受「借用调试端口」这个前提

比如：给消息加「复制消息 ID」、给会话加「导出为 Markdown」、给工具栏加按钮。

改 `inject/session-menu.js` 里的三处即可：**锚点选择器**、**插入的节点**、
**点击后的动作**。

反过来说，如果要做的事需要**主进程能力**（读写系统文件、开新窗口、改菜单栏），
这条路径做不到——那得走官方 service，或者老老实实等宿主加贡献点。
