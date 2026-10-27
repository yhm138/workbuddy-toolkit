import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function expandHome(input) {
  if (!input) return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function workbuddyHome() {
  return expandHome(process.env.WORKBUDDY_HOME || path.join(os.homedir(), '.workbuddy'));
}

export function dshHome() {
  return expandHome(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
}

export function resolveFromCwd(input) {
  return path.resolve(process.cwd(), expandHome(input));
}

/** Hides machine-specific absolute paths so reports can be committed publicly. */
export function sanitizePaths(text, extra = []) {
  let out = String(text);
  const home = os.homedir();
  out = out.split(home).join('<HOME>');
  out = out.split(home.replace(/\\/g, '/')).join('<HOME>');
  out = out.replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+/g, '<USERPROFILE>');
  out = out.replace(/[A-Za-z]:[\\/]+Software[\\/]+DeepSeekHarness/gi, '<DSH_ROOT>');
  for (const item of extra) {
    if (!item) continue;
    out = out.split(item).join('<DSH_PROFILE>');
    out = out.split(item.replace(/\\/g, '/')).join('<DSH_PROFILE>');
  }
  return out;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
}

export function copyDir(from, to) {
  ensureDir(to);
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
}

export function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export function timestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
