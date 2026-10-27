/**
 * DSH → WorkBuddy capability map.
 *
 * `status` values:
 *   native  - WorkBuddy already has an equivalent; nothing to install.
 *   bundle  - missing in WorkBuddy; this bundle fills the gap.
 *   partial - WorkBuddy covers part of it; the bundle improves or documents the rest.
 *   manual  - a setting that must be flipped by hand in the WorkBuddy UI.
 *   none    - no equivalent; documented as a deliberate gap.
 */
export const VERIFIED_WITH = {
  workbuddy: '5.9.0',
  dsh: '0.2.1-rc.2',
  checkedAt: '2026-10-24',
};

export const PLUGIN_MAP = [
  {
    dsh: '@deepseek-ai/dsh-base',
    kind: '内置核心',
    status: 'native',
    wb: 'WorkBuddy 内核（Agent 循环、会话、工具、存储、模型接入）',
    note: '形态不同，能力对应。',
  },
  {
    dsh: '@deepseek-ai/dsh-web-app',
    kind: '内置核心',
    status: 'native',
    wb: 'WorkBuddy 桌面端 / Web 工作台',
    note: '无需迁移。',
  },
  {
    dsh: 'dsh-conversation-navigator',
    kind: '第三方',
    status: 'partial',
    wb: '无对话大纲面板；`dsh-session-inspector` 可把任一轮次导出成大纲',
    note: 'UI 面板无法移植，用技能补“看结构”的能力。',
  },
  {
    dsh: 'dsh-sessions-manager',
    kind: '第三方（本地构建）',
    status: 'partial',
    wb: '任务列表原生支持重命名 / 删除 / 搜索；归档、回收站、标签、收藏没有',
    note: '高频操作可继续在 DSH 内完成，WorkBuddy 侧负责干活。',
  },
  {
    dsh: '@deepseek-ai/dsh-experimental-inspector-profile',
    kind: '内置实验',
    status: 'bundle',
    wb: '`dsh-session-inspector`：session.v4.jsonl.zstd → 时间线 Markdown / HTML',
    note: '按用户/助手/工具调用还原一轮到底发生了什么。',
  },
  {
    dsh: '@deepseek-ai/dsh-subagent-codex',
    kind: '第三方',
    status: 'native',
    wb: 'WorkBuddy 子代理（Agent 工具，可并行、可指定模型）',
    note: '子代理模型不同，编排语义一致。',
  },
  {
    dsh: '@deepseek-ai/dsh-experimental-plugin-market-bundle',
    kind: '内置实验',
    status: 'native',
    wb: '插件市场（插件 = 技能 + 连接 + 指令 + Hooks + Agents）',
    note: '自定义市场索引不可配；本地目录市场可用。',
  },
  {
    dsh: '@deepseek-ai/dsh-experimental-session-search',
    kind: '内置实验',
    status: 'bundle',
    wb: '`dsh-session-search`：跨工作区检索 DSH 历史会话（支持中文、正则、时间过滤）',
    note: 'WorkBuddy 的会话检索只覆盖自己的会话，故补齐 DSH 侧。',
  },
  {
    dsh: '@deepseek-ai/dsh-experimental-terminal-bundle',
    kind: '内置实验',
    status: 'partial',
    wb: 'Bash / PowerShell 工具在单次任务内可复用工作目录',
    note: '没有跨工具调用的常驻终端与 pwsh 会话。',
  },
  {
    dsh: '@hyzyn/dsh-search',
    kind: '第三方',
    status: 'native',
    wb: '侧栏全局搜索 / 命令面板',
    note: '入口位置不同，能力对等。',
  },
  {
    dsh: 'dsh-as-mcp',
    kind: '第三方',
    status: 'bundle',
    wb: '`mcp.json` 写入 `dsh_local`（streamable-http + Bearer token），直接暴露 session_create/list/prompt/messages/cancel',
    note: 'WorkBuddy 作为 MCP client 反向驱动 DSH 的工作区/会话工具。',
  },
  {
    dsh: '@michengai/dsh-codex-ui',
    kind: '第三方',
    status: 'none',
    wb: '—',
    note: '侧栏/会话树/皮肤属于宿主 UI，插件无法注入 WorkBuddy 前端。',
  },
  {
    dsh: '@laoyuehanni/dsh-token-usage',
    kind: '第三方',
    status: 'bundle',
    wb: '`dsh-token-usage`：读取 ~/.dsh/token-usage，按天/模型/人民币出账',
    note: '保留国内定价口径与历史数据，不重新估算。',
  },
  {
    dsh: '@deepseek-ai/dsh-experimental-agent-team-profile',
    kind: '内置实验',
    status: 'native',
    wb: '多人多 Agent 协作 / 团队任务面板',
    note: '成员上限与消息大小由 WorkBuddy 决定。',
  },
  {
    dsh: 'dsh-client-auto-continue',
    kind: '第三方',
    status: 'partial',
    wb: '无“中断自动继续”开关；可用定时任务或手动“继续”',
    note: '属于运行时行为，插件层无法拦截重试。',
  },
];

export const SETTING_MAP = [
  {
    id: 'locale',
    dsh: '界面语言：中文（zh）',
    status: 'native',
    wb: 'WorkBuddy 中文界面',
    action: '设置 → 外观/语言，确认为简体中文',
    value: (s) => s.locale,
  },
  {
    id: 'model',
    dsh: '默认模型：deepseek-flash · 推理强度 max',
    status: 'manual',
    wb: '模型选择器按任务切换',
    action: '在模型菜单选择 DeepSeek 对应模型；高强度推理任务手动拉满',
    value: (s) => (s.model ? `${s.model.provider}/${s.model.model} · ${s.model.reasoningEffort ?? 'default'}` : null),
  },
  {
    id: 'permissions',
    dsh: '默认权限：danger-full-access + 审批 never',
    status: 'manual',
    wb: '信任级别 / 沙箱策略',
    action: '设置 → 默认权限与安全沙箱；建议改为「工作区可写 + 审批」，不要照搬 danger-full-access',
    value: (s) => s.permissions?.defaultPreset ?? null,
    risk: (s) => s.permissions?.defaultPreset === 'danger-full-access',
  },
  {
    id: 'concurrency',
    dsh: '单轮并行工具 20 / 活跃子代理 16',
    status: 'native',
    wb: '由 WorkBuddy 调度，不可配',
    action: '无需处理',
    value: (s) => `${s.agentLoop?.maxParallelToolCalls ?? '—'} / ${s.subagent?.maxActiveSubagents ?? '—'}`,
  },
  {
    id: 'busyEnter',
    dsh: '繁忙时 Enter：插话发送（steer），Ctrl+Enter 排队',
    status: 'none',
    wb: 'WorkBuddy 无 steer/queue 双模式',
    action: '无对应设置，忽略',
    value: (s) => s.conversation?.busyEnter ?? null,
  },
  {
    id: 'transcript',
    dsh: '聊天记录：详细；性能/用量：详细',
    status: 'partial',
    wb: '结果区「概览 / 全部文件 / 变更」三视图',
    action: '需要过程细节时用 `dsh-session-inspector` 看原始时间线',
    value: (s) => (s.chat ? `${s.chat.transcriptView ?? '—'} / ${s.chat.performanceUsage ?? '—'}` : null),
  },
  {
    id: 'market',
    dsh: '插件市场索引 3 个（jsdelivr / bruc3van / awesome-dsh-plugin）',
    status: 'none',
    wb: '插件市场索引固定',
    action: '无对应设置，忽略',
    value: (s) => s.pluginMarket?.indexes?.length ?? null,
  },
  {
    id: 'mcp',
    dsh: 'dsh-as-mcp：127.0.0.1:8790/mcp，开放工作区+会话',
    status: 'bundle',
    wb: '`~/.workbuddy/mcp.json` 的 `dsh_local`',
    action: '运行 `dsh2wb install` 自动写入；DSH 需在运行',
    value: (s) => (s.mcp?.http ? `${s.mcp.http.host}:${s.mcp.http.port}${s.mcp.http.path}` : null),
  },
  {
    id: 'tokenUsage',
    dsh: 'Token 用量：国内人民币定价、记录压缩调用、供应商配额',
    status: 'bundle',
    wb: '`dsh-token-usage` 技能',
    action: '直接问「这个月 DSH 花了多少钱」',
    value: (s) => s.tokenUsage?.pricingRegion ?? null,
  },
  {
    id: 'autoContinue',
    dsh: '自动继续：开启（宽限 30s、最多 30 次、自主循环关闭）',
    status: 'partial',
    wb: '无中断自动继续',
    action: '长任务用定时任务兜底，或手动继续',
    value: (s) => (s.autoContinue ? (s.autoContinue.paused ? '已暂停' : '开启') : null),
  },
  {
    id: 'onboarding',
    dsh: '引导问卷：开发用途 / 标准流程 / 详细用量 / 开发者工具开',
    status: 'partial',
    wb: '无同等问卷',
    action: '用本包的 `dsh-parity` 技能载入同样的工作偏好',
    value: (s) => (s.accountOnboarding?.purpose ?? null),
  },
];

const STATUS_LABEL = {
  native: '原生等价',
  bundle: '本包补齐',
  partial: '部分覆盖',
  manual: '需手动设置',
  none: '不可移植',
};

export function analyze(profile) {
  const { bundles, dependencies } = profile;
  const plugins = bundles.map((name) => {
    const mapped = PLUGIN_MAP.find((item) => item.dsh === name);
    return {
      name,
      version: dependencies[name] ?? '内置',
      kind: mapped?.kind ?? (name.startsWith('@deepseek-ai/') ? '内置' : '第三方'),
      status: mapped?.status ?? 'none',
      wb: mapped?.wb ?? '—',
      note: mapped?.note ?? '未收录，需人工评估',
    };
  });

  // Bundles can be enabled in package.json without a mapping; surface them clearly.
  const unmapped = plugins.filter((p) => p.note === '未收录，需人工评估');

  const settings = SETTING_MAP.map((item) => {
    let value = null;
    try {
      value = item.value?.(profile.settings) ?? null;
    } catch {
      value = null;
    }
    let risk = false;
    try {
      risk = Boolean(item.risk?.(profile.settings));
    } catch {
      risk = false;
    }
    return {
      id: item.id,
      dsh: item.dsh,
      status: item.status,
      wb: item.wb,
      action: item.action,
      value,
      risk,
    };
  });

  const counts = { native: 0, bundle: 0, partial: 0, manual: 0, none: 0 };
  for (const row of [...plugins, ...settings]) counts[row.status] = (counts[row.status] ?? 0) + 1;

  const total = plugins.length + settings.length;
  const covered = counts.native + counts.bundle;
  const score = total === 0 ? 0 : Math.round(((covered + counts.partial * 0.5) / total) * 100);

  return {
    verifiedWith: VERIFIED_WITH,
    plugins,
    settings,
    counts,
    score,
    unmapped,
    statusLabel: STATUS_LABEL,
    manualSteps: settings.filter((s) => s.status === 'manual' || s.risk),
    bundleSkills: [
      'dsh-parity',
      'dsh-config-port',
      'dsh-session-ops',
      'dsh-token-usage',
      'dsh-session-search',
      'dsh-session-inspector',
      'wb-parity-doctor',
    ],
  };
}

export { STATUS_LABEL };
