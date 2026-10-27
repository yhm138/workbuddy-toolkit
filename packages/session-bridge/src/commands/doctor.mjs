import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { analyze } from '../core/parity.mjs';
import { readProfile } from '../core/profile.mjs';
import { dshHome, readJson, workbuddyHome } from '../core/fsx.mjs';
import { EXT_ID, findWorkbuddyRoot } from './installExtension.mjs';

const SKILLS = [
  'dsh-parity',
  'dsh-config-port',
  'dsh-session-ops',
  'dsh-token-usage',
  'dsh-session-search',
  'dsh-session-inspector',
  'wb-parity-doctor',
];

export async function doctor(options = {}) {
  const wbHome = options.workbuddyHome ? path.resolve(options.workbuddyHome) : workbuddyHome();
  const checks = [];
  const add = (level, title, detail) => checks.push({ level, title, detail });

  add('info', 'WorkBuddy 目录', wbHome);

  // skills
  const skillRoot = path.join(wbHome, 'skills');
  for (const skill of SKILLS) {
    const file = path.join(skillRoot, skill, 'SKILL.md');
    if (fs.existsSync(file)) add('ok', `技能 ${skill}`, file);
    else add('fail', `技能 ${skill}`, '未安装，运行 node bin/dsh2wb.mjs install');
  }

  // runtime + snapshot
  const targetRoot = path.join(wbHome, 'dsh-skills');
  const snapshot = readJson(path.join(targetRoot, 'config', 'dsh-parity.json'), null);
  if (snapshot) {
    add(
      'ok',
      '配置快照',
      `${snapshot.profile} · ${snapshot.dshVersion ?? '版本未知'} · ${snapshot.parity?.score ?? '—'}/100`,
    );
  } else {
    add('fail', '配置快照', `缺少 ${path.join(targetRoot, 'config', 'dsh-parity.json')}`);
  }

  // mcp
  const mcp = readJson(path.join(wbHome, 'mcp.json'), null);
  const entry = mcp?.mcpServers?.dsh_local;
  if (entry) {
    add('ok', 'MCP 桥接 dsh_local', `${entry.type ?? 'http'} ${entry.url}`);
    const tokenAuthorized = Boolean(entry.headers?.Authorization);
    add(
      tokenAuthorized ? 'ok' : 'warn',
      'MCP 令牌',
      tokenAuthorized ? '已写入 Authorization' : '缺 Authorization，重新运行 install',
    );
    const url = new URL(entry.url);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    const reachable = await probe(url.hostname, port);
    add(
      reachable ? 'ok' : 'warn',
      'DSH MCP 服务',
      reachable
        ? `${url.hostname}:${port} 可连接`
        : `${url.hostname}:${port} 未监听（启动 DSH 后 dsh-as-mcp 才会监听）`,
    );
  } else {
    add('warn', 'MCP 桥接 dsh_local', '未配置（不需要反向驱动 DSH 时可忽略）');
  }

  // token file
  const tokenFile = path.join(dshHome(), 'dsh-as-mcp', 'token');
  add(fs.existsSync(tokenFile) ? 'ok' : 'warn', 'DSH token 文件', tokenFile);

  // live profile drift
  const liveProfileDir = path.join(dshHome(), 'profiles', 'desktop');
  if (snapshot && fs.existsSync(path.join(liveProfileDir, 'cordis.patch.yml'))) {
    try {
      const live = analyze(readProfile(liveProfileDir));
      const drift = diffSettings(snapshot, live);
      if (drift.length === 0) {
        add('ok', '配置漂移', '本机 DSH 配置与快照一致');
      } else {
        add('warn', '配置漂移', `${drift.length} 项变化：${drift.join('；')}`);
      }
    } catch (error) {
      add('warn', '配置漂移', `无法读取本机 DSH 配置：${error.message}`);
    }
  }

  // mcp session tools
  if (entry) {
    const token = entry.headers?.Authorization?.replace(/^Bearer\s+/i, '') || '';
    const tools = await listMcpTools(entry.url, token);
    if (tools === null) {
      add('warn', 'MCP 会话工具', '无法列工具（DSH 未启动或 token 失效）');
    } else {
      const required = ['session_create', 'session_list', 'session_prompt', 'session_messages', 'session_cancel'];
      const missing = required.filter((name) => !tools.includes(name));
      add(
        missing.length ? 'warn' : 'ok',
        'MCP 会话工具',
        missing.length ? `缺少 ${missing.join(', ')}` : `${required.length} 个会话工具可用`,
      );
    }
  }

  // builtin extension
  try {
    const wbRoot = findWorkbuddyRoot(options.workbuddyRoot);
    const extDir = path.join(wbRoot, 'resources', 'app.asar.unpacked', 'resources', 'extensions', EXT_ID);
    const manifest = readJson(path.join(extDir, 'extension.json'), null);
    const dist = readJson(path.join(extDir, 'distribution.json'), null);
    if (!manifest) {
      add('warn', '侧栏扩展', `未安装（${extDir}）`);
    } else if (!dist || dist.version !== manifest.version || dist.extensionId !== manifest.id) {
      add('warn', '侧栏扩展', '清单版本不一致，重新运行 install-extension');
    } else {
      add('ok', '侧栏扩展', `${manifest.name} v${manifest.version} · 已就位（重启客户端后生效）`);
    }
  } catch (error) {
    add('warn', '侧栏扩展', error.message.split('\n')[0]);
  }

  // marketplace registration
  const known = readJson(path.join(wbHome, 'plugins', 'known_marketplaces.json'), {});
  add(
    known?.['dsh-skills'] ? 'ok' : 'info',
    '本地插件市场',
    known?.['dsh-skills'] ? '已注册 dsh-skills' : '未注册（install --register-marketplace 可开启）',
  );

  // remaining manual settings from snapshot
  const manual = [];
  const s = snapshot?.settings ?? {};
  if (s.permissionPreset === 'danger-full-access') {
    manual.push('权限：DSH 是 danger-full-access，WorkBuddy 建议「工作区可写 + 审批」');
  }
  if (s.model) manual.push(`模型：${s.model.provider}/${s.model.model} · ${s.model.reasoningEffort ?? 'default'}（在模型菜单选择）`);
  if (s.locale) manual.push(`语言：${s.locale}（WorkBuddy 界面语言）`);

  if (options.json) {
    console.log(JSON.stringify({ wbHome, checks, manual }, null, 2));
  } else {
    console.log('会话桥 · 安装自检\n');
    for (const check of checks) {
      const icon = check.level === 'ok' ? '✓' : check.level === 'warn' ? '!' : check.level === 'fail' ? '✗' : '·';
      console.log(`  ${icon} ${check.title.padEnd(18)} ${check.detail}`);
    }
    if (manual.length) {
      console.log('\n客户端设置（命令行改不了）：');
      for (const item of manual) console.log(`  ✍️ ${item}`);
    }
    const failed = checks.filter((c) => c.level === 'fail').length;
    console.log(
      failed === 0
        ? '\n技能与桥接已就位。重启 WorkBuddy 后即可在会话里使用。'
        : `\n有 ${failed} 项未就位，重新运行 node bin/dsh2wb.mjs install。`,
    );
  }

  return { checks, manual };
}

async function listMcpTools(url, token, timeout = 2500) {
  if (!url || !token) return null;
  try {
    const init = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dsh2wb-doctor', version: '0.1.0' } },
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!init.ok) return null;
    const list = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!list.ok) return null;
    const text = await list.text();
    const match = text.match(/data: (\{[\s\S]*\})/);
    const payload = match ? JSON.parse(match[1]) : JSON.parse(text);
    return (payload.result?.tools || []).map((tool) => tool.name);
  } catch {
    return null;
  }
}

function probe(host, port, timeout = 900) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function diffSettings(snapshot, liveAnalysis) {
  const drift = [];
  const live = Object.fromEntries(liveAnalysis.settings.map((row) => [row.id, row.value]));
  const snap = snapshot.settings ?? {};
  if (snap.locale && live.locale && snap.locale !== live.locale) drift.push('界面语言');
  if (snap.permissionPreset && live.permissions && snap.permissionPreset !== live.permissions) drift.push('权限预设');
  if (snap.tokenUsage?.pricingRegion && live.tokenUsage && snap.tokenUsage.pricingRegion !== live.tokenUsage) {
    drift.push('计价区域');
  }
  if (snap.autoContinue && live.autoContinue !== undefined) {
    const before = snap.autoContinue.paused ? 'paused' : 'active';
    const after = live.autoContinue === '已暂停' ? 'paused' : 'active';
    if (before !== after) drift.push('自动继续');
  }
  return drift;
}
