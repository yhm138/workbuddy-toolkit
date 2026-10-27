#!/usr/bin/env node
/**
 * Full-text search across DSH sessions.
 *
 * WorkBuddy can search its own conversations, not DSH's. This script decodes the
 * append-only zstd session logs under ~/.dsh/sessions and greps user/assistant
 * text, so "上次那个方案是哪次会话" still works after switching hosts.
 */
import {
  humanTime,
  listSessionDirs,
  readSessionFile,
  sessionTitles,
  truncate,
} from './lib/session-store.mjs';

const args = process.argv.slice(2);
const options = {
  cwd: null,
  since: null,
  limit: 10,
  maxSessions: 150,
  regex: false,
  role: 'all',
  snippets: 2,
  json: false,
  includeReasoning: false,
  width: 120,
};

const queryParts = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--cwd') options.cwd = args[++i];
  else if (arg === '--since') options.since = args[++i];
  else if (arg === '--limit') options.limit = Number(args[++i] || 10);
  else if (arg === '--max-sessions') options.maxSessions = Number(args[++i] || 150);
  else if (arg === '--regex') options.regex = true;
  else if (arg === '--role') options.role = args[++i];
  else if (arg === '--snippets') options.snippets = Number(args[++i] || 2);
  else if (arg === '--width') options.width = Number(args[++i] || 120);
  else if (arg === '--include-reasoning') options.includeReasoning = true;
  else if (arg === '--json') options.json = true;
  else if (arg === '--help' || arg === '-h') {
    console.log(usage());
    process.exit(0);
  } else if (!arg.startsWith('-')) queryParts.push(arg);
  else throw new Error(`未知参数：${arg}`);
}

const query = queryParts.join(' ');
if (!query) {
  console.error(usage());
  process.exit(2);
}

function usage() {
  return `在 DSH 历史会话里全文检索

用法：node session-search.mjs "关键词" [options]
  --cwd <substr>        只看某个工作区（路径片段即可）
  --since YYYY-MM-DD    只看该日期之后修改过的会话
  --role user|assistant 只搜某一侧（默认 all）
  --limit <n>           最多返回 n 个会话（默认 10）
  --max-sessions <n>    最多扫描 n 个会话（默认 150，按最近修改倒序）
  --regex               把关键词当正则
  --include-reasoning   连推理过程一起搜（更全，但噪声大）
  --json                JSON 输出
`;
}

const matcher = options.regex
  ? new RegExp(query, 'iu')
  : { test: (text) => text.toLowerCase().includes(query.toLowerCase()) };

const sinceMs = options.since ? Date.parse(`${options.since}T00:00:00`) : 0;
const all = listSessionDirs().filter((item) => item.mtimeMs >= sinceMs);
const scanned = all.slice(0, options.maxSessions);
const titles = sessionTitles();

const hits = [];
let matchedSessions = 0;

for (const session of scanned) {
  let events;
  try {
    events = readSessionFile(session.file);
  } catch {
    continue;
  }
  const sessionEvent = events.find((event) => event.type === 'session');
const meta = sessionEvent?.data ?? sessionEvent ?? {};
  const cwd = meta.cwd ?? '';
  if (options.cwd && !matchesCwd(options.cwd, cwd, session.workspace)) continue;

  const units = extractUnits(events, options);
  const matches = [];
  for (const unit of units) {
    if (!matcher.test(unit.text)) continue;
    matches.push({
      role: unit.role,
      time: unit.time,
      snippet: snippetAround(unit.text, query, options.regex, options.width),
    });
  }
  if (matches.length === 0) continue;

  matchedSessions += 1;
  hits.push({
    id: session.id,
    title: titles[session.id]?.title ?? titles[`session-${session.id}`]?.title ?? '(未命名会话)',
    cwd,
    time: meta.createdAt ?? session.mtimeMs,
    mtime: session.mtimeMs,
    matches,
  });
  if (hits.length >= options.limit) break;
}

hits.sort((a, b) => b.mtime - a.mtime);

if (options.json) {
  console.log(
    JSON.stringify(
      { query, scanned: scanned.length, matchedSessions, results: hits },
      null,
      2,
    ),
  );
  process.exit(0);
}

if (hits.length === 0) {
  console.log(`没有命中：${query}`);
  console.log(`扫描 ${scanned.length} 个会话（共 ${all.length} 个符合时间条件）。`);
  process.exit(0);
}

console.log(`命中 ${matchedSessions} 个会话 / 扫描 ${scanned.length} 个（关键词：${query}）\n`);
hits.forEach((hit, index) => {
  console.log(`${index + 1}. ${hit.title}`);
  console.log(`   ${hit.id} · ${humanTime(hit.time)}`);
  if (hit.cwd) console.log(`   ${shortenPath(hit.cwd)}`);
  console.log(`   ${hit.matches.length} 处命中`);
  for (const match of hit.matches.slice(0, options.snippets)) {
    console.log(`   - [${match.role}] ${match.snippet}`);
  }
  console.log('');
});

function extractUnits(events, opts) {
  const units = [];
  for (const event of events) {
    if (event.type === 'user/message' && opts.role !== 'assistant') {
      const kind = event.data?.source?.kind;
      // runtime-context / time-context / skill-catalog are harness noise.
      if (kind && kind !== 'user') continue;
      const text = textOfMessage(event.data);
      if (text) units.push({ role: 'user', text, time: event.time });
    }
    if (event.type === 'assistant/message' && opts.role !== 'user') {
      const parts = event.data?.message?.content ?? [];
      const text = parts
        .filter((part) => part?.type === 'text' || (opts.includeReasoning && part?.type === 'reasoning'))
        .map((part) => part.text)
        .join('\n');
      if (text) units.push({ role: 'assistant', text, time: event.time });
    }
  }
  return units;
}

function textOfMessage(data) {
  const content = data?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function matchesCwd(filter, cwd, workspaceDir) {
  const needle = filter.toLowerCase().replace(/\\/g, '/');
  if (cwd && cwd.toLowerCase().replace(/\\/g, '/').includes(needle)) return true;
  const dashed = needle.replace(/\//g, '-');
  return workspaceDir.toLowerCase().includes(dashed);
}

function snippetAround(text, needle, isRegex, width) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (isRegex) return truncate(flat, width);
  const index = flat.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return truncate(flat, width);
  const start = Math.max(0, index - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

function shortenPath(cwd) {
  return cwd.replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/i, '~').replace(/\\/g, '/');
}
