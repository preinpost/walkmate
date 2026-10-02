// End-to-end check of the live review in headless Chrome.
//   node scripts/e2e-live.ts
// Serves a small app whose elements carry React-like fibers, drives it over CDP (record, hover,
// pin with a note, in-app navigation, full navigation, submit), feeds speech from `say -v Yuna`
// as the microphone, then prints the report and writes replay.html.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLiveReport } from "../src/core/live/report.ts";
import { writeReplay } from "../src/core/live/replay.ts";
import { runLiveSession } from "../src/core/live/session.ts";
import type { Recorder } from "../src/core/live/mic.ts";
import { configFromEnv, transcribeClips } from "../src/core/transcribe.ts";

const dir = mkdtempSync(join(tmpdir(), "prr-live-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const speech = join(dir, "speech.aiff");
execFileSync("say", [
	"-v",
	"Yuna",
	"-o",
	speech,
	"이 범례 색이 너무 비슷해서 구분이 안 돼요. [[slnc 1800]] 여기 숫자는 오른쪽 정렬해 주세요. [[slnc 1800]] 청구서 화면은 로딩이 너무 길어요.",
]);

// The "microphone" plays the speech from the moment recording starts.
const fakeMic: Recorder = async (file) => {
	const startedAt = Date.now();
	return {
		startedAt,
		stop: async () => {
			execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", speech, "-ar", "48000", "-ac", "1", "-c:a", "flac", file]);
		},
	};
};

const APP = `<!doctype html><html><head><meta charset="utf-8"><title>Watcher test</title>
<style>body{font:15px sans-serif;margin:40px} li{padding:6px} td{padding:6px 14px;border:1px solid #ddd} #slow{margin-top:30px}</style></head>
<body><h1 id="h">대시보드</h1>
<ul id="legend"><li>Compute</li><li>Storage</li></ul>
<table><tr><td>서비스</td><td id="num">1,234,000원</td></tr></table>
<p><a id="inv" href="/invoice">청구서 보기</a> · <a id="full" href="/settings">설정</a></p>
<div id="slow"></div>
<script>
const fiber = (el, name, file) => {
  const Comp = { [name]: function () {} }[name];
  const Page = function DashboardPage() {};
  el["__reactFiber$test"] = { type: el.tagName.toLowerCase(), return: { type: Comp, return: { type: Page, return: null } },
    _debugStack: { stack: "Error\\n    at jsxDEV (" + location.origin + "/node_modules/.vite/deps/react_jsx-dev-runtime.js:1:1)\\n    at " + name + " (" + location.origin + "/src/" + file + "?t=1:12:9)" } };
};
document.querySelectorAll("#legend li").forEach((li) => fiber(li, "ServiceUsageChart", "features/dashboard/chart/ServiceUsageChart.tsx"));
fiber(document.getElementById("num"), "InvoiceTable", "features/dashboard/table/InvoiceTable.tsx");
document.getElementById("inv").onclick = (e) => {
  e.preventDefault();
  history.pushState({}, "", "/invoice");
  document.getElementById("h").textContent = "청구서";
  document.getElementById("slow").textContent = "불러오는 중…";
};
</script></body></html>`;

const app = createServer((req, res) => {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "script-src 'self' 'unsafe-inline'" });
	res.end(req.url === "/settings" ? `<!doctype html><meta charset="utf-8"><h1>설정</h1><button>저장</button>` : APP);
});
await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;

let control: { port: number; targetId: string } | undefined;
const session = runLiveSession({
	url: `${base}/dashboard`,
	title: "E2E 라이브 리뷰",
	points: [
		{ id: "p1", title: "차트 색상" },
		{ id: "p2", title: "청구서 로딩", url: "/invoice" },
	],
	dir,
	recorder: fakeMic,
	userDataDir: join(dir, "chrome"),
	headless: true,
	shotEveryMs: 700,
	onReady: (info) => (control = info),
});

try {
	for (let i = 0; i < 100 && !control; i++) await sleep(50);
	if (!control) throw new Error("session did not start");
	const ws = new WebSocket(`ws://127.0.0.1:${control.port}/devtools/page/${control.targetId}`);
	await new Promise((r) => ws.addEventListener("open", r, { once: true }));
	let id = 0;
	const pending = new Map<number, (v: any) => void>();
	ws.addEventListener("message", (m) => {
		const msg = JSON.parse(String(m.data));
		pending.get(msg.id)?.(msg.result);
	});
	const cdp = (method: string, params: object = {}) =>
		new Promise<any>((resolve) => {
			const n = ++id;
			pending.set(n, resolve);
			ws.send(JSON.stringify({ id: n, method, params }));
		});
	const js = async (expr: string) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }))?.result?.value;
	const center = async (sel: string): Promise<[number, number]> =>
		js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
	const move = async (sel: string) => {
		const [x, y] = await center(sel);
		await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
		return [x, y];
	};
	const click = async (sel: string) => {
		const [x, y] = await move(sel);
		await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
		await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
	};
	const altKey = (code: string, key: string) =>
		Promise.all(
			["keyDown", "keyUp"].map((type) => cdp("Input.dispatchKeyEvent", { type, modifiers: 1, code, key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) })),
		);

	for (let i = 0; i < 50 && !(await js("!!document.querySelector('pi-review-toolbar')")); i++) await sleep(100);
	console.log("toolbar mounted:", await js("!!document.querySelector('pi-review-toolbar')"));

	await altKey("KeyR", "r"); // start recording
	await sleep(300);
	await move("#legend li");
	await sleep(3400);
	await altKey("KeyP", "p"); // pin mode
	await sleep(200);
	await click("#num");
	await sleep(300);
	await cdp("Input.insertText", { text: "오른쪽 정렬" });
	await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	await sleep(2600);
	await click("#inv");
	await sleep(400);
	await move("#slow");
	await sleep(3500);
	console.log("url after in-app nav:", await js("location.pathname"));
	await click("#full");
	await sleep(1500);
	console.log("toolbar after full nav:", await js("!!document.querySelector('pi-review-toolbar')"));

	// A tab the reviewer opens is instrumented too.
	await cdp("Runtime.evaluate", { expression: `window.open(location.origin + "/settings?tab=2")`, userGesture: true });
	await sleep(1500);
	const list = (await fetch(`http://127.0.0.1:${control.port}/json/list`).then((r) => r.json())) as { id: string; url: string; webSocketDebuggerUrl: string }[];
	const other = list.find((t) => t.url.includes("tab=2"));
	if (other) {
		const ws2 = new WebSocket(other.webSocketDebuggerUrl);
		await new Promise((r) => ws2.addEventListener("open", r, { once: true }));
		const res = await new Promise<any>((resolve) => {
			ws2.addEventListener("message", (m) => resolve(JSON.parse(String(m.data))), { once: true });
			ws2.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "!!document.querySelector('pi-review-toolbar')", returnByValue: true } }));
		});
		console.log("toolbar in new tab:", res.result?.result?.value);
		ws2.close();
	} else console.log("toolbar in new tab: tab not found");
	await js(`window.__piReview(JSON.stringify({ kind: "cmd", cmd: "submit" }))`);
	ws.close();

	const outcome = await session;
	console.log("status:", outcome.status, "| events:", outcome.events.length, "| shots:", outcome.shots.length, "| clips:", outcome.clips.length, "| rrweb:", outcome.rrweb.length);

	const transcript = await transcribeClips(outcome.clips, configFromEnv());
	const report = await buildLiveReport({
		title: "E2E 라이브 리뷰",
		url: `${base}/dashboard`,
		points: [
			{ id: "p1", title: "차트 색상" },
			{ id: "p2", title: "청구서 로딩", url: "/invoice" },
		],
		outcome,
		words: transcript.words,
		engine: transcript.engine,
		warnings: transcript.warnings,
		dir,
		maxShots: 6,
	});
	const replay = await writeReplay({ dir, title: "E2E", t0: outcome.t0, rrweb: outcome.rrweb, clips: outcome.clips, utterances: report.utterances });
	console.log(`\n${report.full}\n`);
	console.log("attached:", report.attached.map((a) => a.file));
	console.log("replay:", replay);
} finally {
	app.close();
}
