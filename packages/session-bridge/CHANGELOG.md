# 更新记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## Unreleased

### 修复

- **「标记未读」点完当场看不到圆点**：db 写进去了、`wb:conversations:list`
  也立刻返回 `unread:true`，但宿主侧栏用的是自己的渲染状态，要等下一次刷新才
  读得到（实测过一阵才冒出圆点）。现在注入脚本在点击成功后直接补一个圆点：
  优先克隆宿主现成的 `_unreadDot_` 节点、样式完全一致；标记已读则只把圆点
  `display:none`，不删 React 管的节点。db 状态仍是真的，重启或列表刷新后宿主
  会自己画正式的。`window.__dshCopySessionMenu.paint(id, want)` 可手动调用排查。
- 顺带让 `stop()` 摘掉 pointer 监听器，热更新时新旧两套监听不会叠在一起。

## 1.3.0 — 2026-11-07

右键菜单和会话桥面板都能「标记已读 / 标记未读」；顺带把客户端升级后
「复制 Session ID」失效的问题修了。

### 新增

- **标记已读**：走宿主官方通道 `wb:conversations:markRead`，内部会
  `setUnread(id, false)` + `emitConversationChanged`，列表圆点立即消失。
- **标记未读**：宿主 daemon 根本没注册 `wb:conversations:markUnread`
  （`createConversationsApi` 里那个只给后台任务完成时用，MethodChannel 没暴露），
  实测调过去返回 `[MethodChannel] no handler for channel`。所以由 service 用
  Node 22 内置的 `node:sqlite` 直写 `sessions.unread = 1`，再借一个无关已读会话的
  `markRead` 触发 `listChanged`，让刚写进去的状态立刻在侧栏显示。
- **两个入口**：宿主会话右键菜单（与「复制 Session ID」并排；渲染进程够不着磁盘，
  走 CDP `Runtime.addBinding` 回调到 service）；会话桥面板的右键菜单和详情页按钮，
  列表行显示「未读」标记，状态来自新方法 `unreadState`。
- `markRead` / `markUnread` / `unreadState` 都进了文件队列白名单，命令行同样能调。
- 新增 14 例单测（db 读写、假成功判定、借道刷新、binding 链路），全量 91 例；
  面板 E2E 补了「未读 → 已读 → 未读」的完整流程。

### 修复

- **客户端升级后「复制 Session ID」失效**：5.9.x 整包升级会重装
  `Public\Desktop` / `ProgramData` 下的快捷方式，调试参数被抹掉；这两处普通权限又
  改不动（`EPERM`），只剩 `WORKBUDDY_REMOTE_DEBUGGING_PORT` 环境变量。而它走的是
  宿主 JS 里的 `appendSwitch`，时机晚于 Chromium 建立调试服务器——实测主进程不绑
  端口，只有后 fork 的 renderer 子进程命令行里带着参数（2026-11-06 复现）。
  `enable` 现在会在**用户自己的桌面**新建一份带参数的
  `WorkBuddy (Session ID).lnk`（普通权限可写、升级抹不掉），`disable` 会收掉它；
  环境变量改为同步成同一个端口并保留，不再清掉。`status` 单独显示这个入口。
- `status` 把桌面图标误列进「系统级快捷方式」，以及「环境变量重复，建议删一个」
  这句与新策略矛盾的提示，一并修掉。
- 新增 7 例用户桌面快捷方式测试（写进去能读回、重复跑不重写、换端口不留旧值、
  自定义参数不覆盖、非法端口不落文件、能删、默认路径不在 Public），全量 77 例。

## 1.2.0 — 2026-11-05

宿主的 `wb:conversations:*` 一直只能靠读源码猜参数。这次把 edge-sync 那份绑定表搬进面板：
第三个标签「宿主通道」列 31 条，点一条填参数就能调，返回原样打出来。

### 新增

- **面板「宿主通道」页**：左侧按 读取 / 配置 / 写入 分组列出 31 条通道，
  右侧填位置参数（JSON 数组）直接透传，返回原样显示，带耗时、体积、复制按钮。
- **`hostChannels` / `hostInvoke` 两个 service 方法**，也进了文件队列白名单，
  命令行同样能调：`wb-call hostInvoke --payload '{"channel":"list","args":[]}'`。
- 通道详情里可以下拉选一个本机会话，模板里的 `<会话ID>` 自动替换成真实 ID。

### 取舍

- 只放行 **16 条**：8 条只读 + 8 条 `configSet*`。剩下 15 条（`create` / `delete` / `fork` /
  `rename` / `move` / `pin` / `archive` / `sendPrompt` / `cancel` / `resolvePending` …）
  只展示不放行，按钮是灰的，点开写明原因。这个面板是调试台，不是遥控器。
- 参数按位置透传，不做字段名映射。`configWb` 那套「四种形态依次试」留给自己用；
  这一页是「我知道我要传什么」的场景，猜字段只会让人看不清到底传了什么。
- 返回超过 200 KB 截断并标记，避免把整段会话正文塞进 `#hostOut`。

### 修复

- `test/panel_test.py` 两处断言还在比对旧的假数据 ID（`session-a1b2c3d4-0004-…`），
  与 `test/panel.html` 里的 `session-22222222-…` 对不上，一直是红的。已对齐。

### 顺带

- 面板版本号跟着清单走，`extension.json` / `distribution.json` / `package.json` 同步到 1.2.0。

## 1.1.0 — 2026-10-28

WorkBuddy 5.9.x 起，客户端升级会**整体替换 `resources/`**，装在那儿的 bundled 扩展跟着被清掉。
这次更新就是对着这件事：留一份稳定副本，再放一个守着它的进程，升级后自己把面板补回来。

### 新增

- **`bin/guard.mjs` 自愈守护**：`~/.workbuddy/dsh-skills/store/<id>` 留一份副本，每 2 秒看一次
  扩展目录。客户端升级把目录清掉、还没重新启动的那几秒里，守护正好把扩展拷回去。
  客户端正开着且版本对不上时不动文件——宿主按启动快照取文件，运行期换必然加载失败。
  目录整个没了则可以补：这次启动根本没加载过它。
- **开机自启**：往「启动」文件夹放一个 `WorkBuddySessionBridgeGuard.vbs`，登录时静默拉起守护。
  路径用 `%USERPROFILE%` 拼，用户名带中文也不会乱码；不想用了删掉这个文件即可
  （Win+R → `shell:startup`）。
- **`guard.mjs --status` / `--once` / `--add` / `--remove`**：命令行排查，以及把别的扩展
  一起纳进自愈名单（云端会话就是这么登记的）。
- `检查状态.cmd` 多一行「升级自愈」，直接看守护在不在跑、store 里是什么版本。

### 修复

- **备份不再写进扩展目录**。旧版把已装的扩展改名成 `dsh-session-bridge.bak-<时间戳>` 留在原地，
  而宿主校验「目录名必须等于清单里的 id」，这些目录每次启动都被当非法扩展扫一遍。
  现在备份放 `~/.workbuddy/dsh-skills/backups/`。

### 为什么不直接把扩展放进宿主的用户扩展目录

`~/.workbuddy/extensions` 和 `extensions-dev` 确实会被扫描，但这两处的 `distribution.json`
不被信任：权限被降级成空的 platform，`service` 也不许 fork（`includeExtension` /
`allowService` / `allowDiskDistribution` 三处是一致的判断）。装进去只有一个空壳面板，
所以只能守着会被升级清掉的 bundled 目录。

### 已知限制

- 守护需要一个 Node 运行时：优先用 WorkBuddy 自带的
  `~/.workbuddy/binaries/node/versions/*/node.exe`，没有才退回 PATH 里的 `node`。
- 如果升级安装比 2 秒轮询还快，会晚一轮补上——下次启动前一定补好，只是那次要再重启一次。

## 1.0.0 — 2026-10-26

一键安装版。0.1.0 要「装 Node → `build` → `install` → `install-extension` → 重启 → 打开一次侧栏面板」，
六道坎，最后一道命令行根本代劳不了。这次把安装路径整体换掉，并把仓库里的真实信息清干净。

### 新增

- **`一键安装.cmd` / `一键卸载.cmd` / `检查状态.cmd`**：双击就完事
- **`bin/setup.mjs`**：找 WorkBuddy → 装扩展 → 装 7 个技能 → 重启 → 等 `ping` 返回。
  只有真的等到服务回话才说「装好了」，没通就直说卡在哪一步。重复跑等于修复，旧版本自动备份成 `*.bak-<时间戳>`
- **`dsh2wb.cmd`**：命令行入口，同样不需要装 Node
- **`~/.workbuddy/dsh-skills/install.json`**：安装记录。卸载按它删，只删自己装的那些
- **发版链路**：`tools/pack.mjs` 打 zip、`tools/release-notes.mjs` 生成小白版正文、
  `.github/workflows/release.yml` 打 tag 自动跑测试 → 打包 → 发 Release

### 修复

- **不需要先点开侧栏面板**。之前文档和技能里都写着「service 是点开面板才 fork 的」，
  实测不对：宿主在客户端启动时就 fork 了。安装器现在直接等到 `ping` 通为止，用户少一步
- **安装器绝不自动重启客户端**。非交互运行时（脚本、CI、另一个 AI 调用）一律不关窗口——
  之前 `ask()` 在无终端时返回默认值 `true`，等于替用户点「是」
- **`test/service.test.mjs` 不再写死版本号**，改成读 `extension/extension.json`，发版不用再改测试

### 安全 / 隐私

- 仓库不再包含任何真实截图（4 张面板截图里有真实会话标题和项目路径），配图改成手画 SVG
- 文档、测试夹具里的真实会话 UUID 全部替换成示例值
- `test/panel.html` 的假数据改成明显虚构的名称和路径；`test/panel_test.py` 的浏览器路径改读环境变量，
  截图写进 `.probe/`（不入库）
- 技能清单里的作者名换成项目名，补上 homepage / repository
- CI 新增两道闸：不许有 `.png/.jpg` 等位图、不许出现本机绝对路径

### 工程

- `src/core/wb.mjs`：把「找 WorkBuddy 装在哪」抽出来，安装器与 `install-extension` 共用一份判断
- `.cmd` 内容一律纯 ASCII（`cmd.exe` 按 GBK 逐字节解析），中文提示全在 Node 脚本里

## 0.1.0 — 2026-10-25

首个可运行版本。三个交付物：侧栏扩展「会话桥」、7 个技能包、迁移 CLI `dsh2wb`。

### 新增

**侧栏扩展「会话桥」**

- guest 桥 10 秒协商、两跳 Local RPC（`$resolveLocalRpc` → `$invokeLocalRpcFallback`）
- DSH MCP 客户端（`127.0.0.1:8790/mcp`），DSH 没开时降级读磁盘会话
- 会话面板：DSH 会话 / WorkBuddy 会话两个来源，右键菜单代替快取条
- WorkBuddy 会话之间也能新建与双向对话（`conversations create / sendPrompt / requests`）
- 投递模式由 `queueDelivery` 决定，支持 **Steering**（插进正在跑的轮次）
- 本地 Codex / Claude 会话接入

**会话菜单注入「复制 Session ID」**

> 这部分在工具集里是 [`packages/copy-session-id`](https://github.com/yhm138/workbuddy-toolkit/tree/main/packages/copy-session-id)。

- 会话右键菜单补一项「复制 Session ID」，复制完整 UUID
- 借宿主留给自动化测试的 CDP 调试端口，在渲染进程里补 DOM 节点
- 不克隆菜单容器、不用全局 MutationObserver、剪贴板走 preload 暴露的对象
- 注入脚本暴露 `state` 快照（`pendingId` / `armRemainMs` / `lastInsert` / `lastReject`）

**技能包（7 个）**

- Token 用量与人民币计费（按天/模型/会话，带缓存命中率）
- 历史会话全文检索（中文、正则、按工作区与时间过滤）
- 单轮次时间线还原（用户消息、回复、推理字数、工具调用）
- DSH 配置盘点与迁移体检
- 会话操作路由（默认 WorkBuddy 原生会话，而不是往 DSH 派活）

**CLI `dsh2wb`**

- profile 三层叠加解析 + DSH→WorkBuddy 映射表
- `inspect` / `build` / `install` / `doctor` 四条命令
- `wb-call`：用文件队列把宿主通道（`wb:conversations:*`）暴露给命令行
- `bridge-test`：一条命令跑完 WorkBuddy 会话间双向通信验收
- `copy-id`：把当前会话 ID 一步放进剪贴板
- `wb-session`：回放某个 WorkBuddy 会话

### 修复

- **复制 Session ID 提示成功但剪贴板是空的**：宿主的 `__wbInvoke` 在通道不存在时
  **不 reject**，而是 resolve `{__wbError:true, code:4001}`，`try/catch` 永远进不去，
  后面两条兜底从未执行
- **关了客户端再打开，菜单项就没了**：`enable` 无条件清环境变量，而快捷方式因
  `EPERM` 没改成，等于把开端口的途径全删了。1.0.0 起改成只有全部改成功才清
- **注入项要 700~1400ms 才出现**：「克隆体子节点数 > 8 就放弃」的守卫把正常条目
  也挡掉了，改用 `role="menuitem"` 判容器后降到 120ms
- **右键后客户端卡死**：早期用全局 MutationObserver + 把菜单容器当行容器克隆，
  节点无限增长
- **环境变量开端口有时灵有时不灵**：`appendSwitch` 晚于 Chromium 初始化，
  改走启动参数
- **service 读不到端口**：daemon fork 的 service 拿不到用户级环境变量，
  加配置文件作为第二条通道
- `requestsWb` 按「请求」展开 user/assistant 两条消息
- 识别并折叠 DSH 注入的 runtime context / skill 提醒 / 时间采样，避免当真人发言显示
- 面板展开子 agent 后显示「已显示 0 条」——`hidden` 归零时要自己数行
- `.cmd` 只留纯 ASCII（`cmd.exe` 按 GBK 解析，UTF-8 中文会被拆成非法命令）

### 工程

- 55 个测试：CDP 协议层真 WebSocket、注入脚本静态约束、`.lnk` 二进制往返、
  YAML 子集解析、service fake MCP、面板 E2E
- `.probe/` 与 `.workbuddy/` 不入库（本地运行产物与工作记忆）
- 安装流程会校验 `cdp` / `menu-inject` / `inject` 脚本是否都在位

### 已知限制

- 配置复原度 67/100（15 个 DSH bundle 中，原生等价 8 · 本包补齐 6 · 部分覆盖 7 ·
  需手动 2 · 不可移植 3），明细见 `docs/parity-report.md`
- 「置顶空间」做不了：宿主没有 `pinWorkspace` 之类的接口，空间分组按活跃时间排序
- 客户端升级会整体替换 `resources/`，bundled 扩展需要重新安装
