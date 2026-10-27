# 参与开发

## 环境

Node.js 20.10+。项目**没有运行时依赖**，`npm install` 不是必须的——直接跑 `node` 就行。

```bash
git clone https://github.com/yhm138/workbuddy-toolkit.git
cd workbuddy-session-menu
node --test test/*.test.mjs
```

## 测试

```bash
node --test test/*.test.mjs          # 全量
node --test test/shortcut.test.mjs   # 单个文件
```

**跑测试务必带 `WORKBUDDY_MENU_INJECT=off`**：

```bash
WORKBUDDY_MENU_INJECT=off node --test test/*.test.mjs
```

原因：`menu-inject.test.mjs` 会起真实 WebSocket 验证协议层。不带这个变量时，
测试进程可能通过环境变量拿到本机端口，连上**你正在用的客户端**去操作真实菜单。

测试里不需要宿主、不需要 WorkBuddy 在跑。涉及真实客户端的验证只能手工做（见下）。

## 改完代码怎么生效

这一步最容易漏，漏了会以为「改了没用」：

| 改了什么 | 要做什么 |
| --- | --- |
| `extension/**`（注入脚本、注入器）、`bin/**` | `node bin/setup.mjs` → 托盘退出重开客户端 |
| `extension/ui/**`、`extension/extension.json` | `node bin/install.mjs` → 托盘退出重开（只影响扩展版） |
| `docs/**` | 没影响 |

**为什么**：注入器跑的是**运行副本**，不是仓库里的文件。

```
仓库  extension/inject/session-menu.js
        ├─ setup.mjs   → ~/.workbuddy/session-menu/app/   （便携版读这里）
        └─ install.mjs → <WorkBuddy>/…/extensions/workbuddy-session-menu/  （扩展版读这里）
```

急着手动验一次、不想重启：

```bash
node tools/verify.mjs
```

它通过 CDP 把仓库里的 `session-menu.js` 直接 `Runtime.evaluate` 进当前页面，
只活到这次页面重载；然后真实右键一个会话、点菜单项、读回剪贴板，
一路断言到 PASS。**它会改掉你剪贴板的内容**，介意的话先备份。

## 打包与发版

```bash
node tools/pack.mjs                  # → dist/workbuddy-session-menu-v<版本>.zip
node tools/release-notes.mjs         # 预览 Release 正文
```

正式发版只需要打 tag：

```bash
git tag v1.0.0 && git push origin v1.0.0
```

`.github/workflows/release.yml` 会跑测试 → 打包 → 建 Release 并挂上 zip，
正文由 `tools/release-notes.mjs` 生成（开头是给普通用户看的三步安装）。

发版前记得同步版本号：`package.json`、`extension/extension.json`、
`extension/distribution.json`、`extension/server/index.cjs` 的 `VERSION`，
以及 `CHANGELOG.md` 新增一节。`test/setup.test.mjs` 会卡这几处不一致。

## 手工验收

自动化测试覆盖不到「宿主真实行为」，每次动注入脚本或剪贴板逻辑都要手工过一遍：

1. `node bin/setup.mjs --status` → 结论应是「一切正常」
2. 右键任意会话行 → 菜单里有「复制 Session ID」
3. 点它 → 弹「已复制」，剪贴板里是完整 UUID
4. 连点两次 → 菜单里仍然只有**一项**（不是两项）
5. 打开另一个会话的菜单 → 复制出来的是那个会话的 ID
6. 客户端不卡（节点数看 `window.__dshCopySessionMenu.state.marks`，应为 0 或 1）

第 4、6 条是防「卡死」那类回归的关键，别省。

## 代码约定

- **service 侧零依赖**。`extension/server/` 下不能出现 `require("ws")` 这类，
  装进 `app.asar.unpacked` 后没有 `node_modules`，会直接崩。
- **`.cmd` 纯 ASCII**。`cmd.exe` 按 GBK 逐字节解析，UTF-8 中文会被拆成非法命令。
  所有中文提示放 Node 脚本里。
- **注入脚本里不写死哈希类名**。宿主每次发版都会变。优先用语义类名
  （`.conversation-context-menu`）、`role`、`data-*` 属性，并留兜底。
- **新增任何 `__wbInvoke` 调用，必须判 `__wbError`**。它在通道不存在时不抛异常。
- **改动宿主结构相关的选择器，同步改 `docs/PROTOCOL.md`**。
  那份文档是「事实清单」，过时了比没有更糟。

## 提交信息

```
类型(范围): 做了什么

为什么这么做。踩过的坑、取舍、验证方式。
```

类型：`feat` / `fix` / `docs` / `refactor` / `test` / `chore`。

正文里值得写的东西：

- 症状和根因（尤其是「看起来是 A，其实是 B」的那种）
- 怎么验证的（命令、真机步骤）
- 放弃过什么方案、为什么

## 目录

```
一键安装.cmd 等          用户双击的入口
bin/                    命令行（安装器 + 便携注入器 + 开关）
extension/              扩展本体（扩展版会被整份复制到客户端）
  inject/               注入脚本（跑在渲染进程，两种模式共用）
  server/               注入器核心 + 扩展版 service
  ui/                   面板（iframe）
tools/                  打包 / Release 正文 / 真机验收
docs/                   见 docs/README.md
test/                   node --test
```
