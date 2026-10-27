#!/usr/bin/env node
/**
 * 常驻注入器（便携版）。
 *
 * 和扩展版的关系：两者用的是同一套注入器（extension/server/menu-inject.cjs）
 * 和同一份配置（~/.workbuddy/session-menu/menu-inject.json），区别只在「谁把它跑起来」。
 *
 *   - 扩展版：宿主 fork service。缺点是必须点开一次侧栏面板 service 才会启动，
 *     而且要把扩展拷进 WorkBuddy 安装目录（可能需要管理员）。
 *   - 便携版：这个脚本自己常驻，开机自启，不依赖宿主、不往安装目录写文件。
 *
 * 安装器默认用便携版。它由 WorkBuddy 自带的 Electron 当 Node 跑
 * （ELECTRON_RUN_AS_NODE=1），所以用户不需要另外装 Node.js。
 *
 * 手动跑：node bin/daemon.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { stateDir, pidFile, readPid, isAlive } from "./pid.mjs";

const require = createRequire(import.meta.url);
const { MenuInjector } = require("../extension/server/menu-inject.cjs");

const dir = stateDir();
const logFile = path.join(dir, "menu-inject.log");
const pid = pidFile();

/** 抢独占锁：开机自启和手动启动撞在一起时，只让一个跑起来。 */
function claim() {
  const existing = readPid(pid);
  if (existing) return { ok: false, pid: existing };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(pid, String(process.pid), { flag: "wx" });
    return { ok: true };
  } catch (error) {
    if (error.code === "EEXIST") return { ok: false, pid: readPid(pid) };
    throw error;
  }
}

function release() {
  try {
    if (Number(fs.readFileSync(pid, "utf8").trim()) === process.pid) fs.unlinkSync(pid);
  } catch {
    /* 文件可能已经被删 */
  }
}

const lock = claim();
if (!lock.ok) {
  console.log(`已经有注入器在跑了（PID ${lock.pid || "?"}），这次不重复启动。`);
  process.exit(0);
}

const injector = new MenuInjector({ logFile });
injector.start();

const status = injector.status();
console.log(`注入器已启动（PID ${process.pid}）`);
console.log(`  端口 ${status.port || "未配置"}（来源 ${status.portSource}）`);
console.log(`  日志 ${logFile}`);

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    injector.stop();
    release();
    process.exit(0);
  });
}
process.on("exit", release);
