/**
 * 找 WorkBuddy 装在哪、是不是在跑。
 *
 * 单独抽出来是因为三个地方都要用：安装器（setup.mjs）、旧开关（context-menu.mjs）、
 * 卸载器，逻辑不能各写一份——路径判断一旦分叉，就会出现「安装器说装了、开关说没装」。
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** 扩展只能放在这里，宿主只扫这一个目录（bundled 扩展免签名）。 */
export function extensionsDir(root) {
  return path.join(root, "resources", "app.asar.unpacked", "resources", "extensions");
}

/** 按「最可能命中」排序的候选安装目录。 */
export function candidateRoots(explicit = "") {
  const list = [];
  if (explicit) list.push(path.resolve(explicit));
  if (process.env.WORKBUDDY_ROOT) list.push(path.resolve(process.env.WORKBUDDY_ROOT));

  if (process.platform === "win32") {
    // 正在跑的客户端最准
    const running = runningExe();
    if (running) list.push(path.dirname(running));
    if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, "Programs", "WorkBuddy"));
    if (process.env.ProgramFiles) list.push(path.join(process.env.ProgramFiles, "WorkBuddy"));
    if (process.env["ProgramFiles(x86)"]) list.push(path.join(process.env["ProgramFiles(x86)"], "WorkBuddy"));
    list.push("D:/Software/WorkBuddy");
  } else if (process.platform === "darwin") {
    list.push("/Applications/WorkBuddy.app/Contents");
  }
  return [...new Set(list.filter(Boolean))];
}

/** 找到有 extensions 目录的那个根，找不到返回 null。 */
export function findRoot(explicit = "") {
  for (const root of candidateRoots(explicit)) {
    try {
      if (fs.existsSync(extensionsDir(root))) return root;
    } catch {
      /* 权限不足就当不存在 */
    }
  }
  return null;
}

/** 正在跑的 WorkBuddy.exe 的路径（没跑或读不到返回空串）。 */
export function runningExe() {
  if (process.platform !== "win32") return "";
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-Process WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)",
      ],
      { encoding: "utf8", timeout: 8000, windowsHide: true }
    ).trim();
    return out || "";
  } catch {
    return "";
  }
}

/** WorkBuddy.exe 的位置。 */
export function findExe(extra) {
  const candidates = [
    extra,
    process.env.WORKBUDDY_EXE,
    runningExe(),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "WorkBuddy", "WorkBuddy.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "WorkBuddy", "WorkBuddy.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "WorkBuddy", "WorkBuddy.exe"),
    "D:\\Software\\WorkBuddy\\WorkBuddy.exe",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* 路径非法就跳过 */
    }
  }
  return null;
}

/** 客户端是不是在运行。 */
export function clientRunning() {
  if (process.platform !== "win32") return false;
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq WorkBuddy.exe", "/NH"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    });
    return /WorkBuddy\.exe/i.test(out);
  } catch {
    return false;
  }
}

/** 版本号，读不到返回空串。只是用来提示「版本可能不匹配」，不做硬校验。 */
export function clientVersion(exe) {
  if (!exe) return "";
  try {
    const out = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`,
      ],
      { encoding: "utf8", timeout: 8000, windowsHide: true }
    ).trim();
    return out.split(/\r?\n/).pop().trim();
  } catch {
    return "";
  }
}
