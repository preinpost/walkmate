// End-to-end check of the review page in headless Chrome with a fake microphone.
//   node scripts/e2e.ts            # speech from `say -v Yuna`
// Drives the page over CDP: record, scroll, hover a diff line, select text, answer, comment, submit.
// Then transcribes with whatever engine is configured and prints the report.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDiffs, renderPage } from "../src/core/render.ts";
import { newToken, startReviewServer } from "../src/core/server.ts";
import { buildReport } from "../src/core/timeline.ts";
import { configFromEnv, transcribeClips } from "../src/core/transcribe.ts";
import type { ReviewRequest } from "../src/core/types.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const dir = mkdtempSync(join(tmpdir(), "prr-e2e-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Speech that refers to "this" while the script points at things.
const wav = join(dir, "speech.wav");
execFileSync("say", ["-v", "Yuna", "-o", join(dir, "speech.aiff"), "음 이 결정은 좀 이상한데요. [[slnc 1500]] 만료는 한 시간으로 할게요. [[slnc 1500]] 아 여기서 쓰는구나, 그럼 괜찮아요."]);
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(dir, "speech.aiff"), "-ar", "48000", "-ac", "1", wav]);

const req: ReviewRequest = {
	title: "E2E 리뷰",
	summary: "인증 흐름을 바꿨습니다.",
	sections: [
		{ id: "d1", kind: "decision", title: "user_id를 nullable로 변경", body: "익명 세션을 허용하려고 `user_id INTEGER NULL`로 바꿨습니다." },
		{ id: "q1", kind: "question", title: "토큰 만료 시간?", options: ["15분", "1시간"] },
		{ id: "c1", kind: "diff", title: "변경 사항", paths: ["src/diff.ts"] },
	],
};
const repo = new URL("..", import.meta.url).pathname;
const diffs = await loadDiffs(req, repo);
let labels: Record<string, string> = {};
const server = await startReviewServer({
	html: (base, nonce) => {
		const r = renderPage(req, diffs, { base, nonce });
		labels = r.labels;
		return r.html;
	},
	token: newToken(),
	dir,
});

const chrome = spawn(CHROME, [
	"--headless=new",
	"--remote-debugging-port=9339",
	`--user-data-dir=${join(dir, "chrome")}`,
	"--use-fake-ui-for-media-stream",
	"--use-fake-device-for-media-stream",
	// On macOS the sandboxed audio service cannot read the file and records silence.
	"--disable-features=AudioServiceSandbox,AudioServiceOutOfProcess",
	`--use-file-for-fake-audio-capture=${wav}%noloop`,
	"--autoplay-policy=no-user-gesture-required",
	"--window-size=1200,900",
	server.url,
]);

try {
	let wsUrl: string | undefined;
	for (let i = 0; i < 50 && !wsUrl; i++) {
		await sleep(200);
		const list = (await fetch("http://127.0.0.1:9339/json/list").then((r) => r.json(), () => [])) as { type: string; webSocketDebuggerUrl: string }[];
		wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl;
	}
	if (!wsUrl) throw new Error("chrome did not start");

	const ws = new WebSocket(wsUrl);
	await new Promise((r) => ws.addEventListener("open", r, { once: true }));
	let id = 0;
	const pending = new Map<number, (v: any) => void>();
	ws.addEventListener("message", (m) => {
		const msg = JSON.parse(String(m.data));
		if (msg.method === "Runtime.consoleAPICalled") console.log("[page]", ...msg.params.args.map((a: any) => a.value));
		if (msg.method === "Runtime.exceptionThrown") console.log("[page error]", msg.params.exceptionDetails.exception?.description);
		pending.get(msg.id)?.(msg);
	});
	const cdp = (method: string, params: object = {}) =>
		new Promise<any>((resolve) => {
			const n = ++id;
			pending.set(n, resolve);
			ws.send(JSON.stringify({ id: n, method, params }));
		});
	const js = async (expr: string) => {
		const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
		if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? "eval failed");
		return r.result?.result?.value;
	};
	const center = (sel: string) =>
		js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
	const mouse = async (sel: string, click = false) => {
		const [x, y] = await center(sel);
		await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
		if (click) {
			await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
			await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
		}
	};
	const scrollTo = (sel: string) => js(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: "center" })`);

	await cdp("Runtime.enable");
	await sleep(800);
	await mouse("#rec", true);
	await scrollTo('[data-rid="d1"]');
	await sleep(400);
	await js(`(() => { const el = document.querySelector('[data-rid="d1"] .md code'); const r = document.createRange(); r.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
	await sleep(2600);
	await scrollTo('[data-rid="q1"]');
	await sleep(500);
	await mouse('[data-value="1시간"]', true);
	await sleep(2600);
	await scrollTo(".hunk tr:nth-child(41)");
	await sleep(300);
	await mouse(".hunk tr:nth-child(41)");
	await sleep(3000);
	await js(`(() => { const t = document.querySelector('[data-comment-for="c1"]'); t.value = "에러 메시지는 영어로"; t.dispatchEvent(new Event("change", { bubbles: true })); })()`);
	await mouse("#submit", true);

	const outcome = await Promise.race([server.outcome, sleep(15000).then(() => null)]);
	if (!outcome || outcome.status !== "submitted") throw new Error(`no submit: ${JSON.stringify(outcome)}`);
	console.log("clips:", outcome.clips.map((c) => `${c.file} @${c.offset}s ${c.mime}`));
	console.log("events:", JSON.stringify(outcome.payload.events));

	const transcript = await transcribeClips(outcome.clips, configFromEnv());
	const report = buildReport({
		title: req.title,
		labels,
		sectionIds: ["summary", ...req.sections.map((s) => s.id)],
		words: transcript.words,
		payload: outcome.payload,
		engine: transcript.engine,
		warnings: transcript.warnings,
		dir,
	});
	console.log(`\n${report.full}`);
	ws.close();
} finally {
	chrome.kill();
	server.close();
}
