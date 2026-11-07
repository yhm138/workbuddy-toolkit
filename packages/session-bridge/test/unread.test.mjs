import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// 注入器在没开调试端口时整体休眠；测试里不希望它去连 9333
process.env.WORKBUDDY_MENU_INJECT = "off";

// node:sqlite 是 Node 22 才有的内置模块。真机 service 跑在宿主 fork 的 Node 22 上，
// 但 CI 还有 Node 20 的 job，那里只能跳过碰数据库的用例（静态断言照跑）。
let DatabaseSync = null;
try {
  // WORKBUDDY_TEST_NO_SQLITE=1 用来在本机复现 Node 20 的环境
  if (process.env.WORKBUDDY_TEST_NO_SQLITE !== "1") {
    ({ DatabaseSync } = require("node:sqlite"));
  }
} catch {
  /* Node 20：没有内置 sqlite */
}
const HAS_SQLITE = typeof DatabaseSync === "function";
const dbTest = (name, fn) => test(name, HAS_SQLITE ? {} : { skip: "Node 20 没有 node:sqlite" }, fn);

const { readUnread, setUnread, dbFile } = require("../extension/server/unread.cjs");
const { activate } = require("../extension/server/index.cjs");

const INDEX_SRC = fs.readFileSync(path.join(HERE, "..", "extension", "server", "index.cjs"), "utf8");
const INJECT_SRC = fs.readFileSync(path.join(HERE, "..", "extension", "inject", "session-menu.js"), "utf8");
const MENU_INJECT_SRC = fs.readFileSync(path.join(HERE, "..", "extension", "server", "menu-inject.cjs"), "utf8");

/** withDb=false 只建空目录：给不需要数据库的 service 用例用（Node 20 也能跑）。 */
function tempHome(withDb = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-unread-"));
  if (!withDb) return dir;
  const db = new DatabaseSync(path.join(dir, "workbuddy.db"));
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, unread INTEGER DEFAULT 0)");
  db.prepare("INSERT INTO sessions (id, unread) VALUES (?, ?)").run("a-1", 0);
  db.prepare("INSERT INTO sessions (id, unread) VALUES (?, ?)").run("a-2", 1);
  db.close();
  return dir;
}

function readAll(home) {
  const db = new DatabaseSync(dbFile(home));
  try {
    return Object.fromEntries(db.prepare("SELECT id, unread FROM sessions ORDER BY id").all().map((r) => [r.id, r.unread]));
  } finally {
    db.close();
  }
}

/** 每个 case 都独立 activate + dispose，避免队列定时器互相干扰。 */
async function withService(home, invoke, fn) {
  const prev = process.env.WORKBUDDY_HOME;
  process.env.WORKBUDDY_HOME = home;
  const svc = activate({ invoke });
  try {
    return await fn(svc.methods);
  } finally {
    await svc.dispose();
    if (prev === undefined) delete process.env.WORKBUDDY_HOME;
    else process.env.WORKBUDDY_HOME = prev;
  }
}

/* ------------------------------ db 模块 ------------------------------ */

dbTest("readUnread：只返回查得到的 id，布尔化 unread", () => {
  const home = tempHome();
  try {
    assert.deepEqual(readUnread(home, ["a-1", "a-2", "nope"]), { "a-1": false, "a-2": true });
    assert.deepEqual(readUnread(home, []), {});
    assert.deepEqual(readUnread(home, null), {});
    assert.deepEqual(readUnread(home, [null, "", 42, "a-1"]), { "a-1": false });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("readUnread：数据库不存在时返回空对象而不是抛", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-nodb-"));
  try {
    assert.deepEqual(readUnread(dir, ["a-1"]), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

dbTest("setUnread：写 1 / 写 0 都落库，并回报前后状态", () => {
  const home = tempHome();
  try {
    const on = setUnread(home, "a-1", true);
    assert.deepEqual(
      { ok: on.ok, exists: on.exists, before: on.before, after: on.after },
      { ok: true, exists: true, before: false, after: true }
    );
    assert.equal(readAll(home)["a-1"], 1);

    const off = setUnread(home, "a-2", false);
    assert.equal(off.before, true);
    assert.equal(off.after, false);
    assert.equal(readAll(home)["a-2"], 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

dbTest("setUnread：会话不在本机表里时明确报 exists=false", () => {
  const home = tempHome();
  try {
    const r = setUnread(home, "ghost", true);
    assert.equal(r.ok, false);
    assert.equal(r.exists, false);
    assert.match(r.error, /不在本机/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* ---------------------------- service 方法 ---------------------------- */

test("三个方法都在队列白名单里（命令行也能调）", () => {
  const block = INDEX_SRC.slice(INDEX_SRC.indexOf("const QUEUE_ALLOWED"), INDEX_SRC.indexOf("]);", INDEX_SRC.indexOf("const QUEUE_ALLOWED")));
  for (const name of ["markRead", "markUnread", "unreadState"]) {
    assert.match(block, new RegExp(`"${name}"`), `${name} 没进 QUEUE_ALLOWED`);
  }
});

dbTest("unreadState：把 db 状态原样交给面板", async () => {
  const home = tempHome();
  try {
    await withService(home, async () => undefined, async (methods) => {
      const res = await methods.unreadState({}, { ids: ["a-1", "a-2"] });
      assert.equal(res.ok, true);
      assert.deepEqual(res.items, { "a-1": false, "a-2": true });
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("markRead：走宿主通道，参数是裸 conversationId", async () => {
  const home = tempHome(false);
  const calls = [];
  try {
    await withService(home, async (ch, ...args) => { calls.push([ch, args]); }, async (methods) => {
      const res = await methods.markRead({}, { conversationId: "a-2" });
      assert.equal(res.method, "host");
      assert.equal(res.unread, false);
    });
    assert.deepEqual(calls, [["wb:conversations:markRead", ["a-2"]]]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("markRead：宿主 resolve 一个 __wbError 时必须抛，不能假装成功", async () => {
  const home = tempHome(false);
  try {
    await withService(home, async () => ({ __wbError: true, message: "no handler" }), async (methods) => {
      await assert.rejects(() => methods.markRead({}, { conversationId: "a-1" }), /宿主标记已读失败：no handler/);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("markRead / markUnread：缺 id 直接拒绝", async () => {
  const home = tempHome(false);
  try {
    await withService(home, async () => undefined, async (methods) => {
      await assert.rejects(() => methods.markRead({}, {}), /缺少 conversationId/);
      await assert.rejects(() => methods.markUnread({}, {}), /缺少 conversationId/);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

dbTest("markUnread：直写 db，并借一个无关已读会话触发列表刷新", async () => {
  const home = tempHome();
  const calls = [];
  const invoke = async (ch, ...args) => {
    calls.push([ch, args]);
    if (ch === "wb:conversations:list") {
      return { items: [{ id: "a-1", unread: true }, { id: "other", unread: false }] };
    }
    return undefined;
  };
  try {
    await withService(home, invoke, async (methods) => {
      const res = await methods.markUnread({}, { conversationId: "a-1" });
      assert.equal(res.ok, true);
      assert.equal(res.method, "db");
      assert.equal(res.unread, true);
      assert.equal(res.refreshed, true);
    });
    assert.equal(readAll(home)["a-1"], 1);
    assert.deepEqual(calls, [
      ["wb:conversations:list", []],
      ["wb:conversations:markRead", ["other"]],
    ]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

dbTest("markUnread：找不到可借的已读会话时仍写库，只是 refreshed=false", async () => {
  const home = tempHome();
  const invoke = async (ch) => (ch === "wb:conversations:list" ? { items: [{ id: "a-1", unread: true }] } : undefined);
  try {
    await withService(home, invoke, async (methods) => {
      const res = await methods.markUnread({}, { conversationId: "a-1" });
      assert.equal(res.refreshed, false);
    });
    assert.equal(readAll(home)["a-1"], 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

dbTest("markUnread：会话不在本机表里时抛 DB_ERROR，不静默成功", async () => {
  const home = tempHome();
  try {
    await withService(home, async () => undefined, async (methods) => {
      await assert.rejects(() => methods.markUnread({}, { conversationId: "ghost" }), (e) => e.code === "DB_ERROR");
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/* -------------------- 右键菜单 → service 的 binding 链路 -------------------- */

test("注入脚本三项菜单齐全，未读走 bridgeCall", () => {
  for (const label of ["复制 Session ID", "标记已读", "标记未读"]) {
    assert.ok(INJECT_SRC.includes(`label: "${label}"`), `缺少菜单项 ${label}`);
  }
  assert.match(INJECT_SRC, /window\.__dshBridgeCall/);
  assert.match(INJECT_SRC, /__dshBridgeResult/);
  assert.match(INJECT_SRC, /wb:conversations:markRead/, "标记已读优先直达宿主通道");
  assert.match(INJECT_SRC, /__wbError/, "直达通道也要判假成功");
});

test("未读圆点即时反馈：点击成功后补/收 DOM 圆点，不删 React 节点", () => {
  assert.match(INJECT_SRC, /paintUnread\(id, true\)/);
  assert.match(INJECT_SRC, /paintUnread\(id, false\)/);
  assert.match(INJECT_SRC, /unreadDot/, "应复用宿主现成的圆点样式");
  assert.match(INJECT_SRC, /data-dsh-unread-dot/);
  assert.match(INJECT_SRC, /style\.display = "none"/, "标记已读只隐藏，避免删掉 React 管的节点");
  assert.match(INJECT_SRC, /template \? template\.cloneNode\(true\)/, "优先克隆宿主圆点，样式才一致");
});

test("注入器注册 Runtime.addBinding 并监听 Runtime.bindingCalled", () => {
  assert.match(MENU_INJECT_SRC, /Runtime\.addBinding/);
  assert.match(MENU_INJECT_SRC, /Runtime\.bindingCalled/);
  assert.match(MENU_INJECT_SRC, /__dshBridgeResult/, "结果要回传给页面 toast");
  assert.match(MENU_INJECT_SRC, /onBridgeCall/);
});
