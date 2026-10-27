import test from "node:test";
import assert from "node:assert/strict";
import { buildLink, parseLink, debugArgs, stripDebugArgs } from "../bin/shortcut.mjs";

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
