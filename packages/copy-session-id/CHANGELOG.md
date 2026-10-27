# 更新记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## 1.0.0 — 2026-10-25

这版只解决一件事：**让不懂命令行的人也能装上**。

0.1.0 的路径是「装 Node.js → 跑 `install.mjs` → 跑 `context-menu.mjs enable` →
重启后打开一次侧栏面板」。四道坎，任何一道都能把人劝退，其中最后一道根本没法用
命令行代劳。

### 新增

- **一键安装**：解压 → 双击 `一键安装.cmd`，结束。不用装 Node.js
  —— `WorkBuddy.exe` 加上 `ELECTRON_RUN_AS_NODE=1` 就是一个完整的 Node 22，
  用户有 WorkBuddy 就有运行时。
- **便携版运行方式**（`bin/daemon.mjs`）：注入器改成开机自启的常驻进程。
  - 不往 WorkBuddy 安装目录写任何东西 → 普通权限就够
  - **不需要打开侧栏面板**。这是 0.1.0 最大的坑：扩展 service 要面板被打开过
    才会被 fork，没法自动化
- **`bin/setup.mjs`**：安装 / 修复 / 卸载 / 状态，带 `--port`、`--no-autostart`、
  `--no-restart`、`--with-panel`
- **`检查状态.cmd` 会自愈**：注入器被任务管理器结束了，它会自己拉起来
- **端口自动避让**：9333 被别的程序占着，就在 9333–9342 里挑一个空闲的
- **装完自检**：等端口、等注入器真的注入，然后才说「装好了」；没通就直说卡在哪
- **发布流程**：`tools/pack.mjs` 打包，打 tag 自动发 Release

### 修复

- **装完总是报「注入器还没说话」**：日志偏移用 `statSync().size`（字节）去切
  `readFileSync(..., "utf8")` 返回的字符串（UTF-16 码元）。日志全是中文，
  1 字符 3 字节，两种偏移差很远，切出来的永远是空串。

### 变更

- 默认不再安装侧栏面板。它是「可选的高级形态」，要就加 `--with-panel`
- README 重写：三步安装放最前，原理与踩坑挪到后面

## 0.1.0 — 2026-10-25

首次作为独立项目发布。此前这段代码内嵌在另一个扩展（会话桥）的 service 里，
下面记的是从零到现在踩过的实质问题，不是罗列提交。

### 新增

- 会话右键菜单注入「复制 Session ID」，复制完整 UUID
- 侧栏面板「会话菜单」：注入状态、端口来源、已连窗口数、诊断日志
- `bin/context-menu.mjs`：`enable` / `disable` / `status` / `launch` 四个子命令
- `bin/shortcut.mjs`：纯 Node 读写 Windows `.lnk`（不依赖 COM / WScript.Shell）
- `bin/install.mjs`：装进 WorkBuddy 的 bundled 扩展目录，带备份与 `--dry-run`
- 注入脚本暴露 `window.__dshCopySessionMenu.state`：`pendingId` / `armRemainMs` /
  `menuItems` / `lastReject`，排查不用再猜
- `WORKBUDDY_MENU_INJECT=off` 硬关开关，跑测试时用它避免连上真实客户端

### 修复

- **复制提示成功但剪贴板是空的**
  宿主的 `__wbInvoke` 在「没有对应 handler」时**不 reject**，而是 resolve
  `{__wbError:true, code:4001}`。原实现把它当成成功，后面两条兜底从未执行。
  改用 preload 直接暴露的 `workbuddyDesktop.clipboard.writeText()`；
  裸 IPC 降为备选且必须判 `__wbError`。

- **关了客户端再打开，菜单项就没了**
  `enable` 的「清环境变量」步骤是无条件执行的：快捷方式因权限（`EPERM`）没改成，
  变量又被删了，于是客户端启动时没有任何途径开端口。
  现在只有**所有快捷方式都改成功**才清变量；改不动就反过来写环境变量兜底。

- **注入项要 700~1400ms 才出现，几乎用满观察窗口**
  「克隆体子节点数 > 8 就放弃」这条守卫把图标节点多的正常条目也挡掉了。
  判「克隆到容器」的本质依据改成「克隆体里还套着 `[role="menuitem"]`」；
  同时让 `arm()` 先同步试一次。实测降到 120ms。

- **右键后客户端卡死**
  早期版本用全局 `MutationObserver` + 把菜单容器当行容器克隆，节点无限增长。
  改为「右键后短窗口轮询 + 只克隆单个 `menuitem` + 插入项数上限」。
  空闲开销归零。

- **环境变量开端口有时灵有时不灵**
  `appendSwitch` 的调用时机晚于 Chromium 初始化，只对子进程生效，
  且宿主会打一条「debugging enabled」的假成功日志。改走启动参数，无竞态。

### 工程

- 扩展 service 不引任何第三方依赖（`cdp.cjs` 手写 RFC6455），
  因为装进 `app.asar.unpacked` 后没有 `node_modules`
- 36 个测试：`.lnk` 二进制往返、CDP 握手、注入脚本静态约束、
  service 与命令行的配置路径一致性
- `.cmd` 一律纯 ASCII（`cmd.exe` 按 GBK 解析，UTF-8 中文会被拆成非法命令）
