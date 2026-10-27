import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CdpSocket } = require('../extension/server/cdp.cjs');
const { MenuInjector, resolvePort } = require('../extension/server/menu-inject.cjs');

// 默认把注入器钉死在关闭状态：开发机上 shell 往往带着
// WORKBUDDY_REMOTE_DEBUGGING_PORT=9222，一不留神测试就会连真实客户端。
process.env.WORKBUDDY_MENU_INJECT = 'off';

/**
 * 注入器的协议层是手写的（service 是裸 Node 进程，装不了 ws），
 * 所以这里起一个真的 WebSocket 服务端，按 RFC6455 走一遍握手和收发，
 * 而不是 mock 掉传输层。
 */
function acceptFor(key) {
  return crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

/** 服务端侧：解析客户端帧（带掩码），并回不带掩码的文本帧。 */
function attachWsServer(server, onMessage) {
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptFor(String(key))}`,
        '',
        '',
      ].join('\r\n'),
    );

    socket.state = { buffer: Buffer.alloc(0) };

    const send = (text) => {
      const payload = Buffer.from(text, 'utf8');
      let header;
      if (payload.length < 126) {
        header = Buffer.alloc(2);
        header[1] = payload.length;
      } else {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
      }
      header[0] = 0x81;
      socket.write(Buffer.concat([header, payload]));
    };

    socket.on('data', (chunk) => {
      socket.state.buffer = Buffer.concat([socket.state.buffer, chunk]);
      for (;;) {
        const buffer = socket.state.buffer;
        if (buffer.length < 2) return;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        let mask = null;
        if (masked) {
          if (buffer.length < offset + 4) return;
          mask = buffer.subarray(offset, offset + 4);
          offset += 4;
        }
        if (buffer.length < offset + length) return;
        let payload = buffer.subarray(offset, offset + length);
        if (mask) {
          const out = Buffer.alloc(length);
          for (let i = 0; i < length; i += 1) out[i] = payload[i] ^ mask[i % 4];
          payload = out;
        }
        socket.state.buffer = buffer.subarray(offset + length);
        if (opcode === 0x8) {
          socket.end();
          return;
        }
        if (opcode === 0x1) onMessage(payload.toString('utf8'), send, socket);
      }
    });
  });
}

test('resolvePort：环境变量优先，其次配置文件，都没有就休眠', () => {
  const backup = process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT;
  const backupOff = process.env.WORKBUDDY_MENU_INJECT;
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'dsh-cfg-'));
  const cfg = path.join(dir, 'menu-inject.json');
  try {
    delete process.env.WORKBUDDY_MENU_INJECT; // 这一条测的是优先级，先解开硬关闭
    delete process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT;
    assert.equal(resolvePort(cfg), 0);

    process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT = 'abc';
    assert.equal(resolvePort(cfg), 0);

    process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT = '0';
    assert.equal(resolvePort(cfg), 0);

    process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT = '70000';
    assert.equal(resolvePort(cfg), 0);

    process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT = '9222';
    assert.equal(resolvePort(cfg), 9222);

    // 环境变量没了（service 拿不到用户级变量就是这个状态），配置文件顶上
    delete process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT;
    fs.writeFileSync(cfg, JSON.stringify({ enabled: true, port: 9333 }), 'utf8');
    assert.equal(resolvePort(cfg), 9333);

    // enabled:false 视为关闭
    fs.writeFileSync(cfg, JSON.stringify({ enabled: false, port: 9333 }), 'utf8');
    assert.equal(resolvePort(cfg), 0);

    // 坏 JSON 不该抛
    fs.writeFileSync(cfg, '{oops', 'utf8');
    assert.equal(resolvePort(cfg), 0);
  } finally {
    if (backup === undefined) delete process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT;
    else process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT = backup;
    if (backupOff === undefined) delete process.env.WORKBUDDY_MENU_INJECT;
    else process.env.WORKBUDDY_MENU_INJECT = backupOff;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('没设端口时 start() 不发任何请求，状态保持关闭', () => {
  const backup = process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT;
  const dir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'dsh-off-'));
  delete process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT;
  try {
    // 必须显式给一个不存在的配置路径：否则会读到本机真实配置（9222），
    // 测试就会去连用户正在用的客户端，等于往人家窗口里注入脚本。
    const injector = new MenuInjector({ configFile: path.join(dir, 'none.json') });
    injector.start();
    const status = injector.status();
    assert.equal(status.enabled, false);
    assert.equal(status.running, false);
    assert.equal(status.connected, 0);
    injector.stop();
  } finally {
    if (backup !== undefined) process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT = backup;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CDP 客户端：握手 → 发请求 → 收结果 → 收事件', async () => {
  const server = http.createServer((_req, res) => res.end('ok'));
  const seen = [];
  attachWsServer(server, (text, send) => {
    const message = JSON.parse(text);
    seen.push(message);
    if (message.method === 'Page.enable') {
      send(JSON.stringify({ id: message.id, result: { ok: true } }));
      send(JSON.stringify({ method: 'Page.loadEventFired', params: { at: 1 } }));
    } else if (message.method === 'Runtime.evaluate') {
      send(JSON.stringify({ id: message.id, result: { result: { type: 'undefined' } } }));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const socket = await CdpSocket.connect(`ws://127.0.0.1:${port}/devtools/page/TEST`);
  try {
    const eventPromise = new Promise((resolve) => socket.on('Page.loadEventFired', resolve));
    const result = await socket.send('Page.enable');
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(await eventPromise, { at: 1 });

    const evaluated = await socket.send('Runtime.evaluate', { expression: '1+1' });
    assert.equal(evaluated.result.type, 'undefined');

    // 请求体必须是掩码帧，服务端解出来的方法名要一模一样
    assert.deepEqual(
      seen.map((m) => m.method),
      ['Page.enable', 'Runtime.evaluate'],
    );
  } finally {
    socket.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('握手被拒时给出可读错误，不是挂死', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(403);
    res.end('nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await assert.rejects(
      () => CdpSocket.connect(`ws://127.0.0.1:${port}/devtools/page/TEST`, 1500),
      /握手被拒|握手超时|连接已关闭/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('注入脚本是合法 JS，且带了幂等守卫和菜单标记', () => {
  const file = path.join(process.cwd(), 'extension', 'inject', 'session-menu.js');
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /__dshCopySessionMenu/);
  assert.match(source, /data-dsh-copy-session/);
  assert.match(source, /data-conversation-id/);
  assert.match(source, /复制 Session ID/);
});

test('注入脚本不绑死会话行的组件 class，菜单定位有兜底', () => {
  const file = path.join(process.cwd(), 'extension', 'inject', 'session-menu.js');
  const source = fs.readFileSync(file, 'utf8');
  // 会话行只认 data-conversation-id（宿主自己给的稳定属性）
  assert.doesNotMatch(source, /workspace-more-popover/);
  assert.doesNotMatch(source, /conversation-item--/);
  // 菜单优先用语义类名，但必须留 role=menu 的兜底，类名改名不至于整条失效
  assert.match(source, /conversation-context-menu/);
  assert.match(source, /role="menu"/);
});
