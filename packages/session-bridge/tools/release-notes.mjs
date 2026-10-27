#!/usr/bin/env node
/**
 * 生成 Release 页面正文：先给普通用户看的三步安装，后面接 CHANGELOG 里对应版本那一段。
 *
 * 为什么不用 `gh release create --generate-notes`：它只会罗列 commit，
 * 对下载 zip 的人没有一句有用的话。
 *
 * 用法：node tools/release-notes.mjs            # 打到标准输出
 *       node tools/release-notes.mjs > notes.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const TAG = process.env.GITHUB_REF_NAME || `v${VERSION}`;
const ZIP = `port-dsh-to-workbuddy-${TAG.startsWith('v') ? TAG : `v${TAG}`}.zip`;

const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const start = changelog.indexOf(`## ${VERSION}`);
const rest = start >= 0 ? changelog.slice(start) : '';
const next = rest.indexOf('\n## ', 3);
const section = (next > 0 ? rest.slice(0, next) : rest).trim();

const install = `## 装（1 分钟，不用装 Node.js）

1. 下载下面的 **\`${ZIP}\`**
2. 解压到任意位置（桌面也行），双击 **\`一键安装.cmd\`**
3. 弹出「是否允许此应用对你的设备进行更改」，点 **是**（没有就跳过）
4. 装完问要不要重启 WorkBuddy，**直接按回车**

重启后左侧栏多出一个 **「会话桥」**，点开就能看到你所有的会话。

- **没看到面板** → 双击 \`检查状态.cmd\`，它会告诉你卡在哪
- **不想用了** → 双击 \`一键卸载.cmd\`，再重启 WorkBuddy

> 需要 Windows + WorkBuddy 5.9.x 桌面版。不用装 Node.js（用的是 WorkBuddy 自带的运行时），
> 不改 WorkBuddy 本身的任何文件，只往扩展目录放一个文件夹。
> 装在 Program Files 下时才需要管理员权限。

---

`;

process.stdout.write(install + section + '\n');
