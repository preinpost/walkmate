import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { groupUtterances, type Utterance } from "../timeline.ts";
import type { Word } from "../types.ts";
import type { ConsoleEntry, NetEntry } from "./capture.ts";
import type { Desc, LiveEvent, LiveOutcome, Point, Shot } from "./session.ts";

export interface LiveReportInput {
	title: string;
	url: string;
	points: Point[];
	outcome: LiveOutcome;
	words: Word[];
	engine: string;
	warnings: string[];
	dir: string;
	maxShots: number;
}

export interface Attached {
	n: number;
	t: number;
	caption: string;
	file: string;
}

export interface LiveReport {
	full: string;
	text: string;
	utterances: LiveUtterance[];
	attached: Attached[];
	stats: { utterances: number; pins: number; recorded: number; shots: number };
}

export interface LiveUtterance extends Utterance {
	tab: number;
	focus?: LiveEvent;
	point?: string;
	shot?: Shot;
	/** Failed or slow requests and console errors around the time it was said. */
	net?: NetEntry[];
	errors?: ConsoleEntry[];
}

/** The tab in front at time t, from the "tab" events the session logs. */
export function tabAt(events: LiveEvent[], t: number): number | undefined {
	let tab: number | undefined;
	for (const e of events) if (e.type === "tab" && e.t <= t) tab = e.tab;
	return tab;
}

const API = new Set(["XHR", "Fetch", "EventSource"]);
const SLOW = 1;
const failed = (n: NetEntry) => (n.failed ? n.failed !== "canceled" : (n.status ?? 0) >= 400);
const isError = (c: ConsoleEntry) => c.level === "error" || c.level === "exception";

const MIN_HOVER = 0.6;
const ATTRIBUTE_BEFORE = 3;
const MODEL_LIMIT = 24_000;
const FOCUS_TYPES = new Set(["pin", "click", "hover", "select", "input"]);

/** Keep what the reviewer dwelt on; drop glances, repeated hovers and scroll jitter. */
export function compressLive(events: LiveEvent[], end: number): LiveEvent[] {
	const ev = [...events].sort((a, b) => a.t - b.t);
	const out: LiveEvent[] = [];
	const notes = new Map(ev.filter((e) => e.type === "pin-note").map((e) => [e.id, e.text]));
	let lastHover = "";
	const lastUrl = new Map<number, string>();

	ev.forEach((e, i) => {
		const next = ev.slice(i + 1).find((x) => x.tab === e.tab && x.type !== "ptr");
		switch (e.type) {
			case "hover": {
				const dwell = (next?.t ?? end) - e.t;
				const key = `${e.tab}|${descKey(e.d)}`;
				if (dwell < MIN_HOVER || key === lastHover) return;
				lastHover = key;
				break;
			}
			case "scroll":
				// A scroll that is followed by another within 2s is part of the same gesture.
				if (ev.slice(i + 1).some((x) => x.tab === e.tab && x.type === "scroll" && x.t - e.t < 2)) return;
				break;
			case "nav":
				if (lastUrl.get(e.tab) === e.url) return;
				lastUrl.set(e.tab, e.url ?? "");
				break;
			case "pin":
				out.push({ ...e, text: e.text ?? notes.get(e.id) });
				return;
			case "pin-note":
			case "away":
			case "back":
				return;
		}
		out.push(e);
	});
	return out;
}

const descKey = (d?: Desc) => (d ? `${d.tag}|${d.text}|${d.comps?.[0] ?? ""}` : "");

/** Point each utterance at what the reviewer pinned, clicked, pointed at or selected around when they spoke. */
export function attributeLive(utterances: Utterance[], events: LiveEvent[]): LiveUtterance[] {
	const focus = events.filter((e) => FOCUS_TYPES.has(e.type) && e.d);
	const points = events.filter((e) => e.type === "point");
	// A click that leaves the page (a navigation follows at once) is the reviewer moving on.
	// So is a click that opens another tab (a PDF preview, a new window).
	const leaving = new Set(
		focus.filter(
			(e) =>
				e.type === "click" &&
				events.some((n) => ((n.type === "nav" && n.tab === e.tab) || (n.type === "tab" && n.tab !== e.tab)) && n.t >= e.t && n.t - e.t < 1.5),
		),
	);
	return utterances.map((u) => {
		// Only what happened in the tab they were looking at counts.
		const front = tabAt(events, u.start);
		const here = front === undefined ? focus : focus.filter((e) => e.tab === front);
		let best: LiveEvent | undefined;
		let bestScore = Number.POSITIVE_INFINITY;
		for (const e of here) {
			if (e.t < u.start - ATTRIBUTE_BEFORE || e.t > u.end) continue;
			if (e.t > u.start && leaving.has(e)) continue;
			// People point, then talk; something touched mid-sentence is usually where they go next.
			// A pin is a deliberate "this one", so it wins over nearby hovers.
			const after = e.t > u.start;
			const bonus = e.type === "pin" ? 3 : !after && (e.type === "click" || e.type === "select") ? 1 : 0;
			const score = (after ? (e.t - u.start) * 2 : u.start - e.t) - bonus;
			if (score < bestScore) {
				best = e;
				bestScore = score;
			}
		}
		if (!best) best = [...here].reverse().find((e) => e.t <= u.start);
		const point = [...points].reverse().find((e) => e.t <= u.start)?.id;
		return { ...u, tab: front ?? best?.tab ?? 1, focus: best, point };
	});
}

/** The screenshot taken when a pin was saved (it shows the pin's outline). */
const pinShot = (shots: Shot[], p: LiveEvent) =>
	shots.find((s) => s.pin !== undefined && s.pin === p.id) ?? shots.find((s) => s.reason === "pin" && Math.abs(s.t - p.t) < 1.5);

function pickShot(all: Shot[], u: LiveUtterance): Shot | undefined {
	if (u.focus?.type === "pin") {
		const pin = pinShot(all, u.focus);
		if (pin) return pin;
	}
	const sameTab = all.filter((s) => s.tab === u.tab);
	const shots = sameTab.length ? sameTab : all;
	// About a second into speaking: the screen they are talking about, not the one they just left.
	const target = u.start + 0.8;
	let best: Shot | undefined;
	for (const s of shots) {
		if (s.t < u.start - 1 || s.t > u.end + 1) continue;
		if (!best || Math.abs(s.t - target) < Math.abs(best.t - target)) best = s;
	}
	return best;
}

export async function buildLiveReport(input: LiveReportInput): Promise<LiveReport> {
	const { outcome } = input;
	const events = compressLive(outcome.events, outcome.duration);
	const utterances = attributeLive(groupUtterances(input.words), events);
	const net = outcome.network ?? [];
	const logs = outcome.console ?? [];
	for (const u of utterances) {
		u.shot = pickShot(outcome.shots, u);
		u.net = [];
		u.errors = [];
	}
	// Each slow or failed request and each error goes under one sentence: people see the symptom
	// first and then say so, so prefer the next sentence started within 5s, else the one being said.
	const ownerOf = (tab: number, t: number) =>
		utterances.find((u) => u.tab === tab && u.start >= t - 0.5 && u.start - t <= 5) ??
		utterances.find((u) => u.tab === tab && u.start <= t && t <= u.end + 1);
	for (const n of net) {
		if (!(failed(n) || ((n.duration ?? 0) >= SLOW && API.has(n.type)))) continue;
		const u = ownerOf(n.tab, n.t);
		if (u && u.net!.length < 4) u.net!.push(n);
	}
	for (const c of logs) {
		if (!isError(c)) continue;
		const u = ownerOf(c.tab, c.t);
		if (u && u.errors!.length < 3) u.errors!.push(c);
	}
	const pins = events.filter((e) => e.type === "pin");
	const recorded = recordedSeconds(outcome.events, outcome.duration);
	const origin = safeOrigin(input.url);
	const where = (e: LiveEvent) => describeTarget(e.d);
	const urlAt = (tab: number, t: number) => {
		let url: string | undefined;
		for (const e of outcome.events) if (e.tab === tab && e.type === "nav" && e.t <= t) url = e.url;
		return url ? shortUrl(url, origin) : undefined;
	};

	// Pins first, then the longest utterances, until the image budget is spent.
	const chosen = new Map<string, Attached>();
	const want: { t: number; shot: Shot; caption: string; d?: Desc; at?: number }[] = [];
	for (const p of pins) {
		const shot = pinShot(outcome.shots, p);
		// The pin's box is drawn even if the memo took a while to type.
		if (shot) want.push({ t: p.t, shot, caption: `📌 ${where(p)}${p.text ? ` — "${p.text}"` : ""}`, d: p.d, at: shot.t });
	}
	for (const u of [...utterances].sort((a, b) => b.text.length - a.text.length)) {
		if (!u.shot) continue;
		const at = u.focus?.type === "pin" && u.shot.reason === "pin" ? u.shot.t : u.focus?.t;
		want.push({ t: u.start, shot: u.shot, caption: `🗣 "${u.text}"`, d: u.focus?.d, at });
	}
	const shotDir = join(input.dir, "report-shots");
	await mkdir(shotDir, { recursive: true });
	for (const w of want) {
		if (chosen.size >= input.maxShots) break;
		if (chosen.has(w.shot.file)) continue;
		const n = chosen.size + 1;
		const file = join(shotDir, `shot-${n}.jpg`);
		// Mark the element only if it was touched close to when the screenshot was taken.
		const rect = w.d && w.at !== undefined && Math.abs(w.at - w.shot.t) < 3 ? w.d.rect : undefined;
		await annotate(w.shot, rect, file).catch(() => undefined);
		chosen.set(w.shot.file, { n, t: w.t, caption: w.caption, file });
	}
	const shotNo = (s?: Shot) => (s ? chosen.get(s.file)?.n : undefined);

	const head = [`# 라이브 리뷰: ${input.title}`, ""];
	head.push(
		`- ${input.url} · 리뷰 ${clock(outcome.duration)} · 녹음 ${clock(recorded)} · 발화 ${utterances.length} · 핀 ${pins.length} · 스크린샷 ${chosen.size}장 첨부`,
	);
	if (recorded > 0) head.push(`- 받아쓰기: ${input.engine}`);
	{
		const fails = net.filter(failed).length;
		const errs = logs.filter(isError).length;
		const docsN = (outcome.docs ?? []).length;
		head.push(`- 네트워크 요청 ${net.length} (실패 ${fails}) · 콘솔 오류 ${errs}${docsN ? ` · 열어 본 파일 ${docsN}` : ""}`);
	}
	for (const w of [...outcome.warnings, ...input.warnings]) head.push(`- ⚠ ${w}`);
	head.push(`- 원본: ${input.dir}  (replay.html 로 화면과 음성을 같이 재생)`);
	if (!utterances.length && !pins.length) head.push("", "리뷰어가 말이나 핀 없이 제출했습니다. 아래 타임라인에는 화면에서 한 행동만 있습니다.");

	const body: string[] = [];
	if (utterances.length) {
		body.push("", "## 피드백 (말한 순서)", "각 발화 아래 ↳ 는 그때 가리키거나 클릭한 대상입니다. '이거/여기'는 그 대상을 뜻합니다.", "");
		utterances.forEach((u, i) => {
			body.push(`${i + 1}. [${stamp(u.start)}] 🗣 "${u.text}"`);
			// In a PDF preview nothing inside can be pointed at; say which document it was instead.
			const doc = u.focus ? undefined : (outcome.docs ?? []).filter((d) => d.tab === u.tab && d.t <= u.start + 1).at(-1);
			const docLabel = doc ? `📄 ${doc.mime.includes("pdf") ? "PDF" : doc.mime}${doc.file ? ` (사본 ${doc.file})` : ""}` : undefined;
			const parts = [urlAt(u.tab, u.start), u.focus ? where(u.focus) : docLabel].filter(Boolean);
			const n = shotNo(u.shot);
			if (parts.length || n) body.push(`   ↳ ${parts.join(" · ")}${n ? `  🖼 #${n}` : ""}`);
			if (u.point) body.push(`   ↳ 포인트: ${pointTitle(input.points, u.point)}`);
			for (const n of u.net ?? []) body.push(`   🌐 ${netLine(n, origin)}`);
			for (const c of u.errors ?? []) body.push(`   ⛔ ${consoleLine(c)}`);
		});
	}
	if (pins.length) {
		body.push("", "## 핀");
		pins.forEach((p, i) => {
			const n = shotNo(pinShot(outcome.shots, p));
			body.push(`📌${i + 1} [${stamp(p.t)}] ${[urlAt(p.tab, p.t), where(p)].filter(Boolean).join(" · ")}${p.text ? ` — 메모: "${p.text}"` : ""}${n ? `  🖼 #${n}` : ""}`);
			if (p.d?.area) {
				if (p.d.inside?.length) body.push(`   안: ${p.d.inside.map((x) => describeTarget({ ...x, rect: [0, 0, 0, 0] })).join(" · ")}`);
				if (p.d.areaText) body.push(`   보이는 글자: "${p.d.areaText}"`);
			}
		});
	}
	const docs = outcome.docs ?? [];
	if (docs.length) {
		body.push("", "## 열어 본 파일", "앱 페이지가 아닌 문서(PDF 미리보기 등)입니다. 안의 클릭·스크롤은 기록되지 않아 스크린샷과 사본으로 확인하세요.");
		for (const d of docs) {
			const saved = d.file ? `사본: ${join(input.dir, d.file)} (${kb(d.bytes ?? 0)})` : `사본 저장 실패: ${d.error}`;
			body.push(`- [${stamp(d.t)}] 📄 ${d.mime} ${shortUrl(d.url, origin).slice(0, 120)} → ${saved}`);
		}
	}

	const api = net.filter((n) => API.has(n.type) || (n.type === "Document" && failed(n)));
	const badOther = net.filter((n) => !API.has(n.type) && n.type !== "Document" && failed(n));
	if (api.length || badOther.length) {
		const fails = net.filter(failed).length;
		body.push("", `## 네트워크 (API ${api.filter((n) => API.has(n.type)).length} · 실패 ${fails} · 전체 요청 ${net.length})`);
		body.push(`응답 본문은 ${input.dir}/network/ 에, 전체 목록은 ${input.dir}/network.json 에 있습니다.`);
		// Failures and slow calls are what reviews are usually about, so they survive the cut.
		const shown = api.length > 60 ? api.filter((n) => failed(n) || (n.duration ?? 0) >= SLOW).slice(0, 60) : api;
		for (const n of shown) body.push(`- ${netLine(n, origin)}`);
		if (shown.length < api.length) body.push(`- … 나머지 ${api.length - shown.length}건은 network.json`);
		for (const n of badOther.slice(0, 20)) body.push(`- ${netLine(n, origin)}`);
	}

	const problems = logs.filter((c) => isError(c) || c.level === "warn");
	if (problems.length) {
		body.push("", `## 콘솔 (오류 ${logs.filter(isError).length} · 경고 ${logs.filter((c) => c.level === "warn").length})`, `전체 로그: ${input.dir}/console.json`);
		for (const c of problems.slice(0, 30)) body.push(`- ${consoleLine(c)}`);
		if (problems.length > 30) body.push(`- … 나머지 ${problems.length - 30}건은 console.json`);
	}

	if (input.points.length) {
		body.push("", "## 리뷰 포인트");
		for (const p of input.points) {
			const said = utterances.filter((u) => u.point === p.id).length;
			body.push(`- ${p.id} ${p.title} — ${said ? `발화 ${said}` : "따로 표시하고 말하지 않음 (다른 발화에서 다뤘을 수 있음)"}`);
		}
	}

	const rows: { t: number; text: string }[] = utterances.map((u) => ({ t: u.start, text: `🗣 "${u.text}"` }));
	for (const e of events) {
		const line = describeEvent(e, input.points, origin);
		if (line) rows.push({ t: e.t, text: line });
	}
	// API calls and errors belong in the timeline; images and scripts would drown it.
	for (const n of net) if (API.has(n.type) || failed(n)) rows.push({ t: n.t, text: `🌐 ${netLine(n, origin, false)}` });
	for (const c of logs) if (isError(c)) rows.push({ t: c.t, text: `⛔ ${consoleLine(c, false)}` });
	rows.sort((a, b) => a.t - b.t);
	const timeline = [
		"",
		"## 타임라인",
		"🗣 말 · 📍 페이지 · 🗂 탭 전환 · 📄 문서 · 👉 포인터 · 🖱 클릭 · 📌 핀 · ✂ 선택 · ⌨ 입력 · ↕ 스크롤 · 🎯 포인트 · 🌐 API · ⛔ 오류",
		"",
		...rows.map((r) => `[${stamp(r.t)}] ${r.text}`),
	];

	const full = [...head, ...body, ...timeline].join("\n");
	let text = full;
	if (text.length > MODEL_LIMIT) {
		const top = [...head, ...body].join("\n");
		text = `${top}${timeline.join("\n").slice(0, Math.max(0, MODEL_LIMIT - top.length - 200))}\n\n… 타임라인이 길어 잘렸습니다. 전체: ${input.dir}/report.md`;
	}
	return {
		full,
		text,
		utterances,
		attached: [...chosen.values()].sort((a, b) => a.n - b.n),
		stats: { utterances: utterances.length, pins: pins.length, recorded, shots: chosen.size },
	};
}

export function describeTarget(d?: Desc): string {
	if (!d) return "";
	if (d.area) {
		// The common element's own text is usually the whole container; the area's text is in areaText.
		const size = `영역 ${d.rect[2]}×${d.rect[3]}`;
		if (!d.comps?.length && !d.file && /^(html|body|main)\b/.test(d.tag)) return size;
		return `${size} 안 (${describeTarget({ ...d, area: false, text: "" })})`;
	}
	const comps = d.comps?.length ? `<${d.comps.slice(0, 3).join(" › ")}> ` : "";
	const text = d.text ? ` "${d.text}"` : "";
	const id = d.testid ? ` [testid=${d.testid}]` : "";
	return `${comps}${d.tag}${text}${id}${d.file ? ` (${d.file})` : ""}`;
}

function describeEvent(e: LiveEvent, points: Point[], origin?: string): string | undefined {
	switch (e.type) {
		case "nav":
			return `📍 ${e.url ? shortUrl(e.url, origin) : "?"}${e.title ? ` — ${e.title}` : ""}`;
		case "hover":
			return `👉 ${describeTarget(e.d)}`;
		case "click":
			return `🖱 ${describeTarget(e.d)}`;
		case "pin":
			return `📌 ${describeTarget(e.d)}${e.d?.areaText ? ` "${e.d.areaText.slice(0, 80)}"` : ""}${e.text ? ` — 메모: "${e.text}"` : ""}`;
		case "select":
			return `✂ "${e.text}"${e.d?.comps ? ` (${e.d.comps[0]})` : ""}`;
		case "input":
			return `⌨ ${describeTarget(e.d)} = "${e.value}"`;
		case "scroll":
			return `↕ ${e.pct}%${e.d ? ` · 화면 중앙: ${describeTarget(e.d)}` : ""}`;
		case "point":
			return `🎯 포인트 ${pointTitle(points, e.id)}`;
		case "tab":
			return `🗂 탭 ${e.tab}${e.url && e.url !== "about:blank" ? ` ${shortUrl(e.url, origin).slice(0, 100)}` : ""}`;
		case "doc":
			return `📄 ${e.value} 열림 (탭 ${e.tab})`;
		case "rec-start":
			return "🎙 녹음 시작";
		case "rec-stop":
			return "🎙 녹음 정지";
		default:
			return undefined;
	}
}

function netLine(n: NetEntry, origin?: string, withBody = true): string {
	const path = n.url.startsWith(origin ?? "\u0000") ? n.url.slice(origin!.length) || "/" : n.url;
	const status = n.failed ? `✖ ${n.failed}` : (n.status ?? "…");
	const parts = [`[${stamp(n.t)}] ${n.method} ${path.slice(0, 160)} ${status}`];
	if (n.duration !== undefined) parts.push(`${n.duration.toFixed(n.duration < 1 ? 2 : 1)}s`);
	if (n.bytes) parts.push(kb(n.bytes));
	if (n.type !== "XHR" && n.type !== "Fetch") parts.push(n.type);
	let line = parts.join(" · ");
	if (withBody && n.body) line += ` → ${n.body}`;
	if (withBody && n.preview) line += `\n     응답: ${n.preview}`;
	return line;
}

function consoleLine(c: ConsoleEntry, withTime = true): string {
	const text = c.text.split("\n")[0].slice(0, 300);
	return `${withTime ? `[${stamp(c.t)}] ` : ""}${c.level}: ${text}${c.count > 1 ? ` (×${c.count})` : ""}${c.source ? ` (${c.source})` : ""}`;
}

const kb = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`);

const pointTitle = (points: Point[], id?: string) => {
	const p = points.find((x) => x.id === id);
	return p ? `${p.id} ${p.title}` : (id ?? "?");
};

/** Downscale and draw a box around the element (or a small one at the pointer). */
async function annotate(shot: Shot, rect: Desc["rect"] | undefined, out: string): Promise<void> {
	const k = shot.dpr || 1;
	let box: number[] | undefined;
	if (rect && rect[2] > 0 && rect[3] > 0) box = [rect[0] - 4, rect[1] - 4, rect[2] + 8, rect[3] + 8];
	else if (shot.ptr) box = [shot.ptr.x - 14, shot.ptr.y - 14, 28, 28];
	const filters: string[] = [];
	if (box) {
		const [x, y, w, h] = box.map((v) => Math.max(0, Math.round(v * k)));
		filters.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=0xff3b30@0.95:t=${Math.max(3, Math.round(3 * k))}`);
	}
	filters.push("scale='min(1280,iw)':-2");
	await new Promise<void>((resolve, reject) => {
		execFile("ffmpeg", ["-y", "-loglevel", "error", "-i", shot.file, "-vf", filters.join(","), "-q:v", "4", out], (err) =>
			err ? reject(err) : resolve(),
		);
	});
}

export async function loadImages(attached: Attached[]) {
	const out: { n: number; caption: string; t: number; data: string }[] = [];
	for (const a of attached) {
		const buf = await readFile(a.file).catch(() => undefined);
		if (buf) out.push({ n: a.n, caption: a.caption, t: a.t, data: buf.toString("base64") });
	}
	return out;
}

function recordedSeconds(events: LiveEvent[], end: number): number {
	let total = 0;
	let start: number | undefined;
	for (const e of [...events].sort((a, b) => a.t - b.t)) {
		if (e.type === "rec-start") start = e.t;
		else if (e.type === "rec-stop" && start !== undefined) {
			total += e.t - start;
			start = undefined;
		}
	}
	if (start !== undefined) total += end - start;
	return total;
}

function safeOrigin(url: string): string | undefined {
	try {
		return new URL(url).origin;
	} catch {
		return undefined;
	}
}

function shortUrl(url: string, origin?: string): string {
	if (origin && url.startsWith(origin)) return url.slice(origin.length) || "/";
	return url;
}

export function stamp(t: number): string {
	const m = Math.floor(t / 60);
	return `${String(m).padStart(2, "0")}:${(t - m * 60).toFixed(1).padStart(4, "0")}`;
}

function clock(t: number): string {
	const s = Math.max(0, Math.round(t));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
