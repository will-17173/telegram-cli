"""Run with the system Python Playwright after `pnpm build`.

Uses isolated local data and mocked Telegram mutations; never opens a real session.
"""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright, expect


ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = Path(tempfile.mkdtemp(prefix="tg-desktop-browser-"))
DATA = Path(tempfile.mkdtemp(prefix="tg-desktop-fixture-"))
accounts = {
    "version": 2,
    "current_account": "work",
    "accounts": [
        {"name": "work", "user_id": 100001, "username": "qa_work", "phone": "15555550101", "display_name": "工作账号 QA", "auth_state": "authenticated"},
        {"name": "personal", "user_id": 100002, "username": "qa_personal", "phone": "15555550102", "display_name": "个人账号 QA", "auth_state": "logged_out"},
    ],
}
(DATA / "accounts.json").write_text(json.dumps(accounts), encoding="utf-8")
for account in accounts["accounts"]:
    directory = DATA / "accounts" / account["name"]
    directory.mkdir(parents=True)
    (directory / "session").write_text("fixture only", encoding="utf-8")
seed = """
import { MessageDB } from './src/storage/message-db.ts'
import { join } from 'node:path'
const db = new MessageDB(join(process.env.TG_QA_DATA, 'accounts/work/messages.db'))
for (let index = 1; index <= 6; index++) db.upsertMessage({
  platform: 'telegram', chat_id: 100, chat_name: '产品讨论组 QA', msg_id: index,
  sender_id: index % 2 ? 10 : 20, sender_name: index % 2 ? 'Alice QA' : 'Ben QA',
  content: index === 6 ? '桌面端功能工作区已经准备就绪。' : `测试消息 ${index}：项目讨论与同步记录`,
  timestamp: `2026-10-13T04:00:0${index}.000Z`, reply_to_msg_id: null,
  media_group_id: null, raw_json: null, attachments: [],
})
db.close()
"""
subprocess.run(["node", "--import", "tsx", "--input-type=module", "-e", seed], cwd=ROOT, env={**os.environ, "TG_QA_DATA": str(DATA)}, check=True)
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
base = f"http://127.0.0.1:{port}"
log = (ARTIFACTS / "server.log").open("w", encoding="utf-8")
environment = {**os.environ, "DATA_DIR": str(DATA)}
environment.pop("DB_PATH", None)
server = subprocess.Popen(["node", "--import", "tsx", "src/index.ts", "web", "--port", str(port), "--no-open"], cwd=ROOT, env=environment, stdout=log, stderr=log)
tasks = {}
requests = []
auth = None
auth_starts = []
runtime = {"status": "stopped", "started_at": None, "queue_length": 0, "error": None}


def fulfill(route, data, status=200):
    route.fulfill(status=status, content_type="application/json", body=json.dumps({"ok": True, "data": data}))


def task_routes(route):
    path = route.request.url.split("/api/workspace/tasks", 1)[1]
    method = route.request.method
    if path == "" and method == "GET":
        fulfill(route, [{**task, "stdout": "", "stderr": "", "result": None} for task in reversed(list(tasks.values()))])
    elif path == "" and method == "POST":
        body = route.request.post_data_json
        requests.append(body)
        identifier = f"qa-task-{len(tasks) + 1}"
        listening = body["commandId"] == "listen"
        failed = body["commandId"] == "group member ban"
        result = None if listening else {"ok": False, "error": {"code": "permission_denied", "message": "QA permission failure"}} if failed else {"ok": True, "data": {"sent": True, "msg_id": 42, "chat": body.get("arguments", {}).get("chat", "@qa")}}
        tasks[identifier] = {"id": identifier, "commandId": body["commandId"], "account": body.get("account"), "status": "running" if listening else "failed" if failed else "succeeded", "startedAt": "2026-10-13T04:30:00.000Z", "finishedAt": None if listening else "2026-10-13T04:30:01.000Z", "exitCode": None if listening else 1 if failed else 0, "stdout": "Listening for incoming messages…\n" if listening else "", "stderr": "", "result": result, "truncated": False}
        fulfill(route, tasks[identifier])
    elif path.endswith("/send"):
        requests.append({"listen_send": route.request.post_data_json})
        fulfill(route, {"sent": True, "msg_id": 43})
    else:
        task = tasks[path.strip("/")]
        if method == "DELETE":
            task.update(status="cancelled", finishedAt="2026-10-13T04:31:00.000Z", exitCode=130)
        fulfill(route, task)


def auth_routes(route):
    global auth
    path = route.request.url.split("/api/auth/sessions", 1)[1]
    method = route.request.method
    if method == "GET":
        fulfill(route, auth)
    elif path == "" and method == "POST":
        body = route.request.post_data_json
        auth_starts.append(body)
        auth = {"id": f"qa-auth-{len(auth_starts)}", "status": "phone", **({"requestedAccount": body["account"]} if "account" in body else {})}
        fulfill(route, auth)
    elif method == "DELETE":
        auth["status"] = "cancelled"
        fulfill(route, auth)
    else:
        value = route.request.post_data_json["value"]
        if auth["status"] == "phone":
            auth.update(status="code", hint="Login code sent")
        elif auth["status"] == "code" and value == "00000":
            auth.update(hint="Invalid login code. Try again.")
        elif auth["status"] == "code":
            auth.update(status="password", hint="Enter your 2FA password")
        else:
            summary = accounts["accounts"][1]
            summary["auth_state"] = "authenticated"
            (DATA / "accounts.json").write_text(json.dumps(accounts), encoding="utf-8")
            auth.update(status="done", account=summary)
        fulfill(route, auth)


def select_operation(page, name):
    page.locator(".workspace-categories button").first.click()
    page.get_by_placeholder("Search operations").fill(name)
    target = page.locator(".workspace-operation-list button").filter(has=page.locator("code", has_text=name))
    # Use the exact code label where a parent command also matches its children.
    for index in range(target.count()):
        if target.nth(index).locator("code").inner_text() == name:
            target.nth(index).click()
            return
    target.first.wait_for()
    for index in range(target.count()):
        if target.nth(index).locator("code").inner_text() == name:
            target.nth(index).click()
            return
    raise AssertionError(f"No operation {name}")


def field(page, command, kind, name):
    from urllib.parse import quote
    return page.locator(f'[id="operation-{quote(command, safe="")}-{kind}-{quote(name, safe="")}"]')


try:
    for _ in range(100):
        if server.poll() is not None:
            raise RuntimeError((ARTIFACTS / "server.log").read_text(encoding="utf-8"))
        try:
            with urllib.request.urlopen(f"{base}/api/health", timeout=1) as response:
                if response.status == 200:
                    break
        except OSError:
            time.sleep(0.1)
    else:
        raise TimeoutError("The isolated web server did not become ready")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, channel="chrome")
        context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="en-US")
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.route("**/api/workspace/tasks**", task_routes)
        page.route("**/api/auth/**", auth_routes)
        page.goto(f"{base}/?lang=en")
        page.wait_for_load_state("networkidle")
        expect(page.get_by_text("产品讨论组 QA", exact=True).first).to_be_visible()
        page.get_by_label("Workspace view", exact=True).get_by_role("button", name="Operations", exact=True).click()
        page.get_by_placeholder("Search operations").wait_for()
        select_operation(page, "send")
        page.get_by_role("button", name="Run operation", exact=True).click()
        expect(page.locator(".workspace-error-summary")).to_be_visible()
        field(page, "send", "argument", "chat").fill("@qa")
        field(page, "send", "argument", "message").fill("first line\nsecond line")
        page.locator(".workspace-form-panel summary").click()
        field(page, "send", "option", "preview").uncheck()
        field(page, "send", "option", "file").fill("/tmp/a file.pdf")
        page.get_by_role("button", name="Run operation", exact=True).click()
        expect(page.locator(".workspace-task-heading")).to_contain_text("Completed")
        assert requests[-1]["arguments"]["message"] == "first line\nsecond line"
        assert requests[-1]["options"]["preview"] is False
        assert requests[-1]["options"]["file"] == ["/tmp/a file.pdf"]
        with page.expect_download() as download_info:
            page.get_by_role("button", name="Download JSON", exact=True).click()
        download_info.value.save_as(ARTIFACTS / "result.json")
        select_operation(page, "group member ban")
        field(page, "group member ban", "argument", "chat").fill("@qa")
        field(page, "group member ban", "argument", "user").fill("12345")
        count = len(requests)
        page.get_by_role("button", name="Run operation", exact=True).click()
        assert len(requests) == count
        page.locator("#operation-confirmation").check()
        page.get_by_role("button", name="Run operation", exact=True).click()
        expect(page.locator(".workspace-task-result")).to_contain_text("QA permission failure")
        select_operation(page, "group admin transfer-owner")
        expect(field(page, "group admin transfer-owner", "option", "ownershipPassword")).to_have_attribute("type", "password")
        select_operation(page, "listen")
        field(page, "listen", "argument", "chats").fill("@qa")
        page.get_by_role("button", name="Run operation", exact=True).click()
        composer = page.locator(".workspace-listen-composer")
        composer.wait_for()
        composer.locator("textarea").fill("Live reply\nsecond line")
        composer.locator("summary").click()
        composer.locator('[id$="-reply"]').fill("7")
        composer.get_by_role("button", name="Send message", exact=True).click()
        expect(composer).to_contain_text("Message sent")
        assert requests[-1]["listen_send"]["reply"] == 7
        assert requests[-1]["listen_send"]["text"] == "Live reply\nsecond line"
        page.locator(".workspace-task-heading button").click()
        expect(page.locator(".workspace-task-heading")).to_contain_text("Cancelled")
        page.get_by_role("button", name="Accounts", exact=True).click()
        page.locator(".account-card").filter(has=page.locator("code", has_text="personal")).get_by_role("button", name="Sign in", exact=True).click()
        page.locator("#account-auth-value").fill("+15555550102")
        page.locator(".account-detail-panel form button[type=submit]").first.click()
        expect(page.locator("#account-auth-value")).to_have_attribute("inputmode", "numeric")
        page.locator("#account-auth-value").fill("00000")
        page.locator(".account-detail-panel form button[type=submit]").first.click()
        expect(page.locator(".account-detail-panel")).to_contain_text("Invalid login code")
        page.locator("#account-auth-value").fill("12345")
        page.locator(".account-detail-panel form button[type=submit]").first.click()
        expect(page.locator("#account-auth-value")).to_have_attribute("type", "password")
        page.get_by_label("Workspace view", exact=True).get_by_role("button", name="Operations", exact=True).click()
        page.get_by_label("Workspace view", exact=True).get_by_role("button", name="Accounts", exact=True).click()
        expect(page.locator("#account-auth-value")).to_have_attribute("type", "password")
        page.locator("#account-auth-value").fill("fixture-password")
        page.locator(".account-detail-panel form button[type=submit]").first.click()
        expect(page.locator("#account-auth-value")).to_have_count(0)
        expect(page.locator(".topbar .account-picker select")).to_have_value("personal")
        page.locator(".language-picker select").select_option("zh-CN")
        page.screenshot(path=str(ARTIFACTS / "accounts.png"), full_page=True)
        page.get_by_role("button", name="功能工作区", exact=True).click()
        page.get_by_placeholder("搜索操作").fill("send")
        page.locator(".workspace-operation-list button").filter(has=page.locator("code", has_text="send")).first.click()
        page.screenshot(path=str(ARTIFACTS / "operations.png"), full_page=True)
        page.set_viewport_size({"width": 800, "height": 900})
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        page.screenshot(path=str(ARTIFACTS / "operations-800.png"), full_page=True)
        assert not errors, errors
        browser.close()
    print(json.dumps({"passed": True, "flows": ["messages", "validation", "send form", "result export", "confirmation", "structured error", "2FA field", "listen reply", "task cancel", "phone-code-2FA login", "login restore", "Chinese UI", "800px layout"], "artifacts": str(ARTIFACTS)}, ensure_ascii=False))
except Exception:
    print(f"Browser QA artifacts: {ARTIFACTS}")
    raise
finally:
    server.terminate()
    try:
        server.wait(timeout=10)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()
    log.close()
    shutil.rmtree(DATA)
