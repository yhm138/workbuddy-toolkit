import { sanitizePaths } from './fsx.mjs';
import { PLUGIN_MAP, SETTING_MAP, STATUS_LABEL } from './parity.mjs';

const ICON = {
  native: '✅',
  bundle: '📦',
  partial: '🟡',
  manual: '✍️',
  none: '⛔',
};

export function renderReport(profile, analysis, options = {}) {
  const { generatedAt = new Date(), outPath = '' } = options;
  const safe = (text) => sanitizePaths(text ?? '', [profile.source]);
  const settings = analysis.settings;

  const lines = [];
  lines.push('# DSH → WorkBuddy 迁移差异报告');
  lines.push('');
  lines.push('> 由 `dsh2wb inspect` 生成，可重复执行。');
  lines.push(`> 源 profile：\`${safe(profile.source)}\``);
  lines.push(`> DSH 桌面版：${profile.dshVersionHint ?? '未在导出说明中标注'} · WorkBuddy 对照版本：${analysis.verifiedWith.workbuddy}`);
  lines.push(`> 生成时间：${generatedAt.toISOString()}`);
  lines.push('');
  lines.push('## 总览');
  lines.push('');
  lines.push(`- 已启用 DSH bundle：**${analysis.plugins.length}** 个`);
  lines.push(
    `- 迁移结果：原生等价 **${analysis.counts.native}** · 本包补齐 **${analysis.counts.bundle}** · 部分覆盖 **${analysis.counts.partial}** · 需手动 **${analysis.counts.manual}** · 不可移植 **${analysis.counts.none}**`,
  );
  lines.push(`- 复原度评分：**${analysis.score}/100**（原生与本包计满分，部分覆盖计半分）`);
  if (analysis.unmapped.length) {
    lines.push(`- ⚠️ 未收录的 bundle：${analysis.unmapped.map((p) => `\`${p.name}\``).join('、')}`);
  }
  lines.push('');

  lines.push('## 一、插件层对照');
  lines.push('');
  lines.push('| # | DSH bundle | 版本 | 类型 | 迁移结果 | WorkBuddy 侧 | 说明 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  analysis.plugins.forEach((row, index) => {
    lines.push(
      `| ${index + 1} | \`${row.name}\` | ${row.version} | ${row.kind} | ${ICON[row.status]} ${STATUS_LABEL[row.status]} | ${row.wb} | ${row.note} |`,
    );
  });
  lines.push('');

  lines.push('## 二、设置层对照');
  lines.push('');
  lines.push('| 设置 | DSH 当前值 | 迁移结果 | WorkBuddy 做法 |');
  lines.push('| --- | --- | --- | --- |');
  for (const row of settings) {
    const value = row.value === null || row.value === undefined || row.value === '' ? '—' : String(row.value);
    lines.push(
      `| ${row.dsh} | \`${safe(value)}\` | ${ICON[row.status]} ${STATUS_LABEL[row.status]} | ${row.action} |`,
    );
  }
  lines.push('');

  lines.push('## 三、本包补齐的能力');
  lines.push('');
  lines.push('| 技能 | 触发场景 | 对应 DSH 能力 |');
  lines.push('| --- | --- | --- |');
  lines.push('| `dsh-parity` | 任何任务开始前载入你的 DSH 工作偏好 | 界面/交互/计费口径 |');
  lines.push('| `dsh-config-port` | 盘点配置、生成跨机迁移包、校验安装 | profile bundles + patch 层 |');
  lines.push('| `dsh-session-ops` | 复制 Session ID、跨会话发消息、新建会话 | dsh-as-mcp 的 session_* 工具 |');
  lines.push('| `dsh-token-usage` | 「这个月花了多少钱 / 哪个模型最贵」 | @laoyuehanni/dsh-token-usage |');
  lines.push('| `dsh-session-search` | 「上次那个方案在哪次会话里」 | experimental-session-search |');
  lines.push('| `dsh-session-inspector` | 「这一轮到底调了什么工具」 | inspector + conversation-navigator |');
  lines.push('| `wb-parity-doctor` | 「还差什么没迁」 | 安装后的自检 |');
  lines.push('');
  lines.push('另外，侧栏扩展 **会话桥** 提供图形化入口：列表、一键复制 ID、新建会话、给会话发消息、查看回复。');
  lines.push('');

  lines.push('## 四、仍需你手动处理');
  lines.push('');
  const manual = analysis.manualSteps;
  if (manual.length === 0) {
    lines.push('无。');
  } else {
    manual.forEach((row, index) => {
      lines.push(`${index + 1}. **${row.dsh}**`);
      lines.push(`   - 当前值：\`${safe(row.value ?? '—')}\``);
      lines.push(`   - 操作：${row.action}`);
      if (row.risk) {
        lines.push('   - ⚠️ 高风险：DSH 里是 `danger-full-access` + 不审批。WorkBuddy 侧建议用「工作区可写 + 审批」，不要直接照搬。');
      }
    });
  }
  lines.push('');

  lines.push('## 五、下一步');
  lines.push('');
  lines.push('```bash');
  lines.push('# 1) 生成迁移计划（只读，不改任何文件）');
  lines.push(`node bin/dsh2wb.mjs inspect "${'<DSH_PROFILE>'}";`);
  lines.push('');
  lines.push('# 2) 安装技能与 MCP 桥接（会自动备份）');
  lines.push('node bin/dsh2wb.mjs install');
  lines.push('');
  lines.push('# 3) 自检');
  lines.push('node bin/dsh2wb.mjs doctor');
  lines.push('```');
  lines.push('');
  lines.push('> 权限、模型、语言三项属于 WorkBuddy 客户端设置，命令行无法代改，按上表手动处理。');
  lines.push('');

  void outPath;
  return lines.join('\n');
}

export function renderJson(profile, analysis) {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      verifiedWith: analysis.verifiedWith,
      source: sanitizePaths(profile.source, [profile.source]),
      profileName: profile.profileName,
      score: analysis.score,
      counts: analysis.counts,
      plugins: analysis.plugins,
      settings: analysis.settings,
    },
    null,
    2,
  );
}

export function renderConsole(profile, analysis) {
  const rows = [...analysis.plugins, ...analysis.settings];
  const width = Math.max(...rows.map((row) => (row.name ?? row.dsh ?? '').length), 20);
  const lines = [];
  lines.push(`源：${profile.source}`);
  lines.push(`bundle：${analysis.plugins.length} 个 · 复原度：${analysis.score}/100`);
  lines.push('');
  for (const row of analysis.plugins) {
    const label = `${ICON[row.status]} ${STATUS_LABEL[row.status]}`.padEnd(7);
    lines.push(`  ${label} ${row.name.padEnd(width)}  ${row.wb}`);
  }
  lines.push('');
  for (const row of analysis.settings) {
    const label = `${ICON[row.status]} ${STATUS_LABEL[row.status]}`.padEnd(7);
    const value = row.value === null || row.value === undefined ? '—' : String(row.value);
    lines.push(`  ${label} ${row.dsh.slice(0, width).padEnd(width)}  ${value}`);
  }
  return lines.join('\n');
}

/** Static reference table: every mapping known to this tool, regardless of profile. */
export function renderMatrix() {
  const lines = [];
  lines.push('# DSH → WorkBuddy 能力对照矩阵');
  lines.push('');
  lines.push('> 这张表是工具内置的映射定义，不依赖某个具体 profile。');
  lines.push(`> 对照版本：WorkBuddy ${'5.9.0'} / DSH 0.2.1-rc.2（2026-10-24 校验）。`);
  lines.push('');
  lines.push('图例：✅ 原生等价 · 📦 本包补齐 · 🟡 部分覆盖 · ✍️ 需手动设置 · ⛔ 不可移植');
  lines.push('');
  lines.push('## 插件层');
  lines.push('');
  lines.push('| DSH bundle | 类型 | 结果 | WorkBuddy 侧 | 说明 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const row of PLUGIN_MAP) {
    lines.push(`| \`${row.dsh}\` | ${row.kind} | ${ICON[row.status]} ${STATUS_LABEL[row.status]} | ${row.wb} | ${row.note} |`);
  }
  lines.push('');
  lines.push('## 设置层');
  lines.push('');
  lines.push('| 设置 | 结果 | WorkBuddy 做法 |');
  lines.push('| --- | --- | --- |');
  for (const row of SETTING_MAP) {
    lines.push(`| ${row.dsh} | ${ICON[row.status]} ${STATUS_LABEL[row.status]} | ${row.action} |`);
  }
  lines.push('');
  lines.push('## 为什么有些东西迁不过去');
  lines.push('');
  lines.push('- **宿主 UI**：侧栏皮肤、会话树、大纲面板、命令面板属于 Electron 前端，插件只能加技能/工具，不能改界面。');
  lines.push('- **运行时行为**：插话发送、自动继续、并行上限由 Agent 循环实现，WorkBuddy 不开放对应开关。');
  lines.push('- **账号凭据**：`~/.dsh/.credentials.yaml` 与 MCP token 属于敏感信息，任何迁移包都不应包含，重装后重新登录/生成。');
  lines.push('');
  return lines.join('\n');
}
