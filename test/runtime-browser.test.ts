// Optional native Chrome integration, exercised through the real MCP transport:
//   WALKMATE_E2E=1 node --test test/runtime-browser.test.ts
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { createReviewServer } from "../src/mcp/server.ts";

const enabled = process.env.WALKMATE_E2E === "1";
let app: Server, url: string;
const secret = "fixture-only-input";
process.env.WALKMATE_E2E_PASSWORD = secret;
const html = `<!doctype html><title>Runtime fixture</title>
<form><label>Email<input data-testid="email" value="stale"></label>
<label>Password<input data-testid="password" type="password"></label>
<label>Tier<select data-testid="tier"><option value="one">One</option><option value="two">Two</option></select></label>
<label>Remember<input data-testid="remember" type="checkbox"></label>
<button data-testid="login">Sign in</button></form>
<div data-testid="result">Not signed in</div>
<div data-testid="row-a"><button data-testid="duplicate" onclick="document.body.dataset.unsafe='yes'">Duplicate A</button></div>
<div data-testid="row-b"><button data-testid="duplicate" onclick="document.body.dataset.unsafe='yes'">Duplicate B</button></div>
<button data-testid="popup" onclick="window.open('/popup')">Open popup</button>
<button data-testid="dialog" onclick="if(confirm('Confirm fixture action?')) document.body.dataset.unsafe='yes'">Confirm</button>
<div style="height:1800px">Scrollable fixture</div>
<script>
document.querySelector('form').onsubmit=async(e)=>{
 e.preventDefault();
 const email=document.querySelector('[data-testid=email]').value;
 const password=document.querySelector('[data-testid=password]').value;
 const tier=document.querySelector('[data-testid=tier]').value;
 const remember=document.querySelector('[data-testid=remember]').checked;
 await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
 document.querySelector('[data-testid=result]').textContent='Signed in: '+email+' / '+tier+' / '+remember+' / trusted='+e.isTrusted;
};
</script>`;

before(async () => {
	if (!enabled) return;
	app = createServer((req, res) => {
		if (req.url === "/api/login") {
			req.resume();
			setTimeout(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); }, 150);
		} else {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(req.url === "/popup" ? '<!doctype html><title>Popup</title><p data-testid="popup-result">Popup ready</p>' :
				req.url === "/second" ? '<!doctype html><title>Second</title><p data-testid="second-result">Second page ready</p>' : html);
		}
	});
	await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
	const address = app.address();
	assert.ok(address && typeof address !== "string");
	url = `http://127.0.0.1:${address.port}/`;
});
after(async () => { if (enabled) await new Promise<void>((resolve) => app.close(() => resolve())); });
const textOf = (r: CallToolResult) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const target = (value: string) => ({ kind: "testid", value });

async function connect(t: TestContext, allow_actions = true, timeout_sec = 30, initialUrl = url) {
	const cwd = await mkdtemp(join(tmpdir(), "walkmate-runtime-browser-"));
	const { server, shutdown } = createReviewServer({ cwd });
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "runtime-e2e", version: "0" });
	await Promise.all([server.connect(a), client.connect(b)]);
	t.after(async () => { await shutdown(); await client.close(); await rm(cwd, { recursive: true, force: true }); });
	const started = await client.callTool({ name: "run_start", arguments: {
		url: initialUrl, title: "Native runtime test", allow_actions, isolated: true, headless: true, timeout_sec,
		source_recording: join(cwd, ".walkmate", "reviews", "demonstration"),
	} });
	assert.ok(!started.isError, textOf(started));
	const info = JSON.parse(textOf(started));
	assert.equal(info.id, "u1");
	assert.ok(info.dir.startsWith(join(cwd, ".walkmate", "runs")));
	assert.ok(started.content.some((content) => content.type === "image"));
	return {
		client, info, cwd,
		async step(action: Record<string, unknown>, ok = true) {
			const result = await client.callTool({ name: "run_step", arguments: { id: info.id, action } });
			assert.equal(result.isError === true, !ok, textOf(result));
			return JSON.parse(textOf(result));
		},
		async finish(cancel = false) {
			const result = await client.callTool({ name: "run_finish", arguments: { id: info.id, cancel } });
			assert.ok(!result.isError, textOf(result));
			return JSON.parse(textOf(result));
		},
	};
}

test("native MCP runtime fills, selects, checks, clicks, waits, asserts, switches tabs and saves replay evidence", { skip: !enabled }, async (t) => {
	const run = await connect(t);
	const ref = run.info.snapshot.elements.find((el: { testid: string }) => el.testid === "email").ref;
	await run.step({ type: "fill", target: { kind: "ref", value: ref }, value: "runtime@example.invalid", source_step: "login-email" });
	await run.step({ type: "fill", target: target("password"), value_env: "WALKMATE_E2E_PASSWORD", source_step: "login-password" });
	await run.step({ type: "select", target: target("tier"), value: "two" });
	await run.step({ type: "check", target: target("remember"), checked: true });
	await run.step({ type: "check", target: target("remember"), checked: true });
	await run.step({ type: "press", target: target("email"), key: "Tab" });
	await run.step({ type: "click", target: target("login"), source_step: "login-submit" });
	await run.step({ type: "wait", target: target("result"), condition: "text", expected: "Signed in:" });
	const verified = await run.step({ type: "assert", target: target("result"), condition: "text", expected: "runtime@example.invalid / two / true / trusted=true" });
	assert.equal(JSON.stringify(verified.snapshot).includes(secret), false);
	await run.step({ type: "scroll", delta_y: 500 });
	await run.step({ type: "click", target: target("popup") });
	let state = await run.step({ type: "observe" });
	for (let i = 0; i < 30 && state.snapshot.tabs.length < 2; i++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		state = await run.step({ type: "observe" });
	}
	const popup = state.snapshot.tabs.find((tab: { url: string }) => tab.url.endsWith("/popup"));
	assert.ok(popup, JSON.stringify(state.snapshot.tabs));
	await run.step({ type: "wait", tab: popup.id, target: target("popup-result"), condition: "visible" });
	await run.step({ type: "assert", target: target("popup-result"), condition: "text", expected: "Popup ready" });
	const done = await run.finish();
	assert.equal(done.status, "passed");
	assert.equal(done.assertions, 2);
	assert.equal(done.failures, 0);
	const replay = await readFile(done.replay, "utf8");
	assert.match(replay, /login-submit/);
	assert.match(replay, /rrweb.Replayer/);
	const steps = await readFile(join(done.dir, "steps.json"), "utf8");
	assert.equal(steps.includes(secret), false);
	for (const step of JSON.parse(steps)) {
		if (step.action.value !== undefined) assert.equal(step.action.value, "[redacted]");
	}
	assert.match(steps, /\[redacted\]/);
	const events = await readFile(join(done.dir, "events.json"), "utf8");
	assert.equal(JSON.parse(events).clips.length, 0);
	const streams = (await readdir(done.dir)).filter((file) => file.startsWith("rrweb-tab"));
	for (const file of streams) assert.equal((await readFile(join(done.dir, file), "utf8")).includes(secret), false);
});

test("blank execution session can navigate and record without a predefined target", { skip: !enabled }, async (t) => {
	const run = await connect(t, true, 30, "about:blank");
	assert.equal(run.info.snapshot.url, "about:blank");
	assert.equal(run.info.snapshot.elements.length, 0);
	await run.step({ type: "navigate", url });
	await run.step({ type: "wait", target: target("email"), condition: "visible" });
	const done = await run.finish();
	assert.equal(done.status, "completed");
	assert.ok(done.replay);
});

test("scope disambiguates repeated row controls and absent credential bindings fail safely", { skip: !enabled }, async (t) => {
	const run = await connect(t);
	await run.step({ type: "click", target: { ...target("duplicate"), scope: '[data-testid="row-b"]' } });
	await run.step({ type: "assert", target: { kind: "css", value: 'body[data-unsafe="yes"]' }, condition: "visible" });
	assert.equal((await run.finish()).status, "passed");
	const missing = await connect(t);
	const failure = await missing.step({ type: "fill", target: target("password"), value_env: "WALKMATE_E2E_NOT_CONFIGURED" }, false);
	assert.match(failure.step.error, /environment variable is not configured/);
	assert.equal((await missing.finish()).status, "failed");
});

test("observe-only run rejects UI mutations before dispatch", { skip: !enabled }, async (t) => {
	const run = await connect(t, false);
	const denied = await run.client.callTool({ name: "run_step", arguments: { id: run.info.id, action: { type: "click", target: target("login") } } });
	assert.equal(denied.isError, true);
	assert.match(textOf(denied), /not authorized/);
	await run.step({ type: "assert", target: target("result"), condition: "text", expected: "Not signed in" });
	const done = await run.finish();
	assert.equal(done.steps, 1);
	assert.equal(done.failures, 0);
});

test("ambiguous targets fail without dispatch and failures cannot be silently retried", { skip: !enabled }, async (t) => {
	const run = await connect(t);
	const failed = await run.step({ type: "click", target: target("duplicate") }, false);
	assert.match(failed.step.error, /matches 2 elements/);
	assert.ok(failed.snapshot);
	const retry = await run.client.callTool({ name: "run_step", arguments: { id: run.info.id, action: { type: "click", target: target("login") } } });
	assert.equal(retry.isError, true);
	assert.match(textOf(retry), /previous step failed/);
	await run.step({ type: "observe" });
	const done = await run.finish();
	assert.equal(done.status, "failed");
	assert.equal(done.failures, 1);
	assert.ok(done.replay);
});

test("refs do not survive document navigation", { skip: !enabled }, async (t) => {
	const run = await connect(t);
	const ref = run.info.snapshot.elements.find((el: { testid: string }) => el.testid === "email").ref;
	await run.step({ type: "navigate", url: url + "second" });
	await run.step({ type: "assert", target: target("second-result"), condition: "text", expected: "Second page ready" });
	const failed = await run.step({ type: "fill", target: { kind: "ref", value: ref }, value: "must-not-type" }, false);
	assert.match(failed.step.error, /Stale element ref/);
	assert.equal((await run.finish()).status, "failed");
});

test("failed assertions are recorded and a run without assertions is not marked passed", { skip: !enabled }, async (t) => {
	const run = await connect(t);
	await run.step({ type: "assert", target: target("result"), condition: "text", expected: "Impossible result" }, false);
	assert.equal((await run.finish()).status, "failed");
	const completed = await connect(t);
	await completed.step({ type: "observe" });
	assert.equal((await completed.finish()).status, "completed");
});

test("step timeout stops the browser and preserves partial evidence", { skip: !enabled }, async (t) => {
	const run = await connect(t);
	await run.step({ type: "wait", target: target("missing"), condition: "visible", timeout_ms: 500 }, false);
	const done = await run.finish();
	assert.equal(done.status, "timeout");
	assert.equal(done.failures, 1);
	assert.ok(done.replay);
	assert.equal(JSON.parse(await readFile(join(done.dir, "steps.json"), "utf8")).length, 1);
});

test("cancel interrupts an in-progress step and dialogs are dismissed, never accepted", { skip: !enabled }, async (t) => {
	const run = await connect(t);
	const pending = run.client.callTool({ name: "run_step", arguments: { id: run.info.id, action: { type: "wait", target: target("missing"), condition: "visible" } } });
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal((await run.finish(true)).status, "cancelled");
	assert.equal((await pending).isError, true);
	const dialog = await connect(t);
	await dialog.step({ type: "click", target: target("dialog") }, false);
	const done = await dialog.finish();
	assert.equal(done.status, "failed");
	assert.ok(done.warnings.some((warning: string) => warning.includes("dialog")));
});
