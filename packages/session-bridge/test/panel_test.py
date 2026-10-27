"""End-to-end panel test with a fake WorkBuddy host.

Reproduces the host contract from docs/EXTENSION-COOKBOOK.md §7:
  - iframe + MessagePort + __wb_port_init__
  - guest-ready within 10s
  - $resolveLocalRpc -> $invokeLocalRpcFallback two-hop
"""

import json
import os
import sys
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(ROOT, "test", "panel.html").replace("\\", "/")
# 浏览器路径可以自己指定；不指定就用 playwright 自带的
CHROME = os.environ.get("WBSM_CHROME", "")

# 截图只用于本地排查，写进 .probe/（已被 .gitignore 忽略）
SHOT_DIR = os.path.join(ROOT, ".probe")


def shot_path(name):
    os.makedirs(SHOT_DIR, exist_ok=True)
    return os.path.join(SHOT_DIR, name)


def main() -> int:
    failures = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME if os.path.exists(CHROME) else None, headless=True)
        page = browser.new_page(viewport={"width": 900, "height": 760})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"file:///{PAGE}")
        frame = page.frame_locator("#panel")

        try:
            page.wait_for_function("() => window.__HOST_LOG__.some(l => l.includes('guest-ready'))", timeout=10000)
        except Exception:
            failures.append("guest-ready 未在 10 秒内完成")

        try:
            page.wait_for_function(
                "() => (window.__HOST_LOG__ || []).some(l => l.includes('→ listDsh'))", timeout=15000
            )
        except Exception:
            failures.append("启动后没有调用 listDsh")

        try:
            frame.locator("#statusDot.on").wait_for(timeout=8000)
        except Exception:
            failures.append("状态灯没有变成在线")

        # service 被回收后，只读调用应当自己重取票据再试，不能把错误甩给用户
        try:
            page.wait_for_function(
                "() => (window.__HOST_LOG__ || []).filter(l => l.includes('resolve ')).length >= 2", timeout=10000
            )
        except Exception:
            failures.append("service 回收后没有自动重取票据（自愈没生效）")

        if not page.evaluate("() => (window.__HOST_LOG__ || []).some(l => l.includes('模拟 service 已回收'))"):
            failures.append("自愈用例没被触发（假宿主没注入失败）")

        status_text = frame.locator("#statusBar").inner_text()
        if "DSH 在线" not in status_text:
            failures.append(f"状态栏文案不对：{status_text}")

        # 「复制 Session ID」注入徽标：假宿主返回 enabled + connected=1，应显示已生效
        badge = frame.locator("#injectBadge")
        try:
            badge.wait_for(state="visible", timeout=5000)
            badge_text = badge.inner_text()
            if "✓" not in badge_text:
                failures.append(f"注入徽标应显示已生效，实际：{badge_text}")
        except Exception:
            failures.append("注入徽标没显示（menuInject 状态没渲染出来）")

        rows = frame.locator("#list .row")
        if rows.count() != 3:
            failures.append(f"DSH 列表行数应为 3，实际 {rows.count()}")

        # 行操作菜单：右键弹出，含三条复制动作
        rows.nth(1).click(button="right")
        try:
            frame.locator("#rowMenu").wait_for(state="visible", timeout=4000)
        except Exception:
            failures.append("右键没有弹出会话菜单")
        labels = frame.locator("#rowMenu .mi").all_inner_texts()
        for need in ("复制会话 ID", "复制会话标题", "复制工作目录"):
            if not any(need in item for item in labels):
                failures.append(f"菜单缺少「{need}」，实际：{labels}")
        # 复制 ID
        frame.locator("#rowMenu .mi", has_text="复制会话 ID").first.click()
        try:
            page.wait_for_function("() => window.__COPIED__", timeout=5000)
        except Exception:
            failures.append("点菜单复制没有调用 copyText")
        copied = page.evaluate("() => window.__COPIED__")
        if copied != "session-a1b2c3d4-0004-4a00-8000-000000000004":
            failures.append(f"复制内容不对：{copied}")

        # ⋯ 按钮走同一条菜单，且「在资源管理器中显示」能拿到 cwd
        rows.nth(1).locator("button.chip").click()
        frame.locator("#rowMenu").wait_for(state="visible", timeout=4000)
        frame.locator("#rowMenu .mi", has_text="在资源管理器中显示").first.click()
        page.wait_for_timeout(300)
        revealed = page.evaluate("() => window.__REVEALED__")
        if revealed != "C:\\Users\\me\\Documents\\demo-workspace":
            failures.append(f"revealPath 路径不对：{revealed}")

        # 详情 + 消息
        rows.nth(1).locator(".main").click()
        frame.locator("#detailView").wait_for(state="visible", timeout=5000)
        msg_count = frame.locator(".msg").count()
        if msg_count != 2:
            failures.append(f"详情消息应为 2 条，实际 {msg_count}")
        detail_id = frame.locator("#dId").inner_text()
        if detail_id != "session-a1b2c3d4-0004-4a00-8000-000000000004":
            failures.append(f"详情 ID 不对：{detail_id}")

        # 系统注入默认隐藏，但要告诉用户藏了几条
        if frame.locator(".msg.injected").count() != 0:
            failures.append("系统注入默认应该是隐藏的")
        bar = frame.locator(".injected-bar")
        if bar.count() != 1 or "3" not in bar.inner_text():
            failures.append(f"缺少注入折叠提示，实际：{bar.inner_text() if bar.count() else '(没有)'}")
        else:
            bar.locator("button").click()
            page.wait_for_timeout(200)
            shown = frame.locator(".msg.injected").count()
            if shown != 3:
                failures.append(f"展开后应有 3 条注入，实际 {shown}")
            frame.locator(".injected-bar button").click()
            page.wait_for_timeout(200)
        # 只截面板本身（右侧是假宿主的日志栏，不该出现在展示图里）
        page.wait_for_timeout(2200)  # 等 toast 自己消失，别挡住发送按钮
        page.locator("#panel").screenshot(path=shot_path("panel-detail.png"))

        # 发消息
        frame.locator("#prompt").fill("把迁移报告补一节回滚步骤")
        frame.locator("#btnSend").click()
        try:
            page.wait_for_function(
                "() => (window.__HOST_CALLS__ || []).some(c => c.method === 'promptDsh')", timeout=8000
            )
        except Exception:
            failures.append("发送消息没有调用 promptDsh")

        # WorkBuddy 标签
        frame.locator('.tab[data-tab="wb"]').click()
        try:
            frame.locator("#list .row").first.wait_for(timeout=8000)
        except Exception:
            failures.append("WorkBuddy 列表没有渲染")

        # 数据源开关：本机（桌面端 UUID）与云端（数字 ID）是两套 ID 空间
        if frame.locator("#wbSource").is_hidden():
            failures.append("WorkBuddy 标签下应显示「本机 / 云端」切换")
        frame.locator('#wbSource button[data-src="cloud"]').click()
        try:
            page.wait_for_function(
                "() => (window.__HOST_CALLS__ || []).some(c => c.method === 'listWb' && c.payload.source === 'cloud')",
                timeout=6000,
            )
        except Exception:
            failures.append("切到云端没有重新拉 listWb(source=cloud)")
        try:
            frame.locator("#list .row .id", has_text="1000000000000000001").wait_for(timeout=6000)
        except Exception:
            failures.append("云端列表没有渲染数字 ID 的会话")
        frame.locator('#wbSource button[data-src="local"]').click()
        page.wait_for_timeout(600)

        # WorkBuddy 侧新建会话：以前这个按钮在 wb 标签下是隐藏的
        if frame.locator("#btnNew").is_hidden():
            failures.append("WorkBuddy 标签下「+ 新建」应该可见")
        frame.locator("#btnNew").click()
        frame.locator("#newDialog").wait_for(state="visible", timeout=4000)
        title = frame.locator("#newDialogTitle").inner_text()
        if "WorkBuddy" not in title:
            failures.append(f"新建弹窗标题不对：{title}")
        frame.locator("#newPrompt").fill("自检：报 ID / 项目 / 时间")
        frame.locator("#btnNewCreate").click()
        try:
            page.wait_for_function(
                "() => (window.__HOST_CALLS__ || []).some(c => c.method === 'promptWb')",
                timeout=10000,
            )
        except Exception:
            failures.append("WorkBuddy 新建没有走到 promptWb")
        try:
            frame.locator(".msg .bubble", has_text="id=conv-wb-new-0001").first.wait_for(timeout=12000)
        except Exception:
            failures.append("WorkBuddy 会话详情没有显示出对方回复")
        page.wait_for_timeout(2200)
        page.locator("#panel").screenshot(path=shot_path("panel-wb.png"))
        frame.locator("#btnBack").click()

        # 其他本地 harness（Codex）：标签页按探测结果生成，只读
        try:
            frame.locator('.tab[data-tab="harness:codex"]').wait_for(timeout=8000)
        except Exception:
            failures.append("没有生成 Codex 标签页")
        frame.locator('.tab[data-tab="harness:codex"]').click()
        try:
            frame.locator("#list .row").first.wait_for(timeout=10000)
        except Exception:
            failures.append("Codex 列表没有渲染")

        # 子 agent 线程默认折叠，但要显式告诉用户折了几条
        if frame.locator("#list .row").count() != 1:
            failures.append(f"Codex 主线程应为 1 行，实际 {frame.locator('#list .row').count()}")
        banner = frame.locator("#bannerHost .banner")
        if banner.count() != 1 or "折叠" not in banner.inner_text() or "1" not in banner.inner_text():
            failures.append(f"缺少子 agent 折叠提示，实际：{banner.inner_text() if banner.count() else '(没有)'}")
        # 只读来源不能「新建」
        if not frame.locator("#btnNew").is_hidden():
            failures.append("Codex 标签下不应显示「+ 新建」")

        # 展开子 agent
        if banner.count():
            banner.locator("button").click()
            page.wait_for_timeout(600)
            if frame.locator("#list .row").count() != 2:
                failures.append(f"展开子 agent 后应为 2 行，实际 {frame.locator('#list .row').count()}")
            if frame.locator("#list .row", has_text="子 agent · Bacon").count() == 0:
                failures.append("展开后没有标出「子 agent · Bacon」")
            if "已显示 1 条" not in frame.locator("#bannerHost .banner").inner_text():
                failures.append(f"展开后的文案不对：{frame.locator('#bannerHost .banner').inner_text()}")
            frame.locator("#bannerHost .banner button").click()
            page.wait_for_timeout(600)

        # 详情：只读，没有输入框，但能看内容、能复制恢复命令
        frame.locator("#list .row").first.locator(".main").click()
        frame.locator("#detailView").wait_for(state="visible", timeout=5000)
        if not frame.locator("#composer").is_hidden():
            failures.append("只读来源不应显示输入框")
        if frame.locator("#readonlyBar").is_hidden():
            failures.append("只读来源应显示只读说明")
        if "Codex" not in frame.locator("#readonlyBar").inner_text():
            failures.append(f"只读说明没标出来源：{frame.locator('#readonlyBar').inner_text()}")
        if frame.locator(".msg").count() != 2:
            failures.append(f"Codex 会话消息应为 2 条，实际 {frame.locator('.msg').count()}")
        if "Codex" not in frame.locator(".msg.assistant .who").first.inner_text():
            failures.append("助手气泡的署名应该是 Codex")
        page.wait_for_timeout(300)
        frame.locator("#readonlyBar button.chip").click()
        try:
            page.wait_for_function("() => window.__COPIED__ && window.__COPIED__.indexOf('codex resume') === 0", timeout=5000)
        except Exception:
            failures.append("没有复制出恢复命令")
        page.wait_for_timeout(2200)
        page.locator("#panel").screenshot(path=shot_path("panel-codex.png"))
        frame.locator("#btnBack").click()

        # 新建会话弹窗（DSH 侧）
        frame.locator('.tab[data-tab="dsh"]').click()
        frame.locator("#btnNew").click()
        frame.locator("#newDialog").wait_for(state="visible", timeout=4000)
        dsh_title = frame.locator("#newDialogTitle").inner_text()
        if "DSH" not in dsh_title:
            failures.append(f"DSH 新建弹窗标题不对：{dsh_title}")
        frame.locator("#btnNewCancel").click()

        if errors:
            failures.append("页面异常：" + " | ".join(errors))

        page.screenshot(path=shot_path("panel-shot.png"), full_page=True)
        browser.close()

    if failures:
        print("FAIL")
        for item in failures:
            print(" -", item)
        return 1
    print("PASS: guest-ready / 状态 / 列表 / 复制 ID / 详情 / 发送 / 新建 / WB 新建双向 / Codex 只读来源")
    return 0


if __name__ == "__main__":
    sys.exit(main())
