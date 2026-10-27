# 术语对照：Bundle / Extension / Plugin / Skill

这套东西名字容易混，混了就会写错目录、放错清单、或者以为"装个插件就能有侧栏面板"。这一页只做一件事：把每个词钉死到具体文件路径和字段上。

## 一张表

| 说法 | 归属 | 落盘位置 | 清单文件 | 有 UI | 有常驻进程 | 本仓库对应物 |
| --- | --- | --- | --- | --- | --- | --- |
| **Bundle** | DSH 专有 | `~/.dsh/profiles/desktop/*.yml` + `package.json` 的 `dsh.profile.bundles` | 无独立清单 | 视 bundle 而定 | 否，属于 DSH 进程内的插件行 | `docs/parity-report.md` 里那 15 行 |
| **Extension** | WorkBuddy 客户端 | `<WorkBuddy>/resources/app.asar.unpacked/resources/extensions/<id>/` | `extension.json` + `distribution.json` | ✅ iframe | ✅ `fork` 出来的 sidecar | `extension/`（id: `dsh-session-bridge`） |
| **Plugin** | WorkBuddy 插件体系 | `~/.workbuddy/plugins/…`（或任意目录 + 市场注册） | `.codebuddy-plugin/plugin.json`、市场用 `marketplace.json` | ❌ | ❌ | `skills-pack/plugins/dsh-skills` |
| **Skill** | WorkBuddy / CodeBuddy | `~/.workbuddy/skills/<name>/SKILL.md` | YAML frontmatter | ❌ | ❌ | `skills-pack/…/skills/*/SKILL.md` |
| **Connector** | WorkBuddy 连接器 | `~/.workbuddy/mcp.json` 等 | MCP 配置 | ❌ | 取决于服务 | `mcp.json` 里的 `dsh_local` |
| **MCP** | 协议 | — | — | — | 取决于实现 | DSH 的 `dsh-as-mcp`：`127.0.0.1:8790/mcp` |

## Bundle ≠ Extension（最容易错的一处）

一开始把需求理解成"用 Bundle 复原 DSH 配置"，于是做了一份"技能包 + 本地插件市场"。方向是对的（那确实是 WorkBuddy 的插件层），但**真需求要的是侧栏面板**，而面板在 WorkBuddy 里只有 Extension 能给。

区别是硬性的：

* **Bundle** 是 DSH 的概念：`cordis.yml` 里的一行插件，跑在 DSH 进程里，加载方式由 DSH 决定。它能带 UI，是因为 DSH 允许插件往自己的前端注入。
* **Extension** 是 WorkBuddy 的概念：**独立的清单 + 独立的进程 + 独立的 iframe**。`extension.json` 描述"面板长什么样、service 入口在哪"，`distribution.json` 描述"谁能装、给什么权限、怎么调度进程"。它是宿主级别的东西，不走插件市场。

所以迁移 DSH 的 **配置**（模型、权限、语言）和迁移 DSH 的 **UI**（侧栏、会话树、命令面板）是两件事：前者能用设置 + 技能对齐，后者只能重写成 Extension，或者承认搬不过去。

## `distribution.json` 里的几个字段

```json
{
  "kind": "builtin",
  "status": "active",
  "grantedPermissions": ["*"],
  "processPolicy": { "server": "fork", "renderer": "iframe" }
}
```

* **`kind`**：只有 `"builtin"` 才真正出现在侧栏。写在 `extensions/` 目录下不等于会显示——`kind` 和 `status` 都要对。
* **`status`**：`"active"`；其它值等于装了个不启动的目录。
* **`processPolicy.server`**：`"fork"` 表示宿主 fork 一个 Node 子进程跑 `service.entry`。
* **`processPolicy.renderer`**：`"iframe"` 是渲染方式；另一个合法值是 `"mf"`（Module Federation）。**本仓库用 iframe**，因为要做的是独立小面板，不需要和宿主共享 React 运行时。
* **`grantedPermissions`**：`["*"]` 只为省事——这是个本机自用扩展。对外分发时应收窄。

注意 `kind` 与 `renderer` 是两个正交维度：`kind` 决定"要不要进侧栏"，`renderer` 决定"用 iframe 还是 MF 渲染"。它们不影响 `EXTENSION_BUNDLE_ID`——那是 macOS 分享扩展的环境变量，和 WorkBuddy 的 Extension 完全无关，别被同名带跑。

## 为什么技能还要留着

Extension 解决"看和点"，不解决"Agent 会不会做"。比如"这个月 DSH 花了多少钱"——面板不需要为它加个标签页，Agent 需要一个能跑脚本的技能就够了。

判断标准：

* 需要**人反复点**的 → Extension（复制 ID、切换会话、发消息）
* 需要**Agent 自己判断**的 → Skill（出账、检索、还原时间线、体检）
* 两者都需要的 → 技能提供脚本，面板调用 service，service 和技能共用同一套读盘逻辑（本仓库的 `scripts/lib/session-store.mjs` 就是共享层）

## 顺带澄清

* **`~/.workbuddy/` 不是缓存目录**，里面是技能、插件、连接器配置、市场注册、会话数据。清理工具不要动它。
* **`.workbuddy/`（项目内）** 是该项目的元数据目录，也不是缓存。
* **`.codebuddy-plugin/marketplace.json`** 是"市场"清单，`plugin.json` 是"插件"清单；只装一个插件不需要市场，市场是为了让别人一条命令装到你。
