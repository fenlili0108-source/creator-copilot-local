import os
import re
from pathlib import Path

from playwright.sync_api import sync_playwright


BASE_URL = os.environ.get("OWNER_STUDIO_BASE_URL", "http://127.0.0.1:4316")
OUT_DIR = Path(os.environ.get("OWNER_STUDIO_QA_DIR", "/tmp/creator-copilot-owner-studio-qa"))
CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def assert_no_horizontal_overflow(page, label: str) -> None:
    overflow = page.evaluate(
        """() => ({
          viewport: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
          body: document.body.scrollWidth
        })"""
    )
    if overflow["scroll"] > overflow["viewport"] + 1 or overflow["body"] > overflow["viewport"] + 1:
        raise AssertionError(f"{label} has horizontal overflow: {overflow}")


def run_owner_flow(page) -> None:
    page.goto(BASE_URL)
    page.wait_for_load_state("networkidle")
    page.get_by_role("heading", name="从你的资料和实拍开始，做完一条视频。").wait_for()
    page.get_by_role("button", name=re.compile("使用.*演示资料")).click()
    page.get_by_text("9/9 项已完成").wait_for()
    page.get_by_role("button", name=re.compile("保存资料，决定这条视频")).click()
    page.get_by_role("heading", name="这条视频，想让谁看完做什么？").wait_for()
    page.get_by_label("最值得拍的一个步骤是什么？").fill("凌晨四点半先揉面，再开始现包。")
    page.get_by_role("button", name=re.compile("生成第一版脚本")).click()
    page.get_by_role("heading", name="脚本已经按你的资料填好").wait_for()
    page.get_by_text("资料快照：王姐演示资料", exact=True).wait_for()
    page.get_by_label("编辑“关键过程”台词").wait_for()
    page.get_by_text(re.compile("凌晨四点半先揉面")).wait_for()
    page.screenshot(path=str(OUT_DIR / "owner-studio-script-desktop.png"), full_page=True)
    page.get_by_role("button", name=re.compile("换一版")).click()
    page.get_by_role("tab", name=re.compile("v2")).wait_for()
    page.get_by_role("button", name=re.compile("确认脚本，自动匹配素材")).click()
    page.get_by_text("4/5", exact=True).wait_for()
    page.get_by_role("button", name="先看报价", exact=True).click()
    page.get_by_text("5/5", exact=True).wait_for()
    page.get_by_role("button", name=re.compile("镜头已齐，进入拼合")).click()
    page.get_by_text(re.compile("正式导出前仍需复核授权")).wait_for()
    page.get_by_role("button", name="一键拼合", exact=True).click()
    page.get_by_text("拼合提案 v1 已就绪", exact=True).first.wait_for(timeout=5000)
    assert_no_horizontal_overflow(page, "desktop owner flow")
    page.screenshot(path=str(OUT_DIR / "owner-studio-flow-desktop.png"), full_page=True)


def run_narrow_profile(page) -> None:
    page.set_viewport_size({"width": 390, "height": 844})
    page.goto(BASE_URL)
    page.wait_for_load_state("networkidle")
    page.get_by_role("button", name=re.compile("使用.*演示资料")).click()
    page.get_by_text("9/9 项已完成").wait_for()
    assert_no_horizontal_overflow(page, "narrow owner profile")
    page.screenshot(path=str(OUT_DIR / "owner-studio-profile-narrow.png"), full_page=True)


def run_architecture_qa(page) -> None:
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.goto(f"{BASE_URL}/docs/Owner-Creator-Workflow-Architecture-v0.3.html")
    page.wait_for_load_state("networkidle")
    page.get_by_role("heading", name=re.compile("原点.*老板创作流水线")).wait_for()
    nodes = page.locator(".node")
    if nodes.count() < 32:
        raise AssertionError(f"expected at least 32 architecture nodes, got {nodes.count()}")
    for index in [0, 4, 10, 19, 23, 27]:
        nodes.nth(index).click()
        page.locator("#overlay:not([hidden])").wait_for()
        page.keyboard.press("Escape")
        page.locator("#overlay:not([hidden])").wait_for(state="hidden")
    page.get_by_role("tab", name="创作对象体系").click()
    page.locator(".domain-group").first.wait_for()
    page.get_by_role("tab", name="关键场景").click()
    page.locator(".scenario-card").nth(3).wait_for()
    page.get_by_role("tab", name="产品架构").click()
    page.locator(".layer").nth(5).wait_for()
    page.wait_for_timeout(700)
    assert_no_horizontal_overflow(page, "desktop architecture")
    page.screenshot(path=str(OUT_DIR / "owner-workflow-architecture-desktop.png"), full_page=True, animations="disabled")
    page.emulate_media(media="print")
    page.locator(".scenario-card").first.wait_for()
    page.emulate_media(media="screen")
    page.set_viewport_size({"width": 390, "height": 844})
    page.get_by_role("tab", name="产品架构").click()
    assert_no_horizontal_overflow(page, "narrow architecture")
    page.screenshot(path=str(OUT_DIR / "owner-workflow-architecture-narrow.png"), full_page=True, animations="disabled")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    console_errors: list[str] = []
    page_errors: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=CHROME_PATH)
        page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
        page.on("console", lambda message: console_errors.append(message.text) if message.type == "error" else None)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        run_owner_flow(page)
        run_narrow_profile(page)
        run_architecture_qa(page)
        browser.close()
    if console_errors or page_errors:
        raise AssertionError(f"browser errors: console={console_errors}, page={page_errors}")
    print(f"owner studio UI + architecture smoke passed; screenshots: {OUT_DIR}")


if __name__ == "__main__":
    main()
