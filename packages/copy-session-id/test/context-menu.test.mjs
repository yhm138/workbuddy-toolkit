import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parsePort, findExe, DEFAULT_PORT, VAR, writeConfig, readConfigPort, clearConfig, configPath } from "../bin/context-menu.mjs";

/**
 * bin/context-menu.mjs 是 .cmd 的实际执行体（.cmd 里不能写中文，原因见文件头）。
 * 这里只测纯函数，不触碰注册表：环境变量的读写留给真机手工验。
 */

test("parsePort：不给参数时用默认端口", () => {
  assert.equal(parsePort(), DEFAULT_PORT);
  assert.equal(parsePort(""), DEFAULT_PORT);
  assert.equal(parsePort(null), DEFAULT_PORT);
  assert.equal(parsePort(9222), 9222);
});

test("parsePort：合法端口原样转成数字", () => {
  assert.equal(parsePort("9222"), 9222);
  assert.equal(parsePort(" 9333 "), 9333);
  assert.equal(parsePort("1"), 1);
  assert.equal(parsePort("65535"), 65535);
});

test("parsePort：非法输入一律返回 null", () => {
  for (const bad of ["0", "-1", "65536", "abc", "9222a", "12.5", "0x10"]) {
    assert.equal(parsePort(bad), null, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test("变量名与宿主主进程里的开关一致", () => {
  // 客户端 main/index.js 读的就是这个名字，改错会静默失效
  assert.equal(VAR, "WORKBUDDY_REMOTE_DEBUGGING_PORT");
});

test("findExe：优先用 WORKBUDDY_EXE 指定的路径", () => {
  const prev = process.env.WORKBUDDY_EXE;
  process.env.WORKBUDDY_EXE = process.execPath; // 一定存在的文件，代替 WorkBuddy.exe
  try {
    assert.equal(findExe(), process.execPath);
  } finally {
    if (prev === undefined) delete process.env.WORKBUDDY_EXE;
    else process.env.WORKBUDDY_EXE = prev;
  }
});

test("findExe：路径不存在时不返回幽灵路径", () => {
  const prev = process.env.WORKBUDDY_EXE;
  process.env.WORKBUDDY_EXE = "Z:\\nope\\WorkBuddy.exe";
  try {
    const got = findExe();
    assert.notEqual(got, "Z:\\nope\\WorkBuddy.exe");
    if (got !== null) assert.ok(got.toLowerCase().endsWith("workbuddy.exe"));
  } finally {
    if (prev === undefined) delete process.env.WORKBUDDY_EXE;
    else process.env.WORKBUDDY_EXE = prev;
  }
});

test("配置文件：写进去能读出来，删掉就回到未启用", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cfg-"));
  const file = path.join(dir, "menu-inject.json");
  try {
    assert.equal(readConfigPort(file), null, "还没写时应视为未启用");

    writeConfig(9333, file);
    assert.equal(readConfigPort(file), 9333);
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(raw.enabled, true);
    assert.equal(raw.port, 9333);

    assert.equal(clearConfig(file), true);
    assert.equal(readConfigPort(file), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("配置文件：坏 JSON / enabled:false 都不算启用", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cfg-"));
  const file = path.join(dir, "menu-inject.json");
  try {
    fs.writeFileSync(file, "{not json", "utf8");
    assert.equal(readConfigPort(file), null);

    fs.writeFileSync(file, JSON.stringify({ enabled: false, port: 9222 }), "utf8");
    assert.equal(readConfigPort(file), null);

    fs.writeFileSync(file, JSON.stringify({ port: "abc" }), "utf8");
    assert.equal(readConfigPort(file), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("配置文件默认落在 session-menu 目录（service 读的是同一个）", () => {
  // 必须和 extension/server/index.cjs 里的 stateDir() 一致，
  // 否则 service 与命令行各看各的配置，永远对不上。
  assert.ok(configPath().includes(path.join(".workbuddy", "session-menu")));
  assert.ok(configPath().endsWith("menu-inject.json"));
});
