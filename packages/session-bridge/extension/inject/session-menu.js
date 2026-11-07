/**
 * 给 WorkBuddy 桌面端的「任务（会话）」右键菜单补三项：
 *   复制 Session ID / 标记已读 / 标记未读
 *
 * 运行位置：宿主主窗口的渲染进程（由 CDP 的 Runtime.evaluate / Page.addScriptToEvaluateOnNewDocument 注入）。
 * 为什么这么干：官方扩展 manifest 的 ui 只有 entry/pickers/modals/settings/messageCards/
 * artifactCards/artifactPreviews/chatInputFileSelectors/artifactUploadTargets/contentBlocks/deepLinks
 * 十一个贡献点，没有菜单插槽；会话菜单是 React 里硬编码的条件数组。
 *
 * 真实结构（2026-10 实测，WorkBuddy 5.9.2）：
 *   <div class="wb-popover-compact _menu_xxx conversation-context-menu" role="menu">
 *     <button class="_item_xxx" role="menuitem"><span class="_itemIcon_xxx"><svg…></span>重命名</button>
 *     <div class="_divider_xxx cb-context-menu-divide"></div>
 *     …
 *   </div>
 *
 * 三条铁律（上一版正是违反第一条把客户端拖卡）：
 *   1. 只克隆「单个 menuitem 按钮」，绝不克隆菜单容器——上一版把 anchor.parentElement
 *      当成了行容器，实际它就是菜单容器，于是每次都在克隆整份菜单；标记又落在菜单外面，
 *      菜单里永远找不到，于是每次 DOM 变动都再克隆一次，节点无限增长直到卡死。
 *   2. 不做全局常驻 MutationObserver。只在「右键会话行」之后开 2.6 秒短窗口，80ms 查一次，
 *      命中或超时就停。空闲时零开销。
 *   3. 卸载时自己删掉插入的节点，不等 React 来收拾。
 *
 * 已读 / 未读怎么落地（2026-11-07 实测）：
 *   - 标记已读有宿主通道 wb:conversations:markRead，这里先直接调，最快也最可靠。
 *   - 标记未读宿主 daemon 根本没注册通道（[MethodChannel] no handler），只能由扩展
 *     service 直写 workbuddy.db 的 sessions.unread。渲染进程够不着磁盘，所以走
 *     CDP 的 Runtime.addBinding：页面调 window.__dshBridgeCall，service 处理完用
 *     window.__dshBridgeResult 把结果送回来。
 */
(() => {
  "use strict";

  const GUARD = "__dshCopySessionMenu";
  if (window[GUARD]) return;

  const MARK = "data-dsh-copy-session"; // 属性名沿用旧值，值改成菜单项的 key
  // 菜单渲染有快有慢，1.2s 实测偶尔不够（项会晚到 1s 左右）；2.6s 足够且仍是短窗口
  const ARM_MS = 2600;
  const TICK_MS = 80;
  const MAX_MARKS = 3; // 一次最多插三项，见 MENU_ITEMS
  // 单个菜单条目的合理上限。守卫的本意是「别把容器当条目克隆」，
  // 但数字压太狠会把图标复杂的正常条目也挡掉，所以放宽，另用 role 判容器。
  const MAX_CLONE_NODES = 24;
  const BRIDGE_RESULT = "__dshBridgeResult";

  let armedUntil = 0;
  let timer = null;
  let pendingId = "";
  let disabled = false;
  let lastReject = "";
  let callSeq = 0;
  const pendingCalls = Object.create(null);

  /* ---------------- 记录右键的是哪个会话 ---------------- */

  function onPointer(event) {
    if (disabled) return;
    const el = event.target instanceof Element ? event.target.closest("[data-conversation-id]") : null;
    if (!el) return;
    const id = el.getAttribute("data-conversation-id");
    if (!id) return;
    pendingId = id;
    arm();
  }

  // 只认右键/按下，capture 阶段拿，早于 React 渲染菜单
  document.addEventListener("contextmenu", onPointer, true);
  document.addEventListener("pointerdown", onPointer, true);

  function arm() {
    armedUntil = Date.now() + ARM_MS;
    if (timer) return;
    // 菜单很多时候已经渲染好了，先立即试一次，别白等一个 tick
    if (tick()) return;
    timer = setInterval(tick, TICK_MS);
  }

  /** @returns {boolean} true = 这一轮不用再等了 */
  function tick() {
    if (disabled || Date.now() > armedUntil) {
      stopTimer();
      return true;
    }
    const menu = findMenu();
    if (!menu) return false;
    // 三项要齐，只插了一两项时继续补，别早早收工
    if (menu.querySelectorAll(`[${MARK}]`).length >= MENU_ITEMS.length) {
      stopTimer();
      return true;
    }
    if (injectInto(menu)) {
      stopTimer();
      return true;
    }
    return false;
  }

  function stopTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function findMenu() {
    // 精确选择器，代价接近 0；[role=menu] 兜底防类名改名
    const precise = document.querySelector(".conversation-context-menu");
    if (precise) return precise;
    for (const m of document.querySelectorAll('[role="menu"]')) {
      if (/重命名|Rename/.test(m.textContent || "")) return m;
    }
    return null;
  }

  /* ---------------- 菜单项定义 ---------------- */

  const CLIPBOARD_ICON =
    '<path fill="currentColor" d="M6.5 1.5a1 1 0 0 0-1 1V3H4.5A1.5 1.5 0 0 0 3 4.5v9A1.5 1.5 0 0 0 4.5 15h7a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 11.5 3H10v-.5a1 1 0 0 0-1-1H6.5Zm0 1.5H9V3H6.5v-.5ZM4.5 4.5h1V6h5V4.5h1v9h-7v-9Z"/>';
  const READ_ICON =
    '<path fill="currentColor" d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 1.5A4.5 4.5 0 1 1 8 12.5 4.5 4.5 0 0 1 8 3.5Z"/><path fill="currentColor" d="m7.1 10.4-2.4-2.4 1-1 1.4 1.4 3.2-3.2 1 1-4.2 4.2Z"/>';
  const UNREAD_ICON =
    '<path fill="currentColor" d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z"/>';

  const MENU_ITEMS = [
    {
      key: "copy",
      label: "复制 Session ID",
      icon: CLIPBOARD_ICON,
      run: async (id) => {
        const ok = await copyText(id);
        return { ok, message: ok ? "已复制 Session ID" : "复制失败" };
      },
    },
    {
      key: "read",
      label: "标记已读",
      icon: READ_ICON,
      run: async (id) => {
        const res = await markAs(id, false);
        return { ok: res.ok, message: res.ok ? "已标记已读" : "标记已读失败：" + (res.error || "") };
      },
    },
    {
      key: "unread",
      label: "标记未读",
      icon: UNREAD_ICON,
      run: async (id) => {
        const res = await markAs(id, true);
        return { ok: res.ok, message: res.ok ? "已标记未读" : "标记未读失败：" + (res.error || "") };
      },
    },
  ];

  /* ---------------- 造一项 ---------------- */

  function makeItem(anchor, spec) {
    // 铁律 1：只克隆这一颗按钮。判「克隆错了容器」的本质依据是里面还套着菜单项，
    // 而不是子节点个数——按个数卡会把图标节点多的正常条目也挡掉。
    const clone = anchor.cloneNode(true);
    const nested = clone.querySelectorAll('[role="menuitem"]').length;
    if (nested > 0) {
      lastReject = `克隆到了容器（内含 ${nested} 个 menuitem）`;
      return null;
    }
    const nodeCount = clone.querySelectorAll("*").length;
    if (nodeCount > MAX_CLONE_NODES) {
      lastReject = `克隆体太大（${nodeCount} 个节点）`;
      return null;
    }

    clone.setAttribute(MARK, spec.key);
    clone.removeAttribute("aria-checked");
    clone.removeAttribute("data-state");
    clone.setAttribute("role", "menuitem");

    const oldIcon = clone.querySelector("svg");
    if (oldIcon) {
      const next = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      for (const attr of ["viewBox", "width", "height", "class", "aria-hidden", "fill", "xmlns"]) {
        const v = oldIcon.getAttribute(attr);
        if (v !== null) next.setAttribute(attr, v);
      }
      if (!next.getAttribute("viewBox")) next.setAttribute("viewBox", "0 0 16 16");
      next.innerHTML = spec.icon;
      oldIcon.replaceWith(next);
    }

    // 只改按钮自己的直接文本节点，别碰图标内部
    let renamed = false;
    for (const node of [...clone.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE && node.nodeValue && node.nodeValue.trim()) {
        node.nodeValue = spec.label;
        renamed = true;
        break;
      }
    }
    if (!renamed) clone.appendChild(document.createTextNode(spec.label));

    const swallow = (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    clone.addEventListener(
      "click",
      async (event) => {
        swallow(event);
        // 先固定 id：await 期间用户可能又右键了别的会话
        const currentId = pendingId;
        removeNode(clone);
        closeMenu();
        let res;
        try {
          res = await spec.run(currentId);
        } catch (error) {
          res = { ok: false, message: "操作失败：" + String((error && error.message) || error) };
        }
        toast(res.message);
      },
      true
    );
    clone.addEventListener("mousedown", swallow, true);
    clone.addEventListener("pointerdown", swallow, true);
    return clone;
  }

  function injectInto(menu) {
    const present = Object.create(null);
    for (const node of menu.querySelectorAll(`[${MARK}]`)) present[node.getAttribute(MARK)] = node;
    if (Object.keys(present).length >= MAX_MARKS) return true;

    // 排除我们自己插的项，别拿它们当锚点
    const items = [...menu.querySelectorAll('button[role="menuitem"]')].filter((el) => !el.hasAttribute(MARK));
    if (!items.length) {
      lastReject = "菜单里还没有 menuitem";
      return false;
    }

    const anchor = items.find((el) => /重命名|Rename/.test(el.textContent || "")) || items[0];
    const parent = anchor.parentElement;
    if (!parent) {
      lastReject = "锚点没有父节点";
      return false;
    }

    let cursor = anchor;
    for (const spec of MENU_ITEMS) {
      if (present[spec.key]) {
        cursor = present[spec.key];
        continue;
      }
      const clone = makeItem(anchor, spec);
      if (!clone) return false;
      parent.insertBefore(clone, cursor.nextSibling);
      cursor = clone;
    }
    lastReject = "";
    return menu.querySelectorAll(`[${MARK}]`).length >= MENU_ITEMS.length;
  }

  function removeNode(node) {
    try {
      node.remove();
    } catch {
      /* ignore */
    }
  }

  /* ---------------- 标记已读 / 未读 ---------------- */

  function bridgeCall(method, id) {
    if (typeof window.__dshBridgeCall !== "function") {
      return Promise.resolve({ ok: false, error: "桥服务未就绪（更新扩展后重启一次客户端）" });
    }
    return new Promise((resolve) => {
      const token = String(++callSeq);
      const timeout = setTimeout(() => {
        delete pendingCalls[token];
        resolve({ ok: false, error: "桥服务没有回话（超时）" });
      }, 8000);
      pendingCalls[token] = (res) => {
        clearTimeout(timeout);
        delete pendingCalls[token];
        resolve(res);
      };
      try {
        window.__dshBridgeCall(JSON.stringify({ token, method, id }));
      } catch (error) {
        clearTimeout(timeout);
        delete pendingCalls[token];
        resolve({ ok: false, error: String((error && error.message) || error) });
      }
    });
  }

  window[BRIDGE_RESULT] = (res) => {
    const token = res && res.token;
    const fn = pendingCalls[token];
    if (fn) fn(res);
  };

  async function markAs(id, unread) {
    if (!id) return { ok: false, error: "没记到会话 ID" };
    // 标记已读优先直达宿主通道：不依赖 binding，也省一次往返
    if (!unread && typeof window.__wbInvoke === "function") {
      try {
        const direct = await window.__wbInvoke("wb:conversations:markRead", id);
        if (!direct || !direct.__wbError) return { ok: true };
      } catch {
        /* 退回桥 */
      }
    }
    return bridgeCall(unread ? "markUnread" : "markRead", id);
  }

  /* ---------------- 复制 ---------------- */

  /**
   * 写系统剪贴板，按可靠性排序，任何一条真成功就停。
   *
   * 上一版把 window.__wbInvoke 放第一位，踩了个坑（2026-10-25 实测）：
   * 通道名不存在时 IPC 层**不 reject**，而是 resolve 一个
   * `{__wbError:true, code:4001, message:'No handler for "…"'}`。
   * 于是这里以为成功、直接 return true，后面两条兜底一次都没跑——
   * 用户看到「已复制」提示，剪贴板却是空的。
   *
   * 现在优先用 preload 直接暴露的 workbuddyDesktop.clipboard.writeText：
   * 宿主自己封装的真通道，不需要页面焦点，实测写入正确。
   */
  async function copyText(text) {
    if (!text) return false;

    const desk = window.workbuddyDesktop && window.workbuddyDesktop.clipboard;
    if (desk && typeof desk.writeText === "function") {
      try {
        await desk.writeText(text);
        return true;
      } catch {
        /* 换下一条通道 */
      }
    }

    // 裸 IPC：必须显式判掉 __wbError，否则失败会被伪装成成功
    if (typeof window.__wbInvoke === "function") {
      try {
        const result = await window.__wbInvoke("workbuddy:clipboard:writeText", text);
        if (!result || !result.__wbError) return true;
      } catch {
        /* 换下一条通道 */
      }
    }

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* 页面可能没有剪贴板权限，或窗口没焦点 */
    }

    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function closeMenu() {
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      for (const type of ["pointerdown", "mousedown", "mouseup", "click"]) {
        document.body.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
    } catch {
      /* ignore */
    }
  }

  function toast(message) {
    try {
      const box = document.createElement("div");
      box.textContent = message;
      box.style.cssText = [
        "position:fixed",
        "left:50%",
        "bottom:64px",
        "transform:translateX(-50%)",
        "z-index:2147483647",
        "padding:8px 14px",
        "border-radius:8px",
        "font:13px/1.4 system-ui,sans-serif",
        "color:#fff",
        "background:rgba(17,17,17,.88)",
        "box-shadow:0 6px 20px rgba(0,0,0,.24)",
        "pointer-events:none",
        "opacity:0",
        "transition:opacity .16s ease",
      ].join(";");
      document.body.appendChild(box);
      requestAnimationFrame(() => {
        box.style.opacity = "1";
      });
      setTimeout(() => {
        box.style.opacity = "0";
        setTimeout(() => box.remove(), 200);
      }, 1400);
    } catch {
      /* 提示失败无所谓 */
    }
  }

  /* ---------------- 控制句柄（出问题能一键停） ---------------- */

  window[GUARD] = {
    stop() {
      disabled = true;
      stopTimer();
      for (const node of document.querySelectorAll(`[${MARK}]`)) removeNode(node);
      return "stopped";
    },
    get marks() {
      return document.querySelectorAll(`[${MARK}]`).length;
    },
    /**
     * 只读快照，排查用。出问题时先看这里，能立刻分清是「没记到会话 ID」
     * 还是「记到了但没赶上菜单渲染」。
     */
    get state() {
      return {
        pendingId,
        armRemainMs: Math.max(0, armedUntil - Date.now()),
        timerAlive: Boolean(timer),
        marks: document.querySelectorAll(`[${MARK}]`).length,
        items: MENU_ITEMS.map((spec) => spec.key),
        bridgeReady: typeof window.__dshBridgeCall === "function",
        pendingCalls: Object.keys(pendingCalls).length,
        disabled,
        menuOpen: Boolean(findMenu()),
        menuItems: findMenu()?.querySelectorAll('button[role="menuitem"]').length ?? 0,
        lastReject,
      };
    },
  };
})();
