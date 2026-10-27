#!/usr/bin/env node
/**
 * Aggregate DSH token usage in RMB.
 *
 * Reads ~/.dsh/token-usage/usage-YYYY-MM-DD.jsonl and prices each request with
 * pricing.ccsa.json (the table DSH itself ships), so the numbers match what the
 * dsh-token-usage plugin shows. Context tiers and time-of-day rules are ignored:
 * the bundle reports base-price estimates, never invents discounts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dshHome, fmtMoney, fmtNumber } from './lib/session-store.mjs';

const args = process.argv.slice(2);
const options = {
  by: 'day',
  since: null,
  until: null,
  model: null,
  json: false,
  top: 0,
};

const positional = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--json') options.json = true;
  else if (arg === '--by') options.by = args[++i];
  else if (arg === '--since') options.since = args[++i];
  else if (arg === '--until') options.until = args[++i];
  else if (arg === '--model') options.model = args[++i];
  else if (arg === '--top') options.top = Number(args[++i] || 0);
  else if (arg === '--help' || arg === '-h') {
    console.log(usage());
    process.exit(0);
  } else if (!arg.startsWith('-')) positional.push(arg);
  else throw new Error(`未知参数：${arg}`);
}

function usage() {
  return `DSH Token 用量（人民币）

用法：node token-usage.mjs [options]
  --by day|model|session   聚合维度（默认 day）
  --since YYYY-MM-DD       起始日期
  --until YYYY-MM-DD       结束日期
  --model <name>           只看某个模型
  --top <n>                只显示前 n 行
  --json                   JSON 输出
`;
}

const dir = path.join(dshHome(), 'token-usage');
if (!fs.existsSync(dir)) {
  console.error(`找不到用量目录：${dir}\n（DSH 需要至少运行过一次，且启用了 token 统计）`);
  process.exit(2);
}

const priceTable = loadPricing(path.join(dir, 'pricing.ccsa.json'));
const files = fs
  .readdirSync(dir)
  .filter((name) => /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
  .filter((name) => {
    const day = name.slice(6, 16);
    if (options.since && day < options.since) return false;
    if (options.until && day > options.until) return false;
    return true;
  })
  .sort();

if (files.length === 0) {
  console.error('所选区间没有用量数据。');
  process.exit(0);
}

const groups = new Map();
const unknownModels = new Map();
let total = blankTotals();
let firstTime = Infinity;
let lastTime = 0;

for (const file of files) {
  const day = file.slice(6, 16);
  const text = fs.readFileSync(path.join(dir, file), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (options.model && modelName !== options.model) continue;
    const modelName = record.model || '(unknown)';
    const price = priceTable.get(modelName);
    const usage = record.usage ?? {};
    const cost = price ? costOf(usage, price) : 0;
    if (!price) unknownModels.set(modelName, (unknownModels.get(modelName) ?? 0) + 1);

    const key =
      options.by === 'model'
        ? modelName
        : options.by === 'session'
          ? record.sessionId ?? 'unknown'
          : day;

    const bucket = groups.get(key) ?? { key, ...blankTotals() };
    accumulate(bucket, usage, cost);
    groups.set(key, bucket);
    accumulate(total, usage, cost);
    if (record.time) {
      firstTime = Math.min(firstTime, record.time);
      lastTime = Math.max(lastTime, record.time);
    }
  }
}

const rows = [...groups.values()].sort((a, b) => {
  if (options.by === 'day') return a.key.localeCompare(b.key);
  return b.cost - a.cost;
});
const shown = options.top > 0 ? rows.slice(0, options.top) : rows;

if (options.json) {
  console.log(
    JSON.stringify(
      {
        range: { since: options.since, until: options.until, files: files.length },
        by: options.by,
        totals: total,
        rows: shown,
        unpricedModels: [...unknownModels.keys()],
        currency: 'CNY',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const title = `DSH Token 用量（人民币）  ${formatTime(firstTime)} → ${formatTime(lastTime)}`;
console.log(title);
console.log('─'.repeat(title.length + 6));
const header = [
  pad(labelFor(options.by), labelWidth(options.by)),
  padLeft('请求', 8),
  padLeft('输入', 12),
  padLeft('输出', 12),
  padLeft('缓存读', 14),
  padLeft('费用', 11),
];
console.log(header.join('  '));

for (const row of shown) {
  console.log(
    [
      pad(String(row.key), labelWidth(options.by)),
      padLeft(fmtNumber(row.requests), 8),
      padLeft(fmtNumber(row.inputTokens), 12),
      padLeft(fmtNumber(row.outputTokens), 12),
      padLeft(fmtNumber(row.cacheReadTokens), 14),
      padLeft(fmtMoney(row.cost), 11),
    ].join('  '),
  );
}

console.log('─'.repeat(header.join('  ').length));
console.log(
  [
    pad('合计', labelWidth(options.by)),
    padLeft(fmtNumber(total.requests), 8),
    padLeft(fmtNumber(total.inputTokens), 12),
    padLeft(fmtNumber(total.outputTokens), 12),
    padLeft(fmtNumber(total.cacheReadTokens), 14),
    padLeft(fmtMoney(total.cost), 11),
  ].join('  '),
);

const cacheBase = total.inputTokens + total.cacheReadTokens;
if (cacheBase > 0) {
  console.log(`\n缓存命中率：${((total.cacheReadTokens / cacheBase) * 100).toFixed(1)}%（缓存读 /(输入+缓存读)）`);
}
if (unknownModels.size) {
  console.log(`未定价模型（计 0）：${[...unknownModels.keys()].join(', ')}`);
}
console.log('口径：基础价估算，不含阶梯价与时段规则；金额保留 2 位小数。');

function loadPricing(file) {
  const table = new Map();
  if (!fs.existsSync(file)) return table;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return table;
  }
  for (const model of data.models ?? []) {
    const price = {
      input: Number(model.inputCostPerMillion ?? 0),
      output: Number(model.outputCostPerMillion ?? 0),
      cacheRead: Number(model.cacheReadCostPerMillion ?? 0),
      cacheWrite: Number(model.cacheCreationCostPerMillion ?? 0),
    };
    table.set(model.modelId, price);
    for (const alias of model.aliases ?? []) table.set(alias, price);
  }
  return table;
}

function costOf(usage, price) {
  return (
    ((usage.inputTokens ?? 0) * price.input +
      (usage.outputTokens ?? 0) * price.output +
      (usage.cacheReadTokens ?? 0) * price.cacheRead +
      (usage.cacheWriteTokens ?? 0) * price.cacheWrite) /
    1_000_000
  );
}

function blankTotals() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
  };
}

function accumulate(target, usage, cost) {
  target.requests += 1;
  target.inputTokens += usage.inputTokens ?? 0;
  target.outputTokens += usage.outputTokens ?? 0;
  target.cacheReadTokens += usage.cacheReadTokens ?? 0;
  target.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  target.cost += cost;
}

function labelFor(by) {
  return by === 'model' ? '模型' : by === 'session' ? '会话' : '日期';
}

function labelWidth(by) {
  return by === 'model' ? 22 : by === 'session' ? 38 : 12;
}

function pad(text, width) {
  return String(text).padEnd(width);
}

function padLeft(text, width) {
  return String(text).padStart(width);
}

function formatTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const date = new Date(ms);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
