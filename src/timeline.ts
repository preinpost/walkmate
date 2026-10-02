import type { ReviewEvent, SubmitPayload, Word } from "./types.ts";

export interface Utterance {
	start: number;
	end: number;
	text: string;
	/** What the reviewer was most likely referring to. */
	rid?: string;
	line?: string;
}

export interface ReportInput {
	title: string;
	labels: Record<string, string>;
	/** Top-level ids in page order, including "summary" when present. */
	sectionIds: string[];
	words: Word[];
	payload: SubmitPayload;
	engine: string;
	warnings: string[];
	dir: string;
}

export interface Report {
	/** Complete report, written to disk. */
	full: string;
	/** What the model receives; the timeline is cut when it gets long. */
	text: string;
	utterances: Utterance[];
	stats: { utterances: number; comments: number; answers: number; recorded: number };
}

const PAUSE = 0.8;
const MAX_UTTERANCE = 20;
const MIN_VIEW = 0.7;
const MIN_HOVER = 0.6;
const ATTRIBUTE_BEFORE = 3;
const MODEL_LIMIT = 20_000;

const sectionOf = (rid: string) => rid.split(":")[0];

export function groupUtterances(words: Word[]): Utterance[] {
	const out: Utterance[] = [];
	let cur: Utterance | undefined;
	for (const w of words) {
		if (!cur || w.start - cur.end > PAUSE || w.end - cur.start > MAX_UTTERANCE) {
			cur = { start: w.start, end: w.end, text: w.text };
			out.push(cur);
		} else {
			cur.end = Math.max(cur.end, w.end);
			cur.text += ` ${w.text}`;
		}
	}
	for (const u of out) u.text = u.text.replace(/\s+([.,!?])/g, "$1").trim();
	return out;
}

/** Drop glances and repeats so the timeline keeps only what the reviewer dwelt on. */
export function compressEvents(events: ReviewEvent[], end: number): ReviewEvent[] {
	const ev = [...events].sort((a, b) => a.t - b.t);
	const kept: ReviewEvent[] = [];

	const views = ev.filter((e) => e.type === "view");
	let lastView: string | undefined;
	views.forEach((v, i) => {
		if ((views[i + 1]?.t ?? end) - v.t < MIN_VIEW || v.rid === lastView) return;
		lastView = v.rid;
		kept.push(v);
	});

	const hovers = ev.filter((e) => e.type === "hover");
	let lastHover = "";
	hovers.forEach((h, i) => {
		if ((hovers[i + 1]?.t ?? end) - h.t < MIN_HOVER) return;
		const key = `${h.rid}|${h.line ?? ""}`;
		if (key === lastHover) return;
		// Pointing at the thing already in view, without a line, adds nothing.
		if (!h.line && h.rid === viewAt(kept, h.t)) return;
		lastHover = key;
		kept.push(h);
	});

	const selects = ev.filter((e) => e.type === "select");
	selects.forEach((s, i) => {
		const next = selects[i + 1];
		if (next && next.t - s.t < 1.5) return;
		if (kept.some((k) => k.type === "select" && k.text === s.text && s.t - k.t < 10)) return;
		kept.push(s);
	});

	let prev: ReviewEvent | undefined;
	for (const e of ev) {
		if (e.type === "view" || e.type === "hover" || e.type === "select") continue;
		if (e.type === "comment" && !e.text) continue;
		if (prev && prev.type === e.type && prev.rid === e.rid && prev.line === e.line && prev.text === e.text && e.t - prev.t < 1) continue;
		kept.push(e);
		prev = e;
	}

	return kept.sort((a, b) => a.t - b.t);
}

function viewAt(events: ReviewEvent[], t: number): string | undefined {
	let rid: string | undefined;
	for (const e of events) {
		if (e.t > t) break;
		if (e.type === "view") rid = e.rid;
	}
	return rid;
}

/** Point each utterance at the thing the reviewer touched closest to when they started talking. */
export function attribute(utterances: Utterance[], events: ReviewEvent[]): void {
	const focus = events.filter((e) => e.rid && (e.type === "hover" || e.type === "select" || e.type === "click" || e.type === "answer"));
	const views = events.filter((e) => e.type === "view");
	for (const u of utterances) {
		let best: ReviewEvent | undefined;
		for (const e of focus) {
			if (e.t < u.start - ATTRIBUTE_BEFORE || e.t > u.end) continue;
			if (!best || Math.abs(e.t - u.start) < Math.abs(best.t - u.start)) best = e;
		}
		if (best) {
			u.rid = best.rid;
			u.line = best.line;
			continue;
		}
		u.rid = viewAt(views, u.start) ?? views[0]?.rid;
	}
}

export function buildReport(input: ReportInput): Report {
	const { payload, labels } = input;
	const events = compressEvents(payload.events, payload.duration);
	const utterances = groupUtterances(input.words);
	attribute(utterances, events);

	const label = (rid?: string) => (rid ? (labels[rid] ?? rid) : "?");
	const recorded = recordedSeconds(payload.events, payload.duration);
	const comments = Object.entries(payload.comments).filter(([, v]) => v);
	const answers = Object.entries(payload.answers).filter(([, v]) => v);

	const head: string[] = [`# 리뷰 피드백: ${input.title}`, ""];
	head.push(
		`- 리뷰 ${clock(payload.duration)} · 녹음 ${clock(recorded)} · 발화 ${utterances.length} · 코멘트 ${comments.length + (payload.general ? 1 : 0)} · 답 ${answers.length}`,
	);
	if (recorded > 0) head.push(`- 받아쓰기: ${input.engine}`);
	for (const w of input.warnings) head.push(`- ⚠ ${w}`);
	head.push(`- 원본: ${input.dir}`);
	if (!utterances.length && !comments.length && !answers.length && !payload.general) {
		head.push("", "리뷰어가 아무 피드백 없이 제출했습니다.");
	}

	// Per section: answers, comments, then what was said and highlighted there.
	const dwell = dwellBySection(payload.events, payload.duration);
	const bySection: string[] = ["", "## 섹션별"];
	for (const sid of input.sectionIds) {
		const lines: string[] = [];
		if (payload.answers[sid]) lines.push(`- ✅ 답: ${payload.answers[sid]}`);
		if (payload.comments[sid]) lines.push(`- 💬 코멘트: ${payload.comments[sid]}`);
		const items: { t: number; text: string }[] = [];
		for (const u of utterances) {
			if (!u.rid || sectionOf(u.rid) !== sid) continue;
			items.push({ t: u.start, text: `- 🗣 [${stamp(u.start)}] "${u.text}"${where(u.rid, u.line, sid)}` });
		}
		for (const e of events) {
			if (e.type !== "select" || !e.rid || sectionOf(e.rid) !== sid) continue;
			items.push({ t: e.t, text: `- ✂ [${stamp(e.t)}] 선택: "${e.text}"${where(e.rid, undefined, sid)}` });
		}
		items.sort((a, b) => a.t - b.t);
		lines.push(...items.map((i) => i.text));
		const seen = dwell.get(sid) ?? 0;
		bySection.push("", `### ${sid} · ${label(sid)}  (본 시간 ${clock(seen)})`);
		bySection.push(...(lines.length ? lines : ["- 피드백 없음"]));
	}
	if (payload.general) bySection.push("", "### 전체 코멘트", payload.general);

	function where(rid: string, line: string | undefined, sid: string) {
		const parts: string[] = [];
		if (rid !== sid) parts.push(label(rid));
		if (line) parts.push(lineLabel(line));
		return parts.length ? `  ← ${parts.join(" ")}` : "";
	}

	// Full timeline: speech interleaved with what was on screen.
	const rows: { t: number; text: string }[] = utterances.map((u) => ({ t: u.start, text: `🗣 "${u.text}"` }));
	for (const e of events) rows.push({ t: e.t, text: describe(e, label) });
	rows.sort((a, b) => a.t - b.t);
	const timeline = [
		"",
		"## 타임라인",
		"🗣 말 · 👁 화면 중앙 · 👉 포인터 · ✂ 선택 · ✅ 답 · 💬 코멘트. '이거/여기'는 바로 앞뒤의 👉 ✂ 대상을 가리킵니다.",
		"",
		...rows.map((r) => `[${stamp(r.t)}] ${r.text}`),
	];

	const full = [...head, ...bySection, ...timeline].join("\n");
	let text = full;
	if (text.length > MODEL_LIMIT) {
		const room = MODEL_LIMIT - [...head, ...bySection].join("\n").length - 200;
		const cut = timeline.join("\n").slice(0, Math.max(room, 0));
		text = [...head, ...bySection].join("\n") + cut + `\n\n… 타임라인이 길어 잘렸습니다. 전체: ${input.dir}/report.md`;
	}

	return {
		full,
		text,
		utterances,
		stats: { utterances: utterances.length, comments: comments.length + (payload.general ? 1 : 0), answers: answers.length, recorded },
	};
}

function describe(e: ReviewEvent, label: (rid?: string) => string): string {
	switch (e.type) {
		case "view":
			return `👁 ${label(e.rid)}`;
		case "hover":
			return `👉 ${label(e.rid)}${e.line ? ` ${lineLabel(e.line)}${e.text ? `: \`${e.text}\`` : ""}` : ""}`;
		case "select":
			return `✂ 선택 (${label(e.rid)}): "${e.text}"`;
		case "click":
			return `🖱 ${label(e.rid)}${e.line ? ` ${lineLabel(e.line)}` : ""}`;
		case "answer":
			return `✅ ${label(e.rid)} → ${e.value || "(선택 해제)"}`;
		case "comment":
			return `💬 ${label(e.rid)}: ${e.text}`;
		case "away":
			return "⏸ 다른 창으로 이동";
		case "back":
			return "▶ 페이지로 돌아옴";
		case "rec-start":
			return "🎙 녹음 시작";
		case "rec-stop":
			return "🎙 녹음 정지";
	}
}

function lineLabel(line: string): string {
	if (line.startsWith("+")) return `L${line.slice(1)}(추가)`;
	if (line.startsWith("-")) return `옛 L${line.slice(1)}(삭제)`;
	return `L${line}`;
}

function recordedSeconds(events: ReviewEvent[], end: number): number {
	let total = 0;
	let start: number | undefined;
	for (const e of events) {
		if (e.type === "rec-start") start = e.t;
		else if (e.type === "rec-stop" && start !== undefined) {
			total += e.t - start;
			start = undefined;
		}
	}
	if (start !== undefined) total += end - start;
	return total;
}

function dwellBySection(events: ReviewEvent[], end: number): Map<string, number> {
	const out = new Map<string, number>();
	// t is undefined while the page is in the background.
	let cur: { sid: string; t?: number } | undefined;
	const flush = (t: number) => {
		if (cur?.t !== undefined) out.set(cur.sid, (out.get(cur.sid) ?? 0) + (t - cur.t));
	};
	for (const e of [...events].sort((a, b) => a.t - b.t)) {
		if (e.type === "view" && e.rid) {
			flush(e.t);
			cur = { sid: sectionOf(e.rid), t: e.t };
		} else if (e.type === "away") {
			flush(e.t);
			if (cur) cur.t = undefined;
		} else if (e.type === "back" && cur) {
			cur.t = e.t;
		}
	}
	flush(end);
	return out;
}

function stamp(t: number): string {
	const m = Math.floor(t / 60);
	const s = t - m * 60;
	return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

function clock(t: number): string {
	const s = Math.max(0, Math.round(t));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
