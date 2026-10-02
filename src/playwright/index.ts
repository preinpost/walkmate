import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
// Types only: the project's own @playwright/test must be the single runtime copy.
import type { BrowserContext, Page, PlaywrightTestArgs, Request, TestInfo, TestStepInfo, TestType } from "@playwright/test";
import { distFile } from "../core/live/assets.ts";
import { redactSecrets, type ConsoleEntry, type NetEntry } from "../core/live/capture.ts";
import { writeReplay } from "../core/live/replay.ts";
import { createRunDir } from "../core/storage.ts";

export interface WalkmateOptions {
	/** Project directory whose .walkmate/runs receives the recording. Default: WALKMATE_CWD or process.cwd(). */
	cwd?: string;
	/** on: keep every recording. retain-on-failure: delete recordings of tests that behaved as expected. off: no recording. */
	mode?: "on" | "retain-on-failure" | "off";
	/** Mask every input value in the DOM recording, as agent runs do. Password inputs are always masked. Default true. */
	maskAllInputs?: boolean;
	/** Demonstration this test was derived from, for provenance in run.json. */
	sourceRecording?: string;
}

export interface WalkmateRun {
	version: 1;
	kind: "playwright";
	title: string;
	file: string;
	status: TestInfo["status"];
	expected: TestInfo["expectedStatus"];
	dir: string;
	source_recording?: string;
	steps: number;
	error?: string;
	replay?: string;
	warnings: string[];
}

const BINDING = "__walkmateRr";
const API_TYPES = new Set(["xhr", "fetch", "eventsource"]);
const TEXT_MIME = /json|text|xml|javascript|graphql|x-www-form-urlencoded/;
const MAX_BODY = 256 * 1024;
const MAX_ENTRIES = 5000;

/** The recording of the test currently running in this worker; tests in one worker run one at a time. */
let current: Recording | undefined;

export type WalkmateFixtures = { walkmate: WalkmateOptions; _walkmateRecording: void };

/**
 * Extends the project's Playwright test so every test is recorded to .walkmate/runs with replay.html.
 *   import { test as base } from "@playwright/test";
 *   export const test = withWalkmate(base);
 */
export function withWalkmate<T extends PlaywrightTestArgs, W extends {}>(base: TestType<T, W>): TestType<T & WalkmateFixtures, W> {
	const test = (base as unknown as TestType<PlaywrightTestArgs, {}>).extend<WalkmateFixtures>({
		walkmate: [{}, { option: true }],
		_walkmateRecording: [async ({ context, walkmate }, use, testInfo) => {
			const mode = process.env.WALKMATE_PLAYWRIGHT === "off" ? "off" : walkmate.mode ?? "on";
			if (mode === "off") return use();
			const recording = await Recording.start(context, walkmate, testInfo);
			current = recording;
			try {
				await use();
			} finally {
				current = undefined;
				const run = await recording.finish(testInfo);
				if (mode === "retain-on-failure" && testInfo.status === testInfo.expectedStatus) await rm(run.dir, { recursive: true, force: true });
				else {
					testInfo.annotations.push({ type: "walkmate", description: run.dir });
					if (run.replay) await testInfo.attach("walkmate replay", { path: run.replay, contentType: "text/html" });
				}
			}
		}, { auto: true }],
	});

	// test.step titles become markers in replay.html, so a generated spec can name steps after the demonstration.
	const step = test.step;
	type StepOptions = NonNullable<Parameters<typeof step>[2]>;
	const marked = <R>(title: string, body: (info: TestStepInfo) => R | Promise<R>, options: StepOptions = {}) =>
		step(title, async (info) => {
			current?.mark(title);
			return body(info);
		}, { ...options, location: options.location ?? callerLocation() });
	test.step = Object.assign(marked, step);
	return test as unknown as TestType<T & WalkmateFixtures, W>;
}

class Recording {
	readonly dir: string;
	private t0 = Date.now();
	private tabs = new Map<Page, { n: number; stream?: WriteStream }>();
	private lastTab?: number;
	private markers: { t: number; text: string; tab?: number }[] = [];
	private network: NetEntry[] = [];
	private consoleLog: ConsoleEntry[] = [];
	private rrweb: { tab: number; file: string }[] = [];
	private requests = new Map<Request, NetEntry>();
	private pending = new Set<Promise<unknown>>();
	private bodySeq = 0;
	private warnings: string[] = [];
	private context: BrowserContext;
	private options: WalkmateOptions;

	private constructor(context: BrowserContext, options: WalkmateOptions, dir: string) {
		this.context = context;
		this.options = options;
		this.dir = dir;
	}

	static async start(context: BrowserContext, options: WalkmateOptions, testInfo: TestInfo) {
		const dir = await createRunDir(options.cwd ?? process.env.WALKMATE_CWD ?? process.cwd());
		await mkdir(join(dir, "network"), { recursive: true });
		const rec = new Recording(context, options, dir);
		await writeFile(join(dir, "request.json"), `${JSON.stringify({ kind: "playwright", title: titleOf(testInfo), file: testInfo.file, source_recording: options.sourceRecording }, null, 2)}\n`);
		await context.exposeBinding(BINDING, ({ page }, events: unknown[]) => rec.events(page, events));
		await context.addInitScript({ content: pageScript(options.maskAllInputs ?? true) });
		for (const page of context.pages()) rec.tab(page);
		context.on("page", (page) => rec.tab(page));
		context.on("request", (request) => rec.onRequest(request));
		context.on("requestfinished", (request) => rec.track(rec.onFinished(request)));
		context.on("requestfailed", (request) => rec.onFailed(request));
		return rec;
	}

	mark(text: string) {
		this.markers.push({ t: this.sec(), text, tab: this.lastTab });
	}

	async finish(testInfo: TestInfo): Promise<WalkmateRun> {
		const error = testInfo.errors[0]?.message?.split("\n")[0];
		this.markers.push({ t: this.sec(), text: `결과 · ${testInfo.status}${error ? ` · ${strip(error).slice(0, 160)}` : ""}`, tab: this.lastTab });
		// Pull the last buffered events out of every page that is still open.
		await Promise.all(this.context.pages().map((page) => page.evaluate(() => (window as any).__walkmateFlush?.()).catch(() => {})));
		for (let i = 0; i < 50 && this.pending.size; i++) await Promise.race([...this.pending, sleep(100)]);
		await Promise.all([...this.tabs.values()].map(({ stream }) => stream && new Promise((resolve) => stream.end(resolve))));
		let replay: string | undefined;
		try {
			replay = await writeReplay({ dir: this.dir, title: titleOf(testInfo), t0: this.t0, rrweb: this.rrweb, clips: [], utterances: [], steps: this.markers });
			if (!replay) this.warnings.push("No full rrweb snapshot was recorded; replay.html is unavailable (e.g. the test never left about:blank).");
		} catch (err) { this.warnings.push(`Replay generation failed: ${err instanceof Error ? err.message : String(err)}`); }
		const run: WalkmateRun = {
			version: 1, kind: "playwright", title: titleOf(testInfo), file: testInfo.file, status: testInfo.status, expected: testInfo.expectedStatus,
			dir: this.dir, source_recording: this.options.sourceRecording, steps: this.markers.length - 1,
			...(error ? { error: strip(error) } : {}), replay, warnings: this.warnings,
		};
		const save = (file: string, value: unknown) => writeFile(join(this.dir, file), `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
		await Promise.all([save("network.json", this.network), save("console.json", this.consoleLog), save("steps.json", this.markers), save("run.json", run)]);
		return run;
	}

	tab(page: Page) {
		let tab = this.tabs.get(page);
		if (tab) return tab;
		tab = { n: this.tabs.size + 1 };
		this.tabs.set(page, tab);
		const n = tab.n;
		page.on("console", (msg) => {
			if (this.consoleLog.length >= MAX_ENTRIES) return;
			const at = msg.location();
			this.consoleLog.push({ t: this.sec(), tab: n, level: msg.type() === "warning" ? "warn" : msg.type(), text: msg.text().slice(0, 2000),
				source: at.url ? `${at.url}:${at.lineNumber + 1}` : undefined, count: 1 });
		});
		page.on("pageerror", (err) => {
			this.consoleLog.push({ t: this.sec(), tab: n, level: "exception", text: String(err.stack ?? err.message).split("\n").slice(0, 4).join("\n").slice(0, 2000), count: 1 });
		});
		return tab;
	}

	private events(page: Page, events: unknown[]) {
		if (!Array.isArray(events) || !events.length) return;
		const tab = this.tab(page);
		this.lastTab = tab.n;
		if (!tab.stream) {
			const file = join(this.dir, `rrweb-tab${tab.n}.jsonl`);
			tab.stream = createWriteStream(file, { mode: 0o600 });
			tab.stream.on("error", (err) => this.warnings.push(`rrweb: ${err.message}`));
			this.rrweb.push({ tab: tab.n, file });
		}
		for (const event of events) tab.stream.write(`${JSON.stringify(event)}\n`);
	}

	private onRequest(request: Request) {
		const page = request.frame()?.page();
		if (!page || this.network.length >= MAX_ENTRIES || /^(data|blob|chrome-extension|devtools):/.test(request.url())) return;
		const postData = request.postData();
		const entry: NetEntry = { id: String(this.network.length + 1), tab: this.tab(page).n, t: this.sec(), method: request.method(), url: request.url(),
			type: resourceType(request.resourceType()), ...(postData ? { postData: redactSecrets(postData).slice(0, 4000) } : {}) };
		this.requests.set(request, entry);
		this.network.push(entry);
	}

	private async onFinished(request: Request) {
		const entry = this.requests.get(request);
		if (!entry) return;
		this.requests.delete(request);
		const response = await request.response().catch(() => null);
		if (!response) return;
		entry.status = response.status();
		entry.mime = (response.headers()["content-type"] ?? "").split(";")[0] || undefined;
		const timing = request.timing();
		if (timing.responseEnd >= 0) entry.duration = round(timing.responseEnd / 1000);
		entry.bytes = (await request.sizes().catch(() => undefined))?.responseBodySize;
		if (!API_TYPES.has(request.resourceType()) || !TEXT_MIME.test(entry.mime ?? "") || (entry.bytes ?? 0) > 8 * MAX_BODY) return;
		let text = redactSecrets(await response.text().catch(() => ""));
		if (!text) return;
		const truncated = text.length > MAX_BODY;
		if (truncated) text = text.slice(0, MAX_BODY);
		const name = `network/${String(++this.bodySeq).padStart(4, "0")}.${/json/.test(entry.mime ?? "") ? "json" : "txt"}`;
		await writeFile(join(this.dir, name), truncated ? `${text}\n… (잘림)` : text, { mode: 0o600 });
		entry.body = name;
		if (entry.status >= 400) entry.preview = text.replace(/\s+/g, " ").slice(0, 300);
	}

	private onFailed(request: Request) {
		const entry = this.requests.get(request);
		if (!entry) return;
		this.requests.delete(request);
		entry.failed = request.failure()?.errorText ?? "failed";
	}

	track(promise: Promise<unknown>) {
		const tracked = promise.catch((err) => this.warnings.push(`network: ${err instanceof Error ? err.message : String(err)}`)).finally(() => this.pending.delete(tracked));
		this.pending.add(tracked);
	}

	private sec() {
		return round((Date.now() - this.t0) / 1000);
	}
}

/** rrweb in every top-level document, flushed through a binding. Loaded as CommonJS so the app's globals stay untouched. */
function pageScript(maskAllInputs: boolean) {
	const rrweb = distFile("@rrweb/record", "record.umd.min.cjs");
	return `(function(){
if (window.top !== window || window.__walkmateRecording || location.href === "about:blank") return;
window.__walkmateRecording = true;
var module = { exports: {} }; var exports = module.exports;
${rrweb}
;var rr = module.exports, buf = [];
var flush = function () { if (!buf.length) return; var batch = buf; buf = []; try { return window.${BINDING}(batch); } catch (e) {} };
var start = function () {
  try {
    rr.record({ emit: function (e) { buf.push(e); }, sampling: { mousemove: 50, scroll: 150, input: "last" },
      maskAllInputs: ${maskAllInputs}, maskInputOptions: { password: true }, inlineStylesheet: true });
  } catch (e) { return; }
  window.__walkmateFlush = flush;
  setInterval(flush, 250);
  addEventListener("pagehide", flush);
};
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true }); else start();
})();`;
}

function callerLocation() {
	// Frames: Error, callerLocation, the test.step wrapper, then the spec that called test.step.
	const frame = new Error().stack?.split("\n")[3] ?? "";
	const match = /\(?((?:file:\/\/)?[^\s()]+):(\d+):(\d+)\)?$/.exec(frame.trim());
	if (!match) return undefined;
	const file = match[1].startsWith("file://") ? fileURLToPath(match[1]) : match[1];
	return { file, line: Number(match[2]), column: Number(match[3]) };
}

function resourceType(type: string) {
	return ({ xhr: "XHR", fetch: "Fetch", document: "Document", script: "Script", stylesheet: "Stylesheet", image: "Image", font: "Font", media: "Media", eventsource: "EventSource", websocket: "WebSocket" } as Record<string, string>)[type] ?? "Other";
}

function titleOf(testInfo: TestInfo) {
	return testInfo.titlePath.slice(1).join(" › ");
}

function strip(text: string) {
	// Playwright error messages carry ANSI colours.
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
