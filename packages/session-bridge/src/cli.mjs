import { inspect, resolveProfileInput } from './commands/inspect.mjs';
import { build } from './commands/build.mjs';
import { install } from './commands/install.mjs';
import { doctor } from './commands/doctor.mjs';
import { installExtension } from './commands/installExtension.mjs';
import { wbCall, renderWbCall } from './commands/wbCall.mjs';
import { bridgeTest, renderBridgeTest } from './commands/bridgeTest.mjs';
import { wbSession, renderWbSession } from './commands/wbSession.mjs';
import { copyId } from './commands/copyId.mjs';

const HELP = `
DSH → WorkBuddy 迁移工具（dsh2wb）

用法：
  dsh2wb <command> [profile] [options]

命令：
  inspect [profile]   分析 DSH 配置 → 迁移差异报告（只读，默认命令）
  build   [profile]   生成配置快照 + 报告到仓库
  install             安装技能包到 WorkBuddy（技能 + MCP 桥接，自动备份）
  install-extension   安装侧栏扩展「会话桥」到 WorkBuddy（需重启客户端）
  doctor              检查技能、扩展、MCP 会话工具与剩余手工项
  wb-call <method>    调扩展 service 的方法（命令行够不到宿主通道时用这条）
  bridge-test         端到端验收：新建 WorkBuddy 会话并双向通信两轮
  wb-session [id]     读本地 WorkBuddy 会话记录（不带 id 则列最近会话）
  copy-id             把当前会话的 Session ID 复制到剪贴板（宿主注入的环境变量，零误差）

参数：
  profile             导出目录 / profile 目录；省略时用 ~/.dsh/profiles/desktop
  --profile <dir>     显式指定 profile
  --out <dir>         inspect/build 的输出目录（默认 docs/）
  --json              输出 JSON（inspect / wb-call）
  --payload <json>    wb-call 的参数（JSON 字面量）
  --payload-file <p>  wb-call 的参数（从文件读）
  --timeout <ms>      wb-call 等待上限（默认 60000）
  --dry-run           只打印将要做的事，不落盘（install）
  --register-marketplace  额外把技能包注册为本地插件市场（install）
  --project <片段>    wb-session 按项目过滤
  --limit <n>         wb-session 列表条数（默认 20）
  --out <file>        wb-session 把时间线写成 Markdown
  --no-tools / --no-reasoning  wb-session 时间线里省略工具与推理
  --sid <id>          copy-id 指定要复制的会话（默认取当前会话）
  --print             copy-id 只打印，不写剪贴板
  --workbuddy-home <dir>  覆盖 ~/.workbuddy（测试用）
  --workbuddy-root <dir>  WorkBuddy 安装目录（install-extension 自动探测）
  --yes               跳过确认（install）
  --help              显示本帮助

示例：
  node bin/dsh2wb.mjs inspect ./dsh-config-export
  node bin/dsh2wb.mjs build ./dsh-config-export
  node bin/dsh2wb.mjs install
`;

export async function runCli(argv) {
  const { command, positional, options } = parseArgs(argv);

  if (options.help || command === 'help' || command === '-h' || command === '--help') {
    console.log(HELP.trim());
    return;
  }

  switch (command || 'inspect') {
    case 'inspect': {
      inspect(resolveProfileInput(positional[0], options), options);
      break;
    }
    case 'build': {
      build(resolveProfileInput(positional[0], options), options);
      break;
    }
    case 'install': {
      await install(options);
      break;
    }
    case 'install-extension': {
      installExtension(options);
      break;
    }
    case 'doctor': {
      await doctor(options);
      break;
    }
    case 'bridge-test': {
      const result = await bridgeTest(options);
      renderBridgeTest(result);
      break;
    }
    case 'wb-session': {
      const result = wbSession(positional[0], options);
      renderWbSession(result);
      break;
    }
    case 'copy-id': {
      copyId({ ...options, positional });
      break;
    }
    case 'wb-call': {
      const body = await wbCall(positional[0], options);
      renderWbCall(body, options);
      break;
    }
    default:
      throw new Error(`未知命令：${command}\n\n${HELP.trim()}`);
  }
}

function parseArgs(argv) {
  const options = {};
  const positional = [];
  let command = null;

  const takesValue = new Set(['profile', 'out', 'workbuddy-home', 'dsh-home', 'workbuddy-root', 'extension-dir', 'payload', 'payload-file', 'timeout', 'cwd', 'wait', 'conversation-id', 'project', 'limit', 'max-text', 'sid']);
  const booleans = new Set(['json', 'dry-run', 'register-marketplace', 'yes', 'help', 'force', 'quiet', 'no-tools', 'no-reasoning', 'print']);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [rawKey, inlineValue] = token.slice(2).split('=');
      const key = rawKey;
      if (takesValue.has(key)) {
        options[camel(key)] = inlineValue ?? argv[++i];
      } else if (booleans.has(key)) {
        options[camel(key)] = inlineValue === undefined ? true : inlineValue !== 'false';
      } else {
        throw new Error(`未知参数：--${key}`);
      }
      continue;
    }
    if (!command) command = token;
    else positional.push(token);
  }
  return { command, positional, options };
}

function camel(key) {
  return key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}
