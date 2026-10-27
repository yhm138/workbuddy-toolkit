import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProfile } from '../core/profile.mjs';
import { analyze } from '../core/parity.mjs';
import { renderMatrix, renderReport } from '../core/report.mjs';
import { sanitizePaths, timestamp, writeJson, writeText } from '../core/fsx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Repo layout: <root>/skills-pack/plugins/dsh-skills
// Installed layout: ~/.workbuddy/dsh-skills (plugin files copied to the root)
const SKILLS_PLUGIN = [
  path.join(ROOT, 'skills-pack', 'plugins', 'dsh-skills'),
  ROOT,
].find((dir) => fs.existsSync(path.join(dir, '.codebuddy-plugin', 'plugin.json')));

export function buildSnapshot(profile) {
  const analysis = analyze(profile);
  const s = profile.settings;
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    profile: profile.profileName,
    dshVersion: profile.dshVersionHint,
    source: sanitizePaths(profile.source, [profile.source]),
    bundles: profile.bundles,
    parity: { score: analysis.score, counts: analysis.counts },
    settings: {
      locale: s.locale,
      model: s.model,
      permissionPreset: s.permissions?.defaultPreset ?? null,
      permissions: s.permissions?.presets ?? null,
      concurrency: {
        maxParallelToolCalls: s.agentLoop?.maxParallelToolCalls ?? null,
        maxActiveSubagents: s.subagent?.maxActiveSubagents ?? null,
      },
      chat: s.chat,
      conversation: s.conversation,
      onboarding: s.accountOnboarding,
      tokenUsage: s.tokenUsage,
      autoContinue: s.autoContinue,
      pluginMarket: s.pluginMarket,
      mcp: s.mcp
        ? {
            enabled: Boolean(s.mcp.http?.enabled),
            url: s.mcp.http
              ? `http://${s.mcp.http.host ?? '127.0.0.1'}:${s.mcp.http.port ?? 8790}${s.mcp.http.path ?? '/mcp'}`
              : null,
            tools: s.mcp.tools ?? null,
            approval: s.mcp.approval ?? null,
            client: s.mcp.client ?? null,
          }
        : null,
    },
  };
}

export function build(profileInput, options = {}) {
  const profile = readProfile(profileInput);
  const analysis = analyze(profile);
  const outDir = path.resolve(process.cwd(), options.out ?? 'docs');
  fs.mkdirSync(outDir, { recursive: true });

  const reportPath = path.join(outDir, 'parity-report.md');
  const matrixPath = path.join(outDir, 'capability-matrix.md');
  writeText(reportPath, `${renderReport(profile, analysis)}\n`);
  writeText(matrixPath, `${renderMatrix()}\n`);

  const snapshot = buildSnapshot(profile);
  const snapshotPath = path.join(SKILLS_PLUGIN, 'config', 'dsh-parity.json');
  writeJson(snapshotPath, snapshot);

  writeJson(path.join(SKILLS_PLUGIN, 'config', 'build-info.json'), {
    builtAt: timestamp(),
    profile: profile.profileName,
    dshVersion: profile.dshVersionHint,
    score: analysis.score,
  });

  console.log(`✓ 迁移报告     ${reportPath}`);
  console.log(`✓ 能力矩阵     ${matrixPath}`);
  console.log(`✓ 配置快照     ${snapshotPath}`);
  console.log(`  复原度 ${analysis.score}/100 · 技能 7 个 · ${analysis.plugins.length} 个 DSH bundle 已对照`);
  return { snapshot, analysis };
}

export { SKILLS_PLUGIN, ROOT };
