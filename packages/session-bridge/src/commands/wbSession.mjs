import fs from 'node:fs';
import path from 'node:path';
import { workbuddyHome, writeText } from '../core/fsx.mjs';

/**
 * WorkBuddy 会话的本地读取器。
 *
 * 与面板里的 requestsWb 不同，这条路完全走磁盘：
 * ~/.workbuddy/projects/<项目目录>/<sessionId>.jsonl
 * 所以它不需要宿主、不需要扩展 service，宿主没开也能复盘。
 *
 * 记录里混着 WorkBuddy 自己注入的 system-reminder（用户消息前缀），
 * 时间线里必须剔掉，否则人读不出来。
 */

const INJECT_HEADS = [
  '<system-reminder',
  '<identity_context',
  '<craft_mode>',
  'Current runtime context',
  'Time sampled while',
];

function projectsRoot() {
  return path.join(workbuddyHome(), 'projects');
}

/** `d-Work-Foo` → `D:/Work/Foo`（只是还原展示，不保证与原串完全一致） */
export function decodeProjectDir(name) {
  if (!name) return '';
  const joined = name.replace(/-/g, '/');
  const withDrive = /^[a-zA-Z]\//.test(joined) ? joined[0].toUpperCase() + ':' + joined.slice(1) : joined;
  return withDrive.split('/').join(path.sep);
}

export function cleanUserText(raw) {
  let text = String(raw || '');
  const queried = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (queried) return queried[1].trim();
  text = text.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '');
  text = text.replace(/<identity_context[\s\S]*$/m, '');
  return text.trim();
}

/**
 * 一条「用户」记录可能整个都是宿主注入，也可能注入后面挂着真人输入。
 * 先取 <user_query>，取不到再看是不是纯注入。
 */
export function extractUserText(raw) {
  const text = String(raw || '');
  const queried = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (queried && queried[1].trim()) return { text: queried[1].trim(), injected: false };
  if (looksInjected(text)) return { text: '', injected: true };
  return { text: cleanUserText(text), injected: false };
}

export function looksInjected(raw) {
  const text = String(raw || '').trimStart();
  return INJECT_HEADS.some((head) => text.startsWith(head));
}

function blocksToText(content, kinds) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && (kinds.includes(part.type) || (!part.type && typeof part.text === 'string')))
    .map((part) => String(part.text ?? ''))
    .join('');
}

function summarizeArgs(name, input) {
  if (input == null) return '';
  if (typeof input === 'string') return clip(input.replace(/\s+/g, ' '), 90);
  const pick = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url;
  if (typeof pick === 'string') return clip(pick.replace(/\s+/g, ' '), 90);
  return clip(JSON.stringify(input).replace(/\s+/g, ' '), 90);
}

function clip(text, max) {
  const value = String(text ?? '');
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function utc8(ts) {
  if (!ts) return '—';
  const iso = new Date(Number(ts) + 8 * 3600 * 1000).toISOString();
  return iso.slice(0, 19).replace('T', ' ') + '+08:00';
}

function utc8Short(ts) {
  if (!ts) return '—';
  const iso = new Date(Number(ts) + 8 * 3600 * 1000).toISOString();
  return iso.slice(11, 19);
}

function fmtInt(n) {
  return Number(n || 0).toLocaleString('en-US');
}

/** 扫一遍所有项目目录，拿到会话文件清单（不含 .file-rollback.ndjson）。 */
export function listWbFiles() {
  const root = projectsRoot();
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const project of fs.readdirSync(root)) {
    const dir = path.join(root, project);
    let stat = null;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      let info = null;
      try {
        info = fs.statSync(file);
      } catch {
        continue;
      }
      files.push({
        sessionId: name.replace(/\.jsonl$/, ''),
        project: project,
        projectDir: decodeProjectDir(project),
        file,
        mtime: info.mtimeMs,
        size: info.size,
      });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

/** 读单个会话文件，把 JSONL 变成可读事件。 */
export function parseWbSession(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const events = [];
  let title = '';
  let cwd = '';
  let createdAt = 0;
  let sessionId = path.basename(file, '.jsonl');
  let skippedInjected = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.cwd && !cwd) cwd = entry.cwd;
    if (entry.type === 'session-meta') {
      sessionId = entry.sessionId || sessionId;
      if (!createdAt) createdAt = Number(entry.timestamp) || 0;
      continue;
    }
    if (entry.type === 'ai-title') {
      if (entry.aiTitle) title = entry.aiTitle;
      continue;
    }
    if (entry.type === 'file-history-snapshot') continue;

    if (entry.type === 'message' && entry.role === 'user') {
      const raw = blocksToText(entry.content, ['input_text', 'text']);
      const parsed = extractUserText(raw);
      if (parsed.injected || !parsed.text) {
        skippedInjected += 1;
        continue;
      }
      events.push({ kind: 'user', time: Number(entry.timestamp) || 0, text: parsed.text });
      continue;
    }
    if (entry.type === 'message' && entry.role === 'assistant') {
      const text2 = blocksToText(entry.content, ['output_text', 'text']) || blocksToText(entry.message?.content, ['output_text', 'text']);
      if (!text2.trim()) continue;
      events.push({
        kind: 'assistant',
        time: Number(entry.timestamp) || 0,
        text: text2.trim(),
        model: entry.providerData?.model || '',
        step: Number(entry.providerData?.stepSeq) || 0,
      });
      continue;
    }
    if (entry.type === 'reasoning') {
      const chunks = entry.rawContent || entry.content || [];
      const chars = Array.isArray(chunks)
        ? chunks.reduce((sum, part) => sum + String(part?.text ?? '').length, 0)
        : String(chunks || '').length;
      if (chars > 0) events.push({ kind: 'reasoning', time: Number(entry.timestamp) || 0, chars });
      continue;
    }
    if (entry.type === 'function_call') {
      events.push({
        kind: 'tool',
        time: Number(entry.timestamp) || 0,
        name: entry.name || entry.toolName || '?',
        args: summarizeArgs(entry.name, entry.input ?? entry.arguments ?? entry.params),
      });
      continue;
    }
    if (entry.type === 'function_call_result') {
      const out = entry.output?.text ?? entry.output?.content ?? '';
      events.push({
        kind: 'tool-result',
        time: Number(entry.timestamp) || 0,
        name: entry.name || '?',
        status: entry.status || '',
        size: String(out || '').length,
      });
    }
  }

  const rounds = events.filter((event) => event.kind === 'user').length;
  const tools = events.filter((event) => event.kind === 'tool').length;
  return {
    sessionId,
    file,
    title: title || '(无标题)',
    cwd,
    createdAt: events[0]?.time || createdAt,
    updatedAt: events[events.length - 1]?.time || createdAt,
    events,
    rounds,
    tools,
    skippedInjected,
    model: events.find((event) => event.kind === 'assistant' && event.model)?.model || '',
  };
}

/** 列表：每个会话只读前 200 行，取标题与首条真实用户消息（大文件也快）。 */
export function listWbSessions(options = {}) {
  const limit = Number(options.limit || 20);
  const projectFilter = options.project ? String(options.project).toLowerCase() : '';
  const files = listWbFiles().filter((item) => {
    if (!projectFilter) return true;
    return item.projectDir.toLowerCase().includes(projectFilter) || item.project.toLowerCase().includes(projectFilter);
  });

  return files.slice(0, Math.max(limit, 1) * 3).map((item) => {
    let head = '';
    try {
      const fd = fs.openSync(item.file, 'r');
      const buffer = Buffer.alloc(Math.min(item.size, 65536));
      fs.readSync(fd, buffer, 0, buffer.length, 0);
      fs.closeSync(fd);
      head = buffer.toString('utf8');
    } catch {
      head = '';
    }
    let title = '';
    let firstUser = '';
    let rounds = 0;
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.type === 'ai-title' && entry.aiTitle) title = entry.aiTitle;
      if (entry.type === 'message' && entry.role === 'user') {
        const raw = blocksToText(entry.content, ['input_text', 'text']);
        const parsed = extractUserText(raw);
        if (parsed.injected || !parsed.text) continue;
        rounds += 1;
        if (!firstUser) firstUser = parsed.text;
      }
    }
    return { ...item, title: title || '(无标题)', firstUser, rounds };
  }).slice(0, limit);
}

export function renderWbList(rows) {
  if (!rows.length) return ['没有找到 WorkBuddy 会话记录（~/.workbuddy/projects/ 为空？）'];
  const lines = [];
  lines.push('时间              轮  标题                         会话 ID');
  lines.push('─'.repeat(96));
  for (const row of rows) {
    lines.push(
      [
        utc8Short(row.mtime).padEnd(8) + '+08  ',
        String(row.rounds).padStart(2),
        '  ' + clip(row.title, 26).padEnd(28),
        row.sessionId,
      ].join(' ')
    );
    lines.push('      ' + clip(row.projectDir, 88));
  }
  return lines;
}

export function renderWbTranscript(session, options = {}) {
  const lines = [];
  lines.push(`# ${session.title}`);
  lines.push('');
  lines.push(`- 会话：\`${session.sessionId}\``);
  lines.push(`- 项目：\`${session.cwd || '(未记录)'}\``);
  lines.push(
    `- 记录：\`${session.file.replace(/\\/g, '/')}\``
  );
  lines.push(
    `- 创建：${utc8(session.createdAt)} · 规模：${session.rounds} 轮 / ${session.events.filter((e) => e.kind === 'user' || e.kind === 'assistant').length} 条消息 / ${session.tools} 次工具调用`
  );
  if (session.model) lines.push(`- 模型：\`${session.model}\``);
  if (session.skippedInjected) lines.push(`- 已剔除 ${session.skippedInjected} 条系统注入（system-reminder / identity_context）`);
  lines.push('');

  let round = 0;
  for (const event of session.events) {
    if (event.kind === 'user') {
      round += 1;
      lines.push(`## 第 ${round} 轮`);
      lines.push('');
      lines.push(`**用户** · ${utc8(event.time)}`);
      lines.push('');
      lines.push(quote(event.text, options.maxText || 1200));
      lines.push('');
      continue;
    }
    if (event.kind === 'assistant') {
      const meta = [utc8(event.time)];
      if (event.step) meta.push(`第 ${event.step} 步`);
      if (event.model) meta.push(event.model);
      lines.push(`**助手** · ${meta.join(' · ')}`);
      lines.push('');
      lines.push(quote(event.text, options.maxText || 1200));
      lines.push('');
      continue;
    }
    if (event.kind === 'reasoning') {
      if (options.noReasoning) continue;
      lines.push(`> _推理 ${fmtInt(event.chars)} 字（已折叠）_`);
      lines.push('');
      continue;
    }
    if (event.kind === 'tool') {
      if (options.noTools) continue;
      lines.push(`- 🔧 \`${event.name}\` ${event.args ? '· ' + event.args : ''}`);
      continue;
    }
    if (event.kind === 'tool-result') {
      if (options.noTools) continue;
      lines.push(`  ↳ ${event.status || 'ok'} · 返回 ${fmtInt(event.size)} 字符`);
      continue;
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function quote(text, max) {
  const body = clip(String(text || '').trim(), max);
  return body
    .split('\n')
    .map((line) => '  ' + line)
    .join('\n');
}

export function wbSession(target, options = {}) {
  if (!target) {
    const rows = listWbSessions(options);
    const text = renderWbList(rows);
    if (options.json) return { mode: 'list', sessions: rows };
    return { mode: 'list', text: text.join('\n') };
  }

  const files = listWbFiles();
  const found =
    files.find((item) => item.sessionId === target) ||
    files.find((item) => item.sessionId.startsWith(target)) ||
    files.find((item) => item.file === target);

  if (!found) {
    throw new Error(
      `没有找到会话：${target}\n提示：先跑 dsh2wb wb-session 看列表；或确认 ~/.workbuddy/projects/ 下有该会话。`
    );
  }

  const session = parseWbSession(found.file);
  if (options.json) return { mode: 'transcript', session };
  const text = renderWbTranscript(session, options);
  if (options.out) {
    writeText(options.out, text);
    return { mode: 'transcript', text, written: options.out, session };
  }
  return { mode: 'transcript', text, session };
}

export function renderWbSession(result) {
  if (result.mode === 'list') {
    if (result.text) console.log(result.text);
    return;
  }
  console.log(result.text);
  if (result.written) console.log(`\n已写入：${result.written}`);
}
