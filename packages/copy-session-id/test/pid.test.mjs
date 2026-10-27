import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isAlive, readPid, sleepSync, stateDir, pidFile } from "../bin/pid.mjs";

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbsm-pid-"));
  return { dir, file: path.join(dir, "daemon.pid") };
}

test("isAlive：自己一定活着", () => {
  assert.equal(isAlive(process.pid), true);
});

test("isAlive：非法 PID 一律当成死的", () => {
  for (const bad of [0, -1, -9999, NaN, undefined, null, "abc", 1.5]) {
    assert.equal(isAlive(bad), false, `${bad} 不该被当成活进程`);
  }
});

test("readPid：文件里有活着的 PID 就返回它", () => {
  const { dir, file } = tempFile();
  try {
    fs.writeFileSync(file, String(process.pid));
    assert.equal(readPid(file), process.pid);
    assert.ok(fs.existsSync(file), "活进程的 PID 文件不该被删");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readPid：进程早就没了，顺手清掉残留的 PID 文件", () => {
  const { dir, file } = tempFile();
  try {
    // 999999 超出 Windows 的 PID 上限（约 2^22），一定不存在
    fs.writeFileSync(file, "999999");
    assert.equal(readPid(file), 0);
    assert.equal(fs.existsSync(file), false, "残留文件应该被清掉，否则下次启动会以为有人在跑");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readPid：文件不存在、或内容是垃圾，都返回 0 而不是抛异常", () => {
  const { dir, file } = tempFile();
  try {
    assert.equal(readPid(file), 0);
    fs.writeFileSync(file, "not-a-number");
    assert.equal(readPid(file), 0);
    fs.writeFileSync(file, "");
    assert.equal(readPid(file), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stateDir / pidFile 跟着 WORKBUDDY_HOME 走", () => {
  const old = process.env.WORKBUDDY_HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wbsm-home-"));
  try {
    process.env.WORKBUDDY_HOME = tmp;
    assert.equal(stateDir(), path.join(tmp, "session-menu"));
    assert.equal(pidFile(), path.join(tmp, "session-menu", "daemon.pid"));
  } finally {
    if (old === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = old;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("sleepSync 真的会阻塞", () => {
  const at = Date.now();
  sleepSync(120);
  assert.ok(Date.now() - at >= 100, "至少要睡够 100ms");
});
