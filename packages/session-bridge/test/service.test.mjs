import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The service is CommonJS (host forks it), so it is loaded with createRequire.
 * A fake dsh-as-mcp server exercises the real MCP client and tool mapping.
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-test-'));
process.env.DSH_HOME = tmp;
process.env.WORKBUDDY_HOME = tmp; // probe 日志别写到真实 ~/.workbuddy
process.env.CODEBUDDY_PROJECT_DIR = 'D:/work/demo';
// 测试绝不能连真实客户端：开发机重启后 shell 会继承
// WORKBUDDY_REMOTE_DEBUGGING_PORT=9222，注入器就会去连 9222，
// 既会往用户的窗口里塞脚本，也会留下不关闭的 socket 让 node --test 退不出去。
process.env.WORKBUDDY_MENU_INJECT = 'off';

fs.mkdirSync(path.join(tmp, 'dsh-as-mcp'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'dsh-as-mcp', 'token'), 'test-token\n');
fs.mkdirSync(path.join(tmp, 'token-usage'), { recursive: true });
fs.writeFileSync(
  path.join(tmp, 'token-usage', 'sessions.json'),
  JSON.stringify({
    'session-live-1': { title: '活会话一', cwd: 'D:/work/demo' },
    'session-old-2': { title: '历史会话二', cwd: 'D:/work/old' },
  }),
);
fs.mkdirSync(path.join(tmp, 'sessions', '--D-work-demo--', 'session-old-2'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'sessions', '--D-work-demo--', 'session-old-2', 'session.v4.jsonl'), '');

/**
 * 桌面端会话的本地记录：宿主重启后 requestsWb 会返回 0 条，
 * 面板只能靠扫这个目录把「本机会话」列出来。
 */
const LOCAL_ID = 'aaaa1111-2222-4333-8444-555566667777';
const localProject = path.join(tmp, 'projects', 'd-work-demo');
fs.mkdirSync(localProject, { recursive: true });
fs.writeFileSync(
  path.join(localProject, `${LOCAL_ID}.jsonl`),
  [
    JSON.stringify({ type: 'session-meta', sessionId: LOCAL_ID, timestamp: 1792810000000 }),
    JSON.stringify({ type: 'ai-title', aiTitle: '桌面端会话一', cwd: 'D:\\work\\demo', sessionId: LOCAL_ID }),
    JSON.stringify({
      type: 'message',
      role: 'user',
      timestamp: 1792810001000,
      // 真实形状：注入在前，真问题包在 <user_query> 里
      content: [{ type: 'input_text', text: '<system-reminder>上下文</system-reminder>\n<user_query>把迁移报告补一节回滚步骤</user_query>' }],
    }),
    JSON.stringify({
      type: 'message',
      role: 'assistant',
      timestamp: 1792810002000,
      content: [{ type: 'output_text', text: '好，我先看目录。' }],
    }),
    JSON.stringify({
      type: 'message',
      role: 'user',
      timestamp: 1792810003000,
      content: [{ type: 'input_text', text: 'Current runtime context. This snapshot supersedes earlier ones.' }],
    }),
  ].join('\n') + '\n',
);
// 回滚快照不是会话，扫目录时必须跳过
fs.writeFileSync(path.join(localProject, `${LOCAL_ID}.file-rollback.ndjson`), '{}\n');

/**
 * 其他 harness 的本地记录。用 CODEX_HOME / CLAUDE_CONFIG_DIR 把根目录指到临时目录，
 * 免得测试读到开发机上真实的几百条会话（那会让断言随机器变化）。
 */
process.env.CODEX_HOME = path.join(tmp, 'codex-home');
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude-home');

const CODEX_ID = 'a1b2c3d4-0006-4a00-8000-000000000006';
const CODEX_SUB_ID = 'a1b2c3d4-0008-4a00-8000-000000000008';
const CODEX_DIR = path.join(process.env.CODEX_HOME, 'sessions', '2026', '10', '24');
fs.mkdirSync(CODEX_DIR, { recursive: true });

const codexLine = (entry) => JSON.stringify(entry);
fs.writeFileSync(
  path.join(CODEX_DIR, `rollout-2026-10-24T09-00-00-${CODEX_ID}.jsonl`),
  [
    codexLine({
      timestamp: '2026-10-24T01:00:00.000Z',
      type: 'session_meta',
      payload: { id: CODEX_ID, timestamp: '2026-10-24T01:00:00.000Z', cwd: 'D:\\work\\demo', model_provider: 'openai' },
    }),
    // developer 是提示词，不是人说的话
    codexLine({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex.' }] } }),
    // 宿主注入的环境上下文，role 也是 user
    codexLine({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>D:\\work\\demo</cwd>\n</environment_context>' }] },
    }),
    codexLine({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '把 README 补一节用法说明' }] } }),
    codexLine({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '先看现有结构。' }] } }),
    codexLine({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '改好了。' }] } }),
  ].join('\n') + '\n',
);
// 子 agent 线程：只有注入没有真人发言，默认不该出现在列表里
fs.writeFileSync(
  path.join(CODEX_DIR, `rollout-2026-10-24T09-05-00-${CODEX_SUB_ID}.jsonl`),
  [
    codexLine({
      timestamp: '2026-10-24T01:05:00.000Z',
      type: 'session_meta',
      payload: {
        id: CODEX_SUB_ID,
        timestamp: '2026-10-24T01:05:00.000Z',
        cwd: 'D:\\work\\demo',
        parent_thread_id: CODEX_ID,
        agent_nickname: 'Bacon',
      },
    }),
    codexLine({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>D:\\work\\demo</cwd>\n</environment_context>' }] },
    }),
  ].join('\n') + '\n',
);

const CLAUDE_ID = 'a1b2c3d4-0005-4a00-8000-000000000005';
const CLAUDE_DIR = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'd-work-demo');
fs.mkdirSync(CLAUDE_DIR, { recursive: true });
fs.writeFileSync(
  path.join(CLAUDE_DIR, `${CLAUDE_ID}.jsonl`),
  [
    JSON.stringify({ type: 'custom-title', customTitle: '重构会话桥', sessionId: CLAUDE_ID }),
    JSON.stringify({
      type: 'user',
      isSidechain: false,
      cwd: 'D:/work/demo',
      timestamp: '2026-10-24T02:00:00.000Z',
      message: { role: 'user', content: '只读来源也要能看内容' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-24T02:00:10.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '想想怎么接' },
          { type: 'text', text: '可以，扫目录就行。' },
        ],
      },
    }),
    // 工具结果也是 user 记录，但不是人说的话
    JSON.stringify({
      type: 'user',
      timestamp: '2026-10-24T02:00:20.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] },
    }),
    // 子 agent 分支
    JSON.stringify({
      type: 'user',
      isSidechain: true,
      timestamp: '2026-10-24T02:00:30.000Z',
      message: { role: 'user', content: '子 agent 的提示词' },
    }),
  ].join('\n') + '\n',
);


let server;
let port;

function startFakeMcp() {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const message = JSON.parse(body || '{}');
      const reply = (result) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
      };

      if (message.method === 'initialize') {
        return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } });
      }
      if (message.method === 'tools/list') {
        return reply({
          tools: [
            { name: 'session_list' },
            { name: 'session_create' },
            { name: 'session_prompt' },
            { name: 'session_messages' },
            { name: 'session_cancel' },
          ],
        });
      }
      if (message.method === 'tools/call') {
        const { name, arguments: args } = message.params;
        const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
        if (name === 'session_list') {
          return reply(text({ sessions: [{ sessionId: 'session-live-1', cwd: 'D:/work/demo', running: true, updatedAt: 1792800000000 }] }));
        }
        if (name === 'session_create') {
          assert.equal(args.cwd, 'D:/work/demo');
          return reply(text({ sessionId: 'session-new-9', cwd: args.cwd }));
        }
        if (name === 'session_prompt') {
          assert.equal(args.sessionId, 'session-new-9');
          return reply(text({ status: 'queued', reply: '收到' }));
        }
        if (name === 'session_messages') {
          return reply(text({
            messages: [
              { role: 'user', text: '你好', time: 1, seq: 1 },
              { role: 'user', text: '<system-reminder> A skill is reusable. </system-reminder>', time: 2, seq: 2 },
              { role: 'user', text: 'Time sampled while preparing turn 1, step 1: 2026-10-24T11:06:32+08:00', time: 3, seq: 3 },
              { role: 'assistant', text: '收到', time: 4, seq: 4 },
            ],
          }));
        }
        if (name === 'session_cancel') return reply(text({ cancelled: true }));
      }
      res.writeHead(400).end('unknown');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    port = server.address().port;
    resolve();
  }));
}

test.before(async () => {
  await startFakeMcp();
  process.env.DSH_MCP_URL = `http://127.0.0.1:${port}/mcp`;
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { activate } = require('../extension/server/index.cjs');

  // WorkBuddy 侧 daemon RPC 的假实现：故意让第一种 create 形态失败，逼出重试路径
  globalThis.__wbInvokes = [];
  const invoke = async (channel, ...args) => {
    globalThis.__wbInvokes.push({ channel, args });
    if (channel === 'wb:conversations:create') {
      const arg = args[0] || {};
      if (arg.cwd) throw new Error('create 不接受 cwd');
      if (arg.workspacePath) return { info: { transport: 'local', id: 'conv-wb-1', workspacePath: arg.workspacePath, title: '自检会话' } };
      throw new Error('create 需要 workspacePath');
    }
    if (channel === 'wb:conversations:sendPrompt') return { ok: true };
    if (channel === 'wb:conversations:requests') {
      // 真实形状：一条 item = 一次请求，含 userMessage + assistantMessage
      return {
        total: 1,
        page: 1,
        hasOlder: false,
        items: [
          {
            id: '01a16bfb85a97c72a55f9d0ae1640e40',
            conversationRequestId: '01a16bfb85a97c72a55f9d0ae1640e40',
            identity: { requestId: '01a16bfb85a97c72a55f9d0ae1640e40', forkMessageId: 'a1b2c3d4-0009-4a00-8000-000000000009' },
            timestamp: 1792813008297,
            userMessage: { type: 'text', content: [{ type: 'text', text: '自检：报 ID / 项目 / 时间' }] },
            // 真实返回里正文前一定有一块 reasoning，解析必须跳过它
            assistantMessage: {
              contentIdentity: 'message',
              type: 'text',
              content: [
                { type: 'reasoning', text: 'The user wants a one-line JSON ack.' },
                { type: 'text', text: '{"sid":"conv-wb-1","cwd":"D:/work/demo","utc8":"2026-10-24T11:36:53+08:00"}' },
              ],
            },
            state: 'completed',
            usage: { input_tokens: 31561, output_tokens: 59 },
          },
        ],
      };
    }
    throw new Error(`未知通道 ${channel}`);
  };

  const service = activate({
    invoke,
    http: { get: async () => ({ code: 0, data: { conversations: [{ id: 'wb-1', name: 'WB 会话' }], pagination: { hasNext: false } } }) },
  });
  globalThis.__service = service;
});

test.after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ctx = { callerId: undefined };

test('status reports endpoint and session tools', async () => {
  const status = await globalThis.__service.methods.status(ctx);
  assert.equal(status.online, true);
  assert.ok(status.tools.includes('session_prompt'));
  assert.equal(status.defaultCwd, 'D:/work/demo');
});

test('listDsh merges MCP sessions with cached titles', async () => {
  const result = await globalThis.__service.methods.listDsh(ctx, { limit: 10 });
  assert.equal(result.source, 'mcp');
  assert.equal(result.sessions[0].id, 'session-live-1');
  assert.equal(result.sessions[0].title, '活会话一');
  assert.equal(result.sessions[0].running, true);
});

test('create + prompt + messages + cancel round trip', async () => {
  const created = await globalThis.__service.methods.createDsh(ctx, { cwd: 'D:/work/demo' });
  assert.equal(created.sessionId, 'session-new-9');

  const prompted = await globalThis.__service.methods.promptDsh(ctx, {
    sessionId: created.sessionId,
    prompt: '跑一下测试',
    wait: false,
  });
  assert.equal(prompted.ok, true);
  assert.equal(prompted.reply, '收到');

  const messages = await globalThis.__service.methods.messagesDsh(ctx, { sessionId: created.sessionId, limit: 5 });
  assert.equal(messages.messages[0].text, '你好');
  // DSH 会在每轮注入 runtime context / skill 提醒 / 时间采样，role 同为 user；
  // 必须标出来，否则面板会把它们当真人发言显示。
  assert.equal(messages.messages[0].injected, false);
  assert.equal(messages.messages[1].injected, true);
  assert.equal(messages.messages[2].injected, true);
  assert.equal(messages.messages[3].injected, false);
  assert.equal(messages.injectedCount, 2);

  const cancelled = await globalThis.__service.methods.cancelDsh(ctx, { sessionId: created.sessionId });
  assert.equal(cancelled.cancelled, true);
});

test('listWb proxies host http and trims fields', async () => {
  const result = await globalThis.__service.methods.listWb(ctx, { page: 1, source: 'cloud' });
  assert.equal(result.source, 'cloud');
  assert.equal(result.conversations[0].id, 'wb-1');
  assert.equal(result.conversations[0].title, 'WB 会话');
});

test('listWb 本机源：扫 projects 目录，标题/目录取自记录，回滚快照不算会话', async () => {
  const result = await globalThis.__service.methods.listWb(ctx, { source: 'local', pageSize: 20 });
  assert.equal(result.source, 'local');
  assert.equal(result.conversations.length, 1);
  const row = result.conversations[0];
  assert.equal(row.id, LOCAL_ID);
  assert.equal(row.title, '桌面端会话一');
  assert.equal(row.cwd, 'D:\\work\\demo');
  assert.equal(row.source, 'local');
});

test('readWbLocal：宿主运行时没有的会话照样读得到，注入消息被剔掉', async () => {
  const res = await globalThis.__service.methods.readWbLocal(ctx, { conversationId: LOCAL_ID });
  assert.equal(res.found, true);
  assert.deepEqual(res.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(res.messages[0].text, '把迁移报告补一节回滚步骤');
  assert.ok(res.messages[1].text.includes('好，我先看目录'));

  // 拿不到的一律 found:false，路径穿越也必须拒绝
  const missing = await globalThis.__service.methods.readWbLocal(ctx, { conversationId: '../evil' });
  assert.equal(missing.found, false);
  assert.equal(missing.messages.length, 0);
});

test('harnesses：按 CODEX_HOME / CLAUDE_CONFIG_DIR 探测，未安装的不报可用', async () => {
  const res = await globalThis.__service.methods.harnesses(ctx, {});
  const codex = res.harnesses.find((h) => h.id === 'codex');
  const claudeRes = res.harnesses.find((h) => h.id === 'claude');
  assert.equal(codex.available, true);
  assert.equal(codex.readOnly, true);
  assert.equal(codex.resumePrefix, 'codex resume');
  assert.equal(claudeRes.available, true);
  assert.equal(claudeRes.resumePrefix, 'claude --resume');
});

test('listHarness codex：子 agent 默认折叠，标题跳过注入消息', async () => {
  const res = await globalThis.__service.methods.listHarness(ctx, { harness: 'codex', limit: 10 });
  assert.equal(res.rows.length, 1);
  assert.equal(res.hidden, 1); // 那个子 agent 线程
  assert.equal(res.rows[0].id, CODEX_ID);
  // 标题不能取 <environment_context>，要取第一句真人说的话
  assert.equal(res.rows[0].title, '把 README 补一节用法说明');
  assert.equal(res.rows[0].cwd, 'D:\\work\\demo');

  const all = await globalThis.__service.methods.listHarness(ctx, { harness: 'codex', limit: 10, includeSubagents: true });
  assert.equal(all.rows.length, 2);
  const sub = all.rows.find((r) => r.subagent);
  assert.equal(sub.id, CODEX_SUB_ID);
  assert.equal(sub.title, '子 agent · Bacon');
});

test('readHarness codex：只留 user/assistant，连续的助手记录合并成一个气泡', async () => {
  const res = await globalThis.__service.methods.readHarness(ctx, { harness: 'codex', id: CODEX_ID });
  assert.equal(res.found, true);
  assert.deepEqual(res.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(res.messages[0].text, '把 README 补一节用法说明');
  assert.ok(res.messages[1].text.includes('先看现有结构。'));
  assert.ok(res.messages[1].text.includes('改好了。'));
  assert.equal(res.resumeHint, `codex resume ${CODEX_ID}`);
});

test('listHarness claude：标题取 custom-title；readHarness 剔掉 tool_result 与子 agent 分支', async () => {
  const res = await globalThis.__service.methods.listHarness(ctx, { harness: 'claude', limit: 10 });
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].title, '重构会话桥');

  const read = await globalThis.__service.methods.readHarness(ctx, { harness: 'claude', id: CLAUDE_ID });
  assert.deepEqual(read.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(read.messages[0].text, '只读来源也要能看内容');
  // thinking 块不能混进正文
  assert.equal(read.messages[1].text, '可以，扫目录就行。');
});

test('listHarness / readHarness：不认识的 harness 直接报错，不静默返回空', async () => {
  await assert.rejects(() => globalThis.__service.methods.listHarness(ctx, { harness: 'nope' }), /不认识的 harness/);
  await assert.rejects(() => globalThis.__service.methods.readHarness(ctx, { harness: 'codex' }), /缺少 id/);
});

test('createWb retries argument shapes until the host returns an id', async () => {
  globalThis.__wbInvokes.length = 0;
  const created = await globalThis.__service.methods.createWb(ctx, { cwd: 'D:/work/demo' });
  assert.equal(created.conversationId, 'conv-wb-1');
  assert.equal(created.title, '自检会话');
  // 第一种形态（cwd）被宿主拒绝后换成 workspacePath 才成功
  assert.equal(created.args.workspacePath, 'D:/work/demo');
  assert.equal(created.trace.length, 1);
  assert.equal(created.trace[0].ok, false);
});

test('promptWb sends ContentBlock[] rather than a bare string', async () => {
  globalThis.__wbInvokes.length = 0;
  const sent = await globalThis.__service.methods.promptWb(ctx, { conversationId: 'conv-wb-1', text: '你好' });
  assert.equal(sent.chars, 2);
  const call = globalThis.__wbInvokes.find((item) => item.channel === 'wb:conversations:sendPrompt');
  assert.equal(call.args[0], 'conv-wb-1');
  assert.deepEqual(call.args[1], [{ type: 'text', text: '你好' }]);

  await assert.rejects(
    () => globalThis.__service.methods.promptWb(ctx, { conversationId: 'conv-wb-1', text: '   ' }),
    /不能为空/,
  );
  await assert.rejects(() => globalThis.__service.methods.promptWb(ctx, { text: 'x' }), /conversationId/);
});

test('requestsWb flattens content blocks into readable messages', async () => {
  const res = await globalThis.__service.methods.requestsWb(ctx, { conversationId: 'conv-wb-1', limit: 10 });
  // 一条 request → 展开成 user + assistant 两条消息
  assert.equal(res.requests, 1);
  assert.equal(res.count, 2);
  assert.equal(res.messages[0].role, 'user');
  assert.equal(res.messages[0].text, '自检：报 ID / 项目 / 时间');
  assert.equal(res.messages[1].role, 'assistant');
  assert.match(res.messages[1].text, /"sid":"conv-wb-1"/);
  assert.ok(res.messages[0].time > 0);
});

test('requestsWb 在助手还没回时只给 user 一条，不会把提问当回复', async () => {
  const { activate } = await import('node:module').then(({ createRequire }) => ({ activate: createRequire(import.meta.url)('../extension/server/index.cjs').activate }));
  const streaming = activate({
    invoke: async (channel) => {
      if (channel === 'wb:conversations:requests') {
        return {
          items: [{
            id: 'r2',
            timestamp: 1792813019023,
            userMessage: { type: 'text', content: [{ type: 'text', text: '第二轮问题' }] },
            state: 'streaming',
          }],
        };
      }
      return { ok: true };
    },
  });
  const res = await streaming.methods.requestsWb({ callerId: undefined }, { conversationId: 'conv-wb-2' });
  assert.equal(res.count, 1);
  assert.equal(res.messages[0].role, 'user');
  assert.equal(res.messages[0].text, '第二轮问题');
});

test('validates required arguments', async () => {
  await assert.rejects(() => globalThis.__service.methods.promptDsh(ctx, { sessionId: '', prompt: 'x' }), /sessionId/);
  await assert.rejects(() => globalThis.__service.methods.copyText(ctx, { text: '' }), /没有要复制/);
});

test('falls back to disk history when MCP is down', async () => {
  const endpoint = process.env.DSH_MCP_URL;
  process.env.DSH_MCP_URL = 'http://127.0.0.1:1/mcp';
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { activate } = require('../extension/server/index.cjs');
  const offline = activate({});
  const result = await offline.methods.listDsh(ctx, { limit: 5 });
  assert.equal(result.online, false);
  assert.equal(result.source, 'history');
  assert.ok(result.sessions.some((session) => session.id === 'session-old-2'));
  process.env.DSH_MCP_URL = endpoint;
});

test('bridge queue：命令行写请求文件，service 取走执行并写回结果', async () => {
  const dir = path.join(process.env.WORKBUDDY_HOME, 'dsh-skills', 'bridge-queue');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'q-ok.req.json'), JSON.stringify({ id: 'q-ok', method: 'ping', payload: {} }));

  let body = null;
  const resPath = path.join(dir, 'q-ok.res.json');
  for (let i = 0; i < 60; i += 1) {
    if (fs.existsSync(resPath)) {
      body = JSON.parse(fs.readFileSync(resPath, 'utf8'));
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok(body, '队列没有写回结果（service 的 watcher 没跑？）');
  assert.equal(body.ok, true);
  assert.equal(body.method, 'ping');
  // 版本号跟着清单走，别在测试里写死——否则每次发版都要改这一行
  const manifest = JSON.parse(fs.readFileSync(new URL('../extension/extension.json', import.meta.url), 'utf8'));
  assert.equal(body.result.version, manifest.version);
  assert.ok(!fs.existsSync(path.join(dir, 'q-ok.req.json')), '请求文件应被取走');
});

test('bridge queue：白名单外的方法直接拒绝执行', async () => {
  const dir = path.join(process.env.WORKBUDDY_HOME, 'dsh-skills', 'bridge-queue');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'q-bad.req.json'),
    JSON.stringify({ id: 'q-bad', method: 'runArbitraryCode', payload: {} })
  );

  let body = null;
  const resPath = path.join(dir, 'q-bad.res.json');
  for (let i = 0; i < 60; i += 1) {
    if (fs.existsSync(resPath)) {
      body = JSON.parse(fs.readFileSync(resPath, 'utf8'));
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.ok(body, '队列没有写回结果');
  assert.equal(body.ok, false);
  assert.equal(body.code, 'INVALID_ARGUMENT');
});

test('flattenWbRequests：用宿主原样 payload 回归，reasoning 不能混进正文', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { flattenWbRequests } = require('../extension/server/index.cjs');

  // 2026-10-24 11:37 从宿主 wb:conversations:requests 原样抓下来的两条 item
  const items = [
    {
      id: '01a16bfb85a97c72a55f9d0ae1640e40',
      conversationRequestId: '01a16bfb85a97c72a55f9d0ae1640e40',
      identity: { requestId: '01a16bfb85a97c72a55f9d0ae1640e40', forkMessageId: 'a1b2c3d4-0009-4a00-8000-000000000009' },
      timestamp: 1792813008297,
      userMessage: {
        type: 'text',
        content: [{ type: 'text', text: '（会话桥自检 1/2）只回一行 JSON' }],
        state: 'completed',
      },
      assistantMessage: {
        contentIdentity: 'message',
        type: 'text',
        content: [
          { type: 'reasoning', text: 'The user is asking for a bridge check - just output JSON, no tools.', messageId: 'a' },
          { type: 'text', text: '{"cwd":"D:/your/project","utc8":"2026-10-24T11:36:53+08:00","sid":null}', messageId: 'b' },
        ],
      },
      state: 'streaming',
      usage: {},
      responseModel: { id: 'glm-5.3-flash' },
    },
    {
      id: '01a16bfb8a5e7bf094e6d0b6a581f150',
      timestamp: 1792813019023,
      userMessage: { type: 'text', content: [{ type: 'text', text: '（会话桥自检 2/2）回显 ID' }], state: 'completed' },
      state: 'streaming',
      usage: {},
    },
  ];

  const messages = flattenWbRequests(items);
  assert.equal(messages.length, 3);
  assert.equal(messages[1].role, 'assistant');
  assert.equal(
    messages[1].text,
    '{"cwd":"D:/your/project","utc8":"2026-10-24T11:36:53+08:00","sid":null}'
  );
  assert.ok(!messages[1].text.includes('bridge check'), 'reasoning 被拼进正文了');
  assert.ok(messages[1].reasoning > 0);
  // 第 2 条还没回复，只能有 user
  assert.equal(messages[2].role, 'user');
  assert.equal(messages.filter((m) => m.role === 'assistant').length, 1);
});
