/**
 * copy-id —— 把会话的 Session ID 放进剪贴板。
 *
 * 痛点：WorkBuddy 界面上看不到自己的会话 ID，agent 自己也看不见，
 * 想贴给别人、写进脚本、或者喂给会话桥，只能翻
 * ~/.workbuddy/projects/<项目>/<uuid>.jsonl 从文件名里抄。
 *
 * 关键：宿主本来就把 ID 注进了 Bash 子进程的环境变量（CODEBUDDY_SESSION_ID），
 * 所以这里不需要「猜哪个 jsonl 最新」这种脆弱办法，直接读环境变量，零误差。
 */

import { spawnSync } from 'node:child_process';
import { listWbFiles, parseWbSession } from './wbSession.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENV_KEYS = ['CODEBUDDY_SESSION_ID', 'CLAUDE_SESSION_ID'];

/** 宿主注入的当前会话 ID。没有就在终端里跑，那就得显式给 --sid。 */
export function envSessionId() {
  for (const key of ENV_KEYS) {
    const value = String(process.env[key] || '').trim();
    if (UUID_RE.test(value)) return { id: value, from: key };
  }
  return null;
}

function run(cmd, args, input) {
  const result = spawnSync(cmd, args, { input, timeout: 5000, windowsHide: true });
  if (result.error) return { ok: false, reason: result.error.message };
  if (result.status !== 0) {
    const err = String(result.stderr || '').trim();
    return { ok: false, reason: err || `退出码 ${result.status}` };
  }
  return { ok: true };
}

/** Windows 用 clip，macOS 用 pbcopy，Linux 依次试 wl-copy / xclip / xsel。 */
function writeClipboard(text) {
  if (process.platform === 'win32') return run('clip', [], text);
  if (process.platform === 'darwin') return run('pbcopy', [], text);

  const chain = [
    ['wl-copy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ];
  let last = { ok: false, reason: '没有可用的剪贴板命令' };
  for (const [cmd, args] of chain) {
    const attempt = run(cmd, args, text);
    if (attempt.ok) return attempt;
    last = attempt;
  }
  return last;
}

/** 会话的元信息，用来让用户核对「复制的是不是这一个」。找不到就返回 null。 */
function describe(sid) {
  const hit = listWbFiles().find((item) => item.sessionId === sid);
  if (!hit) return null;
  try {
    const session = parseWbSession(hit.file);
    return {
      title: session.title,
      cwd: session.cwd,
      rounds: session.rounds,
      updatedAt: session.updatedAt,
      file: hit.file,
    };
  } catch {
    return { title: '', cwd: '', rounds: 0, updatedAt: 0, file: hit.file };
  }
}

export function copyId(options = {}) {
  const explicit = String(options.sid || options.positional?.[0] || '').trim();
  let sid = explicit;
  let from = '参数 --sid';

  if (!sid) {
    const env = envSessionId();
    if (env) {
      sid = env.id;
      from = `环境变量 ${env.from}`;
    } else {
      // 不在会话里（用户自己的终端）：退化成「最近更新的那个会话」。
      // 不严谨但可用，且会明说是猜的，不冒充精确来源。
      const recent = listWbFiles()[0];
      if (!recent) {
        throw new Error(
          '拿不到会话 ID：没有环境变量，本地也没有任何会话记录。\n' +
            '  WorkBuddy 会话里跑会自动读到 CODEBUDDY_SESSION_ID；\n' +
            '  在终端里用请显式指定：dsh2wb copy-id --sid <ID>',
        );
      }
      sid = recent.sessionId;
      from = '本地最近更新的会话（无环境变量，属推测）';
    }
  }

  if (!UUID_RE.test(sid)) {
    throw new Error(`看起来不是合法的 Session ID：${sid}`);
  }

  const meta = describe(sid);
  const skipped = Boolean(options.print);
  const clip = skipped ? { ok: true, skipped: true } : writeClipboard(sid);

  if (options.json) {
    console.log(JSON.stringify({ ok: true, sessionId: sid, from, copied: !skipped && clip.ok, meta }, null, 2));
    return { sessionId: sid, copied: !skipped && clip.ok, meta };
  }

  console.log('');
  if (skipped) {
    console.log(`✓ 会话 ID  ${sid}`);
  } else if (clip.ok) {
    console.log(`✓ 已复制到剪贴板  ${sid}`);
  } else {
    console.log(`✓ 会话 ID  ${sid}`);
    console.log(`  ⚠ 写剪贴板失败：${clip.reason}（复制上面这行即可）`);
  }
  console.log('');
  if (meta) {
    console.log(`  会话  ${meta.title || '(无标题)'}`);
    if (meta.cwd) console.log(`  项目  ${meta.cwd}`);
    const when = meta.updatedAt ? new Date(meta.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '-';
    console.log(`  规模  ${meta.rounds} 轮 · 最后活动 ${when}`);
  } else {
    console.log('  （本地没有这个会话的记录，可能属于别的机器或已清理）');
  }
  console.log(`  来源  ${from}`);
  console.log('');

  return { sessionId: sid, copied: !skipped && clip.ok, meta };
}
