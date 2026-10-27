import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const svc = require("../extension/server/index.cjs");
const { defaultConfigFile } = require("../extension/server/menu-inject.cjs");
import { configPath } from "../bin/context-menu.mjs";

const realHome = process.env.WORKBUDDY_HOME;

async function withTempHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wbsm-"));
  process.env.WORKBUDDY_HOME = tmp;
  process.env.WORKBUDDY_MENU_INJECT = "off"; // 测试期间一次网络请求都不发
  try {
    return await fn(tmp);
  } finally {
    if (realHome === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = realHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("activate() 交给宿主的方法表是完整的", async () => {
  await withTempHome(() => {
    const app = svc.activate();
    assert.deepEqual(Object.keys(app.methods).sort(), ["menuInject", "ping", "reload", "status"]);
    assert.equal(typeof app.dispose, "function");
    app.dispose();
  });
});

test("ping 报版本号", async () => {
  await withTempHome(() => {
    const app = svc.activate();
    return app.methods.ping().then((r) => {
      assert.equal(r.ok, true);
      assert.equal(r.version, svc.VERSION);
      app.dispose();
    });
  });
});

test("status 在端口未配置时是「关」而不是报错", async () => {
  await withTempHome(() => {
    const app = svc.activate();
    return app.methods.status().then((s) => {
      assert.equal(s.ok, true);
      assert.equal(s.enabled, false);
      assert.equal(s.port, 0);
      app.dispose();
    });
  });
});

test("service 的日志目录与命令行的配置文件目录必须一致", async () => {
  // 这条最容易悄悄错位：命令行把端口写进 A 目录，service 却去 B 目录找，
  // 表现就是「命令行说启用了，面板永远说没启用」。
  await withTempHome((tmp) => {
    const serviceConfig = defaultConfigFile(path.join(tmp, "session-menu", "menu-inject.log"));
    assert.equal(serviceConfig, configPath());

    const app = svc.activate();
    const reported = app.methods.status();
    app.dispose();
    return Promise.resolve(reported).then((s) => {
      assert.equal(s.configFile, configPath(), "面板显示的配置文件必须是命令行写的那一份");
    });
  });
});
