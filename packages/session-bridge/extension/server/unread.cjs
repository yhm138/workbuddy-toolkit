"use strict";

/**
 * WorkBuddy 会话的未读标记（workbuddy.db 的 sessions.unread）。
 *
 * 为什么需要直写库：宿主 daemon 只注册了 `wb:conversations:markRead`，
 * 内部虽然还有 createConversationsApi().markUnread()（后台任务完成时自动用），
 * 但 MethodChannel 里根本没有 `wb:conversations:markUnread` 这个 handler
 * ——实测返回 `[MethodChannel] no handler for channel`。所以「标记未读」没有
 * 合法 IPC 可走，只能落到数据库；「标记已读」仍优先走宿主通道。
 *
 * 用 node:sqlite 的理由：extension service 是宿主 fork 的裸 Node 进程，
 * 装不了第三方依赖，也 require 不到 asar 里的 node_modules；Node 22 自带
 * DatabaseSync 够用。（会打一行 ExperimentalWarning，无害。）
 */

const fs = require("node:fs");
const path = require("node:path");

function dbFile(home) {
  return path.join(home, "workbuddy.db");
}

function openDb(file) {
  if (!fs.existsSync(file)) throw new Error(`找不到会话数据库：${file}`);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);
  // 宿主自己持有同一个库的连接，短事务 + busy timeout 避免撞上写锁
  db.exec("PRAGMA busy_timeout=5000");
  return db;
}

/** 批量读未读状态。查不到的 id 不出现在结果里（云端会话不在本库）。 */
function readUnread(home, ids) {
  const file = dbFile(home);
  if (!fs.existsSync(file)) return {};
  const wanted = [
    ...new Set(
      (Array.isArray(ids) ? ids : [])
        .filter((x) => typeof x === "string" && x.trim())
        .map((x) => String(x).trim())
        .slice(0, 400)
    ),
  ];
  if (!wanted.length) return {};

  const db = openDb(file);
  try {
    const placeholders = wanted.map(() => "?").join(",");
    const rows = db.prepare(`SELECT id, unread FROM sessions WHERE id IN (${placeholders})`).all(...wanted);
    const out = {};
    for (const row of rows) out[String(row.id)] = Number(row.unread) === 1;
    return out;
  } finally {
    db.close();
  }
}

/** 写一个会话的未读标记。返回 { ok, exists, changed, before, after }。 */
function setUnread(home, id, unread) {
  const file = dbFile(home);
  const db = openDb(file);
  try {
    const key = String(id);
    const row = db.prepare("SELECT unread FROM sessions WHERE id = ?").get(key);
    if (!row) return { ok: false, exists: false, changed: false, error: "会话不在本机 sessions 表里" };
    const result = db.prepare("UPDATE sessions SET unread = ? WHERE id = ?").run(unread ? 1 : 0, key);
    return {
      ok: true,
      exists: true,
      changed: Number(result.changes) > 0,
      before: Number(row.unread) === 1,
      after: Boolean(unread),
    };
  } finally {
    db.close();
  }
}

module.exports = { dbFile, openDb, readUnread, setUnread };
