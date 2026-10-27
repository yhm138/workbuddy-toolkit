/**
 * 找 WorkBuddy 装在哪、是不是在跑。
 *
 * 抽成独立模块是因为安装器、扩展安装命令、卸载/状态三处都要用。判断逻辑一旦
 * 各写一份，就会出现「安装器说装好了、状态说没找到」这种自相矛盾的输出。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 扩展只能放在这里——宿主只扫这一个目录（bundled 扩展免签名）。 */
export function extensionsDir(root) {
  return path.join(root, 'resources', 'app.asar.unpacked', 'resources', 'extensions');
}

/** 正在跑的 WorkBuddy.exe 路径；没跑或读不到返回空串。 */
export function runningExe() {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)',
      ],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    ).trim();
    return out || '';
  } catch {
    return '';
  }
}

/** 按「最可能命中」排序的候选安装目录。 */
export function candidateRoots(explicit = '') {
  const list = [];
  if (explicit) list.push(path.resolve(explicit));
  if (process.env.WORKBUDDY_ROOT) list.push(path.resolve(process.env.WORKBUDDY_ROOT));

  const running = runningExe();
  if (running) list.push(path.dirname(running));

  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'WorkBuddy'));
    if (process.env.ProgramFiles) list.push(path.join(process.env.ProgramFiles, 'WorkBuddy'));
    if (process.env['ProgramFiles(x86)']) list.push(path.join(process.env['ProgramFiles(x86)'], 'WorkBuddy'));
  } else if (process.platform === 'darwin') {
    list.push('/Applications/WorkBuddy.app/Contents');
  }
  return [...new Set(list.filter(Boolean))];
}

/** 找到带 extensions 目录的那个根；找不到返回 null。 */
export function findRoot(explicit = '') {
  for (const root of candidateRoots(explicit)) {
    try {
      if (fs.existsSync(extensionsDir(root))) return root;
    } catch {
      /* 权限不足就当不存在 */
    }
  }
  return null;
}

/** WorkBuddy.exe 的位置。 */
export function findExe(extra = '') {
  const candidates = [
    extra,
    process.env.WORKBUDDY_EXE,
    runningExe(),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'WorkBuddy', 'WorkBuddy.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'WorkBuddy', 'WorkBuddy.exe'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* 路径非法就跳过 */
    }
  }
  return null;
}

/** 客户端在不在跑。 */
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
