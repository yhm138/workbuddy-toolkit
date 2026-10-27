"use strict";

/**
 * 把「复制 Session ID」注入到 WorkBuddy 主窗口的会话菜单里。
 *
 * 存在的理由：宿主扩展 manifest 没有菜单贡献点，会话菜单是 React 里硬编码的条件数组，
 * 官方没给插槽。唯一合法的入口是宿主自己留的调试通道——
 * 主进程启动时读 WORKBUDDY_REMOTE_DEBUGGING_PORT，设了就给 Chromium 开 remote-debugging-port。
 *
 * 行为约定：
 *   - 环境变量没设：整体休眠，一次网络请求都不发。
 *   - 端口开了但连不上：静默重试，只在状态翻转时记一行日志。
 *   - 注入失败绝不影响宿主，也不影响会话桥其它功能。
 */

const fs = require("node:fs");
const path = require("node:path");
const { CdpSocket, httpJson } = require("./cdp.cjs");

const POLL_IDLE_MS = 15000;
const POLL_ACTIVE_MS = 5000;
const LOG_LIMIT = 256 * 1024;
// 没启用时多久回看一眼配置文件（用户点「启用」后不必重启 service）
const RELOAD_MS = 20000;

function normalizePort(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d+$/.test(raw)) return 0;
  const port = Number(raw);
  return port > 0 && port < 65536 ? port : 0;
}

/**
 * 端口来源，按顺序：
 *   1. 环境变量 WORKBUDDY_REMOTE_DEBUGGING_PORT —— 客户端自己认这个
 *   2. ~/.workbuddy/dsh-skills/menu-inject.json —— 我们用 bin/context-menu.mjs 写的
 *
 * 为什么需要第 2 条：宿主的扩展 service 是 daemon 进程 fork 出来的，实测它
 * **拿不到**用户级环境变量（客户端主进程拿到了 9222，service 里 process.env 是空的）。
 * 所以不能只靠环境变量，否则永远 enabled=false。
 */
function readConfig(configFile) {
  if (!configFile) return null;
  try {
    const raw = fs.readFileSync(configFile, "utf8");
    const data = JSON.parse(raw);
    if (!data || data.enabled === false) return null;
    const port = normalizePort(data.port);
    return port ? { port, at: Number(data.at) || 0 } : null;
  } catch {
    return null;
  }
}

function defaultConfigFile(logFile) {
  const dir = logFile ? path.dirname(logFile) : path.join(require("node:os").homedir(), ".workbuddy", "dsh-skills");
  return path.join(dir, "menu-inject.json");
}

/** 返回 { port, source }，给注入器自己用。 */
function resolvePortInfo(configFile) {
  // 硬关闭开关：跑测试、或用户临时不想要注入时用，优先于环境变量与配置文件。
  if (String(process.env.WORKBUDDY_MENU_INJECT || "").toLowerCase() === "off") {
    return { port: 0, source: "off" };
  }
  const fromEnv = normalizePort(process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT);
  if (fromEnv) return { port: fromEnv, source: "env" };
  const cfg = readConfig(configFile);
  if (cfg) return { port: cfg.port, source: "config" };
  return { port: 0, source: "none" };
}

/** 只返回端口号（0 = 休眠），保持给测试用的简单签名。 */
function resolvePort(configFile) {
  return resolvePortInfo(configFile).port;
}

/**
 * 判断一个 CDP target 是不是 WorkBuddy 自己的窗口。
 * 打包后的渲染进程是 file://…/resources/app.asar/renderer/index.html，
 * 所以 app.asar 是最可靠的标志；开发模式下退到标题匹配。
 */
function isWorkBuddyTarget(target) {
  const url = String(target.url || "");
  if (/app\.asar/i.test(url)) return true;
  if (/^file:\/\//i.test(url) && /\/resources\//i.test(url)) return true;
  return /workbuddy/i.test(url) || /workbuddy/i.test(String(target.title || ""));
}

function loadSource() {
  const file = path.join(__dirname, "..", "inject", "session-menu.js");
  return fs.readFileSync(file, "utf8");
}

class MenuInjector {
  constructor(options = {}) {
    this.logFile = options.logFile || "";
    this.configFile = options.configFile || defaultConfigFile(this.logFile);
    const resolved = resolvePortInfo(this.configFile);
    this.port = resolved.port;
    this.portSource = resolved.source;
    this.source = "";
    this.timer = null;
    this.reloadTimer = null;
    this.running = false;
    this.sessions = new Map(); // targetId -> { socket, target }
    this.state = {
      enabled: this.port > 0,
      port: this.port,
      portSource: this.portSource,
      configFile: this.configFile,
      connected: 0,
      injected: 0,
      lastError: "",
      lastAt: 0,
      note: "",
      seen: [],
    };
    this.lastLoggedError = "";
    this.lastNote = "";
  }

  start() {
    if (this.running) return;
    if (!this.state.enabled) {
      // 没启用就每 20 秒看一眼配置文件；用户点了启用就能自己醒过来，不用重启 service。
      this.#scheduleReload();
      return;
    }
    try {
      this.source = loadSource();
    } catch (error) {
      this.state.lastError = `读不到注入脚本：${error.message}`;
      this.#log("error", this.state.lastError);
      return;
    }
    this.running = true;
    this.#log("info", `注入器启动，CDP 端口 ${this.port}（来源 ${this.portSource}）`);
    this.#poll();
  }

  #scheduleReload() {
    if (this.reloadTimer) return;
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      const resolved = resolvePortInfo(this.configFile);
      if (!resolved.port) {
        this.#scheduleReload();
        return;
      }
      this.port = resolved.port;
      this.portSource = resolved.source;
      this.state.enabled = true;
      this.state.port = this.port;
      this.state.portSource = this.portSource;
      this.start();
    }, RELOAD_MS);
    this.reloadTimer.unref?.();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    for (const [, session] of this.sessions) {
      try {
        session.socket.close();
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear();
    this.state.connected = 0;
  }

  status() {
    return { ...this.state, running: this.running };
  }

  async #poll() {
    if (!this.running) return;
    let delay = POLL_ACTIVE_MS;
    try {
      const targets = await this.#listTargets();
      if (!targets.length) {
        delay = POLL_IDLE_MS;
      }
      await this.#sync(targets);
      if (this.state.note && this.lastNote !== this.state.note) {
        this.lastNote = this.state.note;
        this.#log("warn", this.state.note);
      } else if (!this.state.note) {
        this.lastNote = "";
      }
      this.state.lastError = "";
      this.lastLoggedError = "";
    } catch (error) {
      this.state.lastError = error.message;
      this.state.connected = 0;
      // 端口没开是常态（用户没设环境变量），只在第一次失败时记一行
      if (this.lastLoggedError !== error.message) {
        this.lastLoggedError = error.message;
        this.#log("warn", `连接 CDP 失败：${error.message}`);
      }
      delay = POLL_IDLE_MS;
    } finally {
      this.state.lastAt = Date.now();
      if (this.running) {
        this.timer = setTimeout(() => this.#poll(), delay);
        this.timer.unref?.();
      }
    }
  }

  async #listTargets() {
    const list = await httpJson(`http://127.0.0.1:${this.port}/json/list`, 2500);
    if (!Array.isArray(list)) return [];
    const pages = list.filter(
      (target) =>
        target &&
        target.type === "page" &&
        typeof target.webSocketDebuggerUrl === "string" &&
        !/^devtools:\/\//i.test(target.url || "")
    );
    // 9222 是 Chromium 的公共习惯端口，本机上可能被别的东西（如 Playwright 残留、
    // 用户自己开的 Chrome）先占住。只认 WorkBuddy 的渲染进程，别往别人窗口里塞脚本。
    const ours = pages.filter((t) => isWorkBuddyTarget(t));
    // 一个都对不上时把看到的 URL 记下来，方便排查是「端口被别人占了」还是「筛选写窄了」
    this.state.seen = pages.slice(0, 3).map((t) => String(t.url || t.title || "").slice(0, 120));
    this.state.note =
      !ours.length && pages.length
        ? `端口 ${this.port} 上有 ${pages.length} 个调试页面，但都不是 WorkBuddy：${this.state.seen[0] || "?"}`
        : "";
    return ours;
  }

  async #sync(targets) {
    const alive = new Set(targets.map((t) => String(t.id)));
    for (const [id, session] of this.sessions) {
      if (!alive.has(id)) {
        try {
          session.socket.close();
        } catch {
          /* ignore */
        }
        this.sessions.delete(id);
      }
    }

    for (const target of targets) {
      const id = String(target.id);
      if (this.sessions.has(id)) continue;
      try {
        const socket = await CdpSocket.connect(target.webSocketDebuggerUrl);
        socket.onClose = () => {
          this.sessions.delete(id);
          this.state.connected = this.sessions.size;
        };
        await socket.send("Page.enable");
        await socket.send("Runtime.evaluate", {
          expression: this.source,
          awaitPromise: false,
          allowUnsafeEvalBlockedByCSP: true,
        });
        await socket.send("Page.addScriptToEvaluateOnNewDocument", { source: this.source });
        this.sessions.set(id, { socket, target });
        this.state.injected += 1;
        this.#log("info", `已注入：${target.title || target.url || id}`);
      } catch (error) {
        this.state.lastError = error.message;
        this.#log("warn", `注入 ${target.url || id} 失败：${error.message}`);
      }
    }
    this.state.connected = this.sessions.size;
  }

  #log(level, message) {
    if (!this.logFile) return;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      const line = `${new Date().toISOString()} [${level}] ${message}\n`;
      try {
        const stat = fs.statSync(this.logFile);
        if (stat.size > LOG_LIMIT) fs.truncateSync(this.logFile, 0);
      } catch {
        /* 文件还不存在 */
      }
      fs.appendFileSync(this.logFile, line);
    } catch {
      /* 日志失败不该影响主流程 */
    }
  }
}

module.exports = { MenuInjector, resolvePort, resolvePortInfo, readConfig, normalizePort, defaultConfigFile };
