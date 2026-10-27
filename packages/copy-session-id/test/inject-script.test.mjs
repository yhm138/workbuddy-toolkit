import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * extension/inject/session-menu.js 是注入到宿主渲染进程里的脚本，没有 DOM 环境
 * 就不好跑真实单测，但有两个硬约束必须守住——它们的失效方式不是报错，而是
 * **把用户的客户端拖卡**，只靠人工点一遍很难发现：
 *
 *   1. 不能有全局常驻 MutationObserver：宿主聊天是流式的，每秒成百上千次变动，
 *      每次都触发全量扫描会把渲染进程占满。上一版就是这么卡的。
 *   2. 插入节点前必须确认「克隆的是单个菜单项」，并且有数量上限。上一版把菜单
 *      容器当成了父节点，克隆出整份菜单、标记又落在菜单外，于是无限重复插入，
 *      节点数一路涨到把界面卡死。
 *
 * 这里用静态断言把这两条钉住：改回去测试就红。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, "..", "extension", "inject", "session-menu.js"), "utf8");

test("注入脚本不使用全局常驻 MutationObserver", () => {
  assert.ok(!/new\s+MutationObserver/.test(source), "不要把整个 document 挂到 MutationObserver 上");
  assert.ok(!/observer\.observe\s*\(\s*document\.documentElement/.test(source));
});

test("注入脚本使用有上限的短窗口轮询", () => {
  assert.match(source, /ARM_MS/, "应有一个「右键后只观察一小段时间」的窗口");
  assert.match(source, /setInterval\s*\(\s*tick\s*,/, "应为 setInterval(tick, …) 的定时探测");
  assert.match(source, /clearInterval/, "窗口结束必须停表");
  assert.match(source, /MAX_MARKS/, "必须有注入项数量上限");
});

test("只克隆单个菜单项，且有护栏", () => {
  assert.match(source, /cloneNode\s*\(\s*true\s*\)/, "仍然需要克隆单个条目以保持样式");
  assert.match(source, /const nodeCount = clone\.querySelectorAll\("\*"\)\.length/, "统计克隆体规模");
  assert.match(source, /nodeCount > MAX_CLONE_NODES/, "超上限就放弃；上限走常量，不写死数字");
  // 判「克隆错了容器」的本质依据是里层还套着 menuitem，不是子节点个数。
  // 按个数卡会把图标节点多的正常条目也挡掉——实测会让注入晚到 1 秒。
  assert.match(source, /clone\.querySelectorAll\('\[role="menuitem"\]'\)\.length/, "用 menuitem 判容器");
  assert.match(source, /conversation-context-menu/, "优先命中宿主真实的菜单容器类名");
  assert.match(source, /button\[role="menuitem"\]/, "锚点必须限定为菜单项按钮");
});

test("右键后先同步试一次，不等第一个 tick", () => {
  assert.match(source, /if \(tick\(\)\) return;/, "arm() 里应立即 tick 一次");
  assert.match(source, /const ARM_MS = (\d+)/, "观察窗口是常量");
  const arm = Number(/const ARM_MS = (\d+)/.exec(source)[1]);
  assert.ok(arm >= 2000, `观察窗口要够菜单渲染（当前 ${arm}ms；1.2s 实测偶尔不够）`);
});

test("提供一键停用的句柄，且能清掉已插入的节点", () => {
  assert.match(source, /window\[GUARD\]\s*=\s*\{/, "句柄要是个对象，方便挂 stop()");
  assert.match(source, /stop\(\)\s*\{/, "必须能停");
  assert.match(source, /querySelectorAll\(`\[\$\{MARK\}\]`\)/, "停用时把自己插的节点删掉");
});

test("复制走宿主 clipboard，且不把 __wbError 当成功", () => {
  assert.match(source, /workbuddyDesktop\.clipboard/, "优先用 preload 直接暴露的 clipboard 对象");
  assert.match(source, /typeof desk\.writeText\s*===\s*"function"/, "调用前先确认 writeText 存在");
  assert.match(source, /__wbError/, "IPC 通道不存在时 resolve 错误对象而不是 reject，必须判掉");
  assert.ok(source.includes("navigator.clipboard.writeText"), "其次 navigator.clipboard");
  assert.ok(source.includes("document.execCommand"), "最后 execCommand 兜底");
});

test("__wbError 的判定在裸 IPC 分支里，顺序不能反", () => {
  // 回归护栏：clipboard.writeText 必须先于 __wbInvoke 尝试，
  // 否则又会走回「假成功」那条路。
  const deskAt = source.indexOf("workbuddyDesktop && window.workbuddyDesktop.clipboard");
  const invokeAt = source.indexOf('__wbInvoke("workbuddy:clipboard:writeText"');
  assert.ok(deskAt > 0, "应能找到 clipboard 分支");
  assert.ok(invokeAt > 0, "应能找到裸 IPC 分支");
  assert.ok(deskAt < invokeAt, "clipboard.writeText 必须排在裸 IPC 之前");
});

