"use strict";

/**
 * 会话桥 · extension service（宿主 fork 的 Node 子进程）
 *
 * 能力边界：
 *   - iframe 面板负责画；这个进程负责够得着（本地文件、本地 MCP、剪贴板）。
 *   - 会话数据源有两条：① DSH 的 dsh-as-mcp（session_list/create/prompt/messages/cancel），
 *     ② DSH 磁盘上的 ~/.dsh/sessions（DSH 没开时仍能列出并复制 ID）。
 *   - WorkBuddy 自己的会话列表走 wb.http.get 借宿主登录态。
 *
 * 宿主约定（docs/EXTENSION-COOKBOOK.md / PROTOCOL.md §6.9）：
 *   - extension.json 声明 service.entry + process=fork
 *   - 导出 activate(wb)，返回 { methods, dispose }
 *   - 方法签名 (context, payload)，返回值必须可结构化克隆
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DshMcpClient, DEFAULT_URL } = require("./mcp.cjs");
const { listLocalSessions, readLocalSession } = require("./sessions.cjs");
const { describe: describeHarnesses, getHarness } = require("./harnesses.cjs");
const { MenuInjector } = require("./menu-inject.cjs");
const {
  clipboard,
  dshHome,
  historySessions,
  mcpEndpoint,
  numberOr,
  readDshToken,
  sessionMeta,
  wbHome,
} = require("./local.cjs");

/**
 * 版本号从旁边的 extension.json 读，不写死。
 * 以前这里是常量，发版时容易只改清单忘了改它，面板「诊断」就会报旧版本号。
 */
const VERSION = (() => {
  try {
    return require("../extension.json").version;
  } catch {
    return "0.0.0";
  }
})();
const WEB = "https://www.workbuddy.cn";

/**
 * 本地队列：让命令行也能调到只有 service 才有的能力。
 *
 * 为什么需要它：`wb.invoke` 只在宿主 fork 出来的 service 里存在，
 * 命令行进程没有任何合法途径拿到 daemon 的 RPC 票据。所以反过来——
 * 命令行往约定目录丢一个请求文件，service 轮询取走执行，把结果写回。
 * 这样 `wb:conversations:*` 这类宿主通道对 CLI、脚本、自动化都变得可调用。
 *
 * 约束：只放行只读 + 会话操作，不放行任意代码执行。
 */
const QUEUE_ALLOWED = new Set([
  "ping",
  "status",
  "listDsh",
  "listWb",
  "createWb",
  "configWb",
  "promptWb",
  "requestsWb",
  "readWbLocal",
  "harnesses",
  "listHarness",
  "readHarness",
  "revealPath",
  "menuInject",
  "messagesDsh",
  "createDsh",
  "cancelDsh",
  "copyText",
  "hostChannels",
  "hostInvoke",
]);

/**
 * 宿主 `wb:conversations:*` 通道清单（31 条），照官方扩展 edge-sync 的绑定表抄的。
 * edge-sync 自己没界面、没安装包，但 server/index.cjs 里把宿主的通道全挂了一遍，
 * 是唯一一份「真实字段名 + 真实参数形状」的现成参考。
 *
 * allow 的含义：
 *   read   —— 只读，随便调，最坏也就是返回一片 JSON
 *   config —— configSet*，改的是会话的配置项（模型 / 上下文 / 思考强度 / 模式），
 *             不碰会话正文，也不动磁盘上的文件
 *   deny   —— 会写会话内容、删会话、发消息、改标题，面板只展示不放行
 *
 * sample 里出现 "<会话ID>" 的，面板会拿当前选中的会话 ID 去替换；
 * verified=false 表示参数形状是猜的，宿主可能直接抛错，当成探测用。
 */
const HOST_CHANNELS = [
  { id: "list", group: "读取", allow: "read", verified: true, sample: [], note: "列出本机会话；分页与筛选参数未公开，空参即可" },
  { id: "listByIds", group: "读取", allow: "read", verified: false, sample: [["<会话ID>"]], note: "按 ID 批量取会话，首个参数应是 ID 数组" },
  { id: "listPinned", group: "读取", allow: "read", verified: false, sample: [], note: "置顶会话列表" },
  { id: "get", group: "读取", allow: "read", verified: true, sample: ["<会话ID>"], note: "单个会话的元信息（标题 / 工作目录 / 模型）" },
  { id: "getPendingInfo", group: "读取", allow: "read", verified: false, sample: ["<会话ID>"], note: "这一轮还卡在什么上（待批准的工具调用等）" },
  { id: "listProgress", group: "读取", allow: "read", verified: false, sample: [], note: "正在跑的会话进度" },
  { id: "requests", group: "读取", allow: "read", verified: true, sample: ["<会话ID>", { limit: 20 }], note: "会话正文，一条 item = 一问一答" },
  { id: "requestEntries", group: "读取", allow: "read", verified: false, sample: ["<会话ID>", "<requestId>"], note: "某一条请求的明细分片" },

  { id: "configSetModel", group: "配置", allow: "config", verified: true, sample: ["<会话ID>", "deepseek-v4.1-flash"], note: "按模型 id 设，不是界面上的显示名" },
  { id: "configSetContextWindow", group: "配置", allow: "config", verified: true, sample: ["<会话ID>", 1000000], note: "300000 / 600000 / 1000000" },
  { id: "configSetThoughtLevel", group: "配置", allow: "config", verified: true, sample: ["<会话ID>", "max"], note: "low / high / max" },
  { id: "configSetMode", group: "配置", allow: "config", verified: false, sample: ["<会话ID>", "agent"], note: "对话模式（agent / plan / ask）" },
  { id: "configSetPermissionMode", group: "配置", allow: "config", verified: false, sample: ["<会话ID>", "acceptEdits"], note: "权限模式，取值与界面下拉一致" },
  { id: "configSetExpert", group: "配置", allow: "config", verified: false, sample: ["<会话ID>", "<专家ID>"], note: "绑定专家，传 expertId" },
  { id: "configSetConnectors", group: "配置", allow: "config", verified: false, sample: ["<会话ID>", []], note: "会话可用的连接器 id 数组" },
  { id: "configSetPreMessageCompactPct", group: "配置", allow: "config", verified: false, sample: ["<会话ID>", 80], note: "上下文压缩触发阈值（百分比）" },

  { id: "create", group: "写入", allow: "deny", note: "建会话；用面板的「新建」或 createWb" },
  { id: "delete", group: "写入", allow: "deny", note: "删会话" },
  { id: "fork", group: "写入", allow: "deny", note: "从某条消息分叉一个新会话" },
  { id: "rename", group: "写入", allow: "deny", note: "改标题" },
  { id: "sendPrompt", group: "写入", allow: "deny", note: "发消息；用 promptWb" },
  { id: "cancel", group: "写入", allow: "deny", note: "掐掉正在跑的这一轮" },
  { id: "archive", group: "写入", allow: "deny", note: "归档会话" },
  { id: "unarchive", group: "写入", allow: "deny", note: "取消归档" },
  { id: "pin", group: "写入", allow: "deny", note: "置顶" },
  { id: "unpin", group: "写入", allow: "deny", note: "取消置顶" },
  { id: "reorderPinned", group: "写入", allow: "deny", note: "调整置顶顺序" },
  { id: "move", group: "写入", allow: "deny", note: "挪到别的项目/分组" },
  { id: "markRead", group: "写入", allow: "deny", note: "标记已读，会改会话状态" },
  { id: "resolvePending", group: "写入", allow: "deny", note: "批准一个待确认的工具调用" },
  { id: "rejectPending", group: "写入", allow: "deny", note: "拒绝一个待确认的工具调用" },
];

const HOST_PREFIX = "wb:conversations:";
const HOST_ALLOWED = new Set(HOST_CHANNELS.filter((c) => c.allow !== "deny").map((c) => c.id));
/** 一次调用最多带 8 个位置参数；再多基本就是拼错了，早点报错比让宿主瞎猜好。 */
const HOST_MAX_ARGS = 8;
/** 单个返回值最多原样带回 200 KB，超了截断并标记——面板是 <pre> 里看的，塞不下也没意义。 */
const HOST_RESULT_LIMIT = 200000;

function bridgeQueueDir() {
  return path.join(wbHome(), "dsh-skills", "bridge-queue");
}

const queueState = { timer: null, busy: false, methods: null };

function startBridgeQueue(methods) {
  queueState.methods = methods;
  if (queueState.timer) return;
  const dir = bridgeQueueDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return; // 目录建不了就别开轮询，避免刷错误
  }

  const writeResult = (target, body) => {
    const tmp = `${target}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2), "utf8");
      fs.renameSync(tmp, target);
    } catch {
      /* 结果写不回就丢弃，调用侧会超时 */
    }
  };

  queueState.timer = setInterval(async () => {
    if (queueState.busy) return;
    queueState.busy = true;
    try {
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith(".req.json")).sort();
      } catch {
        return;
      }
      for (const file of files.slice(0, 4)) {
        const full = path.join(dir, file);
        const id = file.slice(0, -".req.json".length);
        let req = null;
        try {
          req = JSON.parse(fs.readFileSync(full, "utf8"));
        } catch {
          continue;
        }
        // 先把请求挪走再执行：重复扫描到同一个文件时不会再跑第二遍
        try {
          fs.renameSync(full, path.join(dir, `${id}.taken`));
        } catch {
          continue;
        }
        const out = path.join(dir, `${id}.res.json`);
        const method = String(req?.method || "");
        try {
          if (!QUEUE_ALLOWED.has(method)) {
            throw fault(`方法不在白名单：${method}`, "INVALID_ARGUMENT");
          }
          const fn = queueState.methods && queueState.methods[method];
          if (typeof fn !== "function") {
            throw fault(`没有这个方法：${method}`, "INVALID_ARGUMENT");
          }
          const result = await fn({ callerId: "bridge-queue" }, req?.payload || {});
          writeResult(out, { ok: true, id, method, at: Date.now(), result });
        } catch (err) {
          writeResult(out, {
            ok: false,
            id,
            method,
            at: Date.now(),
            error: String((err && err.message) || err),
            code: err && err.code ? String(err.code) : undefined,
          });
        } finally {
          try {
            fs.unlinkSync(path.join(dir, `${id}.taken`));
          } catch {
            /* noop */
          }
        }
      }
    } catch {
      /* 轮询本身不抛 */
    } finally {
      queueState.busy = false;
    }
  }, 600);
  if (queueState.timer.unref) queueState.timer.unref();
}

function stopBridgeQueue() {
  if (queueState.timer) {
    clearInterval(queueState.timer);
    queueState.timer = null;
  }
}

function activate(wb) {
  const endpoint = mcpEndpoint() || DEFAULT_URL;
  let disposed = false;
  let probeCache = null;
  const client = new DshMcpClient({ url: endpoint, token: readDshToken(), timeoutMs: 20000 });

  // 会话菜单注入：只有宿主带着调试端口启动时才真正跑起来，否则整体休眠。
  const menuInjector = new MenuInjector({
    logFile: path.join(wbHome(), "dsh-skills", "menu-inject.log"),
  });
  menuInjector.start();

  function clientFor(timeoutMs) {
    // Token can rotate while the client is idle; cheap to re-read per call.
    return new DshMcpClient({
      url: endpoint,
      token: readDshToken(),
      timeoutMs: Math.max(1000, numberOr(timeoutMs, 20000)),
    });
  }

  async function probe(force) {
    if (!force && probeCache && Date.now() - probeCache.at < 5000) return probeCache.value;
    const fresh = clientFor(2500);
    try {
      const tools = await fresh.listTools();
      probeCache = {
        at: Date.now(),
        value: { online: true, tools, error: "", tokenFound: Boolean(fresh.token) },
      };
    } catch (error) {
      probeCache = {
        at: Date.now(),
        value: { online: false, tools: [], error: error.message, tokenFound: Boolean(fresh.token) },
      };
    }
    return probeCache.value;
  }

  const methods = {
    /** 健康检查：面板启动后第一件事 */
    ping: async () => ({
      ok: true,
      version: VERSION,
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      defaultCwd: process.env.CODEBUDDY_PROJECT_DIR || process.cwd(),
      dshHome: dshHome(),
      endpoint,
    }),

    /** 连接状态 + 可用工具，用于面板顶部的状态灯 */
    status: async () => {
      const info = await probe(true);
      return {
        ok: true,
        version: VERSION,
        endpoint,
        defaultCwd: process.env.CODEBUDDY_PROJECT_DIR || process.cwd(),
        tokenFound: info.tokenFound,
        online: info.online,
        tools: info.tools,
        error: info.error,
      };
    },

    /** 列出 DSH 会话：优先 MCP（带 running 状态），离线时退回磁盘历史 */
    listDsh: async (ctx, payload) => {
      const limit = Math.min(200, Math.max(1, numberOr(payload?.limit, 50)));
      const meta = sessionMeta();
      const info = await probe(false);

      if (info.online) {
        try {
          const result = await clientFor(15000).callTool("session_list", { limit });
          const sessions = (result.sessions || []).map((session) => {
            const key = session.sessionId || session.id;
            const cached = meta[key] || meta[`session-${key}`];
            return {
              id: key,
              title: cached?.title || shortCwd(session.cwd) || "(未命名会话)",
              cwd: session.cwd || cached?.cwd || "",
              running: Boolean(session.running),
              blank: Boolean(session.blank),
              updatedAt: numberOr(session.updatedAt, Date.now()),
              source: "mcp",
            };
          });
          return { ok: true, source: "mcp", online: true, sessions };
        } catch (error) {
          // 服务探活成功但调用失败：仍然退回磁盘，避免面板空白
          return {
            ok: true,
            source: "history",
            online: false,
            warning: error.message,
            sessions: historySessions(limit),
          };
        }
      }

      return {
        ok: true,
        source: "history",
        online: false,
        warning: info.error,
        sessions: historySessions(limit),
      };
    },

    /** 新建 DSH 会话；可顺手下发第一条任务（不等待，避免面板卡 3 分钟） */
    createDsh: async (ctx, payload) => {
      const cwd = cleanString(payload?.cwd);
      const workspaceId = cleanString(payload?.workspaceId);
      if (!cwd && !workspaceId) throw fault("需要 cwd 或 workspaceId", "INVALID_ARGUMENT");

      const args = {};
      if (workspaceId) args.workspaceId = workspaceId;
      else args.cwd = cwd;
      if (payload?.agentPreset) args.agentPreset = String(payload.agentPreset);

      const result = await clientFor(30000).callTool("session_create", args);
      const sessionId = result.sessionId || result.id;
      if (!sessionId) throw fault("session_create 没有返回 sessionId", "BAD_RESPONSE");

      let prompted = false;
      let promptError = "";
      const prompt = cleanString(payload?.prompt);
      if (prompt) {
        try {
          await clientFor(30000).callTool("session_prompt", {
            sessionId,
            prompt,
            mode: "queue",
            wait: false,
          });
          prompted = true;
        } catch (error) {
          promptError = error.message;
        }
      }
      return { ok: true, sessionId, cwd: result.cwd || cwd, prompted, promptError };
    },

    /** 给指定 DSH 会话发一条消息——这就是「会话之间对话」的入口 */
    promptDsh: async (ctx, payload) => {
      const sessionId = cleanString(payload?.sessionId);
      const prompt = cleanString(payload?.prompt);
      if (!sessionId) throw fault("缺少 sessionId", "INVALID_ARGUMENT");
      if (!prompt) throw fault("消息为空", "INVALID_ARGUMENT");
      if (prompt.length > 20000) throw fault("消息过长（上限 20000 字）", "INVALID_ARGUMENT");

      const wait = Boolean(payload?.wait);
      const timeoutMs = Math.min(120000, Math.max(5000, numberOr(payload?.timeoutMs, wait ? 90000 : 20000)));
      const mode = payload?.mode === "steer" ? "steer" : "queue";

      const result = await clientFor(timeoutMs + 5000).callTool(
        "session_prompt",
        { sessionId, prompt, mode, wait, timeoutMs },
        { timeoutMs: timeoutMs + 5000 },
      );
      return normalizePromptResult(result, sessionId, wait);
    },

    /** 读取会话最近的消息 */
    messagesDsh: async (ctx, payload) => {
      const sessionId = cleanString(payload?.sessionId);
      if (!sessionId) throw fault("缺少 sessionId", "INVALID_ARGUMENT");
      const limit = Math.min(200, Math.max(1, numberOr(payload?.limit, 30)));
      const result = await clientFor(15000).callTool("session_messages", { sessionId, limit });
      const messages = (result.messages || []).map((message) => {
        const role = message.role === "user" ? "user" : "assistant";
        const text = String(message.text ?? "");
        return {
          role,
          text,
          time: numberOr(message.time, Date.now()),
          seq: numberOr(message.seq, 0),
          // DSH 每轮会往对话里注入 runtime context / skill 提醒 / 时间采样，
          // 它们的 role 也是 user，面板不标出来就会当成真人发言。
          injected: role === "user" && isInjected(text),
        };
      });
      return {
        ok: true,
        sessionId,
        messages,
        injectedCount: messages.filter((message) => message.injected).length,
      };
    },

    cancelDsh: async (ctx, payload) => {
      const sessionId = cleanString(payload?.sessionId);
      if (!sessionId) throw fault("缺少 sessionId", "INVALID_ARGUMENT");
      const result = await clientFor(15000).callTool("session_cancel", { sessionId });
      return { ok: true, cancelled: result.cancelled !== false, sessionId };
    },

    /**
     * ---- WorkBuddy 侧：新建会话 / 发消息 / 读消息 ----
     *
     * 走宿主的 daemon RPC。通道名在 edge-sync（官方内置扩展）的 service 里能看到：
     *   wb:conversations:create      参数对象透传，返回 { info: { transport:"local", ... } }
     *   wb:conversations:sendPrompt  (conversationId, ContentBlock[], options)
     *   wb:conversations:requests    (conversationId, ...) → { items: [...] }
     *
     * 入参形状没有公开文档，所以 create 按几种形态依次试，第一个能拿到 id 的为准；
     * 每次尝试的原始返回都写进 ~/.workbuddy/dsh-skills/wb-probe.jsonl，事后对着真实结构改解析。
     */
    createWb: async (ctx, payload) => {
      const cwd = cleanString(payload?.cwd) || defaultCwd;
      // 可选：payload.model 指定新会话使用的模型（例如 "DeepSeek-V4.1-Flash"）。
      // 宿主没有公开入参形状，所以带 model 的几种形态先试，失败再退回只传 cwd，
      // 保证在不支持 model 的宿主上行为与以前完全一致。
      const model = cleanString(payload?.model);
      // 可选：payload.contextWindow 指定上下文长度（例如 1000000）。
      // 模型定义里 supportedLengths 是按会话生效的，宿主的建会话入参名未知，
      // 所以把几种可能的字段名依次试一遍；宿主忽略未知字段时行为与只传 cwd 一致。
      const contextWindow = Number(payload?.contextWindow) || 0;
      const ctxVariants = contextWindow
        ? [
            { contextWindow },
            { contextWindow, contextWindowSize: contextWindow },
            { contextWindow, maxContextWindow: contextWindow },
            { contextWindow, contextLength: contextWindow },
            { contextWindow, maxInputTokens: contextWindow },
          ]
        : [];
      // 可选：payload.thoughtLevel 指定思考强度（sessions 表的 thought_level 列，
      // UI 里叫「思考强度」，取值 low / high / max）。宿主入参名按该列的 camelCase 猜，
      // 猜错时宿主多半抛错，那就换下一个字段名。
      const thoughtLevel =
        cleanString(payload?.thoughtLevel) || cleanString(payload?.thought_level);
      const effortVariants = thoughtLevel
        ? [
            { thoughtLevel },
            { thoughtLevel, thought_level: thoughtLevel },
            { thoughtLevel, effort: thoughtLevel },
            { thoughtLevel, reasoningEffort: thoughtLevel },
          ]
        : [];
      const baseArgs = model ? { cwd, model } : { cwd };
      // 先试「上下文 + 思考强度」的全量形态，再退到只带上下文的旧形态，
      // 最后退到只带 model / 只带 cwd，保证老宿主行为不变。
      const fullVariants = [];
      if (contextWindow && thoughtLevel) {
        for (const v of ctxVariants) for (const e of effortVariants) fullVariants.push({ ...v, ...e });
      }
      const attempts = [
        ...fullVariants.map((v) => ({ ...baseArgs, ...v })),
        ...ctxVariants.map((v) => ({ ...baseArgs, ...v })),
        ...effortVariants.map((v) => ({ ...baseArgs, ...v })),
        ...(model
          ? [{ cwd, model }, { cwd, model, modelId: model }, { workspacePath: cwd, model }, { cwd }]
          : [{ cwd }, { workspacePath: cwd }, {}]),
      ];
      const trace = [];
      for (const args of attempts) {
        try {
          const res = await wbCall(wb, "wb:conversations:create", args);
          const conv = pickWbConversation(res);
          if (conv.id) {
            probeLog("createWb ok", { args, id: conv.id, shape: shapeOf(res) });
            return { ok: true, conversationId: conv.id, title: conv.title, cwd: conv.cwd || cwd, args, trace };
          }
          trace.push({ args, ok: false, error: "返回里没有会话 id", shape: shapeOf(res) });
        } catch (error) {
          trace.push({ args, ok: false, error: error.message });
        }
      }
      probeLog("createWb failed", { cwd, trace });
      throw fault(`宿主要么拒绝了建会话：${JSON.stringify(trace).slice(0, 600)}`, "WB_CREATE_FAILED");
    },

    /**
     * configWb：改一个已存在会话的模型 / 上下文长度 / 思考强度。
     *
     * 建会话时宿主只认 cwd 与 model，contextWindow 和 thoughtLevel 会被静默丢掉，
     * 所以这三项要在建完之后单独设。宿主通道是：
     *   wb:conversations:configSetModel
     *   wb:conversations:configSetContextWindow
     *   wb:conversations:configSetThoughtLevel
     * 参数形状没有公开，第二个参数可能是裸值、{value}、{<字段名>} 或 {level}，
     * 依次试到宿主不抛错为止。调用方必须回查 workbuddy.db 的 sessions 表确认真的生效。
     */
    configWb: async (ctx, payload) => {
      const conversationId = cleanString(payload?.conversationId);
      if (!conversationId) throw fault("缺少 conversationId", "INVALID_ARGUMENT");
      const jobs = [];
      const model = cleanString(payload?.model);
      if (model) jobs.push(["configSetModel", "model", model]);
      const contextWindow = Number(payload?.contextWindow) || 0;
      if (contextWindow) jobs.push(["configSetContextWindow", "contextWindow", contextWindow]);
      const thoughtLevel = cleanString(payload?.thoughtLevel) || cleanString(payload?.thought_level);
      if (thoughtLevel) jobs.push(["configSetThoughtLevel", "thoughtLevel", thoughtLevel]);
      if (!jobs.length) throw fault("没有要改的项", "INVALID_ARGUMENT");

      const results = [];
      for (const [channel, key, value] of jobs) {
        const variants = [
          [conversationId, value],
          [conversationId, { [key]: value }],
          [conversationId, { value }],
          [conversationId, { level: value }],
        ];
        let done = false;
        for (const args of variants) {
          try {
            const res = await wbCall(wb, `wb:conversations:${channel}`, ...args);
            results.push({ channel, variant: JSON.stringify(args[1]), ok: true, shape: shapeOf(res) });
            done = true;
            break;
          } catch (error) {
            results.push({ channel, variant: JSON.stringify(args[1]), ok: false, error: error.message });
          }
        }
        if (!done) results.push({ channel, ok: false, error: "所有参数形态都被拒" });
      }
      probeLog("configWb", { conversationId, results });
      return { ok: true, conversationId, results };
    },

    /**
     * hostChannels：给面板的「宿主通道」页用的清单。
     *
     * 31 条里只放行 16 条（8 条只读 + 8 条 configSet*）。剩下 15 条会写会话内容、
     * 删会话、发消息，一律只展示不放行——这个面板是调试台，不是遥控器。
     */
    hostChannels: async () => ({
      ok: true,
      total: HOST_CHANNELS.length,
      allowed: HOST_ALLOWED.size,
      prefix: HOST_PREFIX,
      channels: HOST_CHANNELS.map((c) => ({
        ...c,
        channel: `${HOST_PREFIX}${c.id}`,
        allowed: c.allow !== "deny",
      })),
    }),

    /**
     * hostInvoke：原样透传一次宿主调用。
     *
     * 参数按位置传给 daemon（宿主那侧就是 (conversationId, ...rest) 的形状），
     * 所以 payload.args 必须是一个 JSON 数组，不做任何字段名猜测——
     * 猜字段名那套放在 configWb 里，这里是「我知道我要传什么」的场景。
     *
     * 返回值原样带回去（超过 200 KB 截断），不解析、不美化，
     * 因为看这个页的人要的就是宿主到底回了什么。
     */
    hostInvoke: async (ctx, payload) => {
      const raw = cleanString(payload?.channel) || cleanString(payload?.id);
      if (!raw) throw fault("缺少 channel", "INVALID_ARGUMENT");
      const id = raw.startsWith(HOST_PREFIX) ? raw.slice(HOST_PREFIX.length) : raw;
      if (!HOST_ALLOWED.has(id)) {
        throw fault(`通道 ${HOST_PREFIX}${id} 不在放行名单里（只放只读与 configSet*）`, "FORBIDDEN");
      }

      let args = payload?.args;
      if (args === undefined || args === null) args = [];
      if (!Array.isArray(args)) throw fault("args 必须是 JSON 数组，按位置透传", "INVALID_ARGUMENT");
      if (args.length > HOST_MAX_ARGS) {
        throw fault(`参数最多 ${HOST_MAX_ARGS} 个，收到 ${args.length} 个`, "INVALID_ARGUMENT");
      }

      const channel = `${HOST_PREFIX}${id}`;
      const started = Date.now();
      try {
        const result = await wbCall(wb, channel, ...args);
        const packed = packHostResult(result);
        probeLog("hostInvoke ok", {
          channel,
          args,
          ms: Date.now() - started,
          shape: shapeOf(result),
          truncated: packed.truncated,
        });
        return {
          ok: true,
          channel,
          args,
          ms: Date.now() - started,
          result: packed.value,
          truncated: packed.truncated,
          bytes: packed.bytes,
        };
      } catch (error) {
        probeLog("hostInvoke failed", { channel, args, ms: Date.now() - started, error: error.message });
        const wrapped = fault(`${channel} 调用失败：${error.message}`, error.code || "HOST_CHANNEL_FAILED");
        wrapped.channel = channel;
        throw wrapped;
      }
    },

    promptWb: async (ctx, payload) => {
      const conversationId = cleanString(payload?.conversationId);
      const text = cleanString(payload?.text);
      if (!conversationId) throw fault("缺少 conversationId", "INVALID_ARGUMENT");
      if (!text) throw fault("消息内容不能为空", "INVALID_ARGUMENT");
      if (text.length > 20000) throw fault("消息超过 20000 字", "INVALID_ARGUMENT");
      // sendPrompt 收的是 ContentBlock[]，不是字符串
      const blocks = [{ type: "text", text }];
      /**
       * 宿主的发送模式有两种（产品里叫 Queue / Steering）：
       *   - queue：消息进队列，等当前轮结束才被处理（宿主默认）
       *   - steer：忙的时候走 core.sendPrompt 的 `queueDelivery === "steer"` 分支，
       *            立即 queueImpl.sendNow 插进当前轮次
       * 会话桥要的是「对方一说话，我这边马上看到」，所以默认 steer；
       * 想退回排队行为传 delivery: "queue"。
       */
      const delivery = cleanString(payload?.delivery) || "steer";
      const options = { emitUserMessage: true };
      if (delivery === "steer") options.queueDelivery = "steer";
      const res = await wbCall(wb, "wb:conversations:sendPrompt", conversationId, blocks, options);
      probeLog("promptWb ok", { conversationId, chars: text.length, delivery, shape: shapeOf(res) });
      return { ok: true, conversationId, chars: text.length, delivery };
    },

    requestsWb: async (ctx, payload) => {
      const conversationId = cleanString(payload?.conversationId);
      if (!conversationId) throw fault("缺少 conversationId", "INVALID_ARGUMENT");
      const limit = Math.min(100, Math.max(1, numberOr(payload?.limit, 30)));

      let res = null;
      let error = null;
      for (const args of [[conversationId, { limit }], [conversationId], [{ conversationId, limit }]]) {
        try {
          res = await wbCall(wb, "wb:conversations:requests", ...args);
          break;
        } catch (e) {
          error = e;
        }
      }
      if (!res) throw fault(`读会话消息失败：${error ? error.message : "未知错误"}`, "WB_REQUESTS_FAILED");

      const items = res.items || res.requests || res.data?.items || [];
      const messages = flattenWbRequests(items);
      probeLog("requestsWb ok", { conversationId, requests: items.length, messages: messages.length, shape: shapeOf(res) });
      return { ok: true, conversationId, count: messages.length, requests: items.length, messages, shape: shapeOf(res) };
    },

    /**
     * WorkBuddy 会话列表，两个数据源必须分开看：
     *   - local：桌面端本机会话，扫 projects/<项目>/<会话>.jsonl，ID 是 UUID
     *   - cloud：宿主登录态下的云端会话，走 wb.http（数字 ID，那是另一套 ID 空间）
     *
     * 之前只实现了 cloud，于是面板列得出一堆数字 ID，却看不到用户自己桌面上正在用的会话。
     * 现在默认两个都返回（source: "all"），行的 source 字段标明出处。
     */
    listWb: async (ctx, payload) => {
      const asked = cleanString(payload?.source) || "all";
      const source = asked === "local" || asked === "cloud" ? asked : "all";
      const page = Math.max(1, numberOr(payload?.page, 1));
      const pageSize = Math.min(50, Math.max(5, numberOr(payload?.pageSize, 30)));

      const local = source === "local" || source === "all" ? listLocalSessions({ limit: pageSize }) : [];

      let cloud = [];
      let cloudError = "";
      let pagination = { hasNext: false, totalPages: 1 };
      if (source === "cloud" || source === "all") {
        if (!wb || !wb.http || typeof wb.http.get !== "function") {
          cloudError = "宿主的 http 通道不可用（拿不到云端会话）";
        } else {
          try {
            const url = `${WEB}/console/as/conversations/?page_size=${pageSize}&page=${page}`;
            const response = await wb.http.get(url, { headers: { accept: "application/json" } });
            const data = unwrapData(response) || {};
            cloud = (data.conversations || [])
              .map((item) => ({
                id: String(item.id ?? ""),
                title: item.name || "(无标题)",
                status: item.status || "",
                updatedAt: numberOr(item.updatedAt || item.createdAt || item.lastActivityAt, 0),
                source: "cloud",
              }))
              .filter((item) => item.id);
            pagination = {
              hasNext: Boolean(data.pagination?.hasNext),
              totalPages: numberOr(data.pagination?.totalPages, 1),
            };
          } catch (e) {
            cloudError = e.message;
          }
        }
      }

      const rows = [];
      const seen = new Set();
      for (const row of local.concat(cloud)) {
        if (!row.id || seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }
      if (source === "all") rows.sort((a, b) => numberOr(b.updatedAt, 0) - numberOr(a.updatedAt, 0));

      return {
        ok: true,
        source,
        page,
        pageSize,
        local: local.length,
        cloud: cloud.length,
        cloudError,
        conversations: rows,
        pagination,
      };
    },

    /**
     * 直接读桌面端会话的本地记录。
     * 宿主只在会话被载入运行时之后才给得出消息，重启后旧会话 requestsWb 会返回 0 条，
     * 面板要能照常看内容，就得走这条路。
     */
    readWbLocal: async (ctx, payload) => {
      const conversationId = cleanString(payload?.conversationId);
      if (!conversationId) throw fault("缺少 conversationId", "INVALID_ARGUMENT");
      const limit = Math.min(500, Math.max(1, numberOr(payload?.limit, 100)));
      const result = readLocalSession(conversationId, { limit });
      probeLog("readWbLocal", { conversationId, found: result.found, messages: result.messages.length });
      return result;
    },

    /**
     * 这台机器上还装了哪些本地 harness，各自有没有会话数据。
     * 面板据此动态生成标签页——没装的不会占位。
     */
    harnesses: async () => ({ ok: true, harnesses: describeHarnesses() }),

    /**
     * 列某个 harness 的本地会话。只读来源（Codex / Claude）没有发消息的通道，
     * 面板只用来查看、复制 ID、复制恢复命令。
     */
    listHarness: async (ctx, payload) => {
      const adapter = getHarness(payload?.harness);
      if (!adapter) throw fault(`不认识的 harness：${cleanString(payload?.harness) || "(空)"}`, "INVALID_ARGUMENT");
      if (!adapter.available()) throw fault(`${adapter.label} 没有本地会话目录`, "NO_HARNESS");
      const limit = Math.min(200, Math.max(1, numberOr(payload?.limit, 60)));
      const result = adapter.list({
        limit,
        includeSubagents: Boolean(payload?.includeSubagents),
      });
      probeLog("listHarness", {
        harness: adapter.id,
        rows: result.rows.length,
        total: result.total,
        hidden: result.hidden,
      });
      return {
        ok: true,
        harness: adapter.id,
        label: adapter.label,
        readOnly: Boolean(adapter.readOnly),
        rows: result.rows,
        total: result.total,
        hidden: result.hidden,
        home: adapter.home(),
      };
    },

    /** 读某个只读 harness 的一条会话（全量，从本地记录解析） */
    readHarness: async (ctx, payload) => {
      const adapter = getHarness(payload?.harness);
      if (!adapter) throw fault("不认识的 harness", "INVALID_ARGUMENT");
      const id = cleanString(payload?.id);
      if (!id) throw fault("缺少 id", "INVALID_ARGUMENT");
      const limit = Math.min(500, Math.max(1, numberOr(payload?.limit, 200)));
      const result = adapter.read(id, { limit });
      probeLog("readHarness", { harness: adapter.id, id, found: result.found, messages: result.messages.length });
      return {
        ...result,
        label: adapter.label,
        readOnly: Boolean(adapter.readOnly),
        resumeHint: adapter.resumePrefix ? `${adapter.resumePrefix} ${id}` : "",
      };
    },

    /** 在系统文件管理器里定位一个目录（右键菜单用） */
    revealPath: async (ctx, payload) => {
      const target = cleanString(payload?.path);
      if (!target) throw fault("缺少 path", "INVALID_ARGUMENT");
      let stat = null;
      try {
        stat = fs.statSync(target);
      } catch {
        throw fault(`路径不存在：${target}`, "INVALID_ARGUMENT");
      }
      const dir = stat.isDirectory() ? target : path.dirname(target);
      const cmd = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
      const child = spawn(cmd, [dir], { detached: true, stdio: "ignore" });
      child.unref();
      return { ok: true, path: dir };
    },

    /** 剪贴板由 Node 侧写，iframe 的 navigator.clipboard 在 wb-extension 源下不可靠 */
    copyText: async (ctx, payload) => {
      const text = String(payload?.text ?? "");
      if (!text) throw fault("没有要复制的内容", "INVALID_ARGUMENT");
      if (text.length > 10000) throw fault("内容过长（上限 10000 字）", "INVALID_ARGUMENT");
      const result = clipboard(text);
      return { ok: result.ok, method: result.method, length: text.length };
    },

    /** 会话菜单注入状态：「复制 Session ID」到底挂上没挂上 */
    menuInject: async () => ({ ok: true, ...menuInjector.status() }),

    dispose: async () => {
      disposed = true;
      probeCache = null;
      menuInjector.stop();
    },
  };

  // dispose 只是登记，真正的清理由宿主的 dispose 钩子调用。
  const { dispose: _disposeMethod, ...publicMethods } = methods;
  startBridgeQueue(publicMethods);
  return {
    methods: publicMethods,
    dispose() {
      disposed = true;
      probeCache = null;
      menuInjector.stop();
      stopBridgeQueue();
    },
  };
}

function normalizePromptResult(result, sessionId, wait) {
  const out = { ok: true, sessionId, wait };
  if (result && typeof result === "object") {
    if (typeof result.reply === "string") out.reply = result.reply;
    else if (typeof result.text === "string") out.reply = result.text;
    if (Array.isArray(result.toolCalls)) out.toolCalls = result.toolCalls.length;
    if (result.status) out.status = String(result.status);
    if (result.timedOut) out.timedOut = true;
  }
  return out;
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * DSH 会在每轮对话前把 runtime context、skill 清单、时间采样等塞成 user 消息。
 * 它们在 session_messages 里和真人发言没有任何可区分的字段，只能按开头特征识别。
 * 这份清单是实测出来的（2026-10-24，DSH 0.2.1-rc.2），看到新形态就往前缀里加。
 */
const INJECTED_PREFIXES = [
  "<system-reminder>",
  "<user_instructions>",
  "<environment_context>",
  "Current runtime context.",
  "Time sampled while preparing turn",
];

function isInjected(text) {
  const head = String(text).trimStart();
  if (!head) return false;
  return INJECTED_PREFIXES.some((prefix) => head.startsWith(prefix));
}

function shortCwd(cwd) {
  if (!cwd) return "";
  const parts = String(cwd).split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? String(cwd) : `…/${parts.slice(-2).join("/")}`;
}

function unwrapData(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if ("data" in payload && ("code" in payload || "msg" in payload)) return payload.data;
  return payload;
}

function fault(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 调宿主的 daemon RPC。通道不在白名单里时这里会直接抛，别自己吞。 */
function wbCall(wb, channel, ...args) {
  if (!wb || typeof wb.invoke !== "function") {
    throw fault(`宿主没有提供 invoke 通道（${channel}）`, "NO_INVOKE");
  }
  return wb.invoke(channel, ...args);
}

/**
 * 把每次探测的原始返回落盘。WorkBuddy 的 conversations RPC 没有公开的入参/出参文档，
 * 猜一次记一次，出问题直接看 ~/.workbuddy/dsh-skills/wb-probe.jsonl。
 */
function probeLog(event, data) {
  try {
    const dir = path.join(wbHome(), "dsh-skills");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "wb-probe.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`);
  } catch {
    /* 日志失败不该影响主流程 */
  }
}

function pickWbConversation(res) {
  const info = res?.info || res?.conversation?.info || res?.conversation || res || {};
  const id = info.id || info.conversationId || info.sessionId || res?.id || res?.conversationId || "";
  return {
    id: id ? String(id) : "",
    title: String(info.title || info.name || ""),
    cwd: String(info.cwd || info.workspacePath || info.projectPath || ""),
  };
}

/**
 * WorkBuddy 的 assistantMessage / userMessage 形如 { type, content: [{ type:"text", text }] }。
 * 和 DSH 不同，这里没有 role 字段 —— 角色由所在字段决定。
 *
 * 注意：content[] 里通常先有一块 { type:"reasoning" }（模型思考），
 * 必须按类型挑出正文，否则思考内容会被拼进回复里。
 */
const TEXT_BLOCK_TYPES = new Set(["text", "output_text", "input_text", "markdown"]);

function wbMessageText(message) {
  if (!message) return "";
  if (typeof message === "string") return message.trim();
  const content = message.content ?? message.parts ?? message.text;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (!block || typeof block !== "object") return "";
        const type = String(block.type || "").toLowerCase();
        if (type && !TEXT_BLOCK_TYPES.has(type)) return "";
        if (typeof block.text === "string") return block.text;
        if (typeof block.content === "string") return block.content;
        return "";
      })
      .filter(Boolean)
      .join("")
      .trim();
  }
  if (content && typeof content === "object" && typeof content.text === "string") {
    return content.text.trim();
  }
  return "";
}

/** 只为展示：这条回复里模型想了多少字。 */
function wbReasoningChars(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  return content.reduce((sum, block) => {
    if (!block || block.type !== "reasoning") return sum;
    return sum + String(block.text ?? "").length;
  }, 0);
}

/**
 * 宿主的一条 item 是「一次请求」，自带 userMessage 与 assistantMessage，
 * 不是一条消息。这里摊平成消息列表，面板与 CLI 才能顺序渲染。
 * assistantMessage 缺失表示还在跑：只给 user 一条，绝不拿提问冒充回复。
 */
function flattenWbRequests(items) {
  const messages = [];
  for (const item of items) {
    const time = numberOr(item.timestamp || item.time || item.createdAt, 0);
    const pending = item.state === "streaming" || item.state === "pending";
    const userText = wbMessageText(item.userMessage);
    const assistantText = wbMessageText(item.assistantMessage);
    if (userText) {
      messages.push({ index: messages.length, role: "user", text: userText, time });
    }
    if (assistantText) {
      messages.push({
        index: messages.length,
        role: "assistant",
        text: assistantText,
        time,
        pending,
        reasoning: wbReasoningChars(item.assistantMessage),
      });
    }
    if (!userText && !assistantText) {
      // 字段形状又变了时的兜底，别把内容直接丢掉
      messages.push({
        index: messages.length,
        role: guessWbRole(item),
        text: guessWbText(item),
        time,
        raw: clip(JSON.stringify(item), 900),
      });
    }
  }
  return messages;
}

function guessWbRole(item) {
  const raw = String(item?.role || item?.author || item?.roleType || item?.kind || "").toLowerCase();
  if (raw.includes("assistant") || raw.includes("agent") || raw === "ai") return "assistant";
  if (raw.includes("user") || raw.includes("human")) return "user";
  return "assistant";
}

/** 消息文本可能藏在 text / content / parts / contentBlocks 里，尽力挖出来。 */function guessWbText(item) {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";

  for (const value of [item.text, item.content, item.body, item.message]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  const blockLists = [item.contentBlocks, item.blocks, item.parts, item.message?.contentBlocks, item.content?.blocks];
  for (const blocks of blockLists) {
    if (!Array.isArray(blocks)) continue;
    const text = blocks
      .map((block) => (block && typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) return text;
  }
  const deep = deepestText(item, 0);
  return deep;
}

function deepestText(node, depth) {
  if (depth > 5 || node === null || typeof node !== "object") return "";
  let best = "";
  for (const value of Object.values(node)) {
    if (typeof value === "string") {
      if (value.length > best.length) best = value;
    } else if (value && typeof value === "object") {
      const nested = deepestText(value, depth + 1);
      if (nested.length > best.length) best = nested;
    }
  }
  return best;
}

function shapeOf(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value !== "object") return typeof value;
  return `{${Object.keys(value).slice(0, 12).join(",")}}`;
}

function clip(text, max) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * 把宿主返回原样打包给面板。
 *
 * 走一趟 JSON 序列化有两个目的：① 丢掉 class / undefined / 函数这类结构化克隆
 * 会直接抛错的成员；② 量一下真实体积。宿主返回过整段会话正文，20 万字符够看了，
 * 再大就截断并告诉调用方「这不是全部」。
 */
function packHostResult(value) {
  if (value === undefined) return { value: null, truncated: false, bytes: 0 };
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) return { value: null, truncated: false, bytes: 0 };
  if (text.length > HOST_RESULT_LIMIT) {
    return { value: `${text.slice(0, HOST_RESULT_LIMIT)}…`, truncated: true, bytes: text.length };
  }
  try {
    return { value: JSON.parse(text), truncated: false, bytes: text.length };
  } catch {
    return { value: text, truncated: false, bytes: text.length };
  }
}

module.exports = { activate, VERSION, flattenWbRequests, wbMessageText };
