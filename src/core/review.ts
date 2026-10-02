import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CHROME_PROFILE, env, REVIEWS_DIR } from "./config.ts";
import { ffmpegRecorder } from "./live/mic.ts";
import { buildLiveReport, loadImages } from "./live/report.ts";
import { writeReplay } from "./live/replay.ts";
import { runLiveSession } from "./live/session.ts";
import { loadDiffs, renderPage } from "./render.ts";
import { newToken, type ReviewServer, startReviewServer } from "./server.ts";
import { buildReport } from "./timeline.ts";
import { configFromEnv, transcribeClips } from "./transcribe.ts";
import type { ReviewDetails, ReviewRequest } from "./types.ts";

/** What a review needs from whoever hosts it (pi, an MCP server, a test). */
export interface ReviewEnv {
	/** Directory diffs are taken from. */
	cwd: string;
	/** Groups review folders, e.g. the pi session id or "mcp". */
	group: string;
	/** Used for transcription when whisper.cpp is not installed and OPENAI_API_KEY is not set. */
	openaiKey?: string;
	signal?: AbortSignal;
	onStatus?: (status: string) => void;
	/** Called once the reviewer can start: the page or browser is open. */
	onWaiting?: (info: { url: string; title: string; live: boolean }) => void;
	/** Register something to close if the host shuts down mid-review. Returns an unregister function. */
	track?: (resource: { close(): void }) => () => void;
}

export interface ReviewOutcome {
	text: string;
	details: ReviewDetails;
	/** Annotated screenshots from a live review, in the order the text refers to them (#1, #2, ...). */
	images?: { n: number; caption: string; t: number; data: string }[];
}

const timeoutMs = () => Number(env("TIMEOUT_MIN") ?? 60) * 60_000 || undefined;

async function reviewDir(group: string): Promise<string> {
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	const dir = join(REVIEWS_DIR, group.replace(/[^\w.-]/g, "_"), stamp);
	await mkdir(dir, { recursive: true });
	return dir;
}

export function normalizeUrl(url: string): string {
	return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
}

/** Live review when the request has a url, otherwise a document review. */
export function runAnyReview(req: ReviewRequest, renv: ReviewEnv): Promise<ReviewOutcome> {
	if (req.url) return runLiveReview({ ...req, url: req.url }, renv);
	if (!req.sections?.length) throw new Error("sections is required for a document review (or pass url for a live review).");
	return runReview(req, renv);
}

const noTrack = () => () => {};

/** Open the running app in the review browser, record the walkthrough, and turn it into a report. */
export async function runLiveReview(req: ReviewRequest & { url: string }, renv: ReviewEnv): Promise<ReviewOutcome> {
	const url = normalizeUrl(req.url);
	const dir = await reviewDir(renv.group);
	const points = (req.sections ?? []).map((s) => ({ id: s.id, title: s.title, body: s.body?.slice(0, 400), url: s.url }));
	await writeFile(join(dir, "request.json"), JSON.stringify(req, null, 2));

	// Cancellation and host shutdown both end the browser session through this controller.
	const ac = new AbortController();
	const forward = () => ac.abort();
	renv.signal?.addEventListener("abort", forward, { once: true });
	const untrack = (renv.track ?? noTrack)({ close: forward });
	renv.onStatus?.(`라이브 리뷰 중: ${url}`);

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
			onReady: () => renv.onWaiting?.({ url, title: req.title, live: true }),
		});
	} finally {
		untrack();
		renv.signal?.removeEventListener("abort", forward);
	}

	await writeFile(join(dir, "events.json"), JSON.stringify(outcome, null, 2));
	if (outcome.status === "aborted") throw new Error("리뷰가 중단되었습니다.");
	if (outcome.status !== "submitted") return notReceived(outcome.status, req.title, dir, "live");

	if (outcome.clips.length) renv.onStatus?.("받아쓰는 중…");
	const transcript = await transcribeClips(outcome.clips, configFromEnv(renv.openaiKey), renv.signal);

	renv.onStatus?.("보고서 만드는 중…");
	const report = await buildLiveReport({
		title: req.title,
		url,
		points,
		outcome,
		words: transcript.words,
		engine: transcript.engine,
		warnings: transcript.warnings,
		dir,
		maxShots: Number(env("MAX_SHOTS") ?? 6),
	});
	const replay = await writeReplay({
		dir,
		title: req.title,
		t0: outcome.t0,
		rrweb: outcome.rrweb,
		clips: outcome.clips,
		utterances: report.utterances,
		assets: outcome.assets,
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

/** Show a page of decisions, questions and diffs, and wait for the reviewer to submit. */
export async function runReview(req: ReviewRequest, renv: ReviewEnv): Promise<ReviewOutcome> {
	const { signal } = renv;
	const dir = await reviewDir(renv.group);

	const diffs = await loadDiffs(req, renv.cwd);
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
	const untrack = (renv.track ?? noTrack)(server);
	await writeFile(join(dir, "request.json"), JSON.stringify(req, null, 2));
	await writeFile(join(dir, "page.html"), html);
	// Lets the reviewer reopen a closed tab.
	await writeFile(join(dir, "url.txt"), `${server.url}\n`);

	openBrowser(server.url);
	renv.onWaiting?.({ url: server.url, title: req.title, live: false });
	renv.onStatus?.(`리뷰 대기 중: ${server.url}`);

	let outcome: Awaited<ReviewServer["outcome"]>;
	try {
		outcome = await server.outcome;
	} finally {
		untrack();
		server.close();
	}

	if (outcome.status === "aborted") throw new Error("리뷰가 중단되었습니다.");
	if (outcome.status !== "submitted") return notReceived(outcome.status, req.title, dir, "doc");

	if (outcome.clips.length) renv.onStatus?.("받아쓰는 중…");
	const transcript = await transcribeClips(outcome.clips, configFromEnv(renv.openaiKey), signal);

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
			mode: "doc",
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

function notReceived(status: "cancelled" | "timeout", title: string, dir: string, mode: "doc" | "live"): ReviewOutcome {
	const why = status === "timeout" ? "시간 안에 제출되지 않았습니다" : "리뷰어가 취소했습니다";
	return { text: `리뷰를 받지 못했습니다: ${why}.`, details: { status, title, dir, mode } };
}

function openBrowser(url: string) {
	if (env("OPEN") === "0") return;
	const [cmd, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", url]]
				: ["xdg-open", [url]];
	// The URL is also reported to the host, so a missing opener is not fatal.
	execFile(cmd, args, () => {});
}
