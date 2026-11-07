"""端到端冒烟测试（桌面 Chromium 模拟 iPhone 视口）

覆盖：
  A. 页面加载无 JS 错误 / 无图标缺失
  B. 码表页在未连接状态下的样式与 iOS 真实渲染
  C. 演示模式下的数据流与“停车确认”硬门槛
  D. 设置页修改协议参数后，原始帧预览随之变化
  E. 设备页渲染
截图输出到 lvbu-ble/tests/shots/
"""
import json
import os
import sys
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8899/"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
os.makedirs(OUT, exist_ok=True)

errors = []
failures = []


def check(cond, msg):
    if cond:
        print(f"  ok   {msg}")
    else:
        print(f"  FAIL {msg}")
        failures.append(msg)


def run():
    with sync_playwright() as p:
        browser = p.webkit.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=3,
                                  is_mobile=True, has_touch=True,
                                  user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148")
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)

        print("\n[A] 加载首页")
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_timeout(300)
        check(page.title() == "智能码表 · LVBU", "标题正确")
        check(not errors, f"无 JS 错误（{errors[:3]}）")
        # 所有 data-icon 都被填充为 svg
        n_icons = page.eval_on_selector_all("[data-icon]", "els => els.length")
        n_svg = page.eval_on_selector_all("[data-icon] > svg", "els => els.length")
        check(n_icons == n_svg and n_icons > 10, f"图标全部渲染 ({n_svg}/{n_icons})")
        # 模式按钮 5 个
        modes = page.eval_on_selector_all(".mode", "els => els.map(e => e.textContent.trim())")
        check(len(modes) == 5, f"助力模式 5 个: {modes}")

        print("\n[B] 码表页初始状态（未连接）")
        state = page.evaluate("""() => {
            const el = s => document.querySelector(s);
            const disp = s => getComputedStyle(el(s)).display;
            return {
              conn: el('#connText').textContent,
              speed: el('#speedValue').textContent,
              unit: el('#speedUnit').textContent,
              confirm: el('#confirmChip').textContent,
              note: el('#assistNote').textContent,
              sliderDisabled: el('#assistSlider').disabled,
              stopDisabled: el('#btnStop').disabled,
              emptyCards: [...document.querySelectorAll('.card.is-empty')].map(c => c.id),
              barWidths: [...document.querySelectorAll('.card__bar i')].map(i => i.style.width),
            };
        }""")
        print("   ", json.dumps(state, ensure_ascii=False))
        check(state["conn"] == "未连接", "状态显示未连接")
        check(state["speed"] == "0.0" and state["unit"] == "km/h", "速度 0.0 km/h")
        check(state["sliderDisabled"] and state["stopDisabled"], "未连接时滑杆与停止按钮禁用")
        check(len(state["emptyCards"]) == 3, f"3 张无数据卡片显示占位: {state['emptyCards']}")
        page.screenshot(path=os.path.join(OUT, "01-dash-disconnected.png"), full_page=True)

        # 检查是否横向溢出（iOS 上最常见的布局问题）
        overflow = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check(overflow <= 1, f"无横向溢出 (delta={overflow}px)")

        print("\n[C] 演示模式 + 停车确认门槛")
        page.evaluate("document.querySelector('[data-tab=settings]').click()")
        page.wait_for_timeout(150)
        page.check("#setDemo")
        page.wait_for_timeout(1600)  # 等 sim 启动 + tick
        page.evaluate("document.querySelector('[data-tab=dash]').click()")
        page.wait_for_timeout(500)
        demo_state = page.evaluate("""() => ({
            conn: document.querySelector('#connText').textContent,
            speed: document.querySelector('#speedValue').textContent,
            gps: document.querySelector('#gpsTag').textContent,
            body: document.querySelector('[data-field=battery]').textContent,
            avg: document.querySelector('#statAvg').textContent,
        })""")
        print("   ", json.dumps(demo_state, ensure_ascii=False))
        check(demo_state["conn"] == "演示模式", "进入演示模式")
        check(demo_state["gps"] == "DEMO", "GPS 标替换为 DEMO")
        check(float(demo_state["speed"]) > 0, "演示数据在流动")
        page.screenshot(path=os.path.join(OUT, "02-dash-demo-moving.png"), full_page=True)

        # 车速 > 0.5 时点“确认下发”应被拒绝
        try:
            page.click("#confirmChip", timeout=2000)
        except Exception:
            pass
        page.wait_for_timeout(200)
        toast = page.evaluate("document.querySelector('#toast').textContent")
        speed_now = float(page.evaluate("document.querySelector('#speedValue').textContent"))
        print(f"    toast={toast!r} speed={speed_now}")
        check(speed_now < 0.5 or "停车" in toast, f"高速时拒绝确认（toast 含『停车』或已停车: {toast}）")

        # 停车后确认
        page.evaluate("""() => {
            const s = LVBU.app.state;
            s.confirmed.level = 0; s.draft.level = 0; s.bike.speed = 0;
            LVBU.sim.stop();
            LVBU.app._internal.changed();
        }""")
        page.wait_for_timeout(300)
        page.evaluate("() => { const s = LVBU.app.state; s.bike.speed = 0; }")
        page.click(".mode[data-mode=climbing]")
        page.wait_for_timeout(200)
        chip = page.evaluate("document.querySelector('#confirmChip').textContent")
        check(chip == "确认下发", f"停车且草稿脏时按钮变为『确认下发』（实际 {chip!r}）")
        page.evaluate("() => { LVBU.app.state.bike.speed = 0; }")
        page.click("#confirmChip")
        page.wait_for_timeout(300)
        after = page.evaluate("""() => ({
            chip: document.querySelector('#confirmChip').textContent,
            confirmed: LVBU.app.state.confirmed,
            draft: LVBU.app.state.draft,
        })""")
        print("   ", json.dumps(after, ensure_ascii=False))
        check("已确认" in after["chip"], "确认后胶囊显示已确认")
        check(after["draft"]["dirty"] is False, "确认后草稿不再脏")
        page.screenshot(path=os.path.join(OUT, "03-dash-demo-confirmed.png"), full_page=True)

        print("\n[D] 设置页：协议参数影响帧预览")
        page.click("[data-tab=device]")
        page.wait_for_timeout(200)
        page.fill("#rawInput", "10")
        page.wait_for_timeout(150)
        prev_default = page.evaluate("document.querySelector('#rawPreview').textContent")
        page.click("[data-tab=settings]")
        page.wait_for_timeout(200)
        page.select_option("#setChecksum", "sum")
        page.select_option("#setEndian", "le")
        page.click("[data-tab=device]")
        page.wait_for_timeout(250)
        prev_sum = page.evaluate("document.querySelector('#rawPreview').textContent")
        print("   default:", prev_default)
        print("   sum    :", prev_sum)
        check(prev_default.split("：")[-1] != prev_sum.split("：")[-1], "切换校验算法后预览帧变化")
        check("AA 55" in prev_default, "默认预览帧以 AA 55 开头")
        page.screenshot(path=os.path.join(OUT, "04-device.png"), full_page=True)

        # 日志区存在
        log_lines = page.eval_on_selector_all(".log__line", "els => els.length")
        print(f"    日志行数: {log_lines}")

        print("\n[E] 设置页渲染")
        page.click("[data-tab=settings]")
        page.wait_for_timeout(200)
        page.screenshot(path=os.path.join(OUT, "05-settings.png"), full_page=True)
        overflow2 = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check(overflow2 <= 1, f"设置页无横向溢出 (delta={overflow2}px)")

        # 切页动画后仪表盘仍正确
        page.click("[data-tab=dash]")
        page.wait_for_timeout(200)
        check(page.is_visible("#page-dash"), "可切回码表页")

        real_errors = [e for e in errors if "Web Bluetooth" not in e and "bluetooth" not in e.lower()]
        check(not real_errors, f"全程无 JS 错误（{real_errors[:3]}）")

        browser.close()

    print("\n================ 结果 ================")
    if failures:
        print(f"失败 {len(failures)} 项")
        for f in failures:
            print(" -", f)
        sys.exit(1)
    print("全部通过 ✓")


if __name__ == "__main__":
    run()