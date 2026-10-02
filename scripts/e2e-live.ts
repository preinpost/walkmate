// End-to-end check of the live review in headless Chrome.
//   node scripts/e2e-live.ts
// Serves a small app whose elements carry React-like fibers, drives it over CDP (record, hover,
// pin with a note, in-app navigation, full navigation, submit), feeds speech from `say -v Yuna`
// as the microphone, then prints the report and writes replay.html.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLiveReport } from "../src/core/live/report.ts";
import { writeReplay } from "../src/core/live/replay.ts";
import { runLiveSession } from "../src/core/live/session.ts";
import type { Recorder } from "../src/core/live/mic.ts";
import { configFromEnv, transcribeClips } from "../src/core/transcribe.ts";

const dir = mkdtempSync(join(tmpdir(), "walkmate-live-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const speech = join(dir, "speech.aiff");
execFileSync("say", [
	"-v",
	"Yuna",
	"-o",
	speech,
	"이 범례 색이 너무 비슷해서 구분이 안 돼요. [[slnc 1800]] 여기 숫자는 오른쪽 정렬해 주세요. [[slnc 1800]] 이 영역은 간격이 너무 좁아요. [[slnc 1800]] 청구서 화면은 로딩이 너무 길어요. [[slnc 1800]] PDF 미리보기는 글씨가 너무 작아요.",
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
<p><img id="logo" src="/logo.png" width="40" alt="로고"> <a id="inv" href="/invoice">청구서 보기</a> · <a id="full" href="/settings">설정</a> · <button id="pdf">PDF 미리보기</button></p>
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
  fetch("/api/invoice").then((r) => r.json()).then((j) => (document.getElementById("slow").textContent = "합계 " + j.total));
  fetch("/api/summary?month=10").then((r) => { if (!r.ok) console.error("청구 요약을 불러오지 못했습니다", r.status); });
};
document.getElementById("pdf").onclick = () => window.open("/doc.pdf");
</script></body></html>`;

const logo = join(dir, "logo.png");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=0x2f6fed:s=40x40", "-frames:v", "1", logo]);
const app = createServer(async (req, res) => {
	if (req.url === "/logo.png") return void res.writeHead(200, { "content-type": "image/png" }).end(readFileSync(logo));
	if (req.url === "/doc.pdf") return void res.writeHead(200, { "content-type": "application/pdf" }).end(tinyPdf("Invoice 2025-10  Total 1,234,000 KRW"));
	if (req.url === "/api/invoice") {
		await sleep(1500);
		return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: 42, total: "1,234,000원", items: 3 }));
	}
	if (req.url?.startsWith("/api/summary"))
		return void res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "db timeout", code: "E_DB" }));
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
	// The toolbar shortcuts use Cmd on macOS and Alt elsewhere (CDP modifiers: Alt=1, Meta=4).
	const mod = process.platform === "darwin" ? 4 : 1;
	const modKey = (code: string, key: string) =>
		Promise.all(
			["keyDown", "keyUp"].map((type) => cdp("Input.dispatchKeyEvent", { type, modifiers: mod, code, key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) })),
		);

	for (let i = 0; i < 50 && !(await js("!!document.querySelector('pi-review-toolbar')")); i++) await sleep(100);
	console.log("toolbar mounted:", await js("!!document.querySelector('pi-review-toolbar')"));

	await modKey("KeyR", "r"); // start recording
	await sleep(300);
	await move("#legend li");
	await sleep(3400);
	await modKey("KeyP", "p"); // pin mode
	await sleep(200);
	await click("#num");
	await sleep(300);
	await cdp("Input.insertText", { text: "오른쪽 정렬" });
	await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	await sleep(2400);
	// Area pin: Cmd/Alt+drag around the legend and the table, the way a person frames them, then a memo.
	const [x0, y0, x1, y1] = await js(`(() => { const a = document.querySelector("#legend").getBoundingClientRect(), b = document.querySelector("table").getBoundingClientRect(); return [Math.min(a.left, b.left) - 12, a.top - 8, b.right + 16, b.bottom + 10]; })()`);
	await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", buttons: 1, clickCount: 1, modifiers: mod });
	for (let i = 1; i <= 5; i++)
		await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: x0 + ((x1 - x0) * i) / 5, y: y0 + ((y1 - y0) * i) / 5, buttons: 1, modifiers: mod });
	await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", buttons: 0, clickCount: 1, modifiers: mod });
	await sleep(300);
	await cdp("Input.insertText", { text: "간격 넓히기" });
	await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
	await sleep(2400);
	await click("#inv");
	await sleep(400);
	await move("#slow");
	await sleep(3500);
	console.log("url after in-app nav:", await js("location.pathname"));
	// A PDF preview in a new tab: the session should switch to it and save a copy.
	await click("#pdf");
	await sleep(1500);
	// Pin on top of the PDF viewer: the glass has to catch the click, not the plugin.
	{
		const targets = (await fetch(`http://127.0.0.1:${control.port}/json/list`).then((r) => r.json())) as { url: string; type: string; webSocketDebuggerUrl: string }[];
		const pdfTab = targets.find((t) => t.type === "page" && t.url.endsWith("/doc.pdf"));
		if (pdfTab) {
			const w = new WebSocket(pdfTab.webSocketDebuggerUrl);
			await new Promise((r) => w.addEventListener("open", r, { once: true }));
			let n = 0;
			const send = (method: string, params: object) =>
				new Promise<void>((resolve) => {
					const my = ++n;
					w.addEventListener("message", function on(m) {
						if (JSON.parse(String(m.data)).id === my) {
							w.removeEventListener("message", on);
							resolve();
						}
					});
					w.send(JSON.stringify({ id: my, method, params }));
				});
			await send("Runtime.evaluate", { expression: "window.__piReviewPin(true)" });
			await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 500, y: 300 });
			await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 500, y: 300, button: "left", clickCount: 1 });
			await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 500, y: 300, button: "left", clickCount: 1 });
			await sleep(300);
			await send("Input.insertText", { text: "글씨 키우기" });
			await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
			w.close();
		} else console.log("pdf tab not found");
	}
	await sleep(5500);
	await cdp("Page.bringToFront");
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
	if (process.env.E2E_DEBUG) console.log("pins:", JSON.stringify(outcome.events.filter((e) => e.type === "pin"), null, 1));
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
	const replay = await writeReplay({
		dir,
		title: "E2E",
		t0: outcome.t0,
		rrweb: outcome.rrweb,
		clips: outcome.clips,
		utterances: report.utterances,
		assets: outcome.assets,
	});
	console.log("assets:", JSON.stringify(outcome.assets));
	console.log("replay uses saved assets:", replay ? readFileSync(replay, "utf8").includes("assets/") : false);
	console.log(`\n${report.full}\n`);
	console.log("attached:", report.attached.map((a) => a.file));
	console.log("replay:", replay);
} finally {
	app.close();
}

/** A one-page PDF with a line of ASCII text. */
function tinyPdf(text: string): Buffer {
	const content = `BT /F1 16 Tf 24 100 Td (${text}) Tj ET`;
	const objs = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objs.forEach((o, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}
