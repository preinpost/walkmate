import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { groupUtterances, type Utterance } from "../timeline.ts";
import type { Word } from "../types.ts";
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
}

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
				out.push({ ...e, text: notes.get(e.id) });
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
	return utterances.map((u) => {
		let best: LiveEvent | undefined;
		let bestScore = Number.POSITIVE_INFINITY;
		for (const e of focus) {
			if (e.t < u.start - ATTRIBUTE_BEFORE || e.t > u.end) continue;
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
		if (!best) best = [...focus].reverse().find((e) => e.t <= u.start);
		const point = [...points].reverse().find((e) => e.t <= u.start)?.id;
		return { ...u, tab: best?.tab ?? 1, focus: best, point };
	});
}

function pickShot(shots: Shot[], u: LiveUtterance): Shot | undefined {
	if (u.focus?.type === "pin") {
		const pin = shots.find((s) => s.reason === "pin" && Math.abs(s.t - u.focus!.t) < 1.5);
		if (pin) return pin;
	}
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
	for (const u of utterances) u.shot = pickShot(outcome.shots, u);
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
		const shot = outcome.shots.find((s) => s.reason === "pin" && Math.abs(s.t - p.t) < 1.5);
		if (shot) want.push({ t: p.t, shot, caption: `📌 ${where(p)}${p.text ? ` — "${p.text}"` : ""}`, d: p.d, at: p.t });
	}
	for (const u of [...utterances].sort((a, b) => b.text.length - a.text.length)) {
		if (u.shot) want.push({ t: u.start, shot: u.shot, caption: `🗣 "${u.text}"`, d: u.focus?.d, at: u.focus?.t });
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
	for (const w of [...outcome.warnings, ...input.warnings]) head.push(`- ⚠ ${w}`);
	head.push(`- 원본: ${input.dir}  (replay.html 로 화면과 음성을 같이 재생)`);
	if (!utterances.length && !pins.length) head.push("", "리뷰어가 말이나 핀 없이 제출했습니다. 아래 타임라인에는 화면에서 한 행동만 있습니다.");

	const body: string[] = [];
	if (utterances.length) {
		body.push("", "## 피드백 (말한 순서)", "각 발화 아래 ↳ 는 그때 가리키거나 클릭한 대상입니다. '이거/여기'는 그 대상을 뜻합니다.", "");
		utterances.forEach((u, i) => {
			body.push(`${i + 1}. [${stamp(u.start)}] 🗣 "${u.text}"`);
			const parts = [urlAt(u.tab, u.start), u.focus ? where(u.focus) : undefined].filter(Boolean);
			const n = shotNo(u.shot);
			if (parts.length || n) body.push(`   ↳ ${parts.join(" · ")}${n ? `  🖼 #${n}` : ""}`);
			if (u.point) body.push(`   ↳ 포인트: ${pointTitle(input.points, u.point)}`);
		});
	}
	if (pins.length) {
		body.push("", "## 핀");
		pins.forEach((p, i) => {
			const shot = outcome.shots.find((s) => s.reason === "pin" && Math.abs(s.t - p.t) < 1.5);
			const n = shotNo(shot);
			body.push(`📌${i + 1} [${stamp(p.t)}] ${[urlAt(p.tab, p.t), where(p)].filter(Boolean).join(" · ")}${p.text ? ` — 메모: "${p.text}"` : ""}${n ? `  🖼 #${n}` : ""}`);
		});
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
	rows.sort((a, b) => a.t - b.t);
	const timeline = [
		"",
		"## 타임라인",
		"🗣 말 · 📍 페이지 · 👉 포인터 · 🖱 클릭 · 📌 핀 · ✂ 선택 · ⌨ 입력 · ↕ 스크롤 · 🎯 포인트",
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
			return `📌 ${describeTarget(e.d)}${e.text ? ` — 메모: "${e.text}"` : ""}`;
		case "select":
			return `✂ "${e.text}"${e.d?.comps ? ` (${e.d.comps[0]})` : ""}`;
		case "input":
			return `⌨ ${describeTarget(e.d)} = "${e.value}"`;
		case "scroll":
			return `↕ ${e.pct}%${e.d ? ` · 화면 중앙: ${describeTarget(e.d)}` : ""}`;
		case "point":
			return `🎯 포인트 ${pointTitle(points, e.id)}`;
		case "rec-start":
			return "🎙 녹음 시작";
		case "rec-stop":
			return "🎙 녹음 정지";
		default:
			return undefined;
	}
}

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
