"use strict";

/**
 * WorkBuddy 桌面端会话的本地读取器。
 *
 * 为什么需要它：宿主的 `wb:conversations:requests` 只对「已经载入当前运行时」的会话有内容，
 * 客户端重启后缓存清空，旧会话读回来就是 0 条。而桌面端真正的会话记录一直在磁盘上：
 *
 *   ~/.workbuddy/projects/<项目编码>/<sessionId>.jsonl
 *
 * 所以面板要「看得到桌面端的 Session」，只能自己扫这个目录。
 * 这也解释了为什么以前面板只列得出云端那批（数字 ID），看不到本机的 UUID 会话。
 */

const fs = require("node:fs");
const path = require("node:path");
const { wbHome } = require("./local.cjs");
const { readHead, clip, blocksToText, decodeProjectDir, HEAD_BYTES } = require("./session-utils.cjs");

/** 宿主每轮会把这些内容当 user 消息写进记录，必须和真人发言区分开 */
const INJECT_HEADS = [
  "<system-reminder",
  "<identity_context",
  "<craft_mode>",
  "Current runtime context",
  "Time sampled while",
];

/** 只读文件头部：标题、cwd、首条用户消息都在前几百 KB，没必要把 6MB 全读进来 */

function projectsRoot() {
  return path.join(wbHome(), "projects");
}

function looksInjected(raw) {
  const text = String(raw || "").trimStart();
  return INJECT_HEADS.some((head) => text.startsWith(head));
}

/** 一条「用户」记录可能是纯注入，也可能是注入 + <user_query> 里包着的真问题 */
function extractUserText(raw) {
  const text = String(raw || "");
  const queried = text.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (queried && queried[1].trim()) return { text: queried[1].trim(), injected: false };
  if (looksInjected(text)) return { text: "", injected: true };
  return { text: text.trim(), injected: false };
}

/** WorkBuddy 的记录开头常有一大段宿主注入，标题要多读一点才够 */
const WB_HEAD_BYTES = 400 * 1024;

function scanFile(file, project) {
  const stat = fs.statSync(file);
  const head = readHead(file, WB_HEAD_BYTES);
  let title = "";
  let cwd = "";
  let createdAt = 0;
  let firstUser = "";

  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && entry.cwd) cwd = String(entry.cwd);
    if (!createdAt && entry.type === "session-meta") createdAt = Number(entry.timestamp) || 0;
    if (!title && entry.type === "ai-title" && entry.aiTitle) title = String(entry.aiTitle);
    if (!firstUser && entry.type === "message" && entry.role === "user") {
      const parsed = extractUserText(blocksToText(entry.content, ["input_text", "text"]));
      if (!parsed.injected && parsed.text) firstUser = parsed.text;
    }
    if (title && cwd && firstUser) break;
  }

  return {
    id: path.basename(file, ".jsonl"),
    title: title || clip(firstUser, 40) || "(无标题)",
    cwd: cwd || decodeProjectDir(project),
    project,
    createdAt: createdAt || Number(stat.birthtimeMs) || Number(stat.mtimeMs) || 0,
    updatedAt: Number(stat.mtimeMs) || 0,
    size: Number(stat.size) || 0,
    source: "local",
  };
}

/** 按最近修改排序的桌面端会话。读不动的文件跳过，不因为一条坏记录连累整个列表。 */
function listLocalSessions(options = {}) {
  const root = projectsRoot();
  if (!fs.existsSync(root)) return [];
  const rows = [];

  let projects = [];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return [];
  }

  for (const project of projects) {
    const dir = path.join(root, project);
    let stat = null;
    try {
      stat = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue; // .file-rollback.ndjson 不算会话
      try {
        rows.push(scanFile(path.join(dir, name), project));
      } catch {
        /* 正在写、被占用、权限不足——跳过 */
      }
    }
  }

  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  const limit = Number(options.limit || 0);
  return limit > 0 ? rows.slice(0, limit) : rows;
}

function findSessionFile(id) {
  if (!/^[\w.-]{1,120}$/.test(String(id || ""))) return null;
  const root = projectsRoot();
  if (!fs.existsSync(root)) return null;
  let projects = [];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const project of projects) {
    const file = path.join(root, project, `${id}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * 完整读一条桌面端会话。宿主运行时里没有的旧会话，面板靠这个显示内容。
 * 返回结构和 requestsWb 摊平后一致：{index, role, text, time}。
 */
function readLocalSession(id, options = {}) {
  const file = findSessionFile(id);
  if (!file) return { ok: true, found: false, conversationId: id, messages: [], total: 0 };

  const raw = fs.readFileSync(file, "utf8");
  const messages = [];
  let title = "";
  let cwd = "";

  /* 记录里每一「步」助手输出都是一条独立 message，一轮对话能拆成十几条。
     面板按气泡渲染，必须把连续的助手记录并回一个气泡，否则满屏碎片。 */
  const push = (role, text, time) => {
    const last = messages[messages.length - 1];
    if (role === "assistant" && last && last.role === "assistant") {
      last.text = `${last.text}\n\n${text}`;
      if (time) last.time = time;
      return;
    }
    messages.push({ role, text, time });
  };

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && entry.cwd) cwd = String(entry.cwd);
    if (entry.type === "ai-title" && entry.aiTitle) title = String(entry.aiTitle);
    if (entry.type !== "message") continue;

    if (entry.role === "user") {
      const parsed = extractUserText(blocksToText(entry.content, ["input_text", "text"]));
      if (parsed.text && !parsed.injected) {
        push("user", parsed.text, Number(entry.timestamp) || 0);
      }
      continue;
    }
    if (entry.role === "assistant") {
      const text =
        blocksToText(entry.content, ["output_text", "text"]) ||
        blocksToText(entry.message && entry.message.content, ["output_text", "text"]);
      if (text.trim()) {
        push("assistant", text.trim(), Number(entry.timestamp) || 0);
      }
    }
  }

  const limit = Number(options.limit || 0);
  const tail = limit > 0 ? messages.slice(-limit) : messages;
  return {
    ok: true,
    found: true,
    conversationId: id,
    title: title || "(无标题)",
    cwd: cwd || decodeProjectDir(path.basename(path.dirname(file))),
    total: messages.length,
    messages: tail.map((item, index) => ({ index, ...item })),
  };
}

module.exports = { listLocalSessions, readLocalSession, projectsRoot, decodeProjectDir };
