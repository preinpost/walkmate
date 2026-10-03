// Optional end-to-end check with the system Chrome: record a live demonstration, export it, run the exported test.
//   WALKMATE_E2E=1 node --test test/export-playwright-browser.test.ts
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportPlaywright } from "../src/core/live/export-playwright.ts";
import { runPlaywrightSpec } from "../src/core/live/run-playwright.ts";
import { runLiveSession } from "../src/core/live/session.ts";
import type { Recorder } from "../src/core/live/mic.ts";

const enabled = process.env.WALKMATE_E2E === "1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PASSWORD = "p@ss w0rd!";
const noMic: Recorder = async () => ({ startedAt: Date.now(), stop: async () => {} });

const LOGIN = `<!doctype html><meta charset="utf-8"><title>Login</title>
<form method="post" action="/login">
<label>이메일<input name="email" type="email"></label>
<label>비밀번호<input name="password" type="password"></label>
<label><input type="checkbox" name="remember"> 로그인 유지</label>
<label>플랜<select name="tier"><option value="free">Free</option><option value="pro">Pro</option></select></label>
<button>로그인</button>
</form><p id="error"></p><script>if(location.search.includes("error"))error.textContent="로그인 실패";</script>`;
const DASHBOARD = `<!doctype html><meta charset="utf-8"><title>Dashboard</title><h1>대시보드</h1>
<form id="search"><input id="q" placeholder="검색어"></form><p id="result"></p>
<ul><li data-testid="row-1">A <button onclick="done.textContent='삭제됨: A'">삭제</button></li>
<li data-testid="row-2">B <button onclick="done.textContent='삭제됨: B'">삭제</button></li></ul>
<p id="done"></p><button id="open" onclick="window.open('/popup')">새 창</button>
<script>search.onsubmit=(e)=>{e.preventDefault();history.pushState({},"","/dashboard?q="+encodeURIComponent(q.value));result.textContent="검색: "+q.value;};</script>`;
const POPUP = `<!doctype html><meta charset="utf-8"><title>Popup</title><button onclick="this.textContent='확인됨'">확인</button>`;

/** Minimal CDP client for one page target. */
async function connect(url: string) {
	const ws = new WebSocket(url);
	await new Promise((r) => ws.addEventListener("open", r, { once: true }));
	let id = 0;
	const pending = new Map<number, (v: any) => void>();
	ws.addEventListener("message", (m) => {
		const msg = JSON.parse(String(m.data));
		pending.get(msg.id)?.(msg.result);
	});
	const send = (method: string, params: object = {}) => new Promise<any>((resolve) => {
		const n = ++id;
		pending.set(n, resolve);
		ws.send(JSON.stringify({ id: n, method, params }));
	});
	const js = async (expression: string) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
	const click = async (selector: string) => {
		const [x, y] = await js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
		await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
		await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
		await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
		await sleep(250);
	};
	const type = async (text: string) => { await send("Input.insertText", { text }); await sleep(150); };
	const enter = async () => {
		await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
		await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
		await sleep(600);
	};
	const ready = async () => { for (let i = 0; i < 50 && !(await js("!!document.querySelector('pi-review-toolbar')")); i++) await sleep(100); };
	return { js, click, type, enter, ready, close: () => ws.close() };
}

test("a recorded login demonstration exports to a Playwright test that passes against the same app", { skip: !enabled, timeout: 180_000 }, async (t) => {
	const app = createServer((req, res) => {
		if (req.method === "POST" && req.url === "/login") {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				const f = new URLSearchParams(body);
				const ok = f.get("email") === "qa@example.com" && f.get("password") === PASSWORD && f.get("remember") === "on" && f.get("tier") === "pro";
				res.writeHead(303, { location: ok ? "/dashboard?u=qa" : "/login?error=1" }).end();
			});
			return;
		}
		const page = req.url?.startsWith("/dashboard") ? DASHBOARD : req.url === "/popup" ? POPUP : LOGIN;
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
	});
	await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
	t.after(() => new Promise<void>((r) => app.close(() => r())));
	const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

	const cwd = await mkdtemp(join(tmpdir(), "walkmate-export-e2e-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const dir = join(cwd, ".walkmate", "reviews", "mcp", "demo");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "request.json"), JSON.stringify({ title: "Login and delete", url: `${base}/login`, isolated: true, record_inputs: true }));

	let control: { port: number; targetId: string } | undefined;
	const session = runLiveSession({
		url: `${base}/login`, title: "Login and delete", points: [], dir, recorder: noMic, recordInputs: true,
		userDataDir: join(cwd, "chrome"), headless: true, onReady: (info) => (control = info),
	});
	try {
		for (let i = 0; i < 100 && !control; i++) await sleep(50);
		assert.ok(control, "session started");
		const page = await connect(`ws://127.0.0.1:${control.port}/devtools/page/${control.targetId}`);
		await page.ready();
		await page.click("input[name=email]");
		await page.type("qa@example.com");
		await page.click("input[name=remember]");
		await page.js(`(() => { const s = document.querySelector("select"); s.focus(); s.value = "pro"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
		await page.click("input[name=password]");
		await page.type(PASSWORD);
		await page.enter();
		await sleep(800);
		await page.ready();
		assert.match(await page.js("location.pathname"), /dashboard/, "logged in during the demonstration");
		await page.click("#q");
		await page.type("청구서");
		await page.enter();
		await page.click("[data-testid=row-2] button");
		// Pin the outcome: it becomes a visibility check.
		await page.js("window.__piReviewPin(true)");
		await page.click("#done");
		await page.type("B가 지워져야 함");
		await page.enter();
		await page.click("#open");
		await sleep(1500);
		const targets = (await fetch(`http://127.0.0.1:${control.port}/json/list`).then((r) => r.json())) as { url: string; webSocketDebuggerUrl: string }[];
		const popupTarget = targets.find((x) => x.url.endsWith("/popup"));
		assert.ok(popupTarget, "popup opened");
		const popup = await connect(popupTarget.webSocketDebuggerUrl);
		await popup.ready();
		await popup.click("button");
		popup.close();
		await sleep(500);
		await page.js(`window.__piReview(JSON.stringify({ kind: "cmd", cmd: "submit" }))`);
		page.close();
	} finally {
		const outcome = await session;
		await writeFile(join(dir, "events.json"), JSON.stringify(outcome, null, 2));
	}

	// An ESM project with no node_modules: Walkmate's own Playwright runs the exported test.
	await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "app", type: "module" }));
	const result = await exportPlaywright(undefined, { cwd });
	const code = await readFile(result.path, "utf8");
	assert.equal(result.path, join(cwd, "e2e", "login-and-delete.spec.ts"));
	assert.equal(result.credentials, true, code);
	for (const expected of [
		'getByRole("textbox", { name: "이메일", exact: true }).fill("qa@example.com")',
		`getByLabel("비밀번호", { exact: true }).fill(${JSON.stringify(PASSWORD)})`,
		'getByRole("checkbox", { name: "로그인 유지", exact: true }).check()',
		'.selectOption("pro")',
		'.press("Enter")',
		`await expect(page).toHaveURL("${base}/dashboard?u=qa")`,
		'getByTestId("row-2").getByRole("button", { name: "삭제", exact: true }).click()',
		'page.waitForEvent("popup")',
		'await page2.getByRole("button", { name: "확인", exact: true }).click()',
		"toBeVisible()",
	]) assert.ok(code.includes(expected), `missing ${expected}\n\n${code}`);
	assert.doesNotMatch(code, /getByRole\("button", \{ name: "로그인"/, "implicit submission is not clicked twice");

	const run = await runPlaywrightSpec({ cwd, spec: result.path });
	assert.equal(run.status, "passed", `${JSON.stringify(run.tests, null, 2)}\n${run.output}\n\n${code}`);
	assert.equal(run.tests.length, 1);
	assert.ok(run.replay, "the run is recorded with withWalkmate");
	assert.ok(run.tests[0].replay && existsSync(run.tests[0].replay), "each test leaves replay.html");
	assert.ok(run.tests[0].run?.startsWith(join(cwd, ".walkmate", "runs")), "the recording lives in the project's .walkmate/runs");
	assert.equal(run.tests[0].replay, join(run.tests[0].run!, "replay.html"));
	for (const f of ["run.json", "steps.json", "network.json", "console.json"]) assert.ok(existsSync(join(run.tests[0].run!, f)), f);
	assert.equal(existsSync(join(cwd, "node_modules")), false, "nothing was installed in the project");

	// A wrong value fails at the step that uses it, with evidence.
	await writeFile(result.path, code.replace(JSON.stringify(PASSWORD), 'process.env.TEST_PASSWORD ?? ""'));
	const wrong = await runPlaywrightSpec({ cwd, spec: result.path, env: { TEST_PASSWORD: "wrong" }, testTimeoutSec: 15 });
	assert.equal(wrong.status, "failed");
	assert.match(wrong.tests[0].failedStep ?? "", /Enter: 비밀번호/);
	assert.match(wrong.tests[0].error ?? "", /toHaveURL/);
	assert.ok(wrong.tests[0].attachments.some((a) => a.name === "screenshot"));
	const right = await runPlaywrightSpec({ cwd, spec: result.path, env: { TEST_PASSWORD: PASSWORD } });
	assert.equal(right.status, "passed", right.output);
});
