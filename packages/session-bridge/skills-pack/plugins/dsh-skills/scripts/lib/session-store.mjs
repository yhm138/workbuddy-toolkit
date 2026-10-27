/**
 * Shared session-store helpers for the DSH bundle skills.
 *
 * DSH writes `session.v4.jsonl.zstd` as a sequence of independent zstd frames
 * (one per append), which Node's zlib only decodes for the first frame. We split
 * on the frame magic and decode each frame, falling back to a wider slice when a
 * payload happens to contain the magic bytes.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function sessionsRoot() {
  return path.join(dshHome(), 'sessions');
}

export function decodeZstdFrames(buffer) {
  const starts = [];
  let from = 0;
  while (true) {
    const index = buffer.indexOf(MAGIC, from);
    if (index < 0) break;
    starts.push(index);
    from = index + MAGIC.length;
  }
  if (starts.length === 0) {
    // Maybe a single frame without detectable magic (or not zstd at all).
    return zlib.zstdDecompressSync(buffer);
  }
  if (starts[0] !== 0) starts.unshift(0);

  const chunks = [];
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i];
    let end = starts[i + 1] ?? buffer.length;
    let decoded = null;
    for (let attempt = 0; attempt < 4 && end <= buffer.length; attempt += 1) {
      try {
        decoded = zlib.zstdDecompressSync(buffer.subarray(start, end));
        break;
      } catch {
        // The slice cut through a frame; extend to the next boundary and retry.
        end = starts[i + 1 + attempt + 1] ?? buffer.length;
      }
    }
    if (decoded) chunks.push(decoded);
  }
  return Buffer.concat(chunks);
}

export function readSessionFile(file) {
  const buffer = fs.readFileSync(file);
  const text = file.endsWith('.zstd')
    ? decodeZstdFrames(buffer).toString('utf8')
    : buffer.toString('utf8');
  return parseJsonl(text);
}

export function parseJsonl(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A torn final line is normal for append-only logs; skip it.
    }
  }
  return events;
}

/** Lists every session directory under ~/.dsh/sessions (one level of workspace dirs). */
export function listSessionDirs() {
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const workspace of fs.readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const workspacePath = path.join(root, workspace.name);
    for (const session of fs.readdirSync(workspacePath, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const dir = path.join(workspacePath, session.name);
      const file = findSessionFile(dir);
      if (!file) continue;
      out.push({
        workspace: workspace.name,
        workspacePath,
        dir,
        id: session.name,
        file,
        mtimeMs: fs.statSync(file).mtimeMs,
      });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function findSessionFile(dir) {
  for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl']) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function findSession(idOrPath) {
  if (fs.existsSync(idOrPath)) {
    return { id: path.basename(path.dirname(idOrPath)) || idOrPath, file: idOrPath };
  }
  const match = listSessionDirs().find((item) => item.id === idOrPath || item.id === `session-${idOrPath}`);
  if (!match) {
    // Accept a unique prefix.
    const byPrefix = listSessionDirs().filter((item) => item.id.includes(idOrPath));
    if (byPrefix.length === 1) return byPrefix[0];
    throw new Error(`找不到会话：${idOrPath}`);
  }
  return match;
}

export function sessionTitles() {
  const file = path.join(dshHome(), 'token-usage', 'sessions.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function textOf(message) {
  const content = message?.content ?? message?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

export function truncate(text, limit = 240) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export function humanTime(ms) {
  const date = new Date(Number(ms) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fmtNumber(n) {
  return Number(n || 0).toLocaleString('en-US');
}

export function fmtMoney(n) {
  return `¥${Number(n || 0).toFixed(2)}`;
}
