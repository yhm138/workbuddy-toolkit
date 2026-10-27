"use strict";

/**
 * 本地其他 harness 的会话读取器：Codex、Claude。
 *
 * 会话桥原来只认两家：DSH（走 MCP）和 WorkBuddy（走宿主通道 + 本地 jsonl）。
 * 但「我这台机器上跟 agent 聊过什么」其实散在好几个目录里：
 *
 *   WorkBuddy  ~/.workbuddy/projects/<项目编码>/<uuid>.jsonl
 *   Codex      ~/.codex/sessions/<年>/<月>/<日>/rollout-<时间>-<uuid>.jsonl
 *   Claude     ~/.claude/projects/<项目编码>/<uuid>.jsonl
 *
 * 这里把后两者读出来，做成只读来源。之所以只读：它们的写入通道要么是私有 IPC、
 * 要么要跑 CLI 起新进程，硬塞消息容易把对方的会话状态搞坏——看得到、复制得了，就够了。
 *
 * 记录格式差异很大，所以每个 harness 一个适配器，对外统一成：
 *   list({limit}) -> [{id,title,cwd,project,createdAt,updatedAt,size,harness}]
 *   read(id,{limit}) -> {found,title,cwd,total,messages:[{index,role,text,time}]}
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readHead, clip, blocksToText, decodeProjectDir, walkFiles, scanCached, eachLine } = require("./session-utils.cjs");

/* ============================================================
 * Codex
 * ============================================================ */

/** 一次最多解析多少个记录文件（按 mtime 取最近的） */
const SCAN_MAX = 400;

/** 宿主注入给模型的上下文，role 也是 user，但不是人说的话 */
const CODEX_INJECT_HEADS = [
  "<environment_context",
  "<external_codex_apps_open_page",
  "<subagent_notification",
  "<send_user_message_question",
  "<recommended_plugins",
  "<user_instructions",
  "<turn_aborted",
  "# AGENTS.md instructions",
  "# Files mentioned by the user",
  "# Files pasted by the user",
];

/**
 * Codex 把「用户附了文件」包装成一整段：文件内容在 `# Files mentioned by the user` 下面，
 * 真问题在 `## My request:` 之后。整段直接展示会把几十 KB 的附件糊在对话里。
 */
function cleanCodexUser(raw) {
  const text = String(raw || "");
  const asked = text.match(/##\s*My request[^\n]*\n([\s\S]*)$/i);
  if (asked && asked[1].trim()) return asked[1].trim();
  const head = text.trimStart();
  if (CODEX_INJECT_HEADS.some((prefix) => head.startsWith(prefix))) return "";
  return text.trim();
}

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function codexIdFromFile(file) {
  const base = path.basename(file, ".jsonl");
  const uuid = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return uuid ? uuid[1] : base;
}

function codexFiles() {
  return walkFiles(path.join(codexHome(), "sessions"), { prefix: "rollout-" });
}

/** 只读头部：session_meta 给 cwd / 创建时间，第一条真实用户消息当标题 */
function codexMeta(file, size, mtime) {
  return scanCached(file, size, mtime, () => {
    let cwd = "";
    let createdAt = 0;
    let title = "";
    let model = "";
    let agent = "";
    let parent = "";
    try {
      eachLine(readHead(file), (entry) => {
        if (entry.type === "session_meta" && entry.payload) {
          const meta = entry.payload;
          if (!cwd && meta.cwd) cwd = String(meta.cwd);
          if (!createdAt) createdAt = Date.parse(meta.timestamp || "") || 0;
          if (!model && meta.model_provider) model = String(meta.model_provider);
          if (!agent && meta.agent_nickname) agent = String(meta.agent_nickname);
          if (!parent && meta.parent_thread_id) parent = String(meta.parent_thread_id);
          return;
        }
        if (!title && entry.type === "response_item" && entry.payload && entry.payload.type === "message") {
          if (entry.payload.role !== "user") return;
          const text = cleanCodexUser(blocksToText(entry.payload.content, ["input_text", "output_text", "text"]));
          if (text) title = text;
        }
      });
    } catch {
      /* 正在写 / 被占用：当作空记录 */
    }
    return { cwd, createdAt, title, model, agent, parent };
  });
}

const codex = {
  id: "codex",
  label: "Codex",
  readOnly: true,
  home: codexHome,
  resumePrefix: "codex resume",

  available() {
    try {
      return fs.statSync(path.join(codexHome(), "sessions")).isDirectory();
    } catch {
      return false;
    }
  },

  count() {
    return codexFiles().length;
  },

  list(options = {}) {
    const limit = Math.max(0, Number(options.limit) || 0);
    const includeSub = Boolean(options.includeSubagents);
    /* 不能先按 mtime 截一刀再过滤：最近的几百个 rollout 几乎全是子 agent，
       截完就只剩几条主线程。改成边扫边收，凑够 limit 条可见的就停。 */
    const rows = [];
    let hidden = 0;
    let scanned = 0;
    for (const item of codexFiles()) {
      if (limit > 0 && rows.length >= limit) break;
      if (scanned >= SCAN_MAX) break;
      scanned += 1;
      const meta = codexMeta(item.file, item.size, item.mtime);
      const subagent = Boolean(meta.parent);
      if (subagent && !includeSub) {
        hidden += 1;
        continue;
      }
      rows.push({
        id: codexIdFromFile(item.file),
        title: clip(meta.title, 44) || (subagent ? `子 agent · ${meta.agent || "未命名"}` : "(无标题)"),
        cwd: meta.cwd,
        project: path.basename(path.dirname(item.file)),
        harness: "codex",
        model: meta.model,
        agent: meta.agent,
        subagent,
        createdAt: meta.createdAt || item.mtime,
        updatedAt: item.mtime,
        size: item.size,
        file: item.file,
      });
    }
    return { rows, total: rows.length, hidden, scanned };
  },

  read(id, options = {}) {
    const wanted = String(id || "");
    const hit = codexFiles().find((item) => codexIdFromFile(item.file) === wanted);
    if (!hit) return { ok: true, found: false, messages: [], total: 0, harness: "codex" };

    let cwd = "";
    let createdAt = 0;
    let title = "";
    const messages = [];
    const push = (role, text, time) => {
      const last = messages[messages.length - 1];
      /* 记录里助手每「步」都是一条独立 message，不合并的话一轮对话碎成十几段 */
      if (role === "assistant" && last && last.role === "assistant") {
        last.text = `${last.text}\n\n${text}`;
        if (time) last.time = time;
        return;
      }
      messages.push({ role, text, time });
    };

    eachLine(fs.readFileSync(hit.file, "utf8"), (entry) => {
      if (entry.type === "session_meta" && entry.payload) {
        if (!cwd && entry.payload.cwd) cwd = String(entry.payload.cwd);
        if (!createdAt) createdAt = Date.parse(entry.payload.timestamp || "") || 0;
        return;
      }
      if (entry.type !== "response_item") return;
      const payload = entry.payload;
      if (!payload || payload.type !== "message") return;
      const role = payload.role === "assistant" ? "assistant" : payload.role === "user" ? "user" : null;
      if (!role) return; // developer / system 是提示词，不是对话
      let text = blocksToText(payload.content, ["input_text", "output_text", "text"]);
      if (role === "user") {
        text = cleanCodexUser(text);
        if (!text) return;
      }
      if (!text.trim()) return;
      if (role === "user" && !title) title = text;
      push(role, text.trim(), Date.parse(entry.timestamp || "") || createdAt);
    });

    const limit = Number(options.limit || 0);
    const tail = limit > 0 ? messages.slice(-limit) : messages;
    return {
      ok: true,
      found: true,
      harness: "codex",
      conversationId: wanted,
      title: clip(title, 44) || "(无标题)",
      cwd,
      file: hit.file,
      total: messages.length,
      messages: tail.map((item, index) => ({ index, ...item })),
    };
  },
};

/* ============================================================
 * Claude（Claude Desktop 的 Code tab / Claude Code 走同一套本地记录）
 * ============================================================ */

const CLAUDE_INJECT_HEADS = [
  "<system-reminder",
  "<task-notification",
  "<local-command-caveat",
  "<local-command-stdout",
  "<command-name",
  "<command-args",
  "<identity_context",
  "<user-prompt-submit-hook",
  "Another Claude session sent",
  "Caveat: The messages below",
];

function cleanClaudeUser(raw) {
  const text = String(raw || "");
  const head = text.trimStart();
  if (CLAUDE_INJECT_HEADS.some((prefix) => head.startsWith(prefix))) return "";
  if (head.startsWith("[Request interrupted by user")) return "";
  return text.trim();
}

/** 标题里不希望带 `<pasted_content id="f2d4">` 这种包装 */
function stripWrappers(text) {
  return String(text || "")
    .replace(/^\s*<pasted_content[^>]*>/i, "")
    .replace(/<\/pasted_content>\s*$/i, "")
    .replace(/^\s*<uploaded_files>[\s\S]*?<\/uploaded_files>/i, "")
    .trim();
}

function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function claudeFiles() {
  return walkFiles(path.join(claudeHome(), "projects"));
}

function claudeMeta(file, size, mtime) {
  return scanCached(file, size, mtime, () => {
    let cwd = "";
    let createdAt = 0;
    let title = "";
    try {
      eachLine(readHead(file), (entry) => {
        if (!cwd && entry.cwd) cwd = String(entry.cwd);
        if (!createdAt) createdAt = Date.parse(entry.timestamp || "") || 0;
        if (entry.type === "custom-title" && entry.customTitle) title = String(entry.customTitle);
        if (!title && entry.type === "user" && !entry.isSidechain) {
          const content = entry.message && entry.message.content;
          const text = typeof content === "string" ? cleanClaudeUser(content) : "";
          if (text) title = stripWrappers(text);
        }
      });
    } catch {
      /* 忽略坏文件 */
    }
    return { cwd, createdAt, title };
  });
}

const claude = {
  id: "claude",
  label: "Claude",
  readOnly: true,
  home: claudeHome,
  resumePrefix: "claude --resume",

  available() {
    try {
      return fs.statSync(path.join(claudeHome(), "projects")).isDirectory();
    } catch {
      return false;
    }
  },

  count() {
    return claudeFiles().length;
  },

  list(options = {}) {
    const limit = Math.max(0, Number(options.limit) || 0);
    const rows = [];
    let scanned = 0;
    for (const item of claudeFiles()) {
      if (limit > 0 && rows.length >= limit) break;
      if (scanned >= SCAN_MAX) break;
      scanned += 1;
      const meta = claudeMeta(item.file, item.size, item.mtime);
      const project = path.basename(path.dirname(item.file));
      rows.push({
        id: path.basename(item.file, ".jsonl"),
        title: clip(meta.title, 44) || "(无标题)",
        cwd: meta.cwd,
        project,
        harness: "claude",
        createdAt: meta.createdAt || item.mtime,
        updatedAt: item.mtime,
        size: item.size,
        file: item.file,
      });
    }
    return { rows, total: rows.length, hidden: 0, scanned };
  },

  read(id, options = {}) {
    const wanted = String(id || "");
    if (!/^[\w.-]{1,120}$/.test(wanted)) {
      return { ok: true, found: false, messages: [], total: 0, harness: "claude" };
    }
    const hit = claudeFiles().find((item) => path.basename(item.file, ".jsonl") === wanted);
    if (!hit) return { ok: true, found: false, messages: [], total: 0, harness: "claude" };

    let cwd = "";
    let title = "";
    let createdAt = 0;
    const messages = [];
    const push = (role, text, time) => {
      const last = messages[messages.length - 1];
      if (role === "assistant" && last && last.role === "assistant") {
        last.text = `${last.text}\n\n${text}`;
        if (time) last.time = time;
        return;
      }
      messages.push({ role, text, time });
    };

    eachLine(fs.readFileSync(hit.file, "utf8"), (entry) => {
      if (!cwd && entry.cwd) cwd = String(entry.cwd);
      if (!createdAt) createdAt = Date.parse(entry.timestamp || "") || 0;
      if (entry.type === "custom-title" && entry.customTitle) title = String(entry.customTitle);
      if (entry.isSidechain) return; // 子 agent 的分支，混进主对话会乱
      if (entry.type !== "user" && entry.type !== "assistant") return;

      const content = entry.message && entry.message.content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter((block) => block && block.type === "text")
          .map((block) => String(block.text || ""))
          .join("");
      }
      if (!text.trim()) return; // tool_result 之类的块，不是对话

      const time = Date.parse(entry.timestamp || "") || createdAt;
      if (entry.type === "user") {
        const cleaned = cleanClaudeUser(text);
        if (!cleaned) return;
        if (!title) title = stripWrappers(cleaned);
        push("user", cleaned, time);
      } else {
        push("assistant", text.trim(), time);
      }
    });

    const limit = Number(options.limit || 0);
    const tail = limit > 0 ? messages.slice(-limit) : messages;
    return {
      ok: true,
      found: true,
      harness: "claude",
      conversationId: wanted,
      title: clip(title, 44) || "(无标题)",
      cwd,
      file: hit.file,
      total: messages.length,
      messages: tail.map((item, index) => ({ index, ...item })),
    };
  },
};

/* ============================================================
 * 注册表
 * ============================================================ */

const ADAPTERS = [codex, claude];

function getHarness(id) {
  return ADAPTERS.find((item) => item.id === String(id || "")) || null;
}

/** 面板启动时问一次：这台机器上装了谁、各有多少条会话 */
function describe() {
  return ADAPTERS.map((adapter) => {
    const available = adapter.available();
    let count = 0;
    let error = "";
    if (available) {
      try {
        count = adapter.count();
      } catch (e) {
        error = e.message;
      }
    }
    return {
      id: adapter.id,
      label: adapter.label,
      readOnly: adapter.readOnly,
      available,
      count,
      home: adapter.home(),
      resumePrefix: adapter.resumePrefix || "",
      error,
    };
  });
}

module.exports = { getHarness, describe, ADAPTERS, codex, claude, cleanCodexUser, cleanClaudeUser };
