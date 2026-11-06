import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildLink,
  parseLink,
  debugArgs,
  stripDebugArgs,
  ensureUserShortcut,
  removeUserShortcut,
  userShortcutFile,
} from "../bin/shortcut.mjs";

/**
 * .lnk 是我们自己拼字节拼出来的（沙箱禁了 COM），所以「写进去能不能读回来」
 * 必须由测试兜住 —— 否则用户桌面上会出现一个点了没反应的图标。
 */

const TARGET = "D:\\Software\\WorkBuddy\\WorkBuddy.exe";
const WORKDIR = "D:\\Software\\WorkBuddy";

test("buildLink → parseLink：目标、参数、工作目录都能原样读回", () => {
  const args = debugArgs(9333);
  const back = parseLink(buildLink({ target: TARGET, args, workDir: WORKDIR }));
  assert.equal(back.target, TARGET);
  assert.equal(back.args, args);
  assert.equal(back.workDir, WORKDIR);
});

test("没有参数时不写 HasArguments 段", () => {
  const back = parseLink(buildLink({ target: TARGET, workDir: WORKDIR }));
  assert.equal(back.args, "");
  assert.equal(back.workDir, WORKDIR);
  // 0x20 = HasArguments
  assert.equal(back.flags & 0x20, 0);
});

test("文件头是合法的 .lnk：大小 76 字节 + 固定 CLSID", () => {
  const buf = buildLink({ target: TARGET });
  assert.equal(buf.readUInt32LE(0), 0x4c);
  assert.equal(buf.subarray(4, 20).toString("hex"), "0114020000000000c000000000000046");
});

test("备注和图标会保留（否则桌面图标变白板）", () => {
  const name = "WorkBuddy Desktop - AI Agent Desktop Application";
  const icon = "D:\\Software\\WorkBuddy\\WorkBuddy.exe";
  const back = parseLink(buildLink({ target: TARGET, args: debugArgs(9333), workDir: WORKDIR, name, iconLocation: icon }));
  assert.equal(back.name, name);
  assert.equal(back.iconLocation, icon);
});

test("中文备注不写进文件，但不能让整次改写失败", () => {
  const back = parseLink(buildLink({ target: TARGET, workDir: WORKDIR, name: "工作台" }));
  assert.equal(back.name, "");
  assert.equal(back.target, TARGET);
});

test("非 ASCII 路径直接拒绝，而不是写出一份坏文件", () => {
  assert.throws(() => buildLink({ target: "D:\\软件\\WorkBuddy.exe" }), /非 ASCII/);
  assert.throws(() => buildLink({ target: TARGET, args: "--x=会话" }), /非 ASCII/);
});

test("parseLink 对垃圾数据要报错，不能返回半截结果", () => {
  assert.throws(() => parseLink(Buffer.alloc(10)), /不是有效的/);
  const junk = Buffer.alloc(120);
  junk.writeUInt32LE(0x4c, 0);
  assert.throws(() => parseLink(junk), /签名不对/);
});

test("debugArgs 同时给 port 和 allow-origins", () => {
  const args = debugArgs(9333);
  assert.match(args, /--remote-debugging-port=9333/);
  assert.match(args, /--remote-allow-origins=/);
  assert.match(args, /127\.0\.0\.1:9333/);
});

test("stripDebugArgs 只摘调试参数，别的参数保留", () => {
  const old = '--remote-debugging-port=9222 --remote-allow-origins=http://127.0.0.1 --user-data-dir="D:\\x y"';
  const got = stripDebugArgs(old);
  assert.equal(got, '--user-data-dir="D:\\x y"');
  assert.equal(stripDebugArgs(debugArgs(9333)), "");
  assert.equal(stripDebugArgs(""), "");
});

test("换端口时不会把旧端口留在参数里", () => {
  const once = debugArgs(9333);
  const twice = `${stripDebugArgs(once)} ${debugArgs(9444)}`.trim();
  assert.equal(twice.match(/--remote-debugging-port=/g).length, 1);
  assert.match(twice, /9444/);
  assert.doesNotMatch(twice, /9333/);
});

/* ---------------- 用户桌面快捷方式（绕开环境变量竞态的那条路） ---------------- */

function tempDesktop() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dsh-lnk-"));
}

test("用户桌面快捷方式：写进去能读回目标、参数、工作目录", () => {
  const dir = tempDesktop();
  try {
    const r = ensureUserShortcut(9333, TARGET, dir);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.created, true);
    assert.equal(r.changed, true);

    const back = parseLink(fs.readFileSync(r.file));
    assert.equal(back.target, TARGET);
    assert.equal(back.args, debugArgs(9333));
    assert.equal(back.workDir, WORKDIR);
    assert.equal(back.iconLocation, TARGET, "没写图标位置的话桌面上会是个白板");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("重复跑不重写：已存在且参数一致时原样返回", () => {
  const dir = tempDesktop();
  try {
    const first = ensureUserShortcut(9333, TARGET, dir);
    const bytes = fs.readFileSync(first.file);
    const second = ensureUserShortcut(9333, TARGET, dir);
    assert.equal(second.ok, true);
    assert.equal(second.changed, false);
    assert.equal(second.created, false);
    assert.deepEqual(fs.readFileSync(second.file), bytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("换端口会重写，旧端口一个字都不留", () => {
  const dir = tempDesktop();
  try {
    ensureUserShortcut(9333, TARGET, dir);
    const r = ensureUserShortcut(9444, TARGET, dir);
    assert.equal(r.changed, true);
    const args = parseLink(fs.readFileSync(r.file)).args;
    assert.match(args, /--remote-debugging-port=9444/);
    assert.doesNotMatch(args, /9333/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("已有自定义参数时不覆盖用户自己的东西", () => {
  const dir = tempDesktop();
  try {
    const file = userShortcutFile(dir);
    const original = buildLink({ target: TARGET, args: '--user-data-dir="D:\\x y"', workDir: WORKDIR });
    fs.writeFileSync(file, original);

    const r = ensureUserShortcut(9333, TARGET, dir);
    assert.equal(r.ok, false);
    assert.match(r.reason, /自定义参数/);
    assert.deepEqual(fs.readFileSync(file), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("非法端口不落文件", () => {
  const dir = tempDesktop();
  try {
    for (const bad of [0, -1, 65536, "9333", null]) {
      assert.equal(ensureUserShortcut(bad, TARGET, dir).ok, false);
    }
    assert.equal(fs.existsSync(userShortcutFile(dir)), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeUserShortcut 能收掉桌面图标，重复删不报错", () => {
  const dir = tempDesktop();
  try {
    ensureUserShortcut(9333, TARGET, dir);
    assert.equal(removeUserShortcut(dir).removed, true);
    assert.equal(fs.existsSync(userShortcutFile(dir)), false);
    assert.equal(removeUserShortcut(dir).removed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("默认落在用户自己的 Desktop，不是改不动的 Public", () => {
  const file = userShortcutFile();
  assert.match(file, /Desktop/);
  assert.doesNotMatch(file, /Users\\Public|ProgramData/);
  assert.match(file, /Session ID/);
});
