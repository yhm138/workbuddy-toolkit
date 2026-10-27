#!/usr/bin/env node
/**
 * 打发布包：dist/port-dsh-to-workbuddy-v<版本>.zip
 *
 * 包里只放「用户双击就要用的东西」：四个 .cmd、运行时、扩展、技能。
 * 文档、测试、CI 配置不进包——它们只对改代码的人有用。
 *
 * 一个例外：context-menu.mjs / shortcut.mjs 那两个「复制 Session ID」的开关
 * 是上一版留下的，菜单注入现在归独立项目 workbuddy-session-menu 管。
 * 它们留在仓库里（开发时还能用），但不进给普通用户的包，免得界面上多出
 * 三个看不懂的 .cmd。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;
const NAME = `port-dsh-to-workbuddy-v${VERSION}`;
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'stage', NAME);

const FILES = [
  '一键安装.cmd',
  'install.cmd',
  '一键卸载.cmd',
  '检查状态.cmd',
  'dsh2wb.cmd',
  '使用说明.txt',
  'README.md',
  'LICENSE',
  // setup.mjs 要读它取版本号；少了这一步装到一半会 ENOENT
  'package.json',
];

const DIRS = ['bin', 'extension', 'skills-pack', 'src'];

/** 这些只对改代码的人有意义，不给下载的人。 */
const EXCLUDE = new Set([
  'bin/context-menu.mjs',
  'bin/shortcut.mjs',
  'bin/enable-context-menu.cmd',
  'bin/disable-context-menu.cmd',
  'bin/launch-with-copy-id.cmd',
]);

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });

function countFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((n, entry) => {
    const p = path.join(dir, entry.name);
    return n + (entry.isDirectory() ? countFiles(p) : 1);
  }, 0);
}

function main() {
  rmrf(path.join(DIST, 'stage'));
  fs.mkdirSync(STAGE, { recursive: true });

  for (const rel of FILES) {
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from)) throw new Error(`缺文件：${rel}`);
    fs.copyFileSync(from, path.join(STAGE, rel));
  }
  for (const rel of DIRS) {
    fs.cpSync(path.join(ROOT, rel), path.join(STAGE, rel), { recursive: true });
  }
  for (const rel of EXCLUDE) rmrf(path.join(STAGE, rel));

  // 装好的副本不该出现在包里（有人从装好的目录打的包）
  for (const entry of fs.readdirSync(path.join(STAGE, 'bin'))) {
    if (entry.includes('.bak-')) rmrf(path.join(STAGE, 'bin', entry));
  }

  const zip = path.join(DIST, `${NAME}.zip`);
  rmrf(zip);
  // Node 没有内置 zip，Windows 上用系统的 Compress-Archive。
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path '${STAGE}' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`,
    ],
    { stdio: 'inherit', windowsHide: true },
  );

  const size = fs.statSync(zip).size;
  const count = countFiles(STAGE);

  console.log(`✓ ${path.relative(ROOT, zip)}  ${(size / 1024).toFixed(1)} KB  ${count} 个文件`);
  console.log(`  解压后文件夹：${NAME}`);
}

main();
