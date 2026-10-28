import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * 守护的重点不是「能拷文件」，而是「什么时候不该动文件」：
 * 客户端跑着的时候换扩展目录，宿主按启动快照去取文件，只会得到加载失败。
 * 所以这里把 running / 缺目录 / 版本不一致 三种情况都钉住。
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh2wb-guard-'));
process.env.WORKBUDDY_HOME = path.join(sandbox, 'home');

const guard = await import('../bin/guard.mjs');

const ROOT = path.join(sandbox, 'WorkBuddy');
const EXT_ROOT = guard.extensionsDir(ROOT);
fs.mkdirSync(EXT_ROOT, { recursive: true });

function makeExtension(id, version) {
  const dir = path.join(sandbox, 'src', id);
  fs.mkdirSync(path.join(dir, 'ui'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'extension.json'), JSON.stringify({ id, version, service: { entry: './server/index.cjs' } }));
  fs.writeFileSync(path.join(dir, 'distribution.json'), JSON.stringify({ extensionId: id, version }));
  fs.writeFileSync(path.join(dir, 'ui', 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(dir, 'server', 'index.cjs'), '// service');
  return dir;
}

function install(id, source) {
  fs.cpSync(source, path.join(EXT_ROOT, id), { recursive: true });
}

const bridge = makeExtension('dsh-session-bridge', '1.1.0');
const cloud = makeExtension('cloud-sessions', '1.11.2');

test('health 能区分四种状态', () => {
  install('dsh-session-bridge', bridge);
  assert.equal(guard.health(path.join(EXT_ROOT, 'dsh-session-bridge'), '1.1.0'), 'ok');
  assert.equal(guard.health(path.join(EXT_ROOT, 'dsh-session-bridge'), '2.0.0'), 'stale');
  assert.equal(guard.health(path.join(EXT_ROOT, 'nope'), '1.1.0'), 'missing');

  fs.rmSync(path.join(EXT_ROOT, 'dsh-session-bridge', 'server'), { recursive: true });
  assert.equal(guard.health(path.join(EXT_ROOT, 'dsh-session-bridge'), '1.1.0'), 'broken');
});

test('升级把目录删掉后，客户端没跑就补回去', () => {
  fs.rmSync(path.join(EXT_ROOT, 'dsh-session-bridge'), { recursive: true, force: true });
  fs.rmSync(path.join(EXT_ROOT, 'cloud-sessions'), { recursive: true, force: true });

  const fromBridge = guard.sweep({ extensions: ['dsh-session-bridge'] }, { running: false, root: ROOT });
  assert.deepEqual(fromBridge.results.map((r) => r.action), ['failed:missing'], 'store 里没登记时不该假装修好');

  guard.writeConfig({ root: ROOT, extensions: ['dsh-session-bridge'] });
  const config = guard.readConfig();
  assert.deepEqual(config.extensions, ['dsh-session-bridge']);
});

test('客户端在跑、目录整个没了：可以补（这次启动本来就没加载过它）', () => {
  // 手动往 store 里放一份，模拟正常安装后的状态
  fs.mkdirSync(path.join(guard.STORE_DIR, 'dsh-session-bridge'), { recursive: true });
  fs.cpSync(bridge, path.join(guard.STORE_DIR, 'dsh-session-bridge'), { recursive: true });
  fs.cpSync(cloud, path.join(guard.STORE_DIR, 'cloud-sessions'), { recursive: true });

  const running = guard.sweep({ root: ROOT, extensions: ['dsh-session-bridge'] }, { running: true, root: ROOT });
  assert.equal(running.results[0].action, 'repaired:missing');
  assert.equal(guard.health(path.join(EXT_ROOT, 'dsh-session-bridge'), '1.1.0'), 'ok');
});

test('客户端在跑、版本对不上：一个字节都不动', () => {
  const file = path.join(EXT_ROOT, 'cloud-sessions', 'extension.json');
  fs.cpSync(cloud, path.join(EXT_ROOT, 'cloud-sessions'), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id: 'cloud-sessions', version: '1.0.0', service: { entry: './server/index.cjs' } }));

  const running = guard.sweep({ root: ROOT, extensions: ['cloud-sessions'] }, { running: true, root: ROOT });
  assert.equal(running.results[0].action, 'skip-running:stale');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, '1.0.0');
});

test('客户端退出后把缺的补回来，并留标记', () => {
  fs.rmSync(path.join(EXT_ROOT, 'cloud-sessions'), { recursive: true, force: true });
  const result = guard.sweep({ root: ROOT, extensions: ['cloud-sessions'] }, { running: false, root: ROOT });
  assert.deepEqual(result.results.map((r) => r.action), ['repaired:missing']);
  const dir = path.join(EXT_ROOT, 'cloud-sessions');
  assert.equal(guard.health(dir, guard.storeVersion('cloud-sessions')), 'ok');
  assert.ok(fs.existsSync(path.join(dir, guard.EXT_MARKER)));
});

test('第二轮回不再重复拷贝', () => {
  const before = fs.statSync(path.join(EXT_ROOT, 'dsh-session-bridge', 'extension.json')).mtimeMs;
  const result = guard.sweep({ root: ROOT, extensions: ['dsh-session-bridge'] }, { running: false, root: ROOT });
  assert.equal(result.results[0].action, 'ok');
  const after = fs.statSync(path.join(EXT_ROOT, 'dsh-session-bridge', 'extension.json')).mtimeMs;
  assert.equal(before, after);
});

test('版本变旧也当成需要修', () => {
  const file = path.join(EXT_ROOT, 'cloud-sessions', 'extension.json');
  fs.writeFileSync(file, JSON.stringify({ id: 'cloud-sessions', version: '1.0.0', service: { entry: './server/index.cjs' } }));
  const result = guard.sweep({ root: ROOT, extensions: ['cloud-sessions'] }, { running: false, root: ROOT });
  assert.equal(result.results[0].action, 'repaired:stale');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, '1.11.2');
});
