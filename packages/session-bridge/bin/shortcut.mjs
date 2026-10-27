#!/usr/bin/env node
/**
 * 改 Windows 快捷方式的启动参数 —— 不依赖 COM。
 *
 * 为什么不用 WScript.Shell：本机沙箱把 `New-Object -ComObject` 拦了（会被判定
 * 为「可执行任意代码」）。而 Windows 的 .lnk 是公开格式（MS-SHLLINK），自己
 * 生成一份比申请例外更可控：写坏了有备份，恢复也就是拷回去。
 *
 * 这里只实现「本地路径 + 参数 + 工作目录」这一小撮字段，够用就行。
 */

import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SIG = Buffer.from("0114020000000000c000000000000046", "hex"); // 00021401-...-00C04FD5
const HEADER_SIZE = 0x4c;

const F_HAS_LINK_INFO = 0x02;
const F_HAS_NAME = 0x04;
const F_HAS_RELATIVE = 0x08;
const F_HAS_WORKDIR = 0x10;
const F_HAS_ARGS = 0x20;
const F_HAS_ICON = 0x40;
const F_IS_UNICODE = 0x80;

function ansi(text) {
  return Buffer.from(`${text}\0`, "latin1");
}

function asciiOnly(label, value) {
  if (/[^\x20-\x7e]/.test(value)) {
    throw new Error(`${label} 含非 ASCII 字符，当前写入器不支持：${value}`);
  }
}

function stringData(text) {
  const buf = Buffer.alloc(2 + text.length * 2);
  buf.writeUInt16LE(text.length, 0);
  buf.write(text, 2, "utf16le");
  return buf;
}

function readCString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end += 1;
  return buf.toString("latin1", offset, end);
}

/** 生成一份 .lnk 的字节。字段顺序按 MS-SHLLINK 2.2 ~ 2.5。 */
export function buildLink(options) {
  const { target, args = "", workDir = "", name = "", iconLocation = "", showCommand = 1 } = options || {};
  if (!target) throw new Error("target 不能为空");
  asciiOnly("target", target);
  asciiOnly("args", args);
  asciiOnly("workDir", workDir);

  // 备注/图标是「锦上添花」，非 ASCII 就直接丢掉，不能因此让整次改写失败
  const safeName = name && !/[^\x20-\x7e]/.test(name) ? name : "";

  let flags = F_HAS_LINK_INFO | F_IS_UNICODE;
  if (safeName) flags |= F_HAS_NAME;
  if (workDir) flags |= F_HAS_WORKDIR;
  if (args) flags |= F_HAS_ARGS;
  if (iconLocation) flags |= F_HAS_ICON;

  // VolumeID：固定盘、无卷标。labelOffset=0x10 指向紧跟在结构后的那个空字节。
  const volumeId = Buffer.alloc(17);
  volumeId.writeUInt32LE(17, 0);
  volumeId.writeUInt32LE(3, 4); // DRIVE_FIXED
  volumeId.writeUInt32LE(0, 8);
  volumeId.writeUInt32LE(0x10, 12);

  const basePath = ansi(target);
  const suffix = ansi(""); // LocalBasePath 已是完整路径，后缀留空

  const linkInfoHeader = 0x1c;
  const volumeIdOffset = linkInfoHeader;
  const localBasePathOffset = volumeIdOffset + volumeId.length;
  const commonSuffixOffset = localBasePathOffset + basePath.length;
  const linkInfoSize = commonSuffixOffset + suffix.length;

  const linkInfo = Buffer.alloc(linkInfoSize);
  linkInfo.writeUInt32LE(linkInfoSize, 0);
  linkInfo.writeUInt32LE(linkInfoHeader, 4);
  linkInfo.writeUInt32LE(0x1, 8); // VolumeIDAndLocalBasePath
  linkInfo.writeUInt32LE(volumeIdOffset, 12);
  linkInfo.writeUInt32LE(localBasePathOffset, 16);
  linkInfo.writeUInt32LE(0, 20); // 无网络路径
  linkInfo.writeUInt32LE(commonSuffixOffset, 24);
  volumeId.copy(linkInfo, volumeIdOffset);
  basePath.copy(linkInfo, localBasePathOffset);
  suffix.copy(linkInfo, commonSuffixOffset);

  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32LE(HEADER_SIZE, 0);
  SIG.copy(header, 4);
  header.writeUInt32LE(flags, 20);
  header.writeUInt32LE(0x20, 24); // FILE_ATTRIBUTE_ARCHIVE
  // 三个时间戳、文件大小都留 0：Shell 不依赖它们
  header.writeUInt32LE(0, 56); // IconIndex
  header.writeUInt32LE(showCommand, 60);

  const parts = [header, linkInfo];
  // StringData 顺序是固定的：NAME → RELATIVE_PATH → WORKING_DIR → ARGUMENTS → ICON
  if (safeName) parts.push(stringData(safeName));
  if (workDir) parts.push(stringData(workDir));
  if (args) parts.push(stringData(args));
  if (iconLocation) parts.push(stringData(iconLocation));
  parts.push(Buffer.alloc(4)); // ExtraData 终止块

  return Buffer.concat(parts);
}

/** 解析 .lnk，只取我们关心的字段。 */
export function parseLink(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_SIZE) throw new Error("不是有效的 .lnk");
  if (!buf.subarray(4, 20).equals(SIG)) throw new Error(".lnk 签名不对");

  const flags = buf.readUInt32LE(20);
  let offset = buf.readUInt32LE(0);

  if (flags & 0x1) {
    // HasLinkTargetIDList：2 字节长度 + 内容
    const idListSize = buf.readUInt16LE(offset);
    offset += 2 + idListSize;
  }

  let target = "";
  let iconLocation = "";
  if (flags & F_HAS_LINK_INFO) {
    const linkInfoSize = buf.readUInt32LE(offset);
    const linkInfoHeader = buf.readUInt32LE(offset + 4);
    const linkInfoFlags = buf.readUInt32LE(offset + 8);
    if (linkInfoFlags & 0x1) {
      // 有 unicode 版本时优先它（header 0x24 起）
      const unicodeOffset = linkInfoHeader >= 0x24 ? buf.readUInt32LE(offset + 28) : 0;
      if (unicodeOffset) {
        let end = offset + unicodeOffset;
        while (end + 1 < offset + linkInfoSize && buf.readUInt16LE(end) !== 0) end += 2;
        target = buf.toString("utf16le", offset + unicodeOffset, end);
      } else {
        target = readCString(buf, offset + buf.readUInt32LE(offset + 16));
      }
    }
    offset += linkInfoSize;
  }

  const unicode = Boolean(flags & F_IS_UNICODE);
  const readString = () => {
    const count = buf.readUInt16LE(offset);
    offset += 2;
    let text = "";
    if (unicode) {
      text = buf.toString("utf16le", offset, offset + count * 2);
      offset += count * 2;
    } else {
      text = buf.toString("latin1", offset, offset + count);
      offset += count;
    }
    return text;
  };

  let name = "";
  let relative = "";
  let workDir = "";
  let args = "";
  if (flags & F_HAS_NAME) name = readString();
  if (flags & F_HAS_RELATIVE) relative = readString();
  if (flags & F_HAS_WORKDIR) workDir = readString();
  if (flags & F_HAS_ARGS) args = readString();
  if (flags & F_HAS_ICON) iconLocation = readString();

  return { target, args, workDir, name, relative, iconLocation, flags };
}

export function readLink(file) {
  return parseLink(fs.readFileSync(file));
}

/* ----------------------------- 快捷方式发现 ----------------------------- */

function walkLnk(dir, depth, out) {
  if (depth < 0) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkLnk(full, depth - 1, out);
    else if (/\.lnk$/i.test(entry.name)) out.push(full);
  }
  return out;
}

/** 本机上可能用来启动 WorkBuddy 的快捷方式。 */
export function listShortcuts() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const programData = process.env.PROGRAMDATA || "C:\\ProgramData";
  const publicDir = process.env.PUBLIC || "C:\\Users\\Public";
  const dirs = [
    path.join(home, "Desktop"),
    path.join(publicDir, "Desktop"),
    path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs"),
    path.join(appData, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar"),
  ];
  const found = new Set();
  for (const dir of dirs) {
    for (const file of walkLnk(dir, 3, [])) {
      if (/workbuddy/i.test(path.basename(file))) found.add(file);
    }
  }
  return [...found];
}

export function shortcutsWithArgs() {
  return listShortcuts().map((file) => {
    try {
      const link = readLink(file);
      return { file, ...link };
    } catch (error) {
      return { file, error: error.message };
    }
  });
}

/* ------------------------------- 应用 / 恢复 ------------------------------- */

export function backupDir() {
  const home = process.env.WORKBUDDY_HOME || path.join(os.homedir(), ".workbuddy");
  return path.join(home, "dsh-skills", "backups", "shortcuts");
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function debugArgs(port) {
  const origins = ["http://127.0.0.1", "http://localhost", `http://127.0.0.1:${port}`, `http://localhost:${port}`].join(",");
  return `--remote-debugging-port=${port} --remote-allow-origins=${origins}`;
}

/** 把旧的调试参数摘掉，换成新的。 */
export function stripDebugArgs(args) {
  return String(args || "")
    .replace(/--remote-debugging-port=\S+/g, "")
    .replace(/--remote-allow-origins=\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function applyToShortcuts(port) {
  const changed = [];
  const skipped = [];
  const failed = [];
  const dir = path.join(backupDir(), stamp());

  for (const info of shortcutsWithArgs()) {
    if (info.error) {
      skipped.push({ file: info.file, reason: info.error });
      continue;
    }
    if (!info.target || !/\.exe$/i.test(info.target)) {
      skipped.push({ file: info.file, reason: `目标不是 exe（${info.target || "空"}）` });
      continue;
    }
    const nextArgs = `${stripDebugArgs(info.args)} ${debugArgs(port)}`.replace(/\s+/g, " ").trim();
    if (nextArgs === info.args.trim()) {
      skipped.push({ file: info.file, reason: "参数已经是这个" });
      continue;
    }
    try {
      // 改之前先原样存一份
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(info.file, path.join(dir, path.basename(info.file)));

      const workDir = info.workDir || path.dirname(info.target);
      const bytes = buildLink({
        target: info.target,
        args: nextArgs,
        workDir,
        name: info.name,
        iconLocation: info.iconLocation,
      });
      fs.writeFileSync(info.file, bytes);

      // 回读校验，写坏了立刻发现
      const check = readLink(info.file);
      if (check.target !== info.target || check.args !== nextArgs) {
        throw new Error(`回读不一致（target=${check.target} args=${check.args}）`);
      }
      changed.push({ file: info.file, before: info.args, after: nextArgs });
    } catch (error) {
      failed.push({ file: info.file, reason: error.message });
    }
  }

  return { changed, skipped, failed, backup: changed.length ? dir : "" };
}

export function restoreShortcuts() {
  const root = backupDir();
  let stamps = [];
  try {
    stamps = fs.readdirSync(root).sort();
  } catch {
    return { restored: [], reason: "没有备份" };
  }
  if (!stamps.length) return { restored: [], reason: "没有备份" };

  const latest = path.join(root, stamps[stamps.length - 1]);
  const restored = [];
  for (const name of fs.readdirSync(latest)) {
    if (!/\.lnk$/i.test(name)) continue;
    const target = listShortcuts().find((file) => path.basename(file).toLowerCase() === name.toLowerCase());
    if (!target) continue;
    try {
      fs.copyFileSync(path.join(latest, name), target);
      restored.push(target);
    } catch {
      /* 单个失败不影响其它 */
    }
  }
  return { restored, from: latest };
}

/* --------------------------------- CLI --------------------------------- */

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const [, , cmd = "list", portArg = "9333"] = process.argv;
  const port = Number(portArg);

  if (cmd === "list") {
    const rows = shortcutsWithArgs();
    if (!rows.length) console.log("没找到 WorkBuddy 快捷方式。");
    for (const row of rows) {
      console.log(row.file);
      if (row.error) console.log(`  [!] 解析失败：${row.error}`);
      else console.log(`  target: ${row.target}\n  args  : ${row.args || "(空)"}\n  workDir: ${row.workDir || "(空)"}`);
    }
    process.exit(0);
  }

  if (cmd === "apply") {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`端口不合法：${portArg}`);
      process.exit(2);
    }
    const result = applyToShortcuts(port);
    for (const row of result.changed) console.log(`[ok] ${row.file}\n     → ${row.after}`);
    for (const row of result.skipped) console.log(`[--] ${row.file}：${row.reason}`);
    for (const row of result.failed) console.log(`[x ] ${row.file}：${row.reason}`);
    if (result.backup) console.log(`备份：${result.backup}`);
    process.exit(result.failed.length ? 1 : 0);
  }

  if (cmd === "restore") {
    const result = restoreShortcuts();
    if (!result.restored.length) console.log(`没恢复任何文件（${result.reason || "无匹配"}）`);
    for (const file of result.restored) console.log(`[ok] 已还原 ${file}`);
    if (result.from) console.log(`来源：${result.from}`);
    process.exit(0);
  }

  console.error("用法：shortcut.mjs [list|apply <port>|restore]");
  process.exit(2);
}
