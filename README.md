# WorkBuddy 工具集

> 三个扩展，补齐 WorkBuddy 桌面客户端缺的会话能力：**聚合、定位、找回**。

WorkBuddy 的会话其实存在两处：本地的 `~/.workbuddy/projects/<项目>/<会话>.jsonl`，和云端（网页版、小程序、定时任务里跑过的对话）。桌面客户端只看得到前者；要用某个会话的 ID，还得自己翻文件名找 UUID。

这三个工具把缺口补上。都不改宿主程序的文件、不需要管理员权限、也不用单独装 Node —— 直接复用 WorkBuddy 自带的 Electron 运行时。

| 包 | 做什么 | 形态 |
| --- | --- | --- |
| [`session-bridge`](packages/session-bridge) | 侧栏「会话桥」：本地与云端会话聚合到一处，点开接着问；附迁移 CLI `dsh2wb` 与技能包 | 桌面扩展 |
| [`copy-session-id`](packages/copy-session-id) | 右键会话 → 复制 Session ID，一步进剪贴板 | CDP 注入的小扩展 |
| [`cloud-sessions`](packages/cloud-sessions) | 云端会话全文查看、跨会话搜索、Markdown 导出 | 桌面扩展 + 本地服务 |

## 怎么做到的

- **不改宿主文件**：扩展用 `ELECTRON_RUN_AS_NODE=1` 复用客户端自带的 Node 运行时，安装和卸载只增删自己的目录。
- **右键菜单**：借宿主已经开着的 CDP 调试端口做注入，脚本带幂等守卫，重复挂载不会叠菜单。
- **云端会话**：客户端把 `DesktopCloudTaskEntry` 这个开关在打包时写死成 `false`，所以侧栏从不请求云空间；这里用你自己的登录态走 ACP 协议回放，正文只落本机。
- **只读**：不写 `workbuddy.db`、不改 `app.asar`、不往任何服务器传数据。

每个包的 README 里有完整的安装、卸载与排错说明；`docs/` 下是协议与互操作性分析笔记。

## 目录

```
packages/
  session-bridge/    # 会话桥 + dsh2wb + 技能包
  copy-session-id/   # 右键菜单注入
  cloud-sessions/    # 云端会话回放
```

## 测试

```
cd packages/session-bridge   && node --test test/*.test.mjs
cd packages/copy-session-id  && node --test test/*.test.mjs
cd packages/cloud-sessions   && node test/service-acp.js
```

CI 在 Windows runner 上跑前两个（宿主是 Windows 客户端，`.lnk`、`tasklist`、`HKCU` 都是 Windows 专有），在 Linux 上跑第三个的静态检查和服务自测。

## 安装

各包的 Release 里有一键安装 zip，下载解压后双击 `一键安装.cmd` 即可。

## License

MIT
