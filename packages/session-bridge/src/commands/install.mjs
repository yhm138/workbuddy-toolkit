import fs from 'node:fs';
import path from 'node:path';
import {
  copyDir,
  dshHome,
  ensureDir,
  readJson,
  timestamp,
  workbuddyHome,
  writeJson,
  writeText,
} from '../core/fsx.mjs';
import { SKILLS_PLUGIN } from './build.mjs';

const MARKETPLACE_NAME = 'dsh-skills';
const PLUGIN_NAME = 'dsh-skills';

export async function install(options = {}) {
  const wbHome = options.workbuddyHome ? path.resolve(options.workbuddyHome) : workbuddyHome();
  const skillsRoot = path.join(SKILLS_PLUGIN, '..', '..'); // skills-pack/
  const snapshotFile = path.join(SKILLS_PLUGIN, 'config', 'dsh-parity.json');
  const snapshot = readJson(snapshotFile, null);
  if (!snapshot) {
    throw new Error(
      `还没有配置快照：${snapshotFile}\n先运行：node bin/dsh2wb.mjs build <DSH profile 或导出目录>`,
    );
  }

  const dryRun = Boolean(options.dryRun);
  const stamp = timestamp();
  const targetRoot = path.join(wbHome, 'dsh-skills');
  const skillSource = path.join(SKILLS_PLUGIN, 'skills');
  const skills = fs
    .readdirSync(skillSource, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const plan = [];
  plan.push(`工作区根目录  ${wbHome}`);
  plan.push(`运行时        ${targetRoot}`);
  plan.push(`技能 (${skills.length})  ${path.join(wbHome, 'skills')}/${skills.join(', ')}`);
  plan.push(`MCP 桥接      ${path.join(wbHome, 'mcp.json')} → dsh_local`);
  if (options.registerMarketplace) {
    plan.push(`本地市场      ${path.join(wbHome, 'plugins', 'marketplaces', MARKETPLACE_NAME)}`);
  }

  console.log('安装计划');
  for (const line of plan) console.log(`  · ${line}`);
  console.log(dryRun ? '\n[dry-run] 未写入任何文件。\n' : '');

  if (!dryRun) {
    ensureDir(wbHome);

    // 1) runtime payload (scripts + snapshot + plugin copy)
    if (fs.existsSync(targetRoot)) {
      const backup = path.join(wbHome, 'dsh-skills.bak', stamp);
      copyDir(targetRoot, backup);
      console.log(`  备份旧运行时 → ${backup}`);
    }
    ensureDir(targetRoot);
    // 整个插件目录都带过去：技能脚本、配置快照、agents、清单
    for (const entry of fs.readdirSync(SKILLS_PLUGIN)) {
      if (entry === 'backups') continue;
      const from = path.join(SKILLS_PLUGIN, entry);
      const to = path.join(targetRoot, entry);
      if (fs.statSync(from).isDirectory()) copyDir(from, to);
      else fs.copyFileSync(from, to);
    }
    // 迁移器本体（技能里的 dsh2wb 命令需要）
    copyDir(path.join(skillsRoot, '..', 'bin'), path.join(targetRoot, 'cli', 'bin'));
    copyDir(path.join(skillsRoot, '..', 'src'), path.join(targetRoot, 'cli', 'src'));
    writeText(path.join(targetRoot, 'README.md'), runtimeReadme(snapshot));
    console.log(`  运行时已写入 ${targetRoot}`);

    // 2) skills
    const installedSkills = [];
    for (const skill of skills) {
      const from = path.join(skillSource, skill);
      const to = path.join(wbHome, 'skills', skill);
      if (fs.existsSync(to)) {
        const backup = path.join(targetRoot, 'backups', `skill-${skill}-${stamp}`);
        copyDir(to, backup);
      }
      copyDir(from, to);
      installedSkills.push(skill);
    }
    console.log(`  技能已安装 ${installedSkills.length} 个 → ${path.join(wbHome, 'skills')}`);

    // 3) MCP bridge
    const mcpResult = installMcp({ wbHome, snapshot, dryRun, stamp });
    console.log(`  MCP：${mcpResult.message}`);

    // 4) optional marketplace registration
    let marketplace = null;
    if (options.registerMarketplace) {
      marketplace = registerMarketplace({ wbHome, skillsRoot, stamp });
      console.log(`  本地市场已注册：${pluginId()}`);
    }

    writeJson(path.join(targetRoot, 'install-manifest.json'), {
      version: readPluginVersion(),
      installedAt: new Date().toISOString(),
      skills: installedSkills,
      mcpServer: mcpResult.name ?? null,
      marketplace: marketplace
        ? { name: MARKETPLACE_NAME, plugin: pluginId(), path: marketplace }
        : null,
      snapshot: {
        profile: snapshot.profile,
        dshVersion: snapshot.dshVersion,
        builtAt: snapshot.generatedAt,
      },
    });
  }

  printNextSteps({ snapshot, dryRun, marketplace: options.registerMarketplace });
  return { skills, dryRun, wbHome };
}

function installMcp({ wbHome, snapshot, dryRun, stamp }) {
  const tokenFile = path.join(dshHome(), 'dsh-as-mcp', 'token');
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : null;
  const url = snapshot.settings?.mcp?.url ?? 'http://127.0.0.1:8790/mcp';
  const mcpPath = path.join(wbHome, 'mcp.json');

  if (!token) {
    return {
      name: 'dsh_local',
      message: `跳过（未找到 ${tokenFile}，先启动一次 DSH 让它生成 token）`,
    };
  }

  const existing = fs.existsSync(mcpPath) ? readJson(mcpPath, null) : { mcpServers: {} };
  if (existing === null) {
    throw new Error(`${mcpPath} 不是合法 JSON，已中止，避免覆盖你的 MCP 配置。`);
  }
  const next = { ...existing, mcpServers: { ...(existing.mcpServers ?? {}) } };
  next.mcpServers.dsh_local = {
    type: 'streamable-http',
    url,
    headers: { Authorization: `Bearer ${token}` },
  };

  if (!dryRun) {
    if (fs.existsSync(mcpPath)) {
      fs.copyFileSync(mcpPath, `${mcpPath}.bak-${stamp}`);
    }
    writeJson(mcpPath, next);
  }
  return { name: 'dsh_local', message: `已写入 dsh_local → ${url}` };
}

function registerMarketplace({ wbHome, skillsRoot, stamp }) {
  const pluginsDir = path.join(wbHome, 'plugins');
  const target = path.join(pluginsDir, 'marketplaces', MARKETPLACE_NAME);
  if (fs.existsSync(target)) {
    copyDir(target, path.join(wbHome, 'dsh-skills', 'backups', `marketplace-${stamp}`));
  }
  ensureDir(path.dirname(target));
  copyDir(skillsRoot, target);

  const knownPath = path.join(pluginsDir, 'known_marketplaces.json');
  const known = readJson(knownPath, {}) ?? {};
  known[MARKETPLACE_NAME] = {
    manifestName: MARKETPLACE_NAME,
    type: 'directory',
    source: { source: 'directory', path: target },
    installLocation: target,
    description: 'DSH Bundle for WorkBuddy (local marketplace)',
    lastUpdated: new Date().toISOString(),
    autoUpdate: false,
  };
  writeJson(knownPath, known);

  const installedPath = path.join(pluginsDir, 'installed_plugins.json');
  const installed = readJson(installedPath, { version: 2, plugins: {} }) ?? { version: 2, plugins: {} };
  installed.plugins = installed.plugins ?? {};
  const now = new Date().toISOString();
  installed.plugins[pluginId()] = [
    {
      scope: 'user',
      installPath: path.join(target, 'plugins', PLUGIN_NAME),
      version: readPluginVersion(),
      installedAt: now,
      lastUpdated: now,
    },
  ];
  writeJson(installedPath, installed);

  const settingsPath = path.join(wbHome, 'settings.json');
  const settings = readJson(settingsPath, {}) ?? {};
  settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), [pluginId()]: true };
  writeJson(settingsPath, settings);

  return target;
}

function pluginId() {
  return `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
}

function readPluginVersion() {
  const manifest = readJson(path.join(SKILLS_PLUGIN, '.codebuddy-plugin', 'plugin.json'), null);
  return manifest?.version ?? '0.0.0';
}

function runtimeReadme(snapshot) {
  return [
    '# DSH Bundle runtime',
    '',
    '由 `dsh2wb install` 生成，供技能脚本读取。',
    '',
    `- profile：${snapshot.profile}`,
    `- 快照时间：${snapshot.generatedAt}`,
    `- 复原度：${snapshot.parity?.score ?? '—'}/100`,
    '',
    '`scripts/` 下是技能共用的只读脚本；`config/dsh-parity.json` 是配置快照。',
    '删除本目录并把 `~/.workbuddy/skills/` 下 6 个 `dsh-*` 技能移除即可卸载。',
    '',
  ].join('\n');
}

function printNextSteps({ snapshot, dryRun, marketplace }) {
  console.log('');
  if (dryRun) {
    console.log('计划生成完毕。去掉 --dry-run 即会执行（会先备份）。');
    return;
  }
  console.log('完成。');
  console.log('  1) 完全退出并重启 WorkBuddy，让技能与 MCP 生效');
  console.log('  2) 在任意会话里说「做个 parity 自检」或直接运行：node bin/dsh2wb.mjs doctor');
  console.log('  3) MCP 桥接需要 DSH 正在运行（dsh-as-mcp 监听 8790）');
  if (!marketplace) {
    console.log('  4) 想以插件形态安装（带 agents/hooks）：重跑并加 --register-marketplace');
  }
  if (snapshot.settings?.permissionPreset === 'danger-full-access') {
    console.log('  ⚠️ 源配置是 danger-full-access + 不审批，WorkBuddy 侧建议改用「工作区可写 + 审批」。');
  }
}
