"use strict";

/**
 * 最小 CDP 客户端：够连 WorkBuddy 的 remote-debugging-port 就行。
 *
 * 为什么不引 ws 包：extension service 是宿主 fork 出来的裸 Node 进程，
 * 装不了依赖；而且宿主自带的 node_modules 在 asar 里，我们无权 require。
 * 所以这里按 RFC6455 手写客户端帧：只支持文本帧 + ping/pong + close，够用。
 */

const http = require("node:http");
const crypto = require("node:crypto");

function httpJson(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(new Error(`响应不是 JSON：${error.message}`));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("连接超时"));
    });
    req.on("error", reject);
  });
}

class CdpSocket {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.onClose = null;

    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => this.#fail(new Error("连接已关闭")));
  }

  static connect(wsUrl, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(wsUrl);
      } catch (error) {
        reject(error);
        return;
      }

      const key = crypto.randomBytes(16).toString("base64");
      const req = http.request({
        host: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        timeout: timeoutMs,
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13",
        },
      });

      req.on("upgrade", (res, socket) => {
        if (res.headers["sec-websocket-accept"] !== acceptFor(key)) {
          socket.destroy();
          reject(new Error("WebSocket 握手校验失败"));
          return;
        }
        socket.setNoDelay(true);
        resolve(new CdpSocket(socket));
      });
      req.on("response", (res) => {
        res.resume();
        reject(new Error(`WebSocket 握手被拒：HTTP ${res.statusCode}`));
      });
      req.on("timeout", () => {
        req.destroy(new Error("WebSocket 握手超时"));
      });
      req.on("error", reject);
      req.end();
    });
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("连接已关闭"));
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ id, method, params }), "utf8");
    this.#writeFrame(0x1, payload);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 8000);
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.#writeFrame(0x8, Buffer.alloc(0));
      this.socket.end();
    } catch {
      /* ignore */
    }
    this.#fail(new Error("连接已关闭"));
  }

  #fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const [, waiter] of this.pending) waiter.reject(error);
    this.pending.clear();
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    if (this.onClose) {
      try {
        this.onClose(error);
      } catch {
        /* ignore */
      }
    }
  }

  #writeFrame(opcode, payload) {
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(6);
      header[1] = 0x80 | length;
    } else if (length < 65536) {
      header = Buffer.alloc(8);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(14);
      header[1] = 0x80 | 127;
      header.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
      header.writeUInt32BE(length >>> 0, 6);
    }
    header[0] = 0x80 | opcode;
    const mask = crypto.randomBytes(4);
    mask.copy(header, header.length - 4);
    const masked = Buffer.alloc(length);
    for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
    try {
      this.socket.write(Buffer.concat([header, masked]));
    } catch (error) {
      this.#fail(error);
    }
  }

  #onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const buffer = this.buffer;
      if (buffer.length < 2) return;

      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      let maskKey = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;

      let payload = buffer.subarray(offset, offset + length);
      if (maskKey) {
        const unmasked = Buffer.alloc(length);
        for (let i = 0; i < length; i += 1) unmasked[i] = payload[i] ^ maskKey[i % 4];
        payload = unmasked;
      }
      this.buffer = buffer.subarray(offset + length);

      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(Buffer.from(payload));
        if (fin) {
          const text = Buffer.concat(this.fragments).toString("utf8");
          this.fragments = [];
          this.#onMessage(text);
        }
      } else if (opcode === 0x8) {
        this.#fail(new Error("对端关闭连接"));
        return;
      } else if (opcode === 0x9) {
        this.#writeFrame(0xa, payload);
      }
    }
  }

  #onMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || "CDP 调用失败"));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method && this.listeners.has(message.method)) {
      for (const handler of this.listeners.get(message.method)) {
        try {
          handler(message.params);
        } catch {
          /* 监听器自己炸不该影响通道 */
        }
      }
    }
  }
}

function acceptFor(key) {
  return crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

module.exports = { CdpSocket, httpJson };
