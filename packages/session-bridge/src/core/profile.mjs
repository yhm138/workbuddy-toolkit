import fs from 'node:fs';
import path from 'node:path';
import { parseYaml, plainify } from './yaml.mjs';

/**
 * Reads a DSH profile from any of these layouts:
 *   <dir>/package.json + cordis.patch.yml          (a profile directory)
 *   <dir>/profile/desktop/...                      (the portable export layout)
 *   <dir>/dsh-config-export/profile/desktop/...    (the zip extracted as-is)
 */
export function resolveProfileDir(input) {
  const candidates = [
    input,
    path.join(input, 'profile', 'desktop'),
    path.join(input, 'dsh-config-export', 'profile', 'desktop'),
  ];
  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) &&
      fs.existsSync(path.join(dir, 'cordis.patch.yml'))
    ) {
      return path.resolve(dir);
    }
  }
  throw new Error(
    `找不到 DSH profile：${input}\n` +
      `期望目录内同时存在 package.json 与 cordis.patch.yml（也支持 profile/desktop 子目录）。`,
  );
}

export function readProfile(input) {
  const dir = resolveProfileDir(input);
  const pkg = readJson(path.join(dir, 'package.json'));
  const patch = plainify(parseYaml(fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8')));

  if (!Array.isArray(patch)) {
    throw new Error(`cordis.patch.yml 顶层应为数组，实际为 ${typeof patch}`);
  }

  // `insert:` entries are real plugin rows too; flatten them so lookups by id work.
  const entries = [];
  for (const entry of patch) {
    if (!entry || typeof entry !== 'object') continue;
    if (Array.isArray(entry.insert)) {
      for (const inserted of entry.insert) entries.push({ ...inserted, __inserted: true });
    } else {
      entries.push(entry);
    }
  }

  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id, e]));
  const configOf = (id) => byId.get(id)?.config ?? null;

  const bundles = pkg?.dsh?.profile?.bundles ?? [];
  const dependencies = pkg?.dependencies ?? {};

  const mcpServer = configOf('dsh-as-mcp');
  const mcpClient = configOf('mcp-client-dsh-local');

  const settings = {
    locale: configOf('locale')?.preference ?? null,
    model: configOf('agent-default-model') ?? null,
    accountOnboarding: configOf('ui-settings-account') ?? null,
    chat: configOf('ui-chat') ?? null,
    uiSettings: configOf('ui-settings') ?? null,
    agentLoop: configOf('agent-loop') ?? null,
    subagent: configOf('subagent') ?? null,
    pluginMarket: configOf('plugin-market') ?? null,
    permissions: configOf('permission') ?? null,
    conversation: configOf('ui-conversation') ?? null,
    tokenUsage: configOf('token-usage') ?? null,
    autoContinue: configOf('auto-continue') ?? null,
    mcp: mcpServer
      ? {
          ...mcpServer,
          client: mcpClient
            ? {
                url: mcpClient.url ?? null,
                transport: mcpClient.transport ?? null,
                toolCallTimeoutMs: mcpClient.toolCallTimeoutMs ?? null,
                reconnect: mcpClient.reconnect ?? null,
              }
            : null,
        }
      : null,
    extraEntries: entries.filter((e) => !KNOWN_IDS.has(e.id)),
  };

  return {
    source: dir,
    profileName: pkg.name ?? 'dsh-profile',
    dshVersionHint: readDshVersionHint(dir),
    bundles,
    dependencies,
    settings,
    entries,
    byId: (id) => byId.get(id),
    hasEntry: (id) => byId.has(id),
  };
}

const KNOWN_IDS = new Set([
  'agent-default-model',
  'ui-settings-account',
  'ui-chat',
  'ui-settings',
  'locale',
  'agent-loop',
  'subagent',
  'plugin-market',
  'dsh-as-mcp',
  'mcp-client-dsh-local',
  'permission',
  'ui-conversation',
  'token-usage',
  'auto-continue',
]);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`读取 ${file} 失败：${error.message}`);
  }
}

/** The export README usually mentions the desktop version; it is nice context, never required. */
function readDshVersionHint(dir) {
  for (const file of ['README-迁移说明.md', 'README.md']) {
    const candidate = path.join(dir, '..', '..', file);
    if (fs.existsSync(candidate)) {
      const text = fs.readFileSync(candidate, 'utf8');
      const match = text.match(/DSH 桌面版\s*\|\s*\**([0-9][^\s|（(]*)/);
      if (match) return match[1].replace(/\*/g, '');
    }
  }
  return null;
}
