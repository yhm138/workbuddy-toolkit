#!/usr/bin/env node
/**
 * 自愈守护：客户端整包升级会把 resources/ 整个换掉，装在这个目录里的扩展跟着消失。
 *
 * 做法和「扩展能不能换个地方放」有关，先把结论写在这儿：
 *   - 宿主只把 <安装目录>/resources/app.asar.unpacked/resources/extensions 当作
 *     bundled 扩展目录，而这个目录正是升级时被整体替换的；
 *   - ~/.workbuddy/extensions 与 ~/.workbuddy/extensions-dev 虽然也会被扫描，但
 *     里面的 distribution.json 不被信任（权限降级成没有任何授权的 platform），
 *     service 也不许跑，等于只有个空壳面板；
 *   - 所以唯一能完整工作的位置就是那个会被升级清掉的目录，只能在外面守着它。
 *
 * 守护进程干的事很小：客户端没在跑的时候，检查每个登记的扩展是否还在、版本对不对，
 * 不在就从 ~/.workbuddy/dsh-skills/store/<id> 复原回去。2 秒一轮，所以升级脚本
 * 刚把目录删掉、还没来得及拉起新客户端时，我们就补回去了——下一次启动就有面板。
 *
 * 这个文件会被复制到 ~/.workbuddy/dsh-skills/guard/guard.mjs 后独立运行，所以
 * 不 import 仓库里的任何模块。
 *
 * 用法（复制到状态目录后）：
 *   guard.mjs --watch                 常驻（计划任务用这个）
 *   guard.mjs --once                  只检查一次，命令行排查用
 *   guard.mjs --status                看登记了哪些扩展、现在健不健康
 *   guard.mjs --add <id> --from <dir> 把一个扩展收进 store 并登记
 *   guard.mjs --remove <id>           取消登记（不删已装的那份）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EXT_MARKER = '.guard-installed.json';
export const TASK_NAME = 'WorkBuddySessionBridgeGuard';

const HOME = process.env.WORKBUDDY_HOME || path.join(os.homedir(), '.workbuddy');
export const STATE_DIR = path.join(HOME, 'dsh-skills');
export const STORE_DIR = path.join(STATE_DIR, 'store');
export const GUARD_DIR = path.join(STATE_DIR, 'guard');
export const CONFIG_FILE = path.join(STATE_DIR, 'guard.json');
export const LOG_FILE = path.join(GUARD_DIR, 'guard.log');
const PID_FILE = path.join(GUARD_DIR, 'guard.pid');
const LOG_LIMIT = 256 * 1024;

/* ------------------------------ 路径与进程 ------------------------------ */

export function extensionsDir(root) {
  return path.join(root, 'resources', 'app.asar.unpacked', 'resources', 'extensions');
}

export function candidateRoots(explicit = '') {
  const list = [];
  if (explicit) list.push(path.resolve(explicit));
  if (process.env.WORKBUDDY_ROOT) list.push(path.resolve(process.env.WORKBUDDY_ROOT));
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'WorkBuddy'));
    if (process.env.ProgramFiles) list.push(path.join(process.env.ProgramFiles, 'WorkBuddy'));
    if (process.env['ProgramFiles(x86)']) {
      list.push(path.join(process.env['ProgramFiles(x86)'], 'WorkBuddy'));
    }
  } else if (process.platform === 'darwin') {
    list.push('/Applications/WorkBuddy.app/Contents');
  }
  return [...new Set(list.filter(Boolean))];
}

export function findRoot(explicit = '') {
  for (const root of candidateRoots(explicit)) {
    try {
      if (fs.existsSync(extensionsDir(root))) return root;
    } catch {
      /* 权限不足当不存在 */
    }
  }
  return null;
}

export function clientRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq WorkBuddy.exe', '/NH'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    return /WorkBuddy\.exe/i.test(out);
  } catch {
    return false;
  }
}

/* ------------------------------ 日志 ------------------------------ */

let logBytes = 0;

export function log(message) {
  const line = `${new Date().toISOString()}  ${message}\n`;
  try {
    fs.mkdirSync(GUARD_DIR, { recursive: true });
    if (!logBytes) {
      logBytes = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
    }
    if (logBytes > LOG_LIMIT) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
      logBytes = 0;
    }
    fs.appendFileSync(LOG_FILE, line, 'utf8');
    logBytes += Buffer.byteLength(line);
  } catch {
    /* 日志写不进去也不能让守护挂掉 */
  }
}

/* ------------------------------ 配置与 store ------------------------------ */

export function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { version: 1, root: '', extensions: [], ...raw, extensions: raw.extensions ?? [] };
  } catch {
    return { version: 1, root: '', extensions: [] };
  }
}

export function writeConfig(config) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const payload = { ...config, version: 1, updatedAt: new Date().toISOString() };
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** store 里这一份的版本；没有或读不出来返回空串。 */
export function storeVersion(id) {
  return readJsonSafe(path.join(STORE_DIR, id, 'extension.json'))?.version ?? '';
}

/**
 * 装好的那份健不健康。
 *   ok      版本一致、关键文件都在
 *   missing 目录没了（升级后的常态）
 *   stale   版本还是旧的
 *   broken  目录在但缺文件（拷一半、被杀掉）
 */
export function health(target, version) {
  try {
    if (!fs.existsSync(target)) return 'missing';
    const manifest = readJsonSafe(path.join(target, 'extension.json'));
    if (!manifest) return 'broken';
    if (version && manifest.version !== version) return 'stale';
    const required = ['extension.json', 'distribution.json', 'ui/index.html'];
    if (manifest.service?.entry) required.push(String(manifest.service.entry).replace(/^\.\//, ''));
    if (required.some((rel) => !fs.existsSync(path.join(target, rel)))) return 'broken';
    return 'ok';
  } catch {
    return 'broken';
  }
}

/** 先拷到临时目录再换名，避免宿主启动时正好读到拷了一半的扩展。 */
export function repairOne(id, target, version) {
  const source = path.join(STORE_DIR, id);
  if (!fs.existsSync(path.join(source, 'extension.json'))) {
    log(`skip ${id}: store 里没有这一份`);
    return false;
  }
  const tmp = `${target}.guard-tmp-${process.pid}`;
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, tmp, { recursive: true });
    fs.writeFileSync(
      path.join(tmp, EXT_MARKER),
      `${JSON.stringify({ id, version, restoredAt: new Date().toISOString(), by: 'dsh2wb-guard' }, null, 2)}\n`,
      'utf8',
    );
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(tmp, target);
    log(`restored ${id} v${version} → ${target}`);
    return true;
  } catch (error) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* 清不掉就留着，下次会覆盖 */
    }
    log(`failed ${id}: ${error?.message ?? error}`);
    return false;
  }
}

/**
 * 一轮检查。
 *
 * 客户端在跑的时候分两种：
 *   - 目录整个没了（升级后的常态）：可以放心拷回去。宿主这次启动根本没加载过它，
 *     不存在「按旧快照取文件」的问题，拷进去至少下次启动是好的；
 *   - 目录在但版本旧/缺文件：不动。宿主可能正拿着它跑，运行期换文件只会加载失败。
 */
export function sweep(config = readConfig(), options = {}) {
  const running = options.running ?? clientRunning();
  const root = options.root ?? findRoot(config.root);
  const results = [];
  if (!root) {
    results.push({ id: '*', action: 'no-root' });
    return { running, root: '', results };
  }
  for (const id of config.extensions) {
    const version = storeVersion(id);
    const target = path.join(extensionsDir(root), id);
    const state = health(target, version);
    if (state === 'ok') {
      results.push({ id, action: 'ok', version });
      continue;
    }
    if (running && state !== 'missing') {
      results.push({ id, action: `skip-running:${state}`, version });
      continue;
    }
    const repaired = repairOne(id, target, version);
    results.push({ id, action: repaired ? `repaired:${state}` : `failed:${state}`, version });
  }
  return { running, root, results };
}

/* ------------------------------ 子命令 ------------------------------ */

function copyIntoStore(id, from) {
  const manifest = readJsonSafe(path.join(from, 'extension.json'));
  if (!manifest?.id) throw new Error(`${from} 里没有 extension.json`);
  if (manifest.id !== id) throw new Error(`id 对不上：目录里是 ${manifest.id}，参数是 ${id}`);
  const dest = path.join(STORE_DIR, id);
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(from, dest, { recursive: true });
  return manifest;
}

/** 已经在跑的守护（同一份状态目录）就返回它的 pid。 */
export function runningPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (!pid) return 0;
    process.kill(pid, 0);
    return pid;
  } catch {
    return 0;
  }
}

function cmdAdd(argv) {
  const id = valueOf(argv, '--add');
  const from = valueOf(argv, '--from');
  if (!id || !from) throw new Error('用法：--add <id> --from <扩展目录>');
  const manifest = copyIntoStore(id, path.resolve(from));
  const config = readConfig();
  if (!config.extensions.includes(id)) config.extensions.push(id);
  writeConfig(config);
  console.log(`✓ 已登记 ${id} v${manifest.version} → ${path.join(STORE_DIR, id)}`);
  return 0;
}

function cmdRemove(argv) {
  const id = valueOf(argv, '--remove');
  if (!id) throw new Error('用法：--remove <id>');
  const config = readConfig();
  config.extensions = config.extensions.filter((x) => x !== id);
  writeConfig(config);
  console.log(`已取消登记 ${id}（已装到客户端的那份没动，store 也留着）`);
  return 0;
}

function cmdStatus() {
  const config = readConfig();
  const root = findRoot(config.root);
  console.log('');
  console.log('  扩展自愈守护');
  console.log(`  安装目录    ${root || '没找到'}`);
  console.log(`  客户端      ${clientRunning() ? '正在运行' : '没在运行'}`);
  console.log(`  登记的扩展  ${config.extensions.length ? config.extensions.join(', ') : '（空）'}`);
  const pid = runningPid();
  console.log(`  守护进程    ${pid ? `在跑（pid ${pid}）` : '没在跑'}`);
  for (const id of config.extensions) {
    const version = storeVersion(id);
    const target = root ? path.join(extensionsDir(root), id) : '';
    const state = target ? health(target, version) : 'no-root';
    console.log(`  · ${id.padEnd(20)} store v${version || '?'}  安装处 ${state}`);
  }
  console.log('');
  return 0;
}

function cmdOnce() {
  const { root, running, results } = sweep();
  if (!root) {
    console.log('没找到 WorkBuddy 安装目录，跳过');
    return 0;
  }
  const acted = results.filter((r) => r.action.startsWith('repaired') || r.action.startsWith('failed'));
  if (!acted.length) {
    const skipped = results.filter((r) => r.action.startsWith('skip-running'));
    if (skipped.length) {
      for (const r of skipped) console.log(`${r.id}: ${r.action}（客户端正开着它，先不动）`);
    } else {
      console.log('都是好的，没动');
    }
    return 0;
  }
  for (const r of acted) console.log(`${r.id}: ${r.action}`);
  if (running) console.log('客户端正在运行，补进去的这份下次启动生效');
  return 0;
}

function cmdWatch() {
  const existing = runningPid();
  if (existing && existing !== process.pid) {
    console.log(`已经有守护在跑（pid ${existing}），本进程退出`);
    return 0;
  }
  fs.mkdirSync(GUARD_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  log(`guard start pid=${process.pid} node=${process.version}`);
  const cleanup = () => {
    try {
      if (fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.rmSync(PID_FILE, { force: true });
    } catch {
      /* 已经没了 */
    }
  };
  process.on('exit', cleanup);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      log(`guard stop (${signal})`);
      process.exit(0);
    });
  }

  let lastMissingRoot = 0;
  const tick = () => {
    try {
      const config = readConfig();
      if (!config.extensions.length) return;
      if (!findRoot(config.root)) {
        if (Date.now() - lastMissingRoot > 60000) {
          log('找不到 WorkBuddy 安装目录，等它出现');
          lastMissingRoot = Date.now();
        }
        return;
      }
      // repairOne 自己会记日志（成功和失败都记），这里只管触发
      sweep(config);
    } catch (error) {
      log(`tick error: ${error?.message ?? error}`);
    }
  };

  // 启动时先同步跑一轮：登录时通常客户端还没起来，正好补上上一次升级的缺口
  tick();
  setInterval(tick, 2000);
  return null;
}

function valueOf(argv, flag, fallback = '') {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function main(argv) {
  if (argv.includes('--status')) return cmdStatus();
  if (argv.includes('--add')) return cmdAdd(argv);
  if (argv.includes('--remove')) return cmdRemove(argv);
  if (argv.includes('--once')) return cmdOnce();
  return cmdWatch();
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const code = main(process.argv.slice(2));
    if (code !== null) process.exitCode = code;
  } catch (error) {
    log(`fatal: ${error?.message ?? error}`);
    console.error(error?.message ?? error);
    process.exitCode = 1;
  }
}
