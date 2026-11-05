import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * hostChannels / hostInvoke 的边界。
 *
 * 这一页的承诺很窄：把宿主的 wb:conversations:* 原样透传出去，只放只读与 configSet*。
 * 所以测试也只盯三件事——清单对不对、挡不挡得住写入类、参数和返回值有没有被动手脚。
 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-channels-'));
process.env.WORKBUDDY_HOME = tmp;
process.env.WORKBUDDY_MENU_INJECT = 'off';

const { activate } = createRequire(import.meta.url)('../extension/server/index.cjs');

function fakeHost(reply) {
  const calls = [];
  const service = activate({
    invoke: async (channel, ...args) => {
      calls.push({ channel, args });
      return reply ? reply(channel, ...args) : { ok: true };
    },
  });
  return { service, calls };
}

test('清单：31 条，放行 16 条，写入类全在 deny 里', async () => {
  const { service } = fakeHost();
  const res = await service.methods.hostChannels();

  assert.equal(res.ok, true);
  assert.equal(res.total, 31, 'edge-sync 里就是 31 条 wb:conversations:* 通道');
  assert.equal(res.allowed, 16, '8 条只读 + 8 条 configSet*');
  assert.equal(res.channels.length, 31);
  assert.equal(new Set(res.channels.map((c) => c.id)).size, 31, 'id 不能重复');

  for (const c of res.channels) {
    assert.ok(c.id && c.group && c.note, `条目缺字段：${JSON.stringify(c)}`);
    assert.equal(c.channel, `wb:conversations:${c.id}`);
    assert.equal(c.allowed, c.allow !== 'deny');
    if (c.allow === 'deny') assert.equal(c.sample, undefined, '不放行的条目不该给参数模板');
  }

  const allowed = res.channels.filter((c) => c.allowed).map((c) => c.id);
  assert.ok(allowed.includes('list'));
  assert.ok(allowed.includes('requests'));
  assert.ok(allowed.includes('configSetModel'));
  assert.ok(allowed.includes('configSetPreMessageCompactPct'));
  assert.ok(!allowed.includes('delete'));
  assert.ok(!allowed.includes('sendPrompt'));
});

test('只读通道：位置参数原样透传，返回值原样带回', async () => {
  const { service, calls } = fakeHost(() => ({ total: 2, items: [{ id: 'a' }, { id: 'b' }] }));
  const res = await service.methods.hostInvoke({}, { channel: 'wb:conversations:requests', args: ['conv-1', { limit: 20 }] });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].channel, 'wb:conversations:requests');
  assert.deepEqual(calls[0].args, ['conv-1', { limit: 20 }]);

  assert.equal(res.ok, true);
  assert.equal(res.channel, 'wb:conversations:requests');
  assert.deepEqual(res.result, { total: 2, items: [{ id: 'a' }, { id: 'b' }] });
  assert.equal(res.truncated, false);
  assert.ok(res.ms >= 0);
});

test('configSet* 放行：裸值直接透传，不做字段名包装', async () => {
  const { service, calls } = fakeHost(() => undefined);
  const res = await service.methods.hostInvoke({}, {
    channel: 'wb:conversations:configSetThoughtLevel',
    args: ['conv-9', 'max'],
  });
  assert.deepEqual(calls[0].args, ['conv-9', 'max']);
  assert.equal(res.result, null, 'undefined 要变成 null 才能结构化克隆');
});

test('写入类一律拒绝，且不往宿主发', async () => {
  const { service, calls } = fakeHost();
  for (const id of ['delete', 'sendPrompt', 'fork', 'resolvePending', 'rename']) {
    await assert.rejects(
      () => service.methods.hostInvoke({}, { channel: `wb:conversations:${id}`, args: ['x'] }),
      (e) => e.code === 'FORBIDDEN',
      `${id} 不该被放行`,
    );
  }
  assert.equal(calls.length, 0, '被拒的通道不能真的调宿主');
});

test('参数形状不对就早点报错，别让宿主瞎猜', async () => {
  const { service, calls } = fakeHost();

  await assert.rejects(
    () => service.methods.hostInvoke({}, { channel: 'wb:conversations:list', args: { limit: 20 } }),
    (e) => e.code === 'INVALID_ARGUMENT',
  );
  await assert.rejects(
    () => service.methods.hostInvoke({}, { channel: 'wb:conversations:list', args: [1, 2, 3, 4, 5, 6, 7, 8, 9] }),
    (e) => e.code === 'INVALID_ARGUMENT',
  );
  await assert.rejects(
    () => service.methods.hostInvoke({}, { args: [] }),
    (e) => e.code === 'INVALID_ARGUMENT',
  );
  assert.equal(calls.length, 0);
});

test('省略 args 等于空参，通道名可以带前缀也可以不带', async () => {
  const { service, calls } = fakeHost(() => ({ ok: true }));
  await service.methods.hostInvoke({}, { channel: 'list' });
  await service.methods.hostInvoke({}, { channel: 'wb:conversations:list' });
  assert.deepEqual(calls.map((c) => c.channel), ['wb:conversations:list', 'wb:conversations:list']);
  assert.deepEqual(calls[0].args, []);
});

test('超大返回：截断并标记，不把整段正文塞给面板', async () => {
  const huge = { items: Array.from({ length: 2000 }, (_, i) => ({ id: `conv-${i}`, text: 'x'.repeat(200) })) };
  const { service } = fakeHost(() => huge);
  const res = await service.methods.hostInvoke({}, { channel: 'wb:conversations:list', args: [] });

  assert.equal(res.truncated, true);
  assert.equal(typeof res.result, 'string');
  assert.ok(res.result.length <= 200001, `截断后还这么长：${res.result.length}`);
  assert.ok(res.result.endsWith('…'));
  assert.ok(res.bytes > 200000);
});

test('宿主报错：带上通道名和原始 message，code 原样透传', async () => {
  const { service } = fakeHost(() => {
    const error = new Error('conversation not found');
    error.code = 'WB_NOT_FOUND';
    throw error;
  });
  await assert.rejects(
    () => service.methods.hostInvoke({}, { channel: 'wb:conversations:get', args: ['missing'] }),
    (e) => {
      assert.equal(e.code, 'WB_NOT_FOUND');
      assert.match(e.message, /wb:conversations:get/);
      assert.match(e.message, /conversation not found/);
      return true;
    },
  );
});
