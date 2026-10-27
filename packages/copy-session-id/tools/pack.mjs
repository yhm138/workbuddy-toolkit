#!/usr/bin/env node
/**
 * 打发布包：dist/workbuddy-session-menu-v<版本>.zip
 *
 * 包里只放「用户双击就要用的东西」：四个 .cmd、运行时、扩展目录、说明。
 * 文档、测试、CI 配置不进包——它们只对改代码的人有用。
 *
 * 用法：node tools/pack.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const VERSION = PKG.version;
const NAME = `workbuddy-session-menu-v${VERSION}`;
const DIST = path.join(ROOT, "dist");
const STAGE = path.join(DIST, "stage", NAME);

const FILES = [
  "一键安装.cmd",
  "install.cmd",
  "一键卸载.cmd",
  "检查状态.cmd",
  "使用说明.txt",
  "README.md",
  "LICENSE",
  // setup.mjs 要读它取版本号；少了这一步装到一半会 ENOENT
  "package.json",
];
const DIRS = ["bin", "extension"];

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function main() {
  rmrf(path.join(DIST, "stage"));
  fs.mkdirSync(STAGE, { recursive: true });

  for (const rel of FILES) {
    const from = path.join(ROOT, rel);
    if (!fs.existsSync(from)) throw new Error(`缺文件：${rel}`);
    fs.copyFileSync(from, path.join(STAGE, rel));
  }
  for (const rel of DIRS) {
    fs.cpSync(path.join(ROOT, rel), path.join(STAGE, rel), { recursive: true });
  }
  // 包里不需要的东西：本地人的 build 产物
  for (const junk of ["bin/VERSION", "extension/ui/index.html.bak"]) {
    rmrf(path.join(STAGE, junk));
  }

  const zip = path.join(DIST, `${NAME}.zip`);
  rmrf(zip);
  // Node 没有内置 zip，Windows 上用系统的 Compress-Archive。
  // -Force 覆盖；-CompressionLevel Optimal 就够，包很小。
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Compress-Archive -Path '${STAGE}' -DestinationPath '${zip}' -CompressionLevel Optimal -Force`,
    ],
    { stdio: "inherit", windowsHide: true }
  );

  const size = fs.statSync(zip).size;
  const count = (function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => {
      const p = path.join(dir, e.name);
      return n + (e.isDirectory() ? walk(p) : 1);
    }, 0);
  })(STAGE);

  console.log(`✓ ${path.relative(ROOT, zip)}  ${(size / 1024).toFixed(1)} KB  ${count} 个文件`);
  console.log(`  解压后文件夹：${NAME}`);
}

main();
