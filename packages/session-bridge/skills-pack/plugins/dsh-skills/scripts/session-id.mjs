#!/usr/bin/env node
/**
 * Copy the current WorkBuddy session id (or a DSH session id) to the clipboard.
 *
 * WorkBuddy exports CODEBUDDY_SESSION_ID to tool processes, so the current
 * conversation can identify itself without any UI affordance. DSH ids come from
 * the session store on disk and work even when DSH is not running.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  dshHome,
  humanTime,
  listSessionDirs,
  sessionTitles,
  truncate,
} from './lib/session-store.mjs';

const args = process.argv.slice(2);
const options = { dsh: false, copy: true, json: false, limit: 10, target: null, kind: 'wb' };

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--dsh') {
    options.dsh = true;
    options.kind = 'dsh';
  } else if (arg === '--copy') options.target = args[++i];
  else if (arg === '--no-copy') options.copy = false;
  else if (arg === '--json') options.json = true;
  else if (arg === '--limit') options.limit = Number(args[++i] || 10);
  else if (arg === '--help' || arg === '-h') {
    console.log(usage());
    process.exit(0);
  } else if (!arg.startsWith('-')) options.target = arg;
  else throw new Error(`未知参数：${arg}`);
}

function usage() {
  return `复制 Session ID

用法：
  node session-id.mjs                    当前 WorkBuddy 会话 ID（自动复制）
  node session-id.mjs --dsh               列出最近的 DSH 会话及其 ID
  node session-id.mjs --dsh --copy 1      复制列表里第 1 个 DSH 会话 ID
  node session-id.mjs --copy <id>         复制指定 ID
  node session-id.mjs --json              机器可读输出
  node session-id.mjs --no-copy           只看不复制
`;
}

const wbSessionId = process.env.CODEBUDDY_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;

if (options.dsh) {
  const sessions = listSessionDirs();
  const titles = sessionTitles();
  const rows = sessions.slice(0, options.limit).map((session, index) => ({
    index: index + 1,
    id: session.id,
    title: titles[session.id]?.title ?? titles[`session-${session.id}`]?.title ?? '(未命名)',
    cwd: titles[session.id]?.cwd ?? null,
    updatedAt: session.mtimeMs,
  }));

  if (options.target && !/^\d+$/.test(options.target)) {
    // `--copy <session-id>`: copy verbatim, no lookup needed.
    const ok = options.copy ? copyToClipboard(options.target) : false;
    console.log(`${ok ? '已复制' : '未复制'}：${options.target}`);
    process.exit(0);
  }

  if (options.json) {
    console.log(JSON.stringify({ sessions: rows }, null, 2));
    process.exit(0);
  }

  if (rows.length === 0) {
    console.log(`没有找到会话（${path.join(dshHome(), 'sessions')} 为空）。`);
    process.exit(0);
  }

  console.log('最近的 DSH 会话\n');
  for (const row of rows) {
    console.log(`  ${String(row.index).padStart(2)}. ${truncate(row.title, 46)}`);
    console.log(`      ${row.id} · ${humanTime(row.updatedAt)}`);
  }

  if (options.target) {
    const index = Number(options.target);
    const row = rows.find((item) => item.index === index);
    if (!row) {
      console.error(`\n没有第 ${options.target} 项（共 ${rows.length} 项）。`);
      process.exit(2);
    }
    const ok = options.copy ? copyToClipboard(row.id) : false;
    console.log(`\n${ok ? '已复制' : 'ID'}：${row.id}`);
  } else {
    console.log('\n复制某一个：node session-id.mjs --dsh --copy <序号>');
  }
  process.exit(0);
}

if (!wbSessionId) {
  console.error(
    '当前进程没有 CODEBUDDY_SESSION_ID。\n' +
      '这通常意味着在 WorkBuddy 之外运行；用 --dsh 查看 DSH 会话，或 --copy <id> 直接复制。',
  );
  process.exit(2);
}

const payload = {
  kind: 'workbuddy',
  id: wbSessionId,
  cwd: process.env.CODEBUDDY_PROJECT_DIR ?? process.cwd(),
  workspace: process.env.CODEBUDDY_PROJECT_DIR ?? null,
};

if (options.json) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

if (options.copy) {
  const ok = copyToClipboard(wbSessionId);
  console.log(ok ? `已复制 WorkBuddy 会话 ID：${wbSessionId}` : `WorkBuddy 会话 ID：${wbSessionId}`);
} else {
  console.log(`WorkBuddy 会话 ID：${wbSessionId}`);
}
if (payload.workspace) console.log(`工作区：${payload.workspace}`);
console.log('提示：把它交给 dsh_local 的 session_* 工具，或贴进 issue / 交接说明。');

function copyToClipboard(text) {
  const commands = {
    win32: [['clip']],
    darwin: [['pbcopy']],
    linux: [['wl-copy'], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]],
  }[process.platform] ?? [];

  for (const [command, argv = []] of commands) {
    try {
      const result = spawnSync(command, argv, { input: text, encoding: 'utf8' });
      if (result.status === 0) return true;
    } catch {
      // Try the next clipboard provider.
    }
  }
  // WSL / Git Bash can reach the Windows clipboard through clip.exe.
  if (process.platform !== 'win32' && fs.existsSync('/mnt/c/Windows/System32/clip.exe')) {
    const result = spawnSync('/mnt/c/Windows/System32/clip.exe', [], { input: text, encoding: 'utf8' });
    if (result.status === 0) return true;
  }
  return false;
}
