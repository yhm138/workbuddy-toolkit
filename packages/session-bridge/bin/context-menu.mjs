#!/usr/bin/env node
/**
 * 「复制 Session ID」右键注入的开关。
 *
 * 为什么要有这个文件：同目录的 .cmd 里不能写中文。cmd.exe 按当前代码页
 * （简中系统是 GBK）逐字节解析批处理文件，UTF-8 的中文字节会撞上 | < > &
 * 这些控制字符，把后面的行拼成非法命令直接报错（'m' is not recognized）。
 * 所以 .cmd 只留纯 ASCII 的转发，中文输出交给 Node —— Node 在 TTY 下走
 * WriteConsoleW，跟代码页无关，稳定不乱码。
 *
 * 端口怎么给客户端：**优先写进用户桌面快捷方式的启动参数**。
 *
 * 系统级快捷方式（Public\Desktop、ProgramData\Start Menu）普通用户改不动，而且
 * 客户端整包升级会把它们整个重装、参数被抹掉。以前这时只能退回环境变量
 * WORKBUDDY_REMOTE_DEBUGGING_PORT，但宿主是在 JS 启动流程里
 * `app.commandLine.appendSwitch('remote-debugging-port', ...)`，这个时机晚于
 * Chromium 建立调试服务器：实测主进程不绑端口，只有后 fork 的 renderer 命令行里
 * 带着参数（2026-11-06 又复现一次）。启动参数在进程创建时就定了，没有竞态。
 * 用户自己桌面那份普通权限可写，升级也不会动它，所以 enable 会确保它存在。
 *
 * service 是 daemon fork 的，拿不到用户级环境变量；它靠
 * ~/.workbuddy/dsh-skills/menu-inject.json 这份文件知道端口。
 *
 * 用法：
 *   node bin/context-menu.mjs enable [port]   写快捷方式 + 配置（默认 9333）
 *   node bin/context-menu.mjs disable         还原并清配置
 *   node bin/context-menu.mjs launch [port]   只给这次启动带上，不动快捷方式
 *   node bin/context-menu.mjs status          看当前状态
 */

import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyToShortcuts, restoreShortcuts, shortcutsWithArgs, debugArgs, ensureUserShortcut, removeUserShortcut, userShortcutFile, readLink } from "./shortcut.mjs";

export const VAR = "WORKBUDDY_REMOTE_DEBUGGING_PORT";
export const DEFAULT_PORT = 9333;

/**
 * 端口还要写一份文件给 service 看。
 *
 * 实测：宿主的扩展 service 是 daemon 进程 fork 的，**拿不到用户级环境变量**
 * （客户端主进程拿到了 9222，service 里 process.env 是空的）。所以「复制 Session ID」
 * 一直显示未启用。启动参数 / 环境变量负责让客户端开端口，这份文件负责告诉 service 端口是多少。
 */
export function configPath() {
  const home = process.env.WORKBUDDY_HOME || path.join(os.homedir(), ".workbuddy");
  return path.join(home, "dsh-skills", "menu-inject.json");
}

export function writeConfig(port, file = configPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ enabled: true, port, at: Date.now() }, null, 2)}\n`, "utf8");
  return file;
}

export function readConfigPort(file = configPath()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || data.enabled === false) return null;
    return parsePort(data.port) || null;
  } catch {
    return null;
  }
}

export function clearConfig(file = configPath()) {
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

const C = process.stdout.isTTY
  ? {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      ok: (s) => `\x1b[32m${s}\x1b[0m`,
      warn: (s) => `\x1b[33m${s}\x1b[0m`,
      bad: (s) => `\x1b[31m${s}\x1b[0m`,
    }
  : { dim: (s) => s, ok: (s) => s, warn: (s) => s, bad: (s) => s };

function run(file, args, opts = {}) {
  const r = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    ...opts,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    out: (r.stdout || "").trim(),
    err: (r.stderr || "").trim(),
    failed: Boolean(r.error),
  };
}

/** 只做参数校验，不做任何副作用，方便单测。 */
export function parsePort(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_PORT;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

export function findExe(extra) {
  const candidates = [
    extra,
    process.env.WORKBUDDY_EXE,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "WorkBuddy", "WorkBuddy.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "WorkBuddy", "WorkBuddy.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "WorkBuddy", "WorkBuddy.exe"),
    "D:\\Software\\WorkBuddy\\WorkBuddy.exe",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* 路径非法就跳过 */
    }
  }
  return null;
}

/** 读用户级环境变量。优先 .NET（不受安全软件的 reg.exe 黑名单影响），再退 reg。 */
function readUserEnv() {
  const ps = run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `[Environment]::GetEnvironmentVariable('${VAR}','User')`,
  ]);
  if (ps.ok) {
    const v = ps.out.split(/\r?\n/).pop().trim();
    return { value: v || null, via: "powershell" };
  }
  const q = run("reg", ["query", "HKCU\\Environment", "/v", VAR]);
  if (q.ok) {
    const m = q.out.match(new RegExp(`${VAR}\\s+REG_\\w+\\s+(\\S+)`));
    return { value: m ? m[1] : null, via: "reg" };
  }
  return { value: null, via: "none", unknown: true };
}

function clearUserEnv() {
  const ps = run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `[Environment]::SetEnvironmentVariable('${VAR}',$null,'User')`,
  ]);
  if (ps.ok) return { ok: true, via: "powershell" };
  const d = run("reg", ["delete", "HKCU\\Environment", "/v", VAR, "/f"]);
  return { ok: d.ok, via: "reg", detail: ps.err || ps.out || d.err };
}

/**
 * 写用户级环境变量 —— 快捷方式改不动时的兜底通道。
 *
 * 为什么这条路可行：宿主的 applyCliCommandLineSwitches() 启动时读
 * WORKBUDDY_REMOTE_DEBUGGING_PORT 再 appendSwitch，主进程确实拿得到用户级变量。
 * （拿不到的是 service：daemon fork 出来的进程环境是干净的，所以 service 侧另用
 * 配置文件。）
 *
 * 为什么需要它：安装包把 WorkBuddy.lnk 放在 Public\Desktop 和
 * ProgramData\Start Menu 下，普通用户改不动；以前 enable 不管改没改成就把环境变量
 * 删掉，于是三条路一起断，重启后端口消失、菜单项也没了。
 */
function setUserEnv(port) {
  const ps = run("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `[Environment]::SetEnvironmentVariable('${VAR}','${port}','User')`,
  ]);
  if (ps.ok) return { ok: true, via: "powershell" };
  const a = run("reg", ["add", "HKCU\\Environment", "/v", VAR, "/t", "REG_SZ", "/d", String(port), "/f"]);
  return { ok: a.ok, via: "reg", detail: ps.err || ps.out || a.err };
}

function clientRunning() {
  const t = run("tasklist", ["/FI", "IMAGENAME eq WorkBuddy.exe", "/NH"]);
  return /WorkBuddy\.exe/i.test(t.out);
}

/**
 * 探测端口。9222 是 Chromium 的公共习惯端口，本机上很可能已经被别的程序
 * （Playwright 残留、用户自己开的 Chrome）占住，所以只看「端口通不通」不够，
 * 还要看端口上有没有 WorkBuddy 的窗口。
 */
async function probePort(port) {
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return { open: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { open: false, detail: err?.name === "TimeoutError" ? "超时" : "无响应" };
  }
  try {
    const res = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(1500) });
    const list = await res.json();
    const pages = (Array.isArray(list) ? list : []).filter((t) => t && t.type === "page");
    const ours = pages.filter(
      (t) => /app\.asar/i.test(t.url || "") || /workbuddy/i.test(`${t.url || ""}${t.title || ""}`)
    );
    return {
      open: true,
      ours: ours.length > 0,
      pages: pages.length,
      sample: pages[0] ? String(pages[0].url || pages[0].title || "").slice(0, 80) : "",
    };
  } catch {
    return { open: true, ours: null, pages: 0, sample: "" };
  }
}

function hr() {
  console.log(C.dim("-".repeat(56)));
}

function banner() {
  console.log("");
  console.log("  WorkBuddy 会话菜单注入 · 复制 Session ID");
  hr();
}

function nextStep() {
  console.log("");
  console.log(C.warn("  下一步：右下角托盘图标右键 → 退出，然后**从桌面图标重新打开**。"));
  console.log(C.dim("  优先用桌面上那个「WorkBuddy (Session ID)」：它带启动参数，"));
  console.log(C.dim("  进程创建时就定了端口，不依赖宿主那次有竞态的 appendSwitch。"));
  console.log(C.dim("  客户端是单例，正在跑的进程改不了命令行。"));
}

function securityNote() {
  console.log("");
  console.log(C.dim("  调试端口只绑 127.0.0.1，但本机任何程序都能连上来控制工作台。"));
  console.log(C.dim("  不想用了跑 bin\\disable-context-menu.cmd 再重启即可。"));
}

/* ------------------------------- 子命令 ------------------------------- */

async function cmdEnable(port) {
  banner();

  // 先看端口，再改快捷方式：端口要是被别的东西占着，客户端照样抢不到。
  const probe = await probePort(port);
  if (probe.open && probe.ours === false) {
    console.log(C.bad(`[x] 端口 ${port} 已经被别的程序占用了。`));
    console.log(C.dim(`    占用者：${probe.sample || "(无页面)"}`));
    console.log(C.dim("    WorkBuddy 启动时抢不到这个端口，注入不会生效。"));
    console.log("");
    console.log("    换个端口：");
    console.log(C.dim(`    node bin\\context-menu.mjs enable ${port + 1}`));
    return 1;
  }

  console.log("[1/4] 系统级快捷方式（客户端升级会重装，普通权限常改不动）");
  const applied = applyToShortcuts(port);
  if (!applied.changed.length && !applied.failed.length) {
    console.log(C.warn("      没找到可改的 WorkBuddy 快捷方式。"));
    console.log(C.dim("      你可能是从开始菜单搜索或别的启动器打开的。"));
    console.log(C.dim(`      手动加参数也行：${debugArgs(port)}`));
  }
  for (const row of applied.changed) {
    console.log(C.ok(`      [ok] ${row.file}`));
    console.log(C.dim(`           ${row.after}`));
  }
  for (const row of applied.skipped) {
    console.log(C.dim(`      [--] ${path.basename(row.file)}：${row.reason}`));
  }
  for (const row of applied.failed) {
    console.log(C.bad(`      [x] ${path.basename(row.file)}：${row.reason}`));
  }
  if (applied.failed.some((row) => /EPERM|EACCES/i.test(row.reason))) {
    console.log("");
    console.log(C.warn("      这些快捷方式在 Public\\Desktop 或 ProgramData 下，需要管理员权限。"));
    console.log(C.dim("      右键 bin\\enable-context-menu.cmd → 以管理员身份运行，再跑一次。"));
  }
  if (applied.backup) console.log(C.dim(`      原文件备份在 ${applied.backup}`));

  console.log("");
  console.log("[2/4] 用户桌面快捷方式（关键：升级抹不掉、普通权限可写）");
  const own = ensureUserShortcut(port, findExe());
  if (own.ok) {
    console.log(C.ok(`      [ok] ${own.file}`));
    console.log(C.dim(`           ${own.args}`));
    if (!own.changed) console.log(C.dim("           已存在且参数正确，没改动"));
  } else {
    console.log(C.bad(`      [x] ${own.reason}`));
  }

  console.log("");
  console.log("[3/4] 配置文件（service 靠它知道端口）");
  try {
    const file = writeConfig(port);
    console.log(C.ok(`      [ok] ${file}`));
  } catch (error) {
    console.log(C.bad(`      [x] 写入失败：${error.message}`));
    return 1;
  }

  console.log("");
  console.log("[4/4] 环境变量（兜底，端口与启动参数保持一致）");

  // 不再清掉它。宿主 appendSwitch 有竞态，但多一条路不是坏事；关键是端口必须和
  // 启动参数一致，否则同名的 switch 会把启动参数反覆盖成旧端口（2026-10-25 踩过）。
  const set = setUserEnv(port);
  if (set.ok) {
    console.log(C.ok(`      [ok] ${VAR}=${port}`));
    console.log(C.dim("      与桌面快捷方式的端口相同，不会反覆盖；从别的入口启动时也多一次机会。"));
  } else {
    console.log(C.bad(`      [x] 写环境变量失败：${set.detail || "未知原因"}`));
    console.log(C.dim(`      不影响桌面快捷方式那条路；想补可手动 setx ${VAR} ${port}`));
  }

  if (probe.open && probe.ours) {
    console.log("");
    console.log(C.ok(`      [i] 端口 ${port} 现在开着，是当前进程的，这次不用重启。`));
    console.log(C.dim("      下次启动会自动带上。"));
  } else {
    nextStep();
  }
  securityNote();
  // 系统级快捷方式改不动不算失败：用户桌面那份已经是可靠入口了
  return own.ok || applied.failed.length === 0 ? 0 : 1;
}

async function cmdDisable() {
  banner();
  const cfgPort = readConfigPort();

  console.log("[1/4] 还原系统级快捷方式");
  const back = restoreShortcuts();
  if (!back.restored.length) {
    console.log(C.dim(`      ${back.reason || "没有可还原的文件"}`));
  } else {
    for (const file of back.restored) console.log(C.ok(`      [ok] ${file}`));
    console.log(C.dim(`      来自备份 ${back.from}`));
  }

  console.log("");
  console.log("[2/4] 删掉桌面上带调试参数的那个图标");
  const own = removeUserShortcut();
  console.log(own.ok && own.removed ? C.ok(`      [ok] ${own.file}`) : C.dim("      本来就没有"));

  console.log("");
  console.log("[3/4] 删配置文件");
  const removedCfg = clearConfig();
  console.log(removedCfg ? C.ok("      [ok] 已删除") : C.dim("      本来就没有"));

  console.log("");
  console.log("[4/4] 清环境变量");
  const env = readUserEnv();
  if (env.value === null && !env.unknown) {
    console.log(C.dim("      本来就没设置。"));
  } else if (env.unknown) {
    console.log(C.warn("      读不到注册表，请手动确认 " + VAR + " 已删除。"));
  } else {
    const r = clearUserEnv();
    console.log(r.ok ? C.ok(`      [ok] 已删除（${r.via}）`) : C.bad("      [x] 删除失败"));
  }

  if (cfgPort) console.log(C.dim(`\n  之前记录的端口是 ${cfgPort}`));
  console.log("");
  console.log(C.warn("  service 会在 20 秒内停止注入；调试端口要等下次重启才关。"));
  return 0;
}

async function cmdLaunch(port) {
  banner();
  const exe = findExe();
  if (!exe) {
    console.log(C.bad("[x] 没找到 WorkBuddy.exe。"));
    console.log(C.dim("    可以设 WORKBUDDY_EXE 指向 exe，或直接改本脚本的候选列表。"));
    return 1;
  }
  if (clientRunning()) {
    console.log(C.warn("[!] WorkBuddy 正在运行。"));
    console.log(C.dim("    客户端是单例，先跑起来的那个说了算：请从托盘退出后再执行本脚本。"));
    return 1;
  }
  console.log(`以启动参数 ${debugArgs(port)} 启动：`);
  console.log(C.dim("  " + exe));
  const child = spawn(exe, debugArgs(port).split(" "), {
    cwd: path.dirname(exe),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log("");
  console.log(C.ok("  [ok] 已拉起，等几秒让面板连上。"));
  console.log(C.dim("  这是临时开关，不写快捷方式；下次正常启动就没有端口了。"));
  return 0;
}

async function cmdStatus(port) {
  banner();
  const running = clientRunning();
  const cfgPort = readConfigPort();
  const probe = await probePort(cfgPort || port);

  const mark = (good, text) => console.log(`  ${good ? C.ok("[ok]") : C.bad("[ x]")} ${text}`);

  console.log("  配置文件（service 读的是这个）");
  if (cfgPort) mark(true, `${configPath()} → ${cfgPort}`);
  else mark(false, `${configPath()} 不存在或未启用`);

  console.log("  用户桌面启动入口（可靠：普通权限可写，升级抹不掉）");
  const ownFile = userShortcutFile();
  let ownOk = false;
  let ownArgs = "";
  try {
    if (fs.existsSync(ownFile)) {
      ownArgs = readLink(ownFile).args || "";
      ownOk = /--remote-debugging-port=\d+/.test(ownArgs);
    }
  } catch {
    /* 文件坏了就当没有 */
  }
  mark(ownOk, ownOk ? `${ownFile} → ${ownArgs}` : `${ownFile} 不存在或没带调试参数`);

  console.log("  系统级快捷方式（客户端升级会重装、普通权限常改不动）");
  const ownKey = path.resolve(userShortcutFile()).toLowerCase();
  const rows = shortcutsWithArgs().filter((row) => path.resolve(row.file).toLowerCase() !== ownKey);
  if (!rows.length) {
    console.log(C.warn("       没找到 WorkBuddy 快捷方式"));
  }
  for (const row of rows) {
    const name = path.basename(row.file);
    if (row.error) {
      mark(false, `${name}：解析失败（${row.error}）`);
      continue;
    }
    const hit = /--remote-debugging-port=(\d+)/.exec(row.args || "");
    if (hit) mark(true, `${name} → 端口 ${hit[1]}`);
    else mark(false, `${name} 没有调试参数`);
  }

  console.log("  环境变量");
  const env = readUserEnv();
  const shortcutHasPort = rows.some((row) => !row.error && /--remote-debugging-port=\d+/.test(row.args || ""));
  if (env.unknown) console.log(C.warn("       读不到（reg 与 powershell 都被拦）"));
  else if (env.value) {
    const wantPort = cfgPort || port;
    const same = env.value === String(wantPort);
    console.log(same
      ? C.ok(`       ${VAR}=${env.value}（与启动参数同端口，作为兜底保留）`)
      : C.warn(`       ${VAR}=${env.value} ≠ 启动参数 ${wantPort}，宿主会反覆盖成它，重跑 enable 同步`));
  } else console.log(C.dim(`       ${VAR} 未设置`));

  console.log("  客户端 / 端口");
  mark(running, running ? "WorkBuddy.exe 正在运行" : "没有在运行");
  const usePort = cfgPort || port;
  if (probe.open && probe.ours) {
    mark(true, `端口 ${usePort} 已监听，且是 WorkBuddy 的窗口`);
  } else if (probe.open && probe.ours === false) {
    mark(false, `端口 ${usePort} 被别的程序占用（${probe.sample || "无页面"}）`);
  } else if (probe.open) {
    mark(true, `端口 ${usePort} 已监听（读不到窗口列表，无法确认身份）`);
  } else {
    mark(false, `端口 ${usePort} 未监听（${probe.detail}）`);
  }

  console.log("");
  if (!cfgPort) {
    console.log(C.dim("  结论：注入没开。跑 bin\\enable-context-menu.cmd。"));
  } else if (probe.open && probe.ours === false) {
    console.log(C.dim(`  结论：端口 ${usePort} 被别人占了，换个端口重跑 enable ${usePort + 1}。`));
  } else if (probe.open && probe.ours) {
    console.log(C.dim("  结论：链路已就绪。注入要 service 在线，点开一次侧栏「会话桥」面板即可。"));
  } else if (env.value || shortcutHasPort || ownOk) {
    console.log(C.dim("  结论：端口没开 —— 当前进程不是带参数启动的（或环境变量那次 appendSwitch 没赶上）。"));
    console.log(C.dim(ownOk
      ? "  托盘退出后，从桌面的「WorkBuddy (Session ID)」图标重开：进程创建时就带参数。"
      : "  先跑一次 enable 生成桌面图标，再托盘退出、从它重开。"));
  } else {
    console.log(C.dim("  结论：没有任何开端口的途径。跑 bin\\enable-context-menu.cmd。"));
  }
  return 0;
}

/* ------------------------------- 入口 ------------------------------- */

function findPortArg(argv) {
  const idx = argv.findIndex((a) => a === "--port");
  if (idx >= 0) return argv[idx + 1];
  return argv.find((a) => /^\d+$/.test(a));
}

const argv = process.argv.slice(2);
const cmd = (argv.find((a) => !a.startsWith("-") && !/^\d+$/.test(a)) || "status").toLowerCase();

// 作为模块被 import（跑测试）时不要执行命令，只导出纯函数。
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const port = parsePort(findPortArg(argv));
  if (!port) {
    console.error(C.bad(`端口不合法：${findPortArg(argv)}（要求 1-65535）`));
    process.exit(2);
  }

  const table = { enable: cmdEnable, disable: cmdDisable, launch: cmdLaunch, status: cmdStatus };
  const fn = table[cmd];
  if (!fn) {
    console.error(C.bad(`未知子命令：${cmd}`));
    console.error("用法：context-menu.mjs [enable|disable|launch|status] [port]");
    process.exit(2);
  }

  const code = await fn(port);
  process.exit(code ?? 0);
}
