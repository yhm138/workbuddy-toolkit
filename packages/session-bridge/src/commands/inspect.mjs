import fs from 'node:fs';
import path from 'node:path';
import { dshHome, resolveFromCwd } from '../core/fsx.mjs';
import { readProfile } from '../core/profile.mjs';
import { analyze } from '../core/parity.mjs';
import { renderConsole, renderJson, renderReport } from '../core/report.mjs';

export function resolveProfileInput(positional, options) {
  if (positional) return resolveFromCwd(positional);
  if (options.profile) return resolveFromCwd(options.profile);
  const live = path.join(dshHome(), 'profiles', 'desktop');
  if (fs.existsSync(path.join(live, 'cordis.patch.yml'))) return live;
  throw new Error(
    '没有指定 DSH profile。\n' +
      '  用法：dsh2wb inspect <导出目录 | profile 目录>\n' +
      `  本机也没有找到 ${live}（DSH 需要至少启动过一次）。`,
  );
}

export function inspect(profileInput, options = {}) {
  const profile = readProfile(profileInput);
  const analysis = analyze(profile);

  const json = renderJson(profile, analysis);
  let written = [];

  if (options.out) {
    const outDir = resolveFromCwd(options.out);
    fs.mkdirSync(outDir, { recursive: true });
    const mdPath = path.join(outDir, 'parity-report.md');
    const jsonPath = path.join(outDir, 'parity-report.json');
    fs.writeFileSync(mdPath, `${renderReport(profile, analysis)}\n`, 'utf8');
    fs.writeFileSync(jsonPath, `${json}\n`, 'utf8');
    written = [mdPath, jsonPath];
  }

  if (options.json) {
    process.stdout.write(`${json}\n`);
  } else {
    console.log(renderConsole(profile, analysis));
    if (analysis.manualSteps.length) {
      console.log('\n仍需手动处理：');
      for (const step of analysis.manualSteps) {
        console.log(`  ${step.risk ? '⚠️' : '✍️'} ${step.dsh}`);
        console.log(`     ${step.action}`);
      }
    }
    if (written.length) {
      console.log('\n已写入：');
      for (const file of written) console.log(`  ${file}`);
    }
    console.log('\n下一步：node bin/dsh2wb.mjs install');
  }

  return { profile, analysis, written };
}
