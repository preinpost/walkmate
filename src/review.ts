import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ffmpegRecorder } from "./live/mic.ts";
import { buildLiveReport, loadImages } from "./live/report.ts";
import { writeReplay } from "./live/replay.ts";
import { runLiveSession } from "./live/session.ts";
import { loadDiffs, renderPage } from "./render.ts";
import { newToken, type ReviewServer, startReviewServer } from "./server.ts";
import { buildReport } from "./timeline.ts";
import { configFromEnv, transcribeClips } from "./transcribe.ts";
import type { ReviewDetails, ReviewRequest } from "./types.ts";

const HOME = join(homedir(), ".pi", "agent", "review-recorder");
export const REVIEWS_DIR = join(HOME, "reviews");
/** Dedicated Chrome profile for live reviews; logins persist between reviews. */
export const CHROME_PROFILE = process.env.PI_REVIEW_CHROME_PROFILE ?? join(HOME, "chrome-profile");
const WIDGET = "review-recorder";

export interface ReviewOutcome {
	text: string;
	details: ReviewDetails;
	/** Annotated screenshots from a live review, in the order the text refers to them (#1, #2, ...). */
	images?: { n: number; caption: string; t: number; data: string }[];
}

const timeoutMs = () => Number(process.env.PI_REVIEW_TIMEOUT_MIN ?? 60) * 60_000 || undefined;

async function reviewDir(ctx: ExtensionContext): Promise<string> {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	const dir = join(REVIEWS_DIR, ctx.sessionManager.getSessionId(), stamp);
	await mkdir(dir, { recursive: true });
	return dir;
}

export function normalizeUrl(url: string): string {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
}

/** Open the running app in the review browser, record the walkthrough, and turn it into a report. */
export async function runLiveReview(opts: {
	ctx: ExtensionContext;
	req: ReviewRequest & { url: string };
	signal?: AbortSignal;
	onStatus?: (status: string) => void;
	track: (resource: { close(): void }) => () => void;
}): Promise<ReviewOutcome> {
	const { ctx, req } = opts;
	const url = normalizeUrl(req.url);
	const dir = await reviewDir(ctx);
	const points = (req.sections ?? []).map((s) => ({ id: s.id, title: s.title, body: s.body?.slice(0, 400), url: s.url }));
	await writeFile(join(dir, "request.json"), JSON.stringify(req, null, 2));

	// Esc in pi and session shutdown both end the browser session through this controller.
	const ac = new AbortController();
	const forward = () => ac.abort();
	opts.signal?.addEventListener("abort", forward, { once: true });
	const untrack = opts.track({ close: forward });
	if (ctx.hasUI) {
		ctx.ui.setWidget(WIDGET, [
			`🎙 라이브 리뷰 중 · ${req.title}`,
			`   ${url}`,
			"   리뷰 창 오른쪽 아래 툴바: ● 녹음(Alt+R) · 📌 핀(Alt+P) · 제출. 창을 닫아도 제출됩니다. Esc로 중단.",
		]);
	}
	opts.onStatus?.(`라이브 리뷰 중: ${url}`);

	let outcome: Awaited<ReturnType<typeof runLiveSession>>;
	try {
		outcome = await runLiveSession({
			url,
			title: req.title,
			points,
			dir,
			recorder: ffmpegRecorder,
			userDataDir: CHROME_PROFILE,
			signal: ac.signal,
			timeoutMs: timeoutMs(),
		});
	} finally {
		untrack();
		opts.signal?.removeEventListener("abort", forward);
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
	}

	await writeFile(join(dir, "events.json"), JSON.stringify(outcome, null, 2));
	if (outcome.status === "aborted") throw new Error("리뷰가 중단되었습니다.");
	if (outcome.status !== "submitted") {
		const why = outcome.status === "timeout" ? "시간 안에 제출되지 않았습니다" : "리뷰어가 취소했습니다";
		return { text: `리뷰를 받지 못했습니다: ${why}.`, details: { status: outcome.status, title: req.title, dir, mode: "live" } };
	}

	if (outcome.clips.length) opts.onStatus?.("받아쓰는 중…");
	const openaiKey = await ctx.modelRegistry.getApiKeyForProvider("openai").catch(() => undefined);
	const transcript = await transcribeClips(outcome.clips, configFromEnv(openaiKey), opts.signal);

	opts.onStatus?.("보고서 만드는 중…");
	const report = await buildLiveReport({
		title: req.title,
		url,
		points,
		outcome,
		words: transcript.words,
		engine: transcript.engine,
		warnings: transcript.warnings,
		dir,
		maxShots: Number(process.env.PI_REVIEW_MAX_SHOTS ?? 6),
	});
	const replay = await writeReplay({
		dir,
		title: req.title,
		t0: outcome.t0,
		rrweb: outcome.rrweb,
		clips: outcome.clips,
		utterances: report.utterances,
	}).catch(() => undefined);
	await Promise.all([
		writeFile(join(dir, "transcript.json"), JSON.stringify(transcript, null, 2)),
		writeFile(join(dir, "report.md"), report.full),
	]);

	return {
		text: report.text,
		images: await loadImages(report.attached),
		details: {
			status: "submitted",
			mode: "live",
			title: req.title,
			dir,
			duration: outcome.duration,
			utterances: report.stats.utterances,
			pins: report.stats.pins,
			shots: report.stats.shots,
			engine: transcript.engine,
			replay,
		},
	};
}

export async function runReview(opts: {
	ctx: ExtensionContext;
	req: ReviewRequest;
	signal?: AbortSignal;
	onStatus?: (status: string) => void;
	/** Lets the extension close the server on session shutdown. Returns an unregister function. */
	track: (resource: { close(): void }) => () => void;
}): Promise<ReviewOutcome> {
	const { ctx, req, signal } = opts;
	const dir = await reviewDir(ctx);

	const diffs = await loadDiffs(req, ctx.cwd);
	let labels: Record<string, string> = {};
	let html = "";
	const server = await startReviewServer({
		html: (base, nonce) => {
			const page = renderPage(req, diffs, { base, nonce });
			labels = page.labels;
			html = page.html;
			return page.html;
		},
		token: newToken(),
		dir,
		timeoutMs: timeoutMs(),
		signal,
	});
	const untrack = opts.track(server);
	await writeFile(join(dir, "request.json"), JSON.stringify(req, null, 2));
	await writeFile(join(dir, "page.html"), html);

	openBrowser(server.url);
	if (ctx.hasUI) {
		ctx.ui.setWidget(WIDGET, [`🎙 리뷰 대기 중 · ${req.title}`, `   ${server.url}`, "   브라우저에서 제출하거나 취소하세요. Esc로 중단합니다."]);
	}
	opts.onStatus?.(`리뷰 대기 중: ${server.url}`);

	let outcome: Awaited<ReviewServer["outcome"]>;
	try {
		outcome = await server.outcome;
	} finally {
		untrack();
		server.close();
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET, undefined);
	}

	if (outcome.status === "aborted") throw new Error("리뷰가 중단되었습니다.");
	if (outcome.status !== "submitted") {
		const why = outcome.status === "timeout" ? "시간 안에 제출되지 않았습니다" : "리뷰어가 취소했습니다";
		return { text: `리뷰를 받지 못했습니다: ${why}.`, details: { status: outcome.status, title: req.title, dir } };
	}

	if (outcome.clips.length) opts.onStatus?.("받아쓰는 중…");
	const openaiKey = await ctx.modelRegistry.getApiKeyForProvider("openai").catch(() => undefined);
	const transcript = await transcribeClips(outcome.clips, configFromEnv(openaiKey), signal);

	const sectionIds = [...(req.summary ? ["summary"] : []), ...(req.sections ?? []).map((s) => s.id)];
	const report = buildReport({
		title: req.title,
		labels,
		sectionIds,
		words: transcript.words,
		payload: outcome.payload,
		engine: transcript.engine,
		warnings: transcript.warnings,
		dir,
	});

	await Promise.all([
		writeFile(join(dir, "submit.json"), JSON.stringify(outcome.payload, null, 2)),
		writeFile(join(dir, "transcript.json"), JSON.stringify(transcript, null, 2)),
		writeFile(join(dir, "report.md"), report.full),
	]);

	return {
		text: report.text,
		details: {
			status: "submitted",
			title: req.title,
			dir,
			duration: outcome.payload.duration,
			utterances: report.stats.utterances,
			comments: report.stats.comments,
			answers: report.stats.answers,
			engine: transcript.engine,
		},
	};
}

function openBrowser(url: string) {
	if (process.env.PI_REVIEW_OPEN === "0") return;
	const [cmd, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: ["xdg-open", [url]];
	// The URL is also in the widget, so a missing opener is not fatal.
	execFile(cmd, args, () => {});
}
