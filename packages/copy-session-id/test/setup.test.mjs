import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderStartupVbs, pickPort } from "../bin/setup.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

test("自启脚本是 UTF-16LE + BOM，且路径带引号", () => {
  const buf = renderStartupVbs("C:\\Program Files\\WorkBuddy\\WorkBuddy.exe", "C:\\Users\\张三\\.workbuddy\\session-menu");
  assert.deepEqual([...buf.slice(0, 2)], [0xff, 0xfe], "缺 BOM 时 wscript 会按 ANSI 读，中文路径全乱");

  const text = buf.slice(2).toString("utf16le");
  assert.match(text, /ELECTRON_RUN_AS_NODE/, "没有它就是一个 Electron 应用，不是 Node");
  assert.match(text, /exe = "C:\\Program Files\\WorkBuddy\\WorkBuddy\.exe"/);
  assert.match(text, /app = "C:\\Users\\张三\\\.workbuddy\\session-menu"/, "中文路径要原样保留");
  assert.match(text, /sh\.Run """" & exe & """ """ & script & """", 0, False/, "0 = 不显示窗口，False = 不等待");
  assert.ok(text.includes("\r\n"), "VBScript 不认 LF 换行");
});

test("自启脚本会去 app\\bin\\daemon.mjs 并临时设环境变量", () => {
  const text = renderStartupVbs("C:\\wb\\WorkBuddy.exe", "C:\\home\\session-menu").slice(2).toString("utf16le");
  assert.match(text, /script = app & "\\app\\bin\\daemon\.mjs"/);
  assert.match(text, /sh\.Environment\("PROCESS"\)\("ELECTRON_RUN_AS_NODE"\) = "1"/, "必须写进程级环境变量，子进程才继承得到");
  assert.match(text, /sh\.CurrentDirectory = app/);
});

test("安装器不能 import daemon.mjs —— 那会顺手抢锁并起一个注入器", () => {
  const source = read("bin/setup.mjs");
  assert.ok(!/from\s+["']\.\/daemon\.mjs["']/.test(source), "读 PID 要走 bin/pid.mjs");
  assert.match(source, /from "\.\/pid\.mjs"/);
});

test("便携版运行时要的文件都在仓库里", () => {
  for (const rel of [
    "bin/daemon.mjs",
    "bin/pid.mjs",
    "bin/setup.mjs",
    "bin/wb.mjs",
    "bin/shortcut.mjs",
    "bin/context-menu.mjs",
    "extension/server/menu-inject.cjs",
    "extension/server/cdp.cjs",
    "extension/inject/session-menu.js",
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `缺 ${rel}`);
  }
});

test("四个双击入口都在，且 .cmd 内容必须是纯 ASCII", () => {
  const files = ["一键安装.cmd", "install.cmd", "一键卸载.cmd", "检查状态.cmd"];
  for (const name of files) {
    const full = path.join(ROOT, name);
    assert.ok(fs.existsSync(full), `缺入口 ${name}`);
    const text = fs.readFileSync(full, "utf8");
    // cmd.exe 按 GBK 解析批处理，非 ASCII 字节会被拼成非法命令
    assert.ok(/^[\x00-\x7f]*$/.test(text), `${name} 含非 ASCII 字符`);
  }
});

test("版本号三处一致，且和 CHANGELOG 最新一节对得上", () => {
  const version = JSON.parse(read("package.json")).version;
  assert.equal(JSON.parse(read("extension/extension.json")).version, version);
  assert.equal(JSON.parse(read("extension/distribution.json")).version, version);
  assert.match(read("extension/server/index.cjs"), new RegExp(`const VERSION = "${version.replace(/\./g, "\\.")}"`));

  const changelog = read("CHANGELOG.md");
  const first = changelog.match(/^## (\d+\.\d+\.\d+)/m);
  assert.ok(first, "CHANGELOG 里找不到版本号");
  assert.equal(first[1], version, "CHANGELOG 最新一节应该就是当前版本");
});

test("端口被别的网页程序占着时，自动往后找一个空的", async () => {
  const taken = await freePort();

  // 冒充「别的 Chromium 应用」：有 /json/list，但页面不是 WorkBuddy
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith("/json/version")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ Browser: "Chrome/120" }));
      return;
    }
    if (req.url.startsWith("/json/list")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ type: "page", url: "https://example.com/", title: "别人的页面" }]));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => srv.listen(taken, "127.0.0.1", resolve));

  try {
    const picked = await pickPort(taken);
    assert.equal(picked.moved, true, `端口 ${taken} 被占，应该换一个`);
    assert.ok(picked.port > taken && picked.port <= taken + 10, "只在后面 10 个里找");
    assert.notEqual(picked.port, taken);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test("端口空着就原样用，不折腾", async () => {
  const free = await freePort();
  const picked = await pickPort(free);
  assert.equal(picked.port, free);
  assert.equal(picked.moved, false);
});
