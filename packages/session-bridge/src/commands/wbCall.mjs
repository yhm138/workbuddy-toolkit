/**
 * wb-call —— 从命令行调用「只有扩展 service 才做得到」的宿主能力。
 *
 * 背景：`wb.invoke`（`wb:conversations:*` 等宿主通道）存在于宿主 fork 出来的
 * service 进程里，命令行进程没有任何合法途径拿到 daemon 的 RPC 票据。
 * 所以反过来：CLI 往约定目录写请求文件，service 轮询取走执行，把结果写回。
 *
 * 这条链路让 `createWb` / `promptWb` / `requestsWb` 这类通道对脚本、自动化、
 * CI 都变得可调用，而不只是面板里点按钮。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, workbuddyHome, writeJson } from '../core/fsx.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function bridgeQueueDir() {
  return path.join(workbuddyHome(), "dsh-skills", "bridge-queue");
}

function newRequestId() {
  return `q${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function wbCall(method, options = {}) {
  if (!method) {
    throw new Error(
      '缺少方法名。用法：dsh2wb wb-call <method> --payload \'{"k":"v"}\'\n' +
        '常用方法：createWb / promptWb / requestsWb / listWb / ping',
    );
  }

  let payload = {};
  if (options.payloadFile) {
    payload = readJson(path.resolve(options.payloadFile));
  } else if (options.payload) {
    try {
      payload = JSON.parse(options.payload);
    } catch (error) {
      throw new Error(`--payload 不是合法 JSON：${error.message}`);
    }
  }

  const timeoutMs = Math.max(1000, Number(options.timeout) || 60000);
  const dir = bridgeQueueDir();
  ensureDir(dir);

  const id = newRequestId();
  const reqPath = path.join(dir, `${id}.req.json`);
  const resPath = path.join(dir, `${id}.res.json`);
  writeJson(reqPath, { id, method, payload, at: Date.now() });

  const deadline = Date.now() + timeoutMs;
  let picked = false;

  while (Date.now() < deadline) {
    if (fs.existsSync(resPath)) {
      const body = readJson(resPath);
      try {
        fs.unlinkSync(resPath);
      } catch {
        /* noop */
      }
      return body;
    }
    if (!picked && !fs.existsSync(reqPath)) picked = true;
    await sleep(250);
  }

  try {
    fs.unlinkSync(reqPath);
  } catch {
    /* 已被 service 取走就删不掉，无妨 */
  }

  const hint = picked
    ? '请求已被 service 取走但没写回结果——多半是该方法卡住了（比如宿主没响应）。'
    : '请求一直没被取走，说明扩展 service 没在跑，或跑的还是旧代码。';
  throw new Error(`等待 ${timeoutMs}ms 无响应。${hint}\n队列目录：${dir}`);
}

export function renderWbCall(body, options = {}) {
  if (options.json) {
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  if (!body.ok) {
    console.error(`✗ ${body.method} 失败：${body.error || '未知错误'}${body.code ? `（${body.code}）` : ''}`);
    return;
  }
  const result = body.result ?? {};
  console.log(`✓ ${body.method}（${new Date(body.at).toLocaleTimeString('zh-CN')}）`);
  console.log(JSON.stringify(result, null, 2));
}
