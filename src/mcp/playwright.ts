import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/server";
import { type PlaywrightRunResult, runPlaywrightSpec } from "../core/live/run-playwright.ts";

/** Clients time out long tool calls, so a test run continues in the background and is waited on in bounded slices. */
const WAIT_SEC = 45;

interface Job {
	id: string;
	spec: string;
	startedAt: number;
	ac: AbortController;
	promise: Promise<PlaywrightRunResult>;
	result?: PlaywrightRunResult;
	error?: Error;
	settled: boolean;
}

export function createPlaywrightTools(opts: { cwd: string }) {
	const jobs = new Map<string, Job>();
	let seq = 0;
	const tools: ListToolsResult["tools"] = [
		{
			name: "run_playwright",
			description: "Run a Playwright test file (e.g. one written by export_to_playwright) with Walkmate's bundled Playwright and the system Chrome. " +
				"Nothing has to be installed in the project: do not install @playwright/test or run playwright install to use it. " +
				"Unless the spec already uses walkmate/playwright, each test is recorded with withWalkmate, leaving .walkmate/runs/<run>/replay.html. " +
				"Pass env for variables the test reads, such as WALKMATE_PASSWORD for masked inputs; ask the user for the values. They go to the test process only and are not saved. " +
				`Waits up to ${WAIT_SEC}s; if the run is still going it returns an id: call run_playwright({ id }) again until it reports the result. ` +
				"Returns per-test status, the failed test.step, the error, screenshot/trace paths and replay paths. A failed test is a result to act on, not a reason to retry blindly.",
			inputSchema: {
				type: "object",
				properties: {
					spec: { type: "string", description: "Test file path, relative to cwd. Required to start a run." },
					id: { type: "string", description: "Id of a run that is still going: wait for it again instead of starting one." },
					cwd: { type: "string", description: "Project directory. Default: the server's working directory." },
					env: { type: "object", additionalProperties: { type: "string" }, description: "Environment variables for the test process only, e.g. { \"WALKMATE_PASSWORD\": \"...\" }." },
					headed: { type: "boolean", description: "Show the Chrome window while the test runs. Default false." },
					grep: { type: "string", description: "Only run tests whose title matches this regular expression." },
					replay: { type: "boolean", description: "Record tests with withWalkmate for replay.html. Default true." },
					test_timeout_sec: { type: "number", minimum: 1, maximum: 3600, description: "Per-test timeout. Default: Playwright's 30 seconds." },
					wait_sec: { type: "number", minimum: 1, maximum: 600, description: `How long this call waits before returning, default ${WAIT_SEC}. Keep it under your tool timeout.` },
					cancel: { type: "boolean", description: "With id: stop that run." },
				},
				additionalProperties: false,
			},
		},
	];

	async function call(args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
		const known = ["spec", "id", "cwd", "env", "headed", "grep", "replay", "test_timeout_sec", "wait_sec", "cancel"];
		for (const field of Object.keys(args)) if (!known.includes(field)) throw new Error(`Unknown field: ${field}.`);
		const waitSec = Math.min(Math.max(1, Number(args.wait_sec ?? WAIT_SEC) || WAIT_SEC), 600);
		if (args.id !== undefined) {
			const job = jobs.get(String(args.id));
			if (!job) throw new Error(`No Playwright run ${args.id}. Start one with run_playwright({ spec }).`);
			if (args.cancel === true) {
				job.ac.abort();
				await job.promise.catch(() => {});
			}
			return wait(job, waitSec, signal);
		}
		if (typeof args.spec !== "string" || !args.spec) throw new Error("spec is required to start a run (or pass id to keep waiting).");
		const busy = [...jobs.values()].find((j) => !j.settled);
		if (busy) throw new Error(`Playwright run ${busy.id} (${busy.spec}) is still going. Call run_playwright({ "id": "${busy.id}" }) or cancel it first.`);
		const env = args.env ?? {};
		if (typeof env !== "object" || Array.isArray(env) || Object.values(env).some((v) => typeof v !== "string")) throw new Error("env must map names to string values.");
		for (const k of ["headed", "replay", "cancel"]) if (args[k] !== undefined && typeof args[k] !== "boolean") throw new Error(`${k} must be a boolean.`);
		if (args.grep !== undefined && typeof args.grep !== "string") throw new Error("grep must be a string.");
		const timeout = args.test_timeout_sec;
		if (timeout !== undefined && (typeof timeout !== "number" || !(timeout >= 1))) throw new Error("test_timeout_sec must be a number of seconds.");

		const id = `p${++seq}`;
		const ac = new AbortController();
		const job: Job = { id, spec: args.spec, startedAt: Date.now(), ac, settled: false, promise: undefined as never };
		job.promise = runPlaywrightSpec({
			cwd: typeof args.cwd === "string" && args.cwd ? args.cwd : opts.cwd, spec: args.spec, env: env as Record<string, string>,
			headed: args.headed as boolean | undefined, grep: args.grep as string | undefined, replay: args.replay as boolean | undefined,
			testTimeoutSec: timeout as number | undefined, signal: ac.signal,
		});
		job.promise.then((r) => (job.result = r), (e) => (job.error = e instanceof Error ? e : new Error(String(e)))).finally(() => (job.settled = true));
		jobs.set(id, job);
		return wait(job, waitSec, signal);
	}

	async function wait(job: Job, waitSec: number, signal: AbortSignal): Promise<CallToolResult> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stop: (() => void) | undefined;
		await Promise.race([
			job.promise.catch(() => {}),
			new Promise<void>((r) => {
				timer = setTimeout(r, waitSec * 1000);
				stop = r;
				signal.addEventListener("abort", stop, { once: true });
			}),
		]);
		clearTimeout(timer);
		if (stop) signal.removeEventListener("abort", stop);
		if (!job.settled) {
			const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
			return text(`Playwright run ${job.id} (${job.spec}) is still going (${elapsed}s). Call run_playwright({ "id": "${job.id}" }) again.`);
		}
		jobs.delete(job.id);
		if (job.error) return { content: [{ type: "text", text: `Could not run ${job.spec}: ${job.error.message}` }], isError: true };
		return { content: [{ type: "text", text: format(job.result!) }], ...(job.result!.status === "error" ? { isError: true } : {}) };
	}

	async function shutdown() {
		const open = [...jobs.values()].filter((j) => !j.settled);
		for (const j of open) j.ac.abort();
		await Promise.allSettled(open.map((j) => j.promise));
	}

	return { tools, call, shutdown, active: () => [...jobs.values()].some((j) => !j.settled) };
}

function format(r: PlaywrightRunResult): string {
	const count = (s: string) => r.tests.filter((t) => t.status === s).length;
	const failed = r.tests.filter((t) => t.status !== "passed" && t.status !== "skipped").length;
	const lines = [
		`Playwright run ${r.status}: ${count("passed")} passed, ${failed} failed${count("skipped") ? `, ${count("skipped")} skipped` : ""} (${r.duration.toFixed(1)}s)`,
		`Spec: ${r.spec}`,
		`Runner: Walkmate's Playwright ${r.version}, Chrome: ${r.browser}${r.replay ? ", recorded with withWalkmate" : ""}`,
	];
	for (const t of r.tests) {
		const mark = t.status === "passed" ? "✔" : t.status === "skipped" ? "-" : "✖";
		lines.push(`${mark} ${t.title} (${(t.duration / 1000).toFixed(1)}s)${t.status !== "passed" && t.status !== "skipped" ? ` ${t.status}` : ""}`);
		if (t.failedStep) lines.push(`   failed step: ${t.failedStep}`);
		if (t.error) lines.push(`   error: ${t.error.replace(/\n/g, "\n   ")}`);
		for (const a of t.attachments) lines.push(`   ${a.name}: ${a.path}`);
		if (t.run) lines.push(`   recording: ${t.run}`);
		if (t.replay) lines.push(`   replay: ${t.replay}`);
	}
	for (const e of r.errors) lines.push(`Error outside tests: ${e}`);
	if (r.status === "error" && !r.errors.length) lines.push(`Runner output:\n${r.output.split("\n").slice(-40).join("\n")}`);
	lines.push(`Artifacts (copied spec, config, report.json, screenshots, traces): ${r.dir}`);
	if (r.replay && r.tests.some((t) => !t.replay)) lines.push("Some tests have no replay.html: they never left about:blank or set content without navigating.");
	if (r.status === "failed") {
		lines.push("Next: read the error and the failed step, compare with the recording and the screenshot, fix the spec in place (not the copy), then run it again. " +
			"Do not weaken assertions just to pass; a failure may be a real bug in the app.");
	}
	if (r.tests.some((t) => /환경 변수를 설정하세요|WALKMATE_[A-Z0-9_]+/.test(t.error ?? ""))) {
		lines.push("The test needs an environment variable: ask the user for the value and pass it in env.");
	}
	return lines.join("\n");
}

const text = (t: string): CallToolResult => ({ content: [{ type: "text", text: t }] });
