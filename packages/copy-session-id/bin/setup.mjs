#!/usr/bin/env node
/**
 * 一键安装器。
 *
 * 设计目标：双击「一键安装.cmd」→ 看完提示 → 完事。不需要装 Node.js、不需要管理员、
 * 不需要理解 CDP 是什么。为此做了三个决定：
 *
 *   1. 用 WorkBuddy 自带的 Electron 当 Node 跑本脚本（ELECTRON_RUN_AS_NODE=1）。
 *      用户机器上一定有 WorkBuddy，就一定有 Node 运行时，不用另装。
 *   2. 注入器跑成「常驻进程」，而不是宿主扩展。扩展的 service 必须点开一次侧栏面板
 *      才会被 fork，这一步没法用命令行代劳——常驻进程绕开了它。
 *   3. 常驻进程放在 ~/.workbuddy/session-menu/app/，不往 WorkBuddy 安装目录写东西，
 *      所以普通权限就够（只有改快捷方式那一步需要管理员，那就退回环境变量）。
 *
 * 用法：
 *   setup.mjs               安装 / 修复
 *   setup.mjs --uninstall   卸载
 *   setup.mjs --status      看状态（挂掉的注入器会自动拉起）
 *   --port <n>              换端口（默认 9333，被占就往后找）
 *   --no-autostart          不设开机自启
 *   --no-restart            装完不重启客户端
 *   --with-panel            顺便装侧栏面板（可选，需要写安装目录）
 *   --yes                   不询问，一律按默认答案
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

import { findRoot, findExe, clientRunning, clientVersion, extensionsDir } from "./wb.mjs";
import { applyToShortcuts, restoreShortcuts, shortcutsWithArgs, debugArgs } from "./shortcut.mjs";
import {
  VAR,
  DEFAULT_PORT,
  parsePort,
  configPath,
  writeConfig,
  readConfigPort,
  clearConfig,
  readUserEnv,
  setUserEnv,
  clearUserEnv,
  probePort,
} from "./context-menu.mjs";
import { readPid, sleepSync, isAlive } from "./pid.mjs";

const EXT_ID = "workbuddy-session-menu";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const VERSION = PKG.version;

const HOME = process.env.WORKBUDDY_HOME || path.join(os.homedir(), ".workbuddy");
const STATE_DIR = path.join(HOME, "session-menu");
const APP_DIR = path.join(STATE_DIR, "app");
const STARTUP_DIR = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const STARTUP_VBS = path.join(STARTUP_DIR, "WorkBuddy 会话菜单.vbs");

/**
 * 便携版运行时 = 整个 bin/ + extension 的 server 与 inject 两块。
 *
 * 不逐个列文件：列过一次，后来加了 pid.mjs 忘了同步，装完的包一跑就
 * ERR_MODULE_NOT_FOUND。目录复制慢几十毫秒，但不会再犯这种错。
 */
const RUNTIME_DIRS = ["bin", "extension/server", "extension/inject"];

/** 少这几个就肯定跑不起来，复制完核对一下。 */
const RUNTIME_REQUIRED = [
  "bin/daemon.mjs",
  "bin/pid.mjs",
  "extension/server/menu-inject.cjs",
  "extension/server/cdp.cjs",
  "extension/inject/session-menu.js",
];

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback = "") => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const tty = process.stdout.isTTY;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("2");
const bold = paint("1");
const green = paint("32");
const yellow = paint("33");
const red = paint("31");
const cyan = paint("36");

const say = (s = "") => console.log(s);
const ok = (s) => console.log(`${green("  ✓")} ${s}`);
const info = (s) => console.log(`${cyan("  ·")} ${s}`);
const warn = (s) => console.log(`${yellow("  !")} ${s}`);
const bad = (s) => console.log(`${red("  ✗")} ${s}`);
const hr = () => console.log(dim("  " + "─".repeat(52)));

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ask(question, def = true) {
  if (!tty || has("--yes")) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = def ? "[Y/n]" : "[y/N]";
    const answer = (await rl.question(`  ${question} ${hint} `)).trim().toLowerCase();
    if (!answer) return def;
    return answer === "y" || answer === "yes" || answer === "是";
  } finally {
    rl.close();
  }
}

/* ------------------------------ 运行时搬运 ------------------------------ */

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function copyRuntime() {
  for (const rel of RUNTIME_REQUIRED) {
    if (!fs.existsSync(path.join(REPO, rel))) throw new Error(`安装包不完整，缺少 ${rel}`);
  }

  if (fs.existsSync(APP_DIR)) {
    const old = `${APP_DIR}.old-${stamp()}`;
    try {
      fs.renameSync(APP_DIR, old);
      fs.rmSync(old, { recursive: true, force: true });
    } catch {
      fs.rmSync(APP_DIR, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(APP_DIR, { recursive: true });
  for (const rel of RUNTIME_DIRS) {
    const from = path.join(REPO, rel);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(APP_DIR, rel), { recursive: true });
  }
  fs.writeFileSync(path.join(APP_DIR, "VERSION"), `${VERSION}\n`, "utf8");
  return RUNTIME_REQUIRED.filter((rel) => !fs.existsSync(path.join(APP_DIR, rel))).length === 0;
}

/* ------------------------------ 端口 / 自启 ------------------------------ */

/** 端口被别的程序占着就往后找，最多试 10 个。返回 {port, moved}。 */
export async function pickPort(want) {
  for (let p = want; p < want + 10; p += 1) {
    const probe = await probePort(p);
    if (!probe.open) return { port: p, moved: p !== want };
    if (probe.ours) return { port: p, moved: p !== want, already: true };
    info(`端口 ${p} 被别的程序占着（${probe.sample || "无页面"}），换下一个`);
  }
  throw new Error(`从 ${want} 往后的 10 个端口都被占用了，用 --port 指定一个空闲的`);
}

/** 让客户端启动时开端口：优先改快捷方式，改不动就退回环境变量。 */
function applyPort(port) {
  const applied = applyToShortcuts(port);
  const shortcutReady = applied.changed.length > 0 && applied.failed.length === 0;

  if (shortcutReady) {
    const env = readUserEnv();
    if (env.value) clearUserEnv();
    return { how: "shortcut", changed: applied.changed, failed: applied.failed, backup: applied.backup };
  }
  const set = setUserEnv(port);
  return { how: set.ok ? "env" : "none", changed: applied.changed, failed: applied.failed, detail: set.detail };
}

function vbsQuote(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

/**
 * 生成开机自启脚本的内容（UTF-16LE + BOM 的 Buffer）。
 *
 * 为什么是 .vbs 而不是 .cmd：cmd 会留下一块黑窗口，而且没法干净地隐藏子进程。
 * VBScript 的 Run(..., 0, False) 是「不显示窗口、不等待」，正好。
 * 为什么必须带 BOM：wscript 读 .vbs 时按系统 ANSI 或 BOM 判断编码，
 * 用户名/路径里有中文（很常见）就会按 GBK 读，路径直接错。
 */
export function renderStartupVbs(exe, appDir) {
  const script = [
    "' WorkBuddy 会话菜单 · 注入器自启动",
    "' 由安装器生成。删掉本文件就不再开机自启。",
    "Option Explicit",
    "Dim sh, exe, app, script",
    `exe = ${vbsQuote(exe)}`,
    `app = ${vbsQuote(appDir)}`,
    'script = app & "\\app\\bin\\daemon.mjs"',
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"',
    "sh.CurrentDirectory = app",
    'sh.Run """" & exe & """ """ & script & """", 0, False',
    "",
  ].join("\r\n");
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(script, "utf16le")]);
}

function writeStartupVbs(exe) {
  fs.mkdirSync(STARTUP_DIR, { recursive: true });
  fs.writeFileSync(STARTUP_VBS, renderStartupVbs(exe, STATE_DIR));
  return STARTUP_VBS;
}

/* ------------------------------ 进程管理 ------------------------------ */

function stopDaemon() {
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid);
  } catch {
    /* 已经没了 */
  }
  // 等它真的退出，最多 3 秒；不然紧接着启动会撞上锁文件
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    sleepSync(100);
  }
  try {
    spawnSync("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true });
  } catch {
    /* ignore */
  }
  return true;
}

/** 启动常驻注入器。优先走 wscript（不闪黑框），没有就退化成直接 spawn。 */
function startDaemon(exe, { autostart }) {
  if (autostart && fs.existsSync(STARTUP_VBS)) {
    const r = spawnSync("wscript.exe", ["//nologo", STARTUP_VBS], { windowsHide: true, timeout: 10000 });
    if (r.status === 0) return "wscript";
  }
  const child = spawn(exe, [path.join(APP_DIR, "bin", "daemon.mjs")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: STATE_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  child.unref();
  return "spawn";
}

function closeClient() {
  try {
    spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-Process WorkBuddy -ErrorAction SilentlyContinue) | ForEach-Object { $_.CloseMainWindow() | Out-Null }",
      ],
      { windowsHide: true, timeout: 15000 }
    );
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (!clientRunning()) return true;
    sleepSync(200);
  }
  return !clientRunning();
}

function launchClient(exe, port) {
  const child = spawn(exe, [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: "ignore",
    cwd: path.dirname(exe),
  });
  child.unref();
}

/* ------------------------------ 验证 ------------------------------ */

/** 等端口起来、等注入器认领窗口，最多 40 秒。只看本次安装之后新增的日志。 */
async function verify(port, { timeout = 40000, since = 0 } = {}) {
  const logPath = path.join(STATE_DIR, "menu-inject.log");
  /**
   * 按**字节**切，不能按字符切。
   * statSync().size 是字节数，而 readFileSync(..., "utf8") 返回的字符串按 UTF-16
   * 码元索引；日志里全是中文，1 个字符 3 个字节，两种偏移量差得很远，
   * 直接 slice 会把起点切到文件末尾，然后永远读不到「已注入」。
   */
  const readInjected = () => {
    try {
      return fs
        .readFileSync(logPath)
        .subarray(since)
        .toString("utf8")
        .split("\n")
        .filter((l) => l.includes("已注入"));
    } catch {
      return [];
    }
  };

  const deadline = Date.now() + timeout;
  let portUp = false;
  let ours = false;
  let oursAt = 0;
  let injected = [];
  while (Date.now() < deadline) {
    const probe = await probePort(port);
    if (probe.open) {
      portUp = true;
      if (probe.ours && !ours) {
        ours = true;
        oursAt = Date.now();
      }
    }
    injected = readInjected();
    if (ours && injected.length) break;
    // 端口通了但注入器迟迟不说话，别让用户干等：12 秒后先给结论
    if (ours && Date.now() - oursAt > 12000) break;
    await sleep(800);
  }
  return { portUp, ours, injected: injected.length, last: injected[injected.length - 1] || "" };
}

/** 中文字符按两格宽算，不然右边框会歪。 */
function wideLen(text) {
  let n = 0;
  for (const ch of text) n += /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return n;
}

function box(lines) {
  const width = Math.max(...lines.map(wideLen)) + 2;
  say(green("  ┌" + "─".repeat(width) + "┐"));
  for (const line of lines) {
    say(green("  │ ") + line + " ".repeat(width - 1 - wideLen(line)) + green("│"));
  }
  say(green("  └" + "─".repeat(width) + "┘"));
}

/* ------------------------------ 安装 ------------------------------ */

async function cmdInstall() {
  say();
  say(`  ${bold("WorkBuddy 会话菜单")} ${dim("· 复制 Session ID")}  ${dim("v" + VERSION)}`);
  hr();
  say();

  if (process.platform !== "win32") {
    bad("这个工具只支持 Windows（注入依赖 Chromium 的调试端口，且客户端目前只有 Windows 版）。");
    return 1;
  }
  if (process.type === "browser") {
    bad("看起来是 WorkBuddy 客户端在跑本脚本，而不是 Node。请用「一键安装.cmd」启动。");
    return 1;
  }

  // 1. 找客户端
  const exe = findExe();
  if (!exe) {
    bad("没找到 WorkBuddy.exe。");
    say(dim("    先装好 WorkBuddy 桌面客户端再来。装在其他盘的话，可以设 WORKBUDDY_EXE 指向它。"));
    return 1;
  }
  const version = clientVersion(exe);
  ok(`WorkBuddy  ${dim(exe)}${version ? dim("  " + version) : ""}`);

  // 2. 端口
  const want = parsePort(valueOf("--port", String(DEFAULT_PORT)));
  if (!want) {
    bad(`端口不合法：${valueOf("--port")}`);
    return 1;
  }
  const picked = await pickPort(want);
  const port = picked.port;
  if (picked.moved) info(`用端口 ${port}（${want} 被占用）`);

  // 3. 放运行时
  copyRuntime();
  const size = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, ent) => {
      const p = path.join(dir, ent.name);
      return sum + (ent.isDirectory() ? size(p) : fs.statSync(p).size);
    }, 0);
  ok(`程序文件  ${dim(APP_DIR)}  ${dim(Math.round(size(APP_DIR) / 1024) + " KB")}`);

  // 4. 写配置（注入器靠它知道端口）
  writeConfig(port);
  ok(`配置文件  ${dim(configPath())} → ${port}`);

  // 5. 让客户端开端口
  const applied = applyPort(port);
  if (applied.how === "shortcut") {
    ok(`启动参数  已写进快捷方式（${applied.changed.length} 个）`);
    for (const row of applied.changed) info(dim(path.basename(row.file)));
  } else if (applied.how === "env") {
    warn(`启动参数  快捷方式改不动，改用环境变量 ${VAR}=${port}`);
    say(dim("            需要管理员权限才能改安装包建的快捷方式；环境变量是等价兜底，"));
    say(dim("            所以这一步不影响使用。"));
  } else {
    bad("开端口的两条路都没走通，注入不会生效。");
    say(dim("    试试右键「一键安装.cmd」→ 以管理员身份运行。"));
    return 1;
  }

  // 6. 开机自启 + 立刻启动
  const autostart = !has("--no-autostart");
  if (autostart) {
    writeStartupVbs(exe);
    ok("开机自启  已设置");
  } else {
    info("开机自启  已跳过（--no-autostart）");
  }

  // 7. 启停注入器。记下日志当前位置，只看这之后的「已注入」，
  //    否则上次安装的旧日志会让「注入成功」变成一句空话。
  const logPath = path.join(STATE_DIR, "menu-inject.log");
  let logFrom = 0;
  try {
    logFrom = fs.statSync(logPath).size;
  } catch {
    /* 第一次装，还没有日志 */
  }

  stopDaemon();
  const how = startDaemon(exe, { autostart });
  await sleep(1200);
  const pid = readPid();
  if (!pid) {
    bad("注入器没起来。日志：");
    say(dim("    " + logPath));
    return 1;
  }
  ok(`注入器    PID ${pid}（${how === "wscript" ? "后台隐藏" : "直接启动"}）`);

  // 8. 可选：侧栏面板
  if (has("--with-panel")) {
    say();
    await installPanel();
  }

  // 9. 重启客户端
  say();
  if (has("--no-restart")) {
    info("已跳过重启（--no-restart）：稍后自己托盘退出再打开即可。");
  } else if (clientRunning()) {
    const yes = await ask("要现在重启 WorkBuddy 吗？（会自动关掉再打开，聊天记录不会丢）");
    if (yes) {
      say(dim("    正在关闭…"));
      if (!closeClient()) {
        warn("客户端没关掉，请手动托盘退出后再打开。");
      } else {
        launchClient(exe, port);
        say(dim("    已重新打开，等它把端口开起来…"));
      }
    } else {
      warn("那就需要你自己退出再打开，否则端口不会生效。");
    }
  } else {
    launchClient(exe, port);
    say(dim("    已帮你打开 WorkBuddy…"));
  }

  // 9. 收尾验证
  say();
  const result = await verify(port, { timeout: 40000, since: logFrom });
  if (result.ours) {
    box(["装好了", "在左侧会话列表里右键任意一个会话 → 「复制 Session ID」"]);
    say();
    say("  " + dim("剪贴板里就是这个会话的 UUID，可以直接粘到任何地方。"));
    if (result.injected) info(dim(`注入器已认领窗口（本次注入 ${result.injected} 次）`));
    else warn("端口通了但注入器还没说话，等几秒再右键试试；不行就双击「检查状态.cmd」。");
    say();
    say("  " + dim("排查：检查状态.cmd     卸载：一键卸载.cmd     日志：" + path.join(STATE_DIR, "menu-inject.log")));
    return 0;
  }

  warn(`客户端起来了，但调试端口 ${port} 还没开。`);
  say(dim("    最常见的原因：刚才没重启，或者重启的不是带参数的那个快捷方式。"));
  say(dim("    手动做一次：托盘退出 → 桌面图标打开。然后双击「检查状态.cmd」。"));
  return 2;
}

async function installPanel() {
  const root = findRoot();
  if (!root) {
    warn("找不到 WorkBuddy 安装目录，跳过侧栏面板。");
    return false;
  }
  const dir = extensionsDir(root);
  const target = path.join(dir, EXT_ID);
  try {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(path.join(REPO, "extension"), target, { recursive: true });
    ok(`侧栏面板  ${dim(target)}`);
    warn("面板版要重启客户端后，点开一次侧栏「会话菜单」才会启动。");
    return true;
  } catch (error) {
    bad(`装面板失败：${error.message}`);
    say(dim("    这一步需要写 WorkBuddy 安装目录，用管理员身份重跑可以解决。"));
    return false;
  }
}

/* ------------------------------ 卸载 ------------------------------ */

async function cmdUninstall() {
  say();
  say(`  ${bold("WorkBuddy 会话菜单")} ${dim("· 卸载")}`);
  hr();
  say();

  if (tty && !has("--yes")) {
    const yes = await ask("确认卸载？（会关掉注入器、删掉自启，菜单项随之消失）", false);
    if (!yes) {
      say(dim("  已取消。"));
      return 0;
    }
  }

  if (stopDaemon()) ok("注入器    已停止");

  let removed = 0;
  for (const file of [STARTUP_VBS, path.join(STATE_DIR, "start.vbs")]) {
    try {
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        removed += 1;
      }
    } catch {
      /* ignore */
    }
  }
  if (removed) ok("开机自启  已移除");

  try {
    if (fs.existsSync(APP_DIR)) {
      fs.rmSync(APP_DIR, { recursive: true, force: true });
      ok("程序文件  已删除");
    }
  } catch (error) {
    warn(`程序文件删不掉：${error.message}`);
  }

  const back = restoreShortcuts();
  if (back.restored?.length) ok(`快捷方式  已还原（${back.restored.length} 个）`);

  const env = readUserEnv();
  if (env.value) {
    if (clearUserEnv().ok) ok(`环境变量  已清除 ${VAR}`);
  }

  if (clearConfig()) ok("配置文件  已删除");

  const root = findRoot();
  if (root) {
    const target = path.join(extensionsDir(root), EXT_ID);
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
        ok("侧栏面板  已删除");
      } catch {
        warn("侧栏面板删不掉（需要管理员权限），可以忽略。");
      }
    }
  }

  say();
  say("  卸载完成。" + dim("重启 WorkBuddy 后菜单项就没了。"));
  say(dim("  日志和配置留在 " + STATE_DIR + "，想彻底干净可以整个删掉。"));
  return 0;
}

/* ------------------------------ 状态 ------------------------------ */

async function cmdStatus() {
  say();
  say(`  ${bold("WorkBuddy 会话菜单")} ${dim("· 状态")}  ${dim("v" + VERSION)}`);
  hr();

  const cfg = readConfigPort();
  const port = cfg || DEFAULT_PORT;

  // 配好了但注入器没跑：顺手拉起来。这是唯一会自愈的一步——
  // 「重启电脑后自启被杀软拦了」「任务管理器里被手动结束了」都长这样，
  // 让人再去双击一次安装器没必要。
  let pid = readPid();
  let revived = false;
  if (!pid && cfg) {
    const exe = findExe();
    if (exe) {
      startDaemon(exe, { autostart: true });
      await sleep(1200);
      pid = readPid();
      revived = Boolean(pid);
    }
  }

  const line = (label, good, text) => {
    const mark = good === null ? dim("  –") : good ? green("  ✓") : red("  ✗");
    say(`${mark} ${label}  ${text}`);
  };

  line("注入器", Boolean(pid), pid ? `正在运行（PID ${pid}）${revived ? " · 刚刚重新拉起" : ""}` : "没在运行");
  line("端口配置", Boolean(cfg), cfg ? `${cfg}  ${dim(configPath())}` : "没有配置");

  const running = clientRunning();
  line("客户端", running, running ? "正在运行" : "没在运行");

  const probe = await probePort(port);
  line("调试端口", probe.open && probe.ours !== false, probe.open ? (probe.ours ? `已监听，是 WorkBuddy 的窗口` : `被别的程序占用（${probe.sample || "无页面"}）`) : `未监听（${probe.detail}）`);

  const rows = shortcutsWithArgs().filter((r) => !r.error);
  const hasArg = rows.some((r) => /--remote-debugging-port=\d+/.test(r.args || ""));
  const env = readUserEnv();
  if (hasArg) line("开端口方式", true, "快捷方式启动参数");
  else if (env.value) line("开端口方式", true, `环境变量 ${VAR}=${env.value}`);
  else line("开端口方式", false, "都没有，客户端启动时不会开端口");

  const logFile = path.join(STATE_DIR, "menu-inject.log");
  let lastInject = "";
  if (fs.existsSync(logFile)) {
    const hits = fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes("已注入"));
    lastInject = hits[hits.length - 1] || "";
  }
  line("最近注入", lastInject ? true : null, lastInject ? lastInject.replace(/^.*?(已注入)/, "$1") : "还没有记录");

  say();
  const healthy = pid && cfg && probe.open && probe.ours !== false;
  if (healthy) {
    say(green("  一切正常。") + dim("右键任意会话，菜单里应该有「复制 Session ID」。"));
  } else if (!pid && cfg) {
    say(yellow("  注入器没在跑。") + dim("双击「一键安装.cmd」修一下（会重新拉起，不会重复装）。"));
  } else if (!cfg) {
    say(yellow("  还没装。") + dim("双击「一键安装.cmd」。"));
  } else if (!probe.open) {
    say(yellow("  端口没开。") + dim("托盘退出 WorkBuddy，再从桌面图标打开。"));
  }
  say(dim("  日志 " + logFile));
  return 0;
}

/* ------------------------------ 入口 ------------------------------ */

async function main() {
  if (has("--help") || has("-h")) {
    say("用法：setup.mjs [--uninstall | --status] [--port 9333] [--no-autostart] [--with-panel] [--yes]");
    return 0;
  }
  if (has("--uninstall")) return cmdUninstall();
  if (has("--status")) return cmdStatus();
  return cmdInstall();
}

/* 被 import（跑测试）时不要执行任何动作，只导出纯函数。 */
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((error) => {
      console.error(red("\n  出错了：") + error.message);
      process.exitCode = 1;
    });
}
