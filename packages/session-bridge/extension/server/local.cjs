"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function expandHome(input) {
  if (!input) return input;
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function dshHome() {
  return expandHome(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"));
}

function wbHome() {
  return expandHome(process.env.WORKBUDDY_HOME || path.join(os.homedir(), ".workbuddy"));
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readDshToken() {
  try {
    return fs.readFileSync(path.join(dshHome(), "dsh-as-mcp", "token"), "utf8").trim();
  } catch {
    return "";
  }
}

function mcpEndpoint() {
  if (process.env.DSH_MCP_URL) return process.env.DSH_MCP_URL;
  const config = readJson(path.join(wbHome(), "mcp.json"), null);
  const entry = config?.mcpServers?.dsh_local;
  if (entry?.url) return entry.url;
  return "http://127.0.0.1:8790/mcp";
}

/** Titles/cwd live in the token-usage cache; the MCP session_list does not carry them. */
function sessionMeta() {
  return readJson(path.join(dshHome(), "token-usage", "sessions.json"), {}) || {};
}

function metaFor(meta, id) {
  return meta[id] || meta[`session-${id}`] || null;
}

/** Disk-only fallback: session ids and mtimes work even when DSH is not running. */
function historySessions(limit) {
  const root = path.join(dshHome(), "sessions");
  const meta = sessionMeta();
  const rows = [];
  if (!fs.existsSync(root)) return rows;

  for (const workspace of fs.readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = path.join(root, workspace.name);
    let entries = [];
    try {
      entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(workspaceDir, entry.name);
      let stat;
      try {
        stat = fs.statSync(dir);
      } catch {
        continue;
      }
      const info = metaFor(meta, entry.name);
      rows.push({
        id: entry.name,
        title: info?.title || "(历史会话)",
        cwd: info?.cwd || "",
        running: false,
        blank: false,
        updatedAt: stat.mtimeMs,
        source: "history",
      });
    }
  }
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows.slice(0, limit);
}

function clipboard(text) {
  const value = String(text ?? "");
  const candidates = {
    win32: [["clip"]],
    darwin: [["pbcopy"]],
    linux: [
      ["wl-copy"],
      ["xclip", ["-selection", "clipboard"]],
      ["xsel", ["--clipboard", "--input"]],
    ],
  }[process.platform] || [];

  for (const [command, argv = []] of candidates) {
    try {
      const result = spawnSync(command, argv, { input: value, encoding: "utf8", timeout: 3000 });
      if (result.status === 0) return { ok: true, method: command };
    } catch {
      // try the next provider
    }
  }
  // Git Bash / WSL can still reach the Windows clipboard.
  const clipExe = "/mnt/c/Windows/System32/clip.exe";
  if (process.platform !== "win32" && fs.existsSync(clipExe)) {
    try {
      const result = spawnSync(clipExe, [], { input: value, encoding: "utf8", timeout: 3000 });
      if (result.status === 0) return { ok: true, method: "clip.exe" };
    } catch {
      // fall through
    }
  }
  return { ok: false, method: null };
}

function unwrap(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if ("data" in payload && ("code" in payload || "msg" in payload || "message" in payload)) {
    return payload.data;
  }
  return payload;
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  clipboard,
  dshHome,
  historySessions,
  mcpEndpoint,
  numberOr,
  readDshToken,
  readJson,
  sessionMeta,
  unwrap,
  wbHome,
};
