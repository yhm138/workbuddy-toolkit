"use strict";

/**
 * 会话菜单 · extension service
 *
 * 宿主会 fork 这个进程（extension.json 里 service.process = "fork"），
 * 然后调用 activate() 拿方法表。面板通过 wb.invoke 调这些方法。
 *
 * 为什么这个小工具也需要 service：
 *   CDP 是 HTTP + WebSocket，而且注入脚本要推到渲染进程里。iframe 面板够不着
 *   这些东西（跨源、没有 Node 能力），所以必须是 Node 侧做。
 *   顺带一个副作用：service 什么时候启动由「面板被打开过」决定，这也解释了
 *   为什么装完扩展要打开一次面板，菜单项才会出现。
 *
 * 依赖：./menu-inject.cjs（注入器）、./cdp.cjs（WebSocket 与 CDP 调用）。
 * 这两者不依赖宿主的任何 API，单测里可以直接跑。
 */

const os = require("node:os");
const path = require("node:path");
const { MenuInjector } = require("./menu-inject.cjs");

const VERSION = "1.0.0";

/** 宿主把 WORKBUDDY_HOME 指到自己的数据目录；没设就按 Windows/macOS/Linux 的默认位置来。 */
function wbHome() {
  return process.env.WORKBUDDY_HOME || path.join(os.homedir(), ".workbuddy");
}

function stateDir() {
  return path.join(wbHome(), "session-menu");
}

let injector = null;

function boot() {
  injector = new MenuInjector({
    logFile: path.join(stateDir(), "menu-inject.log"),
  });
  injector.start();
  return injector;
}

function activate() {
  if (!injector) boot();

  return {
    methods: {
      ping: async () => ({ ok: true, version: VERSION }),

      /** 注入器状态：端口从哪来、连了几个窗口、注入了几次、最后一次错在哪 */
      status: async () => ({ ok: true, version: VERSION, ...injector.status() }),

      /** 旧名字，面板早期版本用过，留着免得老面板打不开 */
      menuInject: async () => ({ ok: true, ...injector.status() }),

      /**
       * 重新读配置后重启注入器。
       *
       * 场景：刚跑完 `node bin/context-menu.mjs enable 9333`，不想重启整个客户端。
       * MenuInjector 的端口是构造时解析的，所以必须重建实例，不能只调 start()。
       */
      reload: async () => {
        try {
          injector.stop();
        } catch {
          /* 停不下来也要继续重建 */
        }
        boot();
        return { ok: true, ...injector.status() };
      },
    },

    dispose() {
      try {
        injector?.stop();
      } finally {
        injector = null;
      }
    },
  };
}

module.exports = { activate, VERSION };
