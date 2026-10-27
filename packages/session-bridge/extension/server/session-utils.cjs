"use strict";

/**
 * 各家 harness 本地会话记录的公共读取工具。
 *
 * 为什么要抽出来：WorkBuddy / Codex / Claude 的记录格式各不相同，但「只读文件头」
 * 「按 mtime 排序」「把 content 块拼成文本」「把项目目录名还原成路径」这几件事是一样的。
 * 各写一份迟早会漂。
 */

const fs = require("node:fs");
const path = require("node:path");

/** 只读头部：标题、cwd、首条用户消息都在前面，没必要把几十 MB 的记录全读进来 */
const HEAD_BYTES = 96 * 1024;

/** 扫过的文件按 (size, mtime) 缓存解析结果，重复刷新不重复解析 */
const SCAN_CACHE = new Map();
const CACHE_MAX = 4000;

function readHead(file, maxBytes = HEAD_BYTES) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const want = Math.min(size, maxBytes);
    const buf = Buffer.alloc(want);
    fs.readSync(fd, buf, 0, want, 0);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function clip(text, max) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function blocksToText(content, kinds) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && (kinds.includes(part.type) || (!part.type && typeof part.text === "string")))
    .map((part) => String(part.text ?? ""))
    .join("");
}

/** `D--work-Foo` → `D:\work\Foo`（记录里没有 cwd 时的兜底展示） */
function decodeProjectDir(name) {
  if (!name) return "";
  const joined = name.replace(/-/g, "/");
  const withDrive = /^[a-zA-Z]\//.test(joined) ? `${joined[0].toUpperCase()}:${joined.slice(1)}` : joined;
  return withDrive.split("/").join(path.sep);
}

/** 递归收集文件，返回 [{file, mtime, size}]，按 mtime 倒序 */
function walkFiles(root, options = {}) {
  const { suffix = ".jsonl", maxDepth = 6, prefix = "" } = options;
  const out = [];
  if (!root) return out;

  const walk = (dir, depth) => {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1);
        continue;
      }
      if (!name.endsWith(suffix)) continue;
      if (prefix && !name.startsWith(prefix)) continue;
      out.push({ file: full, mtime: Number(stat.mtimeMs) || 0, size: Number(stat.size) || 0 });
    }
  };

  walk(root, 0);
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/**
 * 只解析文件头一次。同一个文件在当前进程里被反复列（每次刷新面板都列一遍）时，
 * 不缓存的话 300 多个会话文件每次都要重新读一遍头。
 */
function scanCached(file, size, mtime, build) {
  const key = `${file}:${size}:${mtime}`;
  const hit = SCAN_CACHE.get(key);
  if (hit) return hit;
  const value = build();
  if (SCAN_CACHE.size >= CACHE_MAX) SCAN_CACHE.clear();
  SCAN_CACHE.set(key, value);
  return value;
}

/** 逐行解析 JSON，坏行跳过（记录可能正在写） */
function eachLine(raw, fn) {
  for (const line of String(raw || "").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    fn(entry);
  }
}

module.exports = {
  HEAD_BYTES,
  readHead,
  clip,
  blocksToText,
  decodeProjectDir,
  walkFiles,
  scanCached,
  eachLine,
};
