import { Server, type CallToolResult, type ListToolsResult } from "@modelcontextprotocol/server";
import { env } from "../core/config.ts";
import { type ReviewOutcome, runAnyReview } from "../core/review.ts";
import { parseReviewRequest, ReviewParamsSchema } from "../core/types.ts";

/**
 * MCP clients time out long tool calls (Codex and Claude Code both have a per-call limit), and a
 * review takes minutes. So the review runs in the background: review_start opens it and returns,
 * and review_wait waits a bounded time and is called again until the review is done.
 */
const WAIT_SEC = Number(env("WAIT_SEC") ?? 45);
const START_WAIT_MS = 30_000;

interface Job {
	id: string;
	title: string;
	startedAt: number;
	status: string;
	ac: AbortController;
	promise: Promise<ReviewOutcome>;
	outcome?: ReviewOutcome;
	error?: Error;
	settled: boolean;
}

const INSTRUCTIONS = `Voice review: the user looks at your work and talks; you get back what they said, tied to exactly what they were looking at.

Workflow:
1. review_start opens the review in the user's browser and returns a review id at once.
   - Live review (pass url): the running app (e.g. http://localhost:5173/dashboard) opens in a dedicated review browser. The user clicks through it and talks, pinning elements they mean. Use it for UI work. Sections become review points shown in the page toolbar.
   - Document review (no url): a page of sections (decision, question with options, diff from git, note). Use it for decisions, open questions and code changes, instead of a long text summary.
2. Tell the user in one short line that the review is open, then call review_wait with the id. It returns after about ${WAIT_SEC}s if the user is not done yet; keep calling it until it returns the feedback. Do not do other work in between.
3. Act on the feedback. Each utterance comes with the page, element, React component and source file it was about, and live reviews include annotated screenshots (#1, #2, ...). Quote the timestamp when something is ambiguous.`;

const START_SCHEMA = {
	...ReviewParamsSchema,
	properties: {
		...ReviewParamsSchema.properties,
		cwd: { type: "string", description: "Repository directory for diff sections. Default: the server's working directory." },
	},
};

export function createReviewServer(opts: { cwd?: string } = {}) {
	const jobs = new Map<string, Job>();
	let seq = 0;
	const server = new Server(
		{ name: "walkmate", version: "0.2.0" },
		{ capabilities: { tools: {}, prompts: {} }, instructions: INSTRUCTIONS },
	);

	server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => ({
		tools: [
			{
				name: "review_start",
				description:
					"Open a voice review for the user and return its id immediately. Pass url for a live review of the running app, " +
					"or sections (decision, question, diff, note) for a document review. Then call review_wait until it returns the feedback.",
				inputSchema: START_SCHEMA,
			},
			{
				name: "review_wait",
				description: `Wait up to ${WAIT_SEC}s for review feedback. Returns the feedback when the user has submitted, otherwise says it is still in progress: call it again.`,
				inputSchema: {
					type: "object",
					properties: {
						id: { type: "string", description: "Id returned by review_start." },
						timeout_sec: { type: "number", description: `Seconds to wait, default ${WAIT_SEC}. Keep it under your tool timeout.` },
					},
					required: ["id"],
				},
			},
			{
				name: "review_cancel",
				description: "Cancel a review that is still open and close its browser window.",
				inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
			},
		],
	}));

	server.setRequestHandler("tools/call", async (request, ctx): Promise<CallToolResult> => {
		const args = (request.params.arguments ?? {}) as Record<string, unknown>;
		try {
			switch (request.params.name) {
				case "review_start":
					return await start(args);
				case "review_wait": {
					const progressToken = request.params._meta?.progressToken;
					return await wait(String(args.id ?? ""), Number(args.timeout_sec ?? WAIT_SEC), ctx.mcpReq.signal, (message, elapsed) => {
						if (progressToken === undefined) return;
						ctx.mcpReq
							.notify({ method: "notifications/progress", params: { progressToken, progress: elapsed, message } })
							.catch(() => {});
					});
				}
				case "review_cancel":
					return await cancel(String(args.id ?? ""));
				default:
					return error(`unknown tool: ${request.params.name}`);
			}
		} catch (err) {
			return error(err instanceof Error ? err.message : String(err));
		}
	});

	async function start(args: Record<string, unknown>): Promise<CallToolResult> {
		const { cwd, ...rest } = args;
		const req = parseReviewRequest(rest);
		const busy = [...jobs.values()].find((j) => !j.settled);
		if (busy) return error(`Review ${busy.id} ("${busy.title}") is still open. Call review_wait("${busy.id}") or review_cancel("${busy.id}") first.`);

		const id = `r${++seq}`;
		const ac = new AbortController();
		let ready!: (info: { url: string; live: boolean }) => void;
		const opened = new Promise<{ url: string; live: boolean }>((r) => (ready = r));
		const job: Job = { id, title: req.title, startedAt: Date.now(), status: "여는 중", ac, settled: false, promise: undefined as never };
		job.promise = runAnyReview(req, {
			cwd: typeof cwd === "string" && cwd ? cwd : (opts.cwd ?? process.cwd()),
			group: "mcp",
			signal: ac.signal,
			onStatus: (s) => (job.status = s),
			onWaiting: (info) => ready(info),
		});
		job.promise.then(
			(o) => (job.outcome = o),
			(e) => (job.error = e instanceof Error ? e : new Error(String(e))),
		).finally(() => (job.settled = true));
		jobs.set(id, job);

		// Report the URL once the page is up; a failure to start shows up here instead of in review_wait.
		const first = await Promise.race([
			opened,
			job.promise.then(
				() => undefined,
				() => undefined,
			),
			sleep(START_WAIT_MS),
		]);
		if (job.error) {
			jobs.delete(id);
			return error(`Could not start the review: ${job.error.message}`);
		}
		const where = first
			? first.live
				? `The app is open in the review browser: ${first.url}\nThe user talks while using it, using the toolbar at the bottom right (● record, 📌 pin, submit).`
				: `The review page is open in the user's browser: ${first.url}`
			: "The review is still opening.";
		return text(`Review ${id} started. ${where}\nNow call review_wait({ "id": "${id}" }) and keep calling it until it returns the feedback.`);
	}

	async function wait(
		id: string,
		timeoutSec: number,
		signal: AbortSignal,
		progress: (message: string, elapsed: number) => void,
	): Promise<CallToolResult> {
		const job = jobs.get(id);
		if (!job) return error(`No review ${id}. Start one with review_start.`);
		const limit = Math.min(Math.max(1, timeoutSec || WAIT_SEC), 600) * 1000;
		const until = Date.now() + limit;
		while (!job.settled && Date.now() < until && !signal.aborted) {
			progress(job.status, Math.round((Date.now() - job.startedAt) / 1000));
			await Promise.race([job.promise.catch(() => {}), sleep(Math.min(10_000, until - Date.now())), aborted(signal)]);
		}
		if (!job.settled) {
			const elapsed = clock((Date.now() - job.startedAt) / 1000);
			return text(`Review ${id} is still in progress (${job.status}, ${elapsed} elapsed). The user has not submitted yet. Call review_wait({ "id": "${id}" }) again.`);
		}
		jobs.delete(id);
		if (job.error) return error(job.error.message);
		return toResult(job.outcome!);
	}

	async function cancel(id: string): Promise<CallToolResult> {
		const job = jobs.get(id);
		if (!job) return error(`No review ${id}.`);
		job.ac.abort();
		await Promise.race([job.promise.catch(() => {}), sleep(10_000)]);
		jobs.delete(id);
		return text(`Review ${id} cancelled.`);
	}

	server.setRequestHandler("prompts/list", async () => ({
		prompts: [
			{
				name: "live_review",
				description: "Review the running app live: click through it and talk",
				arguments: [
					{ name: "url", description: "App page, e.g. localhost:5173/dashboard", required: true },
					{ name: "focus", description: "What to look at (optional)", required: false },
				],
			},
			{
				name: "review_changes",
				description: "Review the agent's recent work as a page of decisions, questions and diffs",
				arguments: [{ name: "focus", description: "What to focus on (optional)", required: false }],
			},
		],
	}));

	server.setRequestHandler("prompts/get", async (request) => {
		const a = request.params.arguments ?? {};
		const focus = a.focus ? ` Focus: ${a.focus}.` : "";
		const prompt =
			request.params.name === "live_review"
				? `Start a live review of ${a.url} with review_start (pass it as url).${focus} If you know what changed recently, add short sections as review points. Then call review_wait until the feedback arrives, and act on it.`
				: request.params.name === "review_changes"
					? `Show me your recent work as a document review with review_start: one decision section per choice I should confirm, a question section (with options) per open question, and a diff section for the changed files.${focus} Then call review_wait until the feedback arrives, and act on it.`
					: undefined;
		if (!prompt) throw new Error(`unknown prompt: ${request.params.name}`);
		return { messages: [{ role: "user", content: { type: "text", text: prompt } }] };
	});

	/** Cancel every open review and wait for browsers and recorders to shut down. */
	async function shutdown() {
		const open = [...jobs.values()].filter((j) => !j.settled);
		for (const j of open) j.ac.abort();
		await Promise.race([Promise.allSettled(open.map((j) => j.promise)), sleep(8000)]);
	}

	return { server, shutdown };
}

function toResult(o: ReviewOutcome): CallToolResult {
	const content: CallToolResult["content"] = [{ type: "text", text: o.text }];
	for (const img of o.images ?? []) {
		content.push({ type: "text", text: `🖼 #${img.n} ${img.caption}` });
		content.push({ type: "image", data: img.data, mimeType: "image/jpeg" });
	}
	return { content };
}

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
const error = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }], isError: true });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const aborted = (signal: AbortSignal) => new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));

function clock(t: number): string {
	const s = Math.max(0, Math.round(t));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
