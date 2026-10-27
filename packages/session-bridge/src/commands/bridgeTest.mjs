/**
 * bridge-test —— WorkBuddy 会话之间的双向通信验收。
 *
 * 做的事和用户在面板里点「+ 新建」→ 发消息 → 看来消息完全一样，
 * 只是从命令行驱动：createWb → promptWb → 轮询 requestsWb → 再发一轮。
 *
 * 走的是 wb-call 那条文件队列，所以前提是扩展 service 在跑。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, writeJson } from '../core/fsx.mjs';
import { wbCall } from './wbCall.mjs';
import { listWbFiles, parseWbSession } from './wbSession.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(method, payload = {}, timeout = 30000) {
  const body = await wbCall(method, { payload: JSON.stringify(payload), timeout });
  if (!body.ok) {
    const error = new Error(`${method} 失败：${body.error || '未知错误'}`);
    error.code = body.code;
    throw error;
  }
  return body.result;
}

/**
 * completeOnly：只认宿主标为已完成的回复。
 * 流式中的 assistantMessage 是**半截文本**，拿它当回复会存下截断的字符串。
 */
function assistantTexts(messages, { completeOnly = false } = {}) {
  return (messages || []).filter(
    (m) =>
      m.role === 'assistant' &&
      String(m.text || '').trim() &&
      (!completeOnly || m.pending !== true),
  );
}

/**
 * 宿主的 requests 里，一轮请求可能只有 userMessage（助手还在跑）。
 * 只有 assistant 条数真的增加才算收到回复——绝不能拿自己的提问冒充。
 * 计数与等待都必须用同一口径（完整回复），否则半截回复会被当成已到。
 */
async function waitReply(conversationId, baseAssistant, startedAt, waitMs) {
  const deadline = Date.now() + waitMs;
  let last = null;
  let localTried = false;
  while (Date.now() < deadline) {
    try {
      last = await call('requestsWb', { conversationId, limit: 50 }, 20000);
      const replies = assistantTexts(last.messages, { completeOnly: true });
      if (replies.length > baseAssistant) {
        return { reply: replies[replies.length - 1], snapshot: last, source: 'host', partial: false };
      }
    } catch {
      /* 会话可能还没落库，继续等 */
    }

    // 宿主侧迟迟不给 assistantMessage 时，退回本地会话记录（同一份数据的落盘版）
    if (!localTried && Date.now() - startedAt > 6000) {
      localTried = true;
      const local = readLocalReply(conversationId, baseAssistant);
      if (local) return { reply: local, snapshot: last, source: 'local', partial: false };
    }
    await sleep(2500);
  }
  // 超时：宁可显式标明「只拿到半截」，也不静默存下一个截断的字符串
  const partials = assistantTexts(last?.messages).filter((m) => m.pending === true);
  if (partials.length) {
    return { reply: partials[partials.length - 1], snapshot: last, source: 'host', partial: true };
  }
  return { reply: null, snapshot: last, source: null, partial: false };
}

/** 读 ~/.workbuddy/projects/<项目>/<会话>.jsonl，拿第 base+1 条助手消息。 */
function readLocalReply(conversationId, baseAssistant) {
  try {
    const file = listWbFiles().find((item) => item.sessionId === conversationId);
    if (!file) return null;
    const session = parseWbSession(file.file);
    const replies = assistantTexts(
      session.events.map((event) => ({ role: event.kind, text: event.text, time: event.time }))
    );
    if (replies.length > baseAssistant) {
      const last = replies[replies.length - 1];
      return { role: 'assistant', text: last.text, time: last.time };
    }
  } catch {
    /* 本地文件还没写完也很正常 */
  }
  return null;
}

export async function bridgeTest(options = {}) {
  const cwd = options.cwd || process.env.CODEBUDDY_PROJECT_DIR || process.cwd();
  const waitMs = Math.max(5000, Number(options.wait) || 45000);
  const replyWait = Math.max(15000, Number(options.timeout) || 120000);

  // ① service 必须在线——这是唯一的人为前提
  process.stdout.write('① 等扩展 service 上线');
  const aliveBy = Date.now() + waitMs;
  let alive = false;
  while (Date.now() < aliveBy) {
    try {
      await call('ping', {}, 3000);
      alive = true;
      break;
    } catch {
      process.stdout.write('.');
      await sleep(2000);
    }
  }
  if (!alive) {
    throw new Error(
      'service 没上线。\n' +
        '  原因：扩展的 service 是客户端启动时 fork 的；代码更新后不会自动重建。\n' +
        '  动作：在左侧栏点开一次「会话桥」面板（或托盘退出重开 WorkBuddy），再跑一次。',
    );
  }
  console.log(' ✓');

  // ② 建会话
  let conversationId = options.conversationId || '';
  if (conversationId) {
    console.log(`② 复用会话 ${conversationId}`);
  } else {
    const created = await call('createWb', { cwd }, 40000);
    conversationId = created.conversationId;
    console.log(`② 新建会话 ${conversationId}（cwd=${created.cwd || cwd}）`);
  }

  const before = await call('requestsWb', { conversationId, limit: 50 }, 20000);
  let baseAssistant = assistantTexts(before.messages, { completeOnly: true }).length;

  // ③ 第一轮
  const q1 =
    '（会话桥自检 1/2）不要调用任何工具，不要读写文件。只回一行 JSON：' +
    '{"cwd":"你当前工作目录的绝对路径","utc8":"当前UTC+8时间ISO8601","sid":"你的会话ID，看不到就填 null"}';
  const t1 = Date.now();
  await call('promptWb', { conversationId, text: q1 }, 30000);
  console.log('③ 已投递第 1 轮，等回复…');
  const r1 = await waitReply(conversationId, baseAssistant, t1, replyWait);
  if (!r1.reply) throw new Error(`第 1 轮没等到回复（等了 ${replyWait}ms）。会话可能还在跑，可稍后用 wb-session 看。`);
  console.log(`   收到（${r1.source}）：` + String(r1.reply.text).replace(/\s+/g, ' ').slice(0, 200));

  // ④ 第二轮：把 ID 告诉它，要求回显——这才算双向
  baseAssistant =
    assistantTexts(r1.snapshot?.messages, { completeOnly: true }).length || baseAssistant + 1;
  const q2 =
    `（会话桥自检 2/2）你的会话 ID 是 ${conversationId}。不要再解释，只回一行 JSON：` +
    '{"echo_sid":"上面这个ID","ok":true}';
  const t2 = Date.now();
  await call('promptWb', { conversationId, text: q2 }, 30000);
  console.log('④ 已投递第 2 轮，等回复…');
  const r2 = await waitReply(conversationId, baseAssistant, t2, replyWait);
  if (!r2.reply) throw new Error(`第 2 轮没等到回复（等了 ${replyWait}ms）。`);

  const result = {
    ok: true,
    at: new Date().toISOString(),
    cwd,
    conversationId,
    source: [r1.source, r2.source],
    partial: [Boolean(r1.partial), Boolean(r2.partial)],
    round1: { question: q1, answer: String(r1.reply.text), at: r1.reply.time || null },
    round2: { question: q2, answer: String(r2.reply.text), at: r2.reply.time || null },
    messageCount: (r2.snapshot?.messages || []).length,
    shape: r2.snapshot?.shape || null,
    rawSample: (r2.snapshot?.messages || []).slice(0, 2),
  };

  const dir = path.join(process.cwd(), '.probe');
  ensureDir(dir);
  writeJson(path.join(dir, 'bridge-test.json'), result);
  return result;
}

export function renderBridgeTest(result) {
  const partial = (result.partial || []).some(Boolean);
  console.log('');
  console.log(partial ? '── 通信成立（有一轮只拿到半截，见下）──' : '── 双向通信成立 ──');
  console.log(`会话 ID   ${result.conversationId}`);
  console.log(`工作区    ${result.cwd}`);
  console.log(`消息条数  ${result.messageCount}`);
  console.log('');
  console.log('第 1 轮 · 我 → 新会话');
  console.log('  Q ' + result.round1.question.slice(0, 120));
  console.log('  A ' + String(result.round1.answer).replace(/\s+/g, ' ').slice(0, 300));
  if (result.partial?.[0]) console.log('  ! 这条是流式中的半截文本，稍后用 wb-session 看完整版');
  console.log('');
  console.log('第 2 轮 · 新会话 → 我（把 ID 告诉它，要求回显）');
  console.log('  Q ' + result.round2.question.slice(0, 120));
  console.log('  A ' + String(result.round2.answer).replace(/\s+/g, ' ').slice(0, 300));
  if (result.partial?.[1]) console.log('  ! 这条是流式中的半截文本，稍后用 wb-session 看完整版');
  console.log('');
  console.log('明细已存 .probe/bridge-test.json');
  console.log(`回放：node bin/dsh2wb.mjs wb-session ${result.conversationId}`);
}
