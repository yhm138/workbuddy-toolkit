#!/usr/bin/env node
/**
 * 把 extension/ 装进 WorkBuddy。
 *
 * 为什么需要它：WorkBuddy 只认 `app.asar.unpacked/resources/extensions/` 下的
 * 目录（bundled 扩展，免签名）。装好之后宿主还要重启才会重新快照扩展清单。
 *
 * 用法：
 *   node bin/install.mjs                    自动找安装目录
 *   node bin/install.mjs --root "D:\\Software\\WorkBuddy"
 *   node bin/install.mjs --dry-run          只看计划
 *   node bin/install.mjs --uninstall        删掉已装的
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRoot, extensionsDir } from "./wb.mjs";

const EXT_ID = "workbuddy-session-menu";
const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, "..", "extension");

function arg(name, fallback = "") {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const DRY = process.argv.includes("--dry-run");
const UNINSTALL = process.argv.includes("--uninstall");

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
  const root = findRoot(arg("--root"));
  if (!root) {
    console.error("找不到 WorkBuddy 安装目录（没有 resources/app.asar.unpacked/resources/extensions）。");
    console.error('用 --root 指定，例如：node bin/install.mjs --root "D:\\Software\\WorkBuddy"');
    process.exit(1);
  }
  const dir = extensionsDir(root);
  const target = path.join(dir, EXT_ID);

  console.log(`WorkBuddy  ${root}`);
  console.log(`扩展目录   ${dir}`);

  if (UNINSTALL) {
    if (!fs.existsSync(target)) {
      console.log("没装，无需卸载。");
      return;
    }
    if (DRY) {
      console.log(`[dry] 会删除 ${target}`);
      return;
    }
    fs.rmSync(target, { recursive: true, force: true });
    console.log("✓ 已删除。托盘退出重开客户端后生效。");
    return;
  }

  if (!fs.existsSync(path.join(source, "extension.json"))) {
    console.error(`扩展源不完整：${source} 里没有 extension.json`);
    process.exit(1);
  }

  if (fs.existsSync(target)) {
    const backup = `${target}.bak-${stamp()}`;
    if (DRY) {
      console.log(`[dry] 会备份到 ${backup}`);
    } else {
      fs.renameSync(target, backup);
      console.log(`已备份旧版本 → ${backup}`);
    }
  }

  if (DRY) {
    console.log(`[dry] 会复制 ${source} → ${target}`);
    return;
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  console.log(`✓ 已安装到 ${target}`);
  console.log("");
  console.log("下一步：右下角托盘图标 → 右键 → 退出 WorkBuddy，再重新打开。");
  console.log("打开后点开一次侧栏「会话菜单」面板，service 才会被 fork。");
}

main();
