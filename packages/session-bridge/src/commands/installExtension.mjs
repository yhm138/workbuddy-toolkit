import fs from 'node:fs';
import path from 'node:path';
import { copyDir, ensureDir, readJson, timestamp } from '../core/fsx.mjs';
import { extensionsDir, findRoot } from '../core/wb.mjs';

const EXT_ID = 'dsh-session-bridge';

/** 找不到就抛错，错误信息里带上「怎么手动指定」。 */
export function findWorkbuddyRoot(explicit) {
  const root = findRoot(explicit);
  if (root) return root;
  throw new Error(
    '找不到 WorkBuddy 安装目录。用 --workbuddy-root 指定，例如：\n' +
      '  node bin/dsh2wb.mjs install-extension --workbuddy-root "D:\\Software\\WorkBuddy"',
  );
}

export function installExtension(options = {}) {
  const source = path.resolve(process.cwd(), options.extensionDir ?? 'extension');
  if (!fs.existsSync(path.join(source, 'extension.json'))) {
    throw new Error(`扩展源目录不完整：${source}（缺 extension.json）`);
  }

  const wbRoot = findWorkbuddyRoot(options.workbuddyRoot);
  const extRoot = extensionsDir(wbRoot);
  const target = path.join(extRoot, EXT_ID);
  const manifest = readJson(path.join(source, 'extension.json'));
  const distribution = readJson(path.join(source, 'distribution.json'));

  if (manifest.id !== EXT_ID) {
    throw new Error(`extension.json 的 id 必须是 ${EXT_ID}，实际 ${manifest.id}`);
  }
  if (distribution.extensionId !== manifest.id || distribution.version !== manifest.version) {
    throw new Error('extension.json 与 distribution.json 的 id/version 不一致');
  }

  console.log('安装计划');
  console.log(`  WorkBuddy  ${wbRoot}`);
  console.log(`  扩展目录   ${target}`);
  console.log(`  版本       ${manifest.version}`);
  if (options.dryRun) {
    console.log('\n[dry-run] 未写入任何文件。\n');
    return { dryRun: true, target };
  }

  ensureDir(extRoot);
  if (fs.existsSync(target)) {
    const backup = `${target}.bak-${timestamp()}`;
    copyDir(target, backup);
    console.log(`  已备份旧版本 → ${backup}`);
  }

  copyDir(source, target);
  verify(target, manifest.version);

  console.log(`\n✓ 扩展已安装到 ${target}`);
  console.log('  下一步：托盘右键退出 WorkBuddy，再重新打开（清单是启动时快照的，热更会「插件加载失败」）。');
  console.log('  打开后侧栏应出现「会话桥」；点开若显示加载失败，先看面板底部「诊断」。');
  return { dryRun: false, target, version: manifest.version };
}

function verify(target, version) {
  const required = [
    'extension.json',
    'distribution.json',
    'icon.svg',
    'ui/index.html',
    'server/index.cjs',
    'server/mcp.cjs',
    'server/local.cjs',
    'server/sessions.cjs',
    'server/session-utils.cjs',
    'server/harnesses.cjs',
    'server/cdp.cjs',
    'server/menu-inject.cjs',
    'inject/session-menu.js',
  ];
  for (const file of required) {
    if (!fs.existsSync(path.join(target, file))) {
      throw new Error(`安装后缺少文件：${file}`);
    }
  }
  const manifest = readJson(path.join(target, 'extension.json'));
  if (manifest.version !== version) throw new Error('安装后的清单版本不一致');
  const html = fs.readFileSync(path.join(target, 'ui/index.html'), 'utf8');
  if (!html.includes('wb:boundary:guest-ready')) {
    throw new Error('面板缺少 guest-ready 握手，宿主会报「插件加载失败」');
  }
}

export { EXT_ID };
