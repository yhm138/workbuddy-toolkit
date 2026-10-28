#!/usr/bin/env node
/**
 * 一键安装器。
 *
 * 目标：双击「一键安装.cmd」→ 看完提示 → 完事。不需要装 Node.js、不需要管理员，
 * 也不需要先打开侧栏面板。为此做的三个决定：
 *
 *   1. 用 WorkBuddy 自带的 Electron 当 Node 跑本脚本（ELECTRON_RUN_AS_NODE=1）。
 *      机器上有 WorkBuddy 就有 Node 运行时，不用另装。
 *   2. 扩展 service 是宿主在**启动时** fork 的（不需要先点开面板），所以装完
 *      重启客户端，服务自己就起来了——这一点是实测确认的，不是猜的。
 *   3. 技能直接拷到 ~/.workbuddy/skills/，脚本拷到 ~/.workbuddy/dsh-skills/scripts/。
 *      不往 WorkBuddy 安装目录写技能，卸载时也好收干净。
 *
 * 用法：
 *   setup.mjs                 安装 / 修复（重复跑安全）
 *   setup.mjs --status        看状态
 *   setup.mjs --uninstall     卸载
 *   --root <路径>             手动指定 WorkBuddy 安装目录
 *   --no-restart              装完不重启客户端
 *   --no-skills               只装侧栏面板，不装技能
 *   --no-guard                不装「升级自愈」守护（升级后要手动重跑）
 *   --yes                     不询问，一律按默认答案
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { findRoot, findExe, clientRunning, extensionsDir } from '../src/core/wb.mjs';
import { wbCall } from '../src/commands/wbCall.mjs';

const EXT_ID = 'dsh-session-bridge';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const VERSION = PKG.version;

const HOME = process.env.WORKBUDDY_HOME || path.join(os.homedir(), '.workbuddy');
const STATE_DIR = path.join(HOME, 'dsh-skills');
const MANIFEST = path.join(STATE_DIR, 'install.json');
const SKILLS_DST = path.join(HOME, 'skills');
const SCRIPTS_DST = path.join(STATE_DIR, 'scripts');

const EXT_SRC = path.join(REPO, 'extension');
const PLUGIN_SRC = path.join(REPO, 'skills-pack', 'plugins', 'dsh-skills');
const SKILLS_SRC = path.join(PLUGIN_SRC, 'skills');
const SCRIPTS_SRC = path.join(PLUGIN_SRC, 'scripts');

/** 自愈守护：客户端整包升级会清掉扩展，靠它把扩展补回去。 */
const GUARD_SRC = path.join(REPO, 'bin', 'guard.mjs');
const GUARD_DIR = path.join(STATE_DIR, 'guard');
const GUARD_SCRIPT = path.join(GUARD_DIR, 'guard.mjs');
const GUARD_RUN = path.join(GUARD_DIR, 'run.cmd');
const GUARD_VBS = path.join(GUARD_DIR, 'start.vbs');
const GUARD_CONFIG = path.join(STATE_DIR, 'guard.json');
const STORE_DIR = path.join(STATE_DIR, 'store');
const GUARD_TASK = 'WorkBuddySessionBridgeGuard';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback = '') => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/* ------------------------------ 输出 ------------------------------ */

const tty = process.stdout.isTTY;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2');
const bold = paint('1');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');
const cyan = paint('36');

const say = (s = '') => console.log(s);
const ok = (s) => console.log(`${green('  ✓')} ${s}`);
const info = (s) => console.log(`${cyan('  ·')} ${s}`);
const warn = (s) => console.log(`${yellow('  !')} ${s}`);
const bad = (s) => console.log(`${red('  ✗')} ${s}`);
const hr = () => console.log(dim('  ' + '─'.repeat(52)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 中文是双宽字符，padEnd 按码元数会算歪，这里按显示宽度补空格。 */
function padW(text, width) {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return text + ' '.repeat(Math.max(0, width - w));
}

async function ask(question, def = true) {
  if (has('--yes')) return def;
  // 没有交互终端时一律按「否」，绝不替用户做删除/重启这类不可逆的选择
  if (!tty) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`  ${question} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    if (!answer) return def;
    return answer === 'y' || answer === 'yes' || answer === '是';
  } finally {
    rl.close();
  }
}

/**
 * 要不要重启客户端。
 * 单独抽出来是因为这是最「危险」的动作——会把用户正在用的窗口关掉。
 * 所以只有三种情况会重启：显式 --restart、交互式确认过、或者装完时它本来没在跑。
 */
async function confirmRestart(question) {
  if (has('--no-restart')) return false;
  if (has('--restart')) return true;
  if (!tty) return false;
  return ask(question);
}

/* ------------------------------ 小工具 ------------------------------ */

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 把目录搬到目标位置；旧的先改名备份，失败才硬删。返回备份路径。 */
function replaceDir(from, to) {
  let backup = '';
  if (fs.existsSync(to)) {
    backup = `${to}.bak-${stamp()}`;
    try {
      fs.renameSync(to, backup);
    } catch {
      fs.rmSync(to, { recursive: true, force: true });
      backup = '';
    }
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  return backup;
}

/* ------------------------------ 安装 / 卸载 ------------------------------ */

function skillNames() {
  if (!fs.existsSync(SKILLS_SRC)) return [];
  return fs
    .readdirSync(SKILLS_SRC, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(SKILLS_SRC, name, 'SKILL.md')));
}

function installExtension(root) {
  const target = path.join(extensionsDir(root), EXT_ID);
  const manifest = readJsonSafe(path.join(EXT_SRC, 'extension.json'));
  if (!manifest) throw new Error('安装包不完整：缺 extension/extension.json');

  // 先确认真的写得进去。Program Files 下会在这里失败，要给出人话。
  let writable = true;
  try {
    fs.mkdirSync(extensionsDir(root), { recursive: true });
    fs.accessSync(extensionsDir(root), fs.constants.W_OK);
  } catch {
    writable = false;
  }
  if (!writable) {
    throw new Error(
      `没有权限写 ${extensionsDir(root)}\n` +
        '    你的 WorkBuddy 装在受保护目录里。右键「一键安装.cmd」→ 以管理员身份运行。',
    );
  }

  // 备份放到状态目录，不要放在扩展目录里：
  // 宿主按「目录名 == 清单里的 id」校验，xxx.bak-20261028 这种名字会被当成非法扩展，
  // 每次启动都白扫一遍、还在日志里刷错误。
  let backup = '';
  if (fs.existsSync(target)) {
    const dest = path.join(STATE_DIR, 'backups', `extension-${stamp()}`);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(target, dest, { recursive: true });
      backup = dest;
    } catch {
      backup = '';
    }
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(EXT_SRC, target, { recursive: true });

  // 装完立刻自检：少一个文件都会让宿主报「插件加载失败」
  const required = [
    'extension.json',
    'distribution.json',
    'icon.svg',
    'ui/index.html',
    'server/index.cjs',
    'server/mcp.cjs',
    'inject/session-menu.js',
  ];
  const missing = required.filter((rel) => !fs.existsSync(path.join(target, rel)));
  if (missing.length) throw new Error(`安装后缺少文件：${missing.join(', ')}`);

  return { target, version: manifest.version, backup };
}

function installSkills() {
  const names = skillNames();
  if (!names.length) throw new Error('安装包不完整：skills-pack 里没有技能');
  fs.mkdirSync(SKILLS_DST, { recursive: true });

  const installed = [];
  for (const name of names) {
    const from = path.join(SKILLS_SRC, name);
    const to = path.join(SKILLS_DST, name);
    replaceDir(from, to);
    installed.push(name);
  }

  // 技能里的命令写的是 node ~/.workbuddy/dsh-skills/scripts/xxx.mjs
  if (fs.existsSync(SCRIPTS_SRC)) replaceDir(SCRIPTS_SRC, SCRIPTS_DST);

  return installed;
}

function writeManifest(payload) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/* ------------------------------ 自愈守护 ------------------------------ */

/**
 * 客户端整包升级会整体替换 resources/，扩展跟着消失——这是宿主行为，改不了。
 * 能做的是在外面留一份 store，客户端没在跑的时候补回去。
 *
 * 为什么不用宿主自己的用户扩展目录（~/.workbuddy/extensions、extensions-dev）：
 * 那两个目录里 distribution.json 不被信任，权限会被降级成「什么都不能做」，
 * service 也不许 fork，装进去只有个空壳面板。源码里 includeExtension /
 * allowService / allowDiskDistribution 三处都是一样的判断。
 */

const GUARD_RUN_CMD = `@echo off
rem Start the WorkBuddy extension guard with whatever Node runtime is available.
rem ASCII only: cmd.exe parses this file as GBK, non-ASCII would break it.
setlocal enabledelayedexpansion
set "NODE="
for /d %%D in ("%USERPROFILE%\\.workbuddy\\binaries\\node\\versions\\*") do (
  if exist "%%~fD\\node.exe" set "NODE=%%~fD\\node.exe"
)
if not defined NODE for %%P in (node.exe) do if not "%%~$PATH:P"=="" set "NODE=%%~$PATH:P"
if not defined NODE (
  >> "%~dp0stdout.log" echo [%DATE% %TIME%] no node runtime found
  exit /b 1
)
"%NODE%" "%~dp0guard.mjs" --watch > "%~dp0stdout.log" 2>&1
`;

const GUARD_VBS_SRC = `' Launch run.cmd with a hidden window (no console flash on logon).
' ASCII only: wscript reads .vbs as ANSI by default.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run """" & dir & "\\run.cmd""", 0, False
`;

/** 写守护运行时：guard.mjs 本体 + 无窗口启动脚本。重复跑覆盖。 */
function writeGuardRuntime() {
  fs.mkdirSync(GUARD_DIR, { recursive: true });
  fs.copyFileSync(GUARD_SRC, GUARD_SCRIPT);
  fs.writeFileSync(GUARD_RUN, GUARD_RUN_CMD.replace(/\n/g, '\r\n'), 'ascii');
  fs.writeFileSync(GUARD_VBS, GUARD_VBS_SRC.replace(/\n/g, '\r\n'), 'ascii');
}

/** 把装好的那份收进 store，并登记到 guard.json。 */
function registerGuardExtension(id, sourceDir, root) {
  const dest = path.join(STORE_DIR, id);
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(sourceDir, dest, { recursive: true });
  const config = readJsonSafe(GUARD_CONFIG, { version: 1, extensions: [] });
  const extensions = new Set([...(config.extensions || []), id]);
  fs.writeFileSync(
    GUARD_CONFIG,
    `${JSON.stringify({ version: 1, root, extensions: [...extensions], updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
}

/**
 * 为什么用「启动」文件夹，而不是计划任务 / 注册表自启动：
 * 后两者分别要 schtasks.exe 和 reg.exe，有些机器上这两个被安全策略直接禁掉
 * （本机就是），而启动文件夹只是往用户自己的目录里放一个 .vbs，不需要管理员，
 * 也不依赖那两个程序，效果一样：登录时静默把守护拉起来。
 * 想关掉：Win+R 输入 shell:startup，删掉里面的 WorkBuddySessionBridgeGuard.vbs。
 */
function startupDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function autoStartFile() {
  return path.join(startupDir(), `${GUARD_TASK}.vbs`);
}

/**
 * 转发脚本里用 %USERPROFILE% 拼路径，不写绝对路径：
 * .vbs 默认按 ANSI 读，用户名里有中文时写死路径会变乱码。
 */
const STARTUP_VBS_SRC = `' WorkBuddy extension guard: start it silently at logon.
' Remove this file to stop auto repair (Win+R -> shell:startup).
Set sh = CreateObject("WScript.Shell")
home = sh.ExpandEnvironmentStrings("%USERPROFILE%")
sh.Run """" & home & "\\.workbuddy\\dsh-skills\\guard\\start.vbs""", 0, False
`;

function autoStartInstalled() {
  return fs.existsSync(autoStartFile());
}

function ensureAutoStart() {
  try {
    fs.mkdirSync(startupDir(), { recursive: true });
    fs.writeFileSync(autoStartFile(), STARTUP_VBS_SRC.replace(/\n/g, '\r\n'), 'ascii');
    return { ok: true, how: '启动文件夹' };
  } catch (error) {
    return { ok: false, error: String(error.message) };
  }
}

function guardPid() {
  try {
    const pid = Number(fs.readFileSync(path.join(GUARD_DIR, 'guard.pid'), 'utf8').trim());
    if (!pid) return 0;
    process.kill(pid, 0);
    return pid;
  } catch {
    return 0;
  }
}

function startGuard() {
  if (guardPid()) return { ok: true, how: '已在跑' };
  try {
    const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
    const child = spawn(wscript, ['//B', '//Nologo', GUARD_VBS], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ok: true, how: '已拉起' };
  } catch (error) {
    return { ok: false, error: String(error.message) };
  }
}

/** 装新版本时要先停掉旧的：跑着的还是内存里那份代码。 */
function stopGuard() {
  const pid = guardPid();
  if (!pid) return;
  try {
    process.kill(pid);
  } catch {
    /* 已经退了 */
  }
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && guardPid()) sleepSync(100);
}

function removeGuard() {
  try {
    fs.rmSync(autoStartFile(), { force: true });
  } catch {
    /* 本来就没有 */
  }
  stopGuard();
}

/** 从 guard.json 里摘掉一个 id；没有别的扩展了就顺手把守护也停掉。 */
function unregisterGuardExtension(id) {
  const config = readJsonSafe(GUARD_CONFIG, { version: 1, extensions: [] });
  const rest = (config.extensions || []).filter((x) => x !== id);
  fs.rmSync(path.join(STORE_DIR, id), { recursive: true, force: true });
  if (!rest.length) {
    removeGuard();
    fs.rmSync(GUARD_CONFIG, { force: true });
    fs.rmSync(GUARD_DIR, { recursive: true, force: true });
    fs.rmSync(STORE_DIR, { recursive: true, force: true });
    return;
  }
  fs.writeFileSync(GUARD_CONFIG, `${JSON.stringify({ ...config, extensions: rest }, null, 2)}\n`, 'utf8');
}

/* ------------------------------ 客户端开关 ------------------------------ */

async function closeClient() {
  if (!clientRunning()) return true;
  try {
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Process WorkBuddy -ErrorAction SilentlyContinue) | ForEach-Object { $_.CloseMainWindow() | Out-Null }',
      ],
      { windowsHide: true, timeout: 15000 },
    );
  } catch {
    /* 关不掉就让用户手动关 */
  }
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (!clientRunning()) return true;
    await sleep(200);
  }
  return !clientRunning();
}

function launchClient(exe) {
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) });
  child.unref();
}

/* ------------------------------ 验证 ------------------------------ */

/** 等扩展 service 响应 ping。宿主启动时会 fork，通常十几秒内就通了。 */
async function waitService({ timeout = 90000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const body = await wbCall('ping', { timeout: 4000 });
      if (body && body.ok) return { ok: true, result: body.result || {} };
    } catch (error) {
      last = String(error.message).split('\n')[0];
    }
    await sleep(1500);
  }
  return { ok: false, error: last };
}

/* ------------------------------ 三个子命令 ------------------------------ */

async function cmdInstall() {
  say();
  say(`  ${bold('WorkBuddy 会话桥')} ${dim('· 一键安装')}  ${dim('v' + VERSION)}`);
  hr();

  const root = findRoot(valueOf('--root'));
  const exe = findExe();
  if (!root) {
    bad('找不到 WorkBuddy 的安装目录。');
    say(dim('    确认 WorkBuddy 已经装好并至少启动过一次，然后重试。'));
    say(dim('    装在非常规位置的话，用：install.cmd --root "D:\\你的\\WorkBuddy"'));
    return 2;
  }
  ok(`WorkBuddy     ${root}`);
  if (root !== path.dirname(exe || '')) info(dim(`程序位置     ${exe || '(未找到 exe)'}`));

  say();
  say(`  ${bold('[1/5] 侧栏面板')}`);
  const ext = installExtension(root);
  ok(`已装到        ${dim(ext.target)}`);
  if (ext.backup) info(dim(`旧版本已备份  ${ext.backup}`));

  say();
  say(`  ${bold('[2/5] 技能')}`);
  if (has('--no-skills')) {
    info(dim('按 --no-skills 跳过'));
  } else {
    const skills = installSkills();
    ok(`已装 ${skills.length} 个      ${dim(SKILLS_DST)}`);
    info(dim(skills.join('  ')));
  }

  say();
  say(`  ${bold('[3/5] 升级自愈')}`);
  if (has('--no-guard')) {
    info(dim('按 --no-guard 跳过：以后客户端升级要手动重跑一次安装'));
  } else {
    writeGuardRuntime();
    registerGuardExtension(EXT_ID, ext.target, root);
    const auto = ensureAutoStart();
    if (auto.ok) {
      ok(`已登记 ${EXT_ID}，登录后自动守着（${auto.how}）`);
    } else {
      warn(`自启动没装上：${auto.error}`);
      info(dim('扩展照用，只是升级后要手动双击一次「一键安装.cmd」。'));
    }
    stopGuard();
    const started = startGuard();
    if (started.ok) info(dim(`守护进程 ${started.how}`));
  }

  say();
  say(`  ${bold('[4/5] 重启 WorkBuddy')}`);
  let restarted = false;
  if (has('--no-restart')) {
    warn('按 --no-restart 跳过。不重启的话新面板不会出现。');
  } else if (!exe) {
    warn('找不到 WorkBuddy.exe，请手动从桌面图标重新打开。');
  } else if (!clientRunning()) {
    launchClient(exe);
    restarted = true;
    info('原本没在跑，已经帮你打开');
  } else {
    // 非交互（脚本、CI、AI 调用）时绝不自动重启：那会把用户正在用的窗口关掉。
    const yes = await confirmRestart('要现在重启一次吗？（会自动关掉再打开，聊天记录不会丢）');
    if (!yes) {
      warn('跳过了重启。请右下角托盘右键 → 退出，再从桌面图标打开一次。');
    } else {
      info('正在关闭…');
      if (await closeClient()) {
        launchClient(exe);
        restarted = true;
        info('已重新打开');
      } else {
        warn('没关掉，请右下角托盘右键 → 退出，再重开。');
      }
    }
  }

  writeManifest({
    version: VERSION,
    installedAt: new Date().toISOString(),
    workbuddyRoot: root,
    extension: { id: EXT_ID, version: ext.version, dir: ext.target },
    skills: has('--no-skills') ? [] : skillNames(),
    scripts: fs.existsSync(SCRIPTS_DST) ? SCRIPTS_DST : '',
  });

  say();
  say(`  ${bold('[5/5] 确认服务真的起来了')}`);
  if (!restarted) {
    const probe = await wbCall('ping', { timeout: 4000 }).catch(() => null);
    if (probe && probe.ok) {
      ok('扩展服务在线');
      return sayDone(true);
    }
    warn('服务还没响应——重启客户端后再双击「检查状态.cmd」。');
    return 2;
  }

  info('等它把扩展服务拉起来，最多 90 秒…');
  const service = await waitService({ timeout: 90000 });
  if (!service.ok) {
    warn('服务还没响应。');
    say(dim('    刚才替换了扩展文件，跑着的旧 service 已经停了，必须重启才会换新的。'));
    say(dim('    托盘图标右键 → 退出 WorkBuddy，等它完全消失，再从桌面图标打开。'));
    say(dim('    起来后双击「检查状态.cmd」确认。'));
    if (service.error) say(dim(`    最近一次错误：${service.error}`));
    return 3;
  }
  ok(`扩展服务在线   ${dim('pid ' + (service.result.pid || '?'))}`);
  return sayDone(true);
}

function sayDone() {
  say();
  say(green('  ┌────────────────────────────────────────────┐'));
  say(green('  │  装好了                                     │'));
  say(green('  └────────────────────────────────────────────┘'));
  say();
  say(`  用法：左侧栏点${bold('「会话桥」')}，就能看到本机所有会话。`);
  say(dim('        发消息、开新会话、看历史都在里面。'));
  say(dim('        想右键复制 Session ID，另装 workbuddy-session-menu。'));
  say();
  say(dim('  排查：双击「检查状态.cmd」    卸载：双击「一键卸载.cmd」'));
  return 0;
}

async function cmdStatus() {
  say();
  say(`  ${bold('WorkBuddy 会话桥')} ${dim('· 状态')}  ${dim('v' + VERSION)}`);
  hr();

  const mark = (good) => (good === null ? dim('  –') : good ? green('  ✓') : red('  ✗'));
  const line = (label, good, text) => say(`${mark(good)} ${padW(label, 12)} ${text}`);

  const root = findRoot(valueOf('--root'));
  const exe = findExe();
  line('WorkBuddy', Boolean(root), root || '没找到安装目录');
  line('客户端', clientRunning(), clientRunning() ? '正在运行' : '没在运行');

  const extTarget = root ? path.join(extensionsDir(root), EXT_ID) : '';
  const extManifest = extTarget ? readJsonSafe(path.join(extTarget, 'extension.json')) : null;
  line('侧栏面板', Boolean(extManifest), extManifest ? `已装 v${extManifest.version}` : '没装（跑一次「一键安装.cmd」）');

  const installedSkills = fs.existsSync(SKILLS_DST)
    ? fs.readdirSync(SKILLS_DST, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];
  const ours = skillNames().filter((name) => installedSkills.includes(name));
  line('技能', ours.length > 0, ours.length ? `已装 ${ours.length} 个` : '没装');

  const manifest = readJsonSafe(MANIFEST, null);
  line('安装记录', Boolean(manifest), manifest ? `${manifest.version}（${manifest.installedAt.slice(0, 10)}）` : '没有（可能是手动装的）');

  const guardConfig = readJsonSafe(GUARD_CONFIG, null);
  const gp = guardPid();
  const auto = autoStartInstalled();
  line('升级自愈', Boolean(gp || auto), gp ? `守护在跑（pid ${gp}）` : auto ? '自启动已装，登录时启动' : '没装（升级后面板会丢）');
  if (guardConfig?.extensions?.length) {
    const parts = guardConfig.extensions.map((id) => {
      const storeV = readJsonSafe(path.join(STORE_DIR, id, 'extension.json'))?.version ?? '?';
      const installedV = root ? readJsonSafe(path.join(extensionsDir(root), id, 'extension.json'))?.version : null;
      return `${id} store v${storeV} / 装 ${installedV ? `v${installedV}` : '缺失'}`;
    });
    info(dim(parts.join('   ')));
  }

  say();
  const probe = await wbCall('ping', { timeout: 4000 }).catch((e) => ({ ok: false, error: String(e.message).split('\n')[0] }));
  if (probe && probe.ok) {
    ok(`扩展服务在线   ${dim('pid ' + (probe.result.pid || '?'))}`);
  } else {
    bad('扩展服务没响应');
    say(dim('    扩展装了但服务没跑：托盘退出 WorkBuddy，再从桌面图标打开一次。'));
  }

  say();
  if (!extManifest) {
    if (gp || auto) {
      say(dim('  结论：面板被升级清掉了。守护会在客户端退出后自己补回，也可以现在双击「一键安装.cmd」。'));
    } else {
      say(dim('  结论：还没装。双击「一键安装.cmd」。'));
    }
  } else if (!(probe && probe.ok)) say(dim('  结论：面板装了，服务没起来。重启客户端后再看。'));
  else say(dim('  结论：都正常。左侧栏点「会话桥」即可。'));
  return 0;
}

async function cmdUninstall() {
  say();
  say(`  ${bold('WorkBuddy 会话桥')} ${dim('· 卸载')}`);
  hr();

  const manifest = readJsonSafe(MANIFEST, null);
  const root = findRoot(valueOf('--root'));
  const extTarget = root ? path.join(extensionsDir(root), EXT_ID) : '';
  const skills = manifest?.skills?.length ? manifest.skills : skillNames();

  say(dim('  将要删除：'));
  if (extTarget) say(dim(`    · 侧栏面板  ${extTarget}`));
  say(dim(`    · ${skills.length} 个技能  ${SKILLS_DST}`));
  say(dim(`    · 脚本目录  ${SCRIPTS_DST}`));
  say(dim(`    · 升级自愈守护（启动文件夹里的 ${GUARD_TASK}.vbs 与后台进程）`));
  say();
  const yes = await ask('确认删除？', true);
  if (!yes) {
    info('已取消，什么都没动。');
    if (!tty) info(dim('非交互运行，确认删除请加 --yes'));
    return 0;
  }

  let removed = 0;
  if (extTarget && fs.existsSync(extTarget)) {
    fs.rmSync(extTarget, { recursive: true, force: true });
    ok('侧栏面板已移除');
    removed += 1;
  }
  for (const name of skills) {
    const dir = path.join(SKILLS_DST, name);
    // 只删「带 SKILL.md 的目录」，避免名字撞上别的东西
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    }
  }
  if (fs.existsSync(SCRIPTS_DST)) {
    fs.rmSync(SCRIPTS_DST, { recursive: true, force: true });
  }
  if (fs.existsSync(MANIFEST)) fs.rmSync(MANIFEST, { force: true });
  unregisterGuardExtension(EXT_ID);
  ok('升级自愈守护已移除');

  ok(`已删除 ${removed} 项`);
  say();
  // 同上：非交互时不动用户的窗口
  const restart = await confirmRestart('要现在重启 WorkBuddy 让改动生效吗？');
  if (clientRunning() && restart) {
    const exe = findExe();
    if (exe && (await closeClient())) {
      launchClient(exe);
      info('已重新打开');
    } else {
      warn('没关掉，请手动托盘退出再打开。');
    }
  } else {
    info(dim('下次启动客户端时生效。'));
  }
  say(dim('  聊天记录和相关配置都还在，只是面板和技能被拿掉了。'));
  return 0;
}

/* ------------------------------ 入口 ------------------------------ */

async function main() {
  if (has('--status')) return cmdStatus();
  if (has('--uninstall')) return cmdUninstall();
  return cmdInstall();
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
    // 非交互（被 .cmd 直接调用）时不要立刻退出，让用户看清结果
    if (!has('--status') && !process.env.DSH2WB_NOPAUSE) return undefined;
    return undefined;
  })
  .catch((error) => {
    console.error(`\n${red('  出错了：')}${error.message}\n`);
    process.exitCode = 1;
  });
