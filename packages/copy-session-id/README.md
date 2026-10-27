<div align="center">

# 复制 Session ID

**给 WorkBuddy 的会话右键菜单加一项 —— 点一下，这个会话的 ID 就进了剪贴板。**

[![release](https://img.shields.io/github/v/release/yhm138/workbuddy-toolkit?color=2ea043&label=%E4%B8%8B%E8%BD%BD)](https://github.com/yhm138/workbuddy-toolkit/releases)
[![ci](https://github.com/yhm138/workbuddy-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/yhm138/workbuddy-toolkit/actions/workflows/ci.yml)
[![stars](https://img.shields.io/github/stars/yhm138/workbuddy-toolkit?color=e3b341)](https://github.com/yhm138/workbuddy-toolkit/stargazers)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![platform](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%C2%B7%20WorkBuddy%205.9.x-lightgrey.svg)](#%E8%A3%85)

</div>

```
  会话列表                     右键一个会话
  ┌──────────────────┐        ┌──────────────────┐
  │ 调试端口失效排查  │  ───▶  │ 重命名            │
  │ 仓库拆分方案      │        │ 复制 Session ID  │  ◀ 新加的
  │ 发票 OCR 调研     │        │ 置顶              │
  └──────────────────┘        │ 删除              │
                              └──────────────────┘
```

复制到的是 `ed759364-535d-4a14-a131-0527eedf9e68` 这种完整 UUID，和
`~/.workbuddy/projects/<项目>/<会话>.jsonl` 的文件名一致。

---

## 装

**不需要 Node.js，不需要管理员权限，不改 WorkBuddy 的任何文件。**

1. 去 [**Releases**](https://github.com/yhm138/workbuddy-toolkit/releases) 下载
   `workbuddy-session-menu-v1.0.0.zip`
2. 解压到任意位置（桌面也行），双击 **`一键安装.cmd`**
3. 如果弹出「是否允许此应用……」，点**是**
4. 装完它会问要不要重启 WorkBuddy，**直接按回车**

重启后等几秒，右键任意会话，菜单里就有「复制 Session ID」了。

> 为什么用 WorkBuddy 自带的程序跑安装脚本：`WorkBuddy.exe` 打开
> `ELECTRON_RUN_AS_NODE=1` 就是一个完整的 Node 22。你有 WorkBuddy，就有运行时，
> 不用再装一套。

## 用

右键任意会话 → **复制 Session ID** → 粘贴。

菜单项只出现在**会话行**的右键菜单里，别处的右键菜单不受影响。

## 没反应

双击 **`检查状态.cmd`**。它逐项打勾，还会顺手修能修的（比如注入器被任务管理器结束了，
它会重新拉起来）。

| 它说 | 意思 | 怎么办 |
| --- | --- | --- |
| 调试端口 未监听 | 客户端这次启动没开端口 | 托盘图标右键退出 → 从桌面图标重新打开 |
| 注入器 没在运行 | 后台进程被结束了 | `检查状态.cmd` 会自己拉起来；拉不起来才重跑 `一键安装.cmd` |
| 端口被别的程序占用 | 9333 撞车了 | 重跑 `一键安装.cmd`，它会在 9333–9342 里挑一个空的 |
| 全部 ✓ 但菜单没有 | 页面是装之前打开的 | 关掉那个窗口重新打开，或按 `Ctrl+R` |

## 卸载

双击 **`一键卸载.cmd`**，然后重启 WorkBuddy。

---

## 为什么需要它

WorkBuddy 的会话 ID 在界面上**没有入口**。侧栏只显示标题；想引用某个会话
（发给另一个会话、贴进 issue、丢给 `wb-session <ID>` 回放），得自己去
`~/.workbuddy/projects/` 里翻 `.jsonl` 文件名，会话一多就对不上号。

宿主的扩展体系里没有菜单贡献点 —— `extension.json` 的 `ui` 只认这 11 个：

```
entry · pickers · modals · settings · messageCards · artifactCards
artifactPreviews · chatInputFileSelectors · artifactUploadTargets
contentBlocks · deepLinks
```

没有 `menus` / `contextMenu`，会话菜单是 React 里硬编码的条件数组。

所以走另一条路：**借宿主自己留的调试端口（CDP），往渲染进程里补一个菜单项**。
不改宿主文件、不注入主进程，进程一退出就恢复原样。

> 这不是官方扩展能力。它是「用宿主已有的调试通道干一件事」，代价见下面的
> [风险与边界](#风险与边界)。

## 它是怎么工作的

```
WorkBuddy 启动（带 --remote-debugging-port=9333）
   │
   ├─ 后台注入器（本工具，开机自启）
   │     └─ 轮询 http://127.0.0.1:9333/json/list
   │           └─ 认出 WorkBuddy 的窗口 → WebSocket 连上
   │                 └─ 把 inject/session-menu.js 推进渲染进程
   │
   └─ 渲染进程里的注入脚本
         ├─ 右键时记住是哪个 [data-conversation-id]
         ├─ 开 2.6 秒观察窗口，80ms 查一次 .conversation-context-menu
         ├─ 找到 → 克隆「重命名」那一项 → 换图标改文案 → 插回去
         └─ 点击 → workbuddyDesktop.clipboard.writeText(uuid) → 关菜单 → 提示
```

几个决定，都是踩过坑之后定的：

| 决定 | 原因 |
| --- | --- |
| 只克隆单个 `menuitem`，不克隆菜单容器 | 克隆容器会随 DOM 变动无限增长，直接把客户端卡死 |
| 不做常驻 `MutationObserver`，只在右键后开短窗口 | 聊天是流式的，全局观察器会在每个 token 上触发 |
| 用 `role="menuitem"` 判断「是不是容器」，不数子节点 | 数个数会把图标复杂的正常条目挡掉，注入晚 1 秒 |
| 剪贴板走 `workbuddyDesktop.clipboard.writeText` | 裸 IPC 通道名不存在时**不报错**，只返回 `{__wbError:true}`，会把失败伪装成成功 |

完整过程写在 [docs/REVERSE-ENGINEERING.md](docs/REVERSE-ENGINEERING.md)。

### 两种运行方式

注入器是同一个，区别只在「谁把它跑起来」：

| | 便携版（默认，安装器用这个） | 扩展版（可选） |
| --- | --- | --- |
| 谁在跑 | 后台常驻进程，开机自启 | 宿主 fork 的扩展 service |
| 要装进 WorkBuddy 目录 | 不用 | 要（可能要管理员） |
| 要打开侧栏面板 | 不用 | **要，否则 service 不启动** |
| 装法 | `一键安装.cmd` | `一键安装.cmd --with-panel` 或 `node bin/install.mjs` |

因为扩展版必须先点开一次侧栏面板才会启动，对普通用户太绕，所以默认走便携版。
两种都装也不会打架 —— 注入脚本有 `window.__dshCopySessionMenu` 这个互斥守卫。

## 命令行（给要折腾的人）

安装器也能直接用，参数一样：

```bash
node bin/setup.mjs                  # 安装 / 修复
node bin/setup.mjs --status         # 看状态（会顺手拉起挂掉的注入器）
node bin/setup.mjs --uninstall      # 卸载
node bin/setup.mjs --port 9444      # 换端口
node bin/setup.mjs --no-autostart   # 不设开机自启
node bin/setup.mjs --no-restart     # 装完不重启客户端
node bin/setup.mjs --with-panel     # 顺便装侧栏面板
```

老开关还在（不装便携版、只用扩展时）：

```bash
node bin/context-menu.mjs enable | disable | launch | status [端口]
node bin/install.mjs [--root <WorkBuddy目录>] [--uninstall]
```

## 风险与边界

| 项 | 说明 |
| --- | --- |
| **端口暴露** | CDP 只绑 `127.0.0.1`，但本机任何进程都能连上来控制工作台。不需要时请卸载。 |
| **升级可能失效** | 宿主改菜单 DOM 结构或文案，菜单项可能不出现。改 `extension/inject/session-menu.js` 里的选择器即可。 |
| **客户端升级会清掉扩展** | 扩展版会被 `resources/` 整体替换；便携版不受影响，但建议升级后重跑一次安装器确认。 |
| **只在 Windows 有** | WorkBuddy 客户端目前只有 Windows 版；`.lnk`、`tasklist`、`HKCU` 也都是 Windows 专有。 |
| **不影响宿主稳定性** | 注入脚本全程 try/catch，找不到目标就什么都不做；注入器连不上就静默重试。 |

## 开发

```bash
WORKBUDDY_MENU_INJECT=off node --test test/*.test.mjs   # 单测（必须带这个变量）
node tools/verify.mjs --port 9333                       # 真机验收：真实右键 + 点击 + 读剪贴板
node tools/pack.mjs                                     # 打 zip
```

改完 `extension/server/*.cjs` 或 `extension/inject/*.js` 记得重跑安装器 —— 运行时是
**复制**到 `~/.workbuddy/session-menu/app/` 的，改仓库文件不会自动生效。

细节见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档

| 我想… | 读这篇 |
| --- | --- |
| 出了问题 | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) |
| 改代码 / 看懂分层 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 查 CDP 通道、菜单 DOM、IPC 名字 | [docs/PROTOCOL.md](docs/PROTOCOL.md) |
| 知道为什么不能做成官方扩展 | [docs/REVERSE-ENGINEERING.md](docs/REVERSE-ENGINEERING.md) |
| 看每个版本改了什么 | [CHANGELOG.md](CHANGELOG.md) |

完整索引：[docs/README.md](docs/README.md)

## License

MIT
