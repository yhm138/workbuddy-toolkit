#!/usr/bin/env node
/**
 * 真机验收：连上正在跑的 WorkBuddy，把仓库里的注入脚本热替换进去，
 * 然后用真实鼠标事件右键一个会话、点「复制 Session ID」，最后读回剪贴板。
 *
 * 这是唯一能验证「宿主真实行为」的手段——单测只能验静态约束和协议层。
 *
 * 用法：
 *   node tools/verify.mjs                # 端口取配置文件里的
 *   node tools/verify.mjs --port 9333
 *   node tools/verify.mjs --keep         # 验完不卸掉注入脚本
 *
 * 前提：客户端带 --remote-debugging-port 启动（先跑 enable），
 *       且侧栏「会话菜单」面板至少打开过一次（service 才会 fork）。
 *
 * 注意：它会真的改动你剪贴板的内容。
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { CdpSocket, httpJson } = require("../extension/server/cdp.cjs");

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const arg = (name, fallback = "") => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const PORT = Number(arg("--port") || process.env.PORT || 9333);
const KEEP = process.argv.includes("--keep");
const SOURCE = fs.readFileSync(path.join(root, "extension", "inject", "session-menu.js"), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

function fail(msg) {
  console.error(bad("FAIL ") + msg);
  process.exit(1);
}

/* ---------- 连上渲染进程 ---------- */

let targets;
try {
  targets = (await httpJson(`http://127.0.0.1:${PORT}/json/list`, 3000)).filter(
    (t) => t.type === "page" && /app\.asar/i.test(t.url || "")
  );
} catch (e) {
  fail(`连不上 127.0.0.1:${PORT}（${e.message}）\n     多半是客户端没带调试端口启动：先跑 node bin/context-menu.mjs enable`);
}

if (!targets.length) fail(`端口 ${PORT} 上没有 WorkBuddy 的窗口（只认 app.asar 下的页面）`);
console.log(dim(`端口 ${PORT}，窗口：${targets[0].title}`));

const sock = await CdpSocket.connect(targets[0].webSocketDebuggerUrl);

const evalJs = async (expression) => {
  const r = await sock.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (r.exceptionDetails) {
    return { __error: String(r.exceptionDetails.exception?.description || r.exceptionDetails.text) };
  }
  return r.result?.value;
};

const mouse = (type, x, y, button) =>
  sock.send("Input.dispatchMouseEvent", {
    type, x, y, button, clickCount: 1,
    buttons: type === "mousePressed" ? (button === "right" ? 2 : 1) : 0,
  });

/* ---------- 1. 热替换 ---------- */

await evalJs(`(() => {
  try { window.__dshCopySessionMenu && window.__dshCopySessionMenu.stop(); } catch (e) {}
  try { delete window.__dshCopySessionMenu; } catch (e) {}
  return true;
})()`);
await evalJs(SOURCE);

const guard = await evalJs(`typeof window.__dshCopySessionMenu`);
if (guard !== "object") fail(`注入脚本没装上（guard=${guard}）`);
console.log(ok("OK   ") + "注入脚本已热替换");

await sock.send("Page.bringToFront");

/* ---------- 2. 找一个可见会话行 ---------- */

const row = await evalJs(`(() => {
  for (const el of document.querySelectorAll('[data-conversation-id]')) {
    const r = el.getBoundingClientRect();
    if (r.width > 40 && r.height > 10 && r.top > 0) {
      return { id: el.getAttribute('data-conversation-id'),
               x: Math.round(r.left + 24), y: Math.round(r.top + r.height / 2) };
    }
  }
  return null;
})()`);

if (!row || row.__error) fail("侧栏里没找到可见的会话行（先打开会话列表）");
console.log(dim(`     目标会话 ${row.id.slice(0, 8)}…`));

/* ---------- 3. 右键 ---------- */

await mouse("mousePressed", row.x, row.y, "right");
await mouse("mouseReleased", row.x, row.y, "right");
await sleep(500);

const item = await evalJs(`(() => {
  const el = document.querySelector('[data-dsh-copy-session]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { label: el.textContent.trim(), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);

const state = await evalJs(`window.__dshCopySessionMenu.state`);

if (!item) {
  const s = state || {};
  fail(
    "菜单里没有插入这一项\n" +
      `     pendingId=${JSON.stringify(s.pendingId)} menuOpen=${s.menuOpen} menuItems=${s.menuItems}\n` +
      `     lastReject=${JSON.stringify(s.lastReject)}`
  );
}
if (item.label !== "复制 Session ID") fail(`文案不对：${item.label}`);
console.log(ok("OK   ") + "菜单项已插入");

const count = await evalJs(`document.querySelectorAll('[data-dsh-copy-session]').length`);
if (count !== 1) fail(`菜单里有 ${count} 项，应该是 1 项`);
console.log(ok("OK   ") + "只插了一项");

/* ---------- 4. 点击 + 读剪贴板 ---------- */

await mouse("mousePressed", item.x, item.y, "left");
await mouse("mouseReleased", item.x, item.y, "left");
await sleep(700);

const readback = await evalJs(`(async () => {
  try { return { text: await window.workbuddyDesktop.clipboard.readText() }; }
  catch (e) { return { err: String(e && e.message || e) }; }
})()`);

await sock.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sock.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });

if (!KEEP) {
  await evalJs(`(() => { try { window.__dshCopySessionMenu.stop(); } catch (e) {} return true })()`);
}

if (readback && readback.err) {
  fail(`点击后读不了剪贴板：${readback.err}\n     如果提示 not focused，点一下 WorkBuddy 窗口再跑`);
}
if (!readback || readback.text !== row.id) {
  fail(
    `剪贴板内容不对\n     期望 ${row.id}\n     实际 ${JSON.stringify(readback && readback.text)}`
  );
}

console.log(ok("OK   ") + `剪贴板 = ${readback.text}`);
console.log("");
console.log(ok("全部通过") + dim(KEEP ? "（注入脚本保留在你当前窗口里）" : "（已清理）"));
sock.close();
