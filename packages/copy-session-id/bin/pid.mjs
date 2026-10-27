/**
 * 注入器进程的存活判断。
 *
 * 单独一个文件，是为了让安装器只读不写：daemon.mjs 一被 import 就会去抢锁、起注入器，
 * 安装器要读 PID 却不能把注入器拉起来。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function stateDir() {
  const home = process.env.WORKBUDDY_HOME || path.join(os.homedir(), ".workbuddy");
  return path.join(home, "session-menu");
}

export function pidFile() {
  return path.join(stateDir(), "daemon.pid");
}

/** PID 对应的进程还活着吗。EPERM 表示活着但不归我们管，也算活。 */
export function isAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** 读 PID 文件，进程已经不在就返回 0（顺手把残留的 PID 文件删掉）。 */
export function readPid(file = pidFile()) {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8").trim();
  } catch {
    return 0;
  }
  const pid = Number(raw);
  if (isAlive(pid)) return pid;
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
  return 0;
}

/** 同步 sleep，用来等进程退出。比 spawn 一个子进程去 sleep 干净。 */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
