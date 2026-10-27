#!/usr/bin/env node
/**
 * Turns one DSH session log into a readable timeline.
 *
 * This is the portable replacement for the Inspector + conversation navigator
 * panels: same source of truth (session.v4.jsonl.zstd), no Electron required.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  dshHome,
  findSession,
  humanTime,
  readSessionFile,
  sessionTitles,
  truncate,
} from './lib/session-store.mjs';

const args = process.argv.slice(2);
const options = {
  out: null,
  full: false,
  json: false,
  maxText: 700,
  tools: true,
  reasoning: true,
};

const positional = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--out') options.out = args[++i];
  else if (arg === '--full') options.full = true;
  else if (arg === '--json') options.json = true;
  else if (arg === '--max-text') options.maxText = Number(args[++i] || 700);
  else if (arg === '--no-tools') options.tools = false;
  else if (arg === '--no-reasoning') options.reasoning = false;
  else if (arg === '--help' || arg === '-h') {
    console.log(usage());
    process.exit(0);
  } else if (!arg.startsWith('-')) positional.push(arg);
  else throw new Error(`未知参数：${arg}`);
}

if (!positional[0]) {
  console.error(usage());
  process.exit(2);
}

function usage() {
  return `导出单个 DSH 会话的时间线

用法：node session-inspect.mjs <session-id | 文件路径 | 目录> [options]
  --out <file.md>     写入文件（默认打印到终端）
  --full              不截断文本
  --max-text <n>      正文截断长度（默认 700）
  --no-tools          不显示工具调用
  --no-reasoning      不显示推理摘要
  --json              输出结构化 JSON
`;
}

let target;
try {
  target = findSession(positional[0]);
} catch (error) {
  console.error(error.message);
  console.error('可用：node session-search.mjs "关键词" 找到会话 ID。');
  process.exit(2);
}

const events = readSessionFile(target.file);
const sessionEvent = events.find((event) => event.type === 'session');
const meta = sessionEvent?.data ?? sessionEvent ?? {};
const sessionId = meta.id ?? target.id;
const titles = sessionTitles();
const title = titles[sessionId]?.title ?? titles[`session-${sessionId}`]?.title ?? '(未命名会话)';
const usageTotals = usageForSession(sessionId);
const timeline = buildTimeline(events, options);
const stats = summarize(events, timeline);

if (options.json) {
  console.log(
    JSON.stringify(
      {
        id: sessionId,
        title,
        cwd: meta.cwd ?? null,
        createdAt: meta.createdAt ?? null,
        stats,
        usage: usageTotals,
        timeline,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const lines = [];
lines.push(`# ${title}`);
lines.push('');
lines.push(`- 会话：\`${sessionId}\``);
lines.push(`- 工作区：\`${meta.cwd ?? '—'}\``);
lines.push(`- 创建：${humanTime(meta.createdAt)} · 日志：${path.basename(target.file)}`);
lines.push(
  `- 规模：${stats.turns} 轮 / ${stats.steps} 步 / ${stats.toolCalls} 次工具调用 / ${stats.userMessages} 条用户消息`,
);
if (stats.failedTools > 0) lines.push(`- 工具异常：${stats.failedTools} 次`);
if (usageTotals) {
  lines.push(
    `- Token：${usageTotals.requests} 次请求 · 输入 ${usageTotals.inputTokens.toLocaleString()} · 输出 ${usageTotals.outputTokens.toLocaleString()} · 缓存读 ${usageTotals.cacheReadTokens.toLocaleString()}`,
  );
}
if (stats.topTools.length) {
  lines.push(`- 高频工具：${stats.topTools.map((item) => `${item.name}×${item.count}`).join(' · ')}`);
}
lines.push('');
lines.push('## 时间线');
lines.push('');
for (const entry of timeline) {
  lines.push(`### ${entry.index}. ${entry.heading}`);
  lines.push('');
  if (entry.body) {
    lines.push(entry.body);
    lines.push('');
  }
  if (entry.note) {
    lines.push(`> ${entry.note}`);
    lines.push('');
  }
  for (const tool of entry.tools) {
    lines.push(`- **${tool.name}** — ${tool.summary}`);
    if (tool.result) lines.push(`  - 返回：${tool.result}`);
  }
  if (entry.tools.length) lines.push('');
}

const text = `${lines.join('\n')}\n`;
if (options.out) {
  const outPath = path.resolve(process.cwd(), options.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text, 'utf8');
  console.log(`已写入 ${outPath}`);
} else {
  process.stdout.write(text);
}

function buildTimeline(events, opts) {
  const entries = [];
  const pendingCalls = new Map();

  for (const event of events) {
    if (event.type === 'user/message') {
      const kind = event.data?.source?.kind;
      if (kind && kind !== 'user') continue;
      const text = textOfMessage(event.data);
      if (!text.trim()) continue;
      entries.push({
        kind: 'user',
        heading: `用户 · ${humanTime(event.time)}`,
        body: clip(text, opts),
        tools: [],
      });
    }

    if (event.type === 'assistant/message') {
      const parts = event.data?.message?.content ?? [];
      const body = parts
        .filter((part) => part?.type === 'text')
        .map((part) => part.text)
        .join('\n\n');
      const reasoning = parts
        .filter((part) => part?.type === 'reasoning')
        .map((part) => part.text)
        .join('\n\n');
      if (!body && !reasoning) continue;
      entries.push({
        kind: 'assistant',
        heading: `助手 · 第 ${event.data?.turn ?? '?'} 轮 / 第 ${event.data?.step ?? '?'} 步`,
        body: body ? clip(body, opts) : '',
        note:
          reasoning && opts.reasoning
            ? `推理 ${reasoning.length.toLocaleString()} 字${opts.full ? '' : '（已折叠）'}`
            : '',
        tools: [],
      });
    }

    if (event.type === 'tool/call' && opts.tools) {
      const call = {
        name: event.data?.name ?? 'tool',
        summary: summarizeArgs(event.data?.arguments),
        result: '',
        entry: entries.length - 1,
      };
      const current = entries[entries.length - 1];
      if (current) current.tools.push(call);
      pendingCalls.set(event.data?.callId, call);
    }

    if (event.type === 'tool/result' && opts.tools) {
      const call = pendingCalls.get(event.data?.toolCallId);
      if (call) {
        const text = textOfMessage(event.data);
        call.result = text ? `${text.length.toLocaleString()} 字符` : '空返回';
        if (/error|failed|异常|拒绝/i.test(text.slice(0, 200))) call.failed = true;
      }
    }

    if (event.type === 'deliverables/presented') {
      const files = event.data?.files ?? [];
      if (files.length) {
        entries.push({
          kind: 'deliverable',
          heading: '交付物',
          body: files.map((file) => `- \`${file.path}\`${file.description ? ` — ${file.description}` : ''}`).join('\n'),
          tools: [],
        });
      }
    }
  }
  return entries.map((entry, index) => ({ ...entry, index: index + 1 }));
}

function summarize(events, timeline) {
  const tools = new Map();
  let toolCalls = 0;
  let failedTools = 0;
  let steps = 0;
  let turns = 0;
  let userMessages = 0;

  for (const event of events) {
    if (event.type === 'tool/call') {
      toolCalls += 1;
      const name = event.data?.name ?? 'tool';
      tools.set(name, (tools.get(name) ?? 0) + 1);
    }
    if (event.type === 'step/start') steps += 1;
    if (event.type === 'turn/start') turns += 1;
    if (event.type === 'user/message' && (!event.data?.source?.kind || event.data.source.kind === 'user')) {
      userMessages += 1;
    }
  }
  for (const entry of timeline) {
    for (const tool of entry.tools) if (tool.failed) failedTools += 1;
  }

  return {
    turns,
    steps,
    toolCalls,
    failedTools,
    userMessages,
    topTools: [...tools.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
}

function usageForSession(sessionId) {
  const dir = path.join(dshHome(), 'token-usage');
  if (!fs.existsSync(dir)) return null;
  const totals = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const file of fs.readdirSync(dir)) {
    if (!/^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes(sessionId)) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record.sessionId !== sessionId) continue;
      totals.requests += 1;
      totals.inputTokens += record.usage?.inputTokens ?? 0;
      totals.outputTokens += record.usage?.outputTokens ?? 0;
      totals.cacheReadTokens += record.usage?.cacheReadTokens ?? 0;
      totals.cacheWriteTokens += record.usage?.cacheWriteTokens ?? 0;
    }
  }
  return totals.requests ? totals : null;
}

function textOfMessage(data) {
  const content = data?.content ?? data?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function summarizeArgs(raw) {
  if (!raw) return '(无参数)';
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return truncate(raw, 160);
    }
  }
  if (value.description) return value.description;
  if (value.command) return `\`${truncate(value.command, 140)}\``;
  if (value.path || value.file_path) return `\`${value.path ?? value.file_path}\``;
  if (value.query) return truncate(value.query, 140);
  return truncate(JSON.stringify(value), 140);
}

function clip(text, opts) {
  return opts.full ? text : truncate(text, opts.maxText);
}
