import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROME_PROFILE } from "../config.ts";
import { runLiveSession, type LiveControl, type LiveOutcome } from "../live/session.ts";
import { writeReplay } from "../live/replay.ts";
import { createRunDir } from "../storage.ts";
import { MUTATING, parseRunAction, recordedAction, type RunAction, type RunResult, type RunStart, type RunStep, type Snapshot, type StepResult } from "./types.ts";

const DOM_SCRIPT = readFileSync(new URL("../page/runtime.js", import.meta.url), "utf8");
const message = (err: unknown) => err instanceof Error ? err.message : String(err);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface BrowserRun {
	dir: string;
	initial: Snapshot;
	readonly active: boolean;
	outcome: Promise<RunResult>;
	step(action: unknown, signal?: AbortSignal): Promise<StepResult>;
	finish(cancel?: boolean): Promise<RunResult>;
}

/** Native CDP actions and evidence recording behind one session interface. No external browser CLI. */
export async function startBrowserRun(req: RunStart, signal?: AbortSignal): Promise<BrowserRun> {
	if (signal?.aborted) throw new Error("Run was cancelled before opening.");
	const dir = await createRunDir(req.cwd);
	await save("request.json", req);
	const profile = req.isolated ? await mkdtemp(join(tmpdir(), "walkmate-run-chrome-")) : CHROME_PROFILE;
	const ac = new AbortController();
	const forward = () => ac.abort();
	signal?.addEventListener("abort", forward, { once: true });
	if (signal?.aborted) ac.abort();
	let control: LiveControl;
	let selected = "";
	let ended = false, finishing = false;
	let busy: Promise<StepResult> | undefined;
	let requestedFinish = false;
	let dialog = false;
	let stepTimeout = false;
	const steps: RunStep[] = [];
	const startedAt = Date.now();
	const warnings: string[] = [];
	let persistedResult: RunResult | undefined;
	let ready!: (value: { control: LiveControl; targetId: string }) => void;
	const opened = new Promise<{ control: LiveControl; targetId: string }>((resolve) => { ready = resolve; });
	const session = runLiveSession({
		url: req.url, title: req.title, points: [], dir, userDataDir: profile,
		headless: req.headless, agent: true, signal: ac.signal, timeoutMs: req.timeout_sec * 1000,
		recorder: async () => { throw new Error("Microphone is disabled in agent runs."); },
		onReady: ready,
	});
	const outcome: Promise<RunResult> = session.then(
		async (live) => {
			ended = true;
			await busy?.catch(() => {});
			await save("events.json", live);
			await save("steps.json", steps);
			let replay: string | undefined;
			try {
				replay = await writeReplay({ dir, title: req.title, t0: live.t0, rrweb: live.rrweb, clips: [], utterances: [], assets: live.assets,
					steps: steps.map((step) => ({ t: Math.max(0, (startedAt + step.t * 1000 - live.t0) / 1000),
						tab: step.action.tab ? Number(step.action.tab.slice(1)) : undefined,
						text: `${step.id} · ${step.action.type} · ${step.status}${step.action.source_step ? ` · source: ${step.action.source_step}` : ""}${step.error ? ` · ${step.error.slice(0, 160)}` : ""}`,
					})),
				});
				if (!replay) warnings.push("No full rrweb snapshot was recorded; replay.html is unavailable (e.g. only a blank tab was opened).");
			} catch (err) { warnings.push(`Replay generation failed: ${message(err)}`); }
			const failures = steps.filter((step) => step.status === "failed").length;
			const assertions = steps.filter((step) => step.action.type === "assert" && step.status === "ok").length;
			const result: RunResult = {
				version: 1, title: req.title, dir, source_recording: req.source_recording,
				status: runStatus(live.status, requestedFinish, failures, assertions, stepTimeout),
				steps: steps.length, assertions, failures, replay, warnings: [...warnings, ...live.warnings],
			};
			persistedResult = result;
			await save("run.json", result);
			return result;
		},
		async (err) => {
			ended = true;
			await busy?.catch(() => {});
			const result: RunResult = { version: 1, title: req.title, dir, source_recording: req.source_recording, status: "failed", steps: steps.length,
				assertions: 0, failures: Math.max(1, steps.filter((step) => step.status === "failed").length), warnings: [message(err)] };
			await save("steps.json", steps);
			persistedResult = result;
			await save("run.json", result);
			return result;
		},
	).finally(async () => {
		signal?.removeEventListener("abort", forward);
		if (req.isolated) {
			await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(async () => {
				if (persistedResult) {
					persistedResult.warnings.push(`Temporary Chrome profile cleanup failed; remove it after Chrome exits: ${profile}`);
					await save("run.json", persistedResult);
				}
			});
		}
	});
	// Also covers failures before a caller has received the session handle.
	outcome.catch(() => {});

	try {
		const first = await Promise.race([opened, outcome.then((result) => { throw new Error(`Run ended before opening (${result.status}). ${dir}`); })]);
		control = first.control;
		selected = control.tabs().find((tab) => tab.targetId === first.targetId)?.id ?? "";
		control.cdp.on("Page.javascriptDialogOpening", (_params, sessionId) => {
			dialog = true;
			warnings.push("A browser dialog was dismissed. Dialog confirmation is not supported in this runtime version.");
			control.cdp.send("Page.handleJavaScriptDialog", { accept: false }, sessionId).catch(() => {});
		});
		await loaded(req.url !== "about:blank", 15_000);
		const initial = await observe("start");
		return {
			dir, initial, outcome,
			get active() { return !ended; },
			step(input, requestSignal) {
				if (busy) return Promise.reject(new Error("A run step is already in progress."));
				if (ended || finishing || ac.signal.aborted) return Promise.reject(new Error("Run is no longer active; collect it with run_finish."));
				const action = parseRunAction(input);
				if (steps.some((step) => step.status === "failed") && action.type !== "observe") return Promise.reject(new Error("A previous step failed. Observe the evidence or finish; start a new run to retry."));
				if (MUTATING.has(action.type) && !req.allow_actions) return Promise.reject(new Error("UI actions are not authorized. Start a run with allow_actions=true only after the user approves the test execution."));
				if (requestSignal?.aborted) return Promise.reject(new Error("Step request was cancelled."));
				const operation = execute(action, requestSignal);
				busy = operation;
				operation.finally(() => { if (busy === operation) busy = undefined; }).catch(() => {});
				return operation;
			},
			async finish(cancel = false) {
				if (!ended && !finishing) {
					if (busy && !cancel) throw new Error("A step is in progress. Use run_finish with cancel=true to stop it.");
					finishing = true;
					if (cancel) ac.abort();
					else { requestedFinish = true; await control.finish("submitted"); }
				}
				return outcome;
			},
		};
	} catch (err) {
		ac.abort();
		await outcome.catch(() => {});
		throw new Error(`Could not start browser run: ${message(err)}. Artifacts: ${dir}`);
	}

	async function save(file: string, value: unknown) {
		await writeFile(join(dir, file), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	}
	function tab() {
		const found = control.tabs().find((entry) => entry.id === selected);
		if (!found) throw new Error("Selected tab is closed or unavailable. Observe using an existing tab id.");
		return found;
	}
	function ensureActive() {
		if (ended || ac.signal.aborted) throw new Error("Run was stopped.");
	}
	async function evaluate<T>(expression: string): Promise<T> {
		ensureActive();
		const reply = await control.cdp.send<{ result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>(
			"Runtime.evaluate", { expression: `${DOM_SCRIPT}\n${expression}`, returnByValue: true, awaitPromise: true }, tab().sessionId,
		);
		if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description?.split("\n")[0] ?? reply.exceptionDetails.text);
		return reply.result.value;
	}
	async function loaded(nonBlank: boolean, timeout: number) {
		const until = Date.now() + timeout;
		while (Date.now() < until) {
			ensureActive();
			const ok = await evaluate<boolean>(`document.readyState !== "loading" && ${nonBlank ? 'location.href !== "about:blank"' : "true"}`).catch(() => false);
			if (ok) return;
			await sleep(50);
		}
		throw new Error("Page did not become ready before the timeout.");
	}
	async function screenshot(name: string): Promise<string> {
		const { data } = await control.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 70 }, tab().sessionId);
		const file = join(dir, "shots", `${name}.jpg`);
		await writeFile(file, Buffer.from(data, "base64"), { mode: 0o600 });
		return file;
	}
	async function observe(name: string): Promise<Snapshot> {
		const state = await evaluate<Omit<Snapshot, "tab" | "tabs" | "screenshot">>("window.__walkmateRuntime.observe()");
		return { ...state, tab: selected, tabs: control.tabs().map(({ id, url }) => ({ id, url })), screenshot: await screenshot(name) };
	}
	async function execute(action: RunAction, requestSignal?: AbortSignal): Promise<StepResult> {
		const started = Date.now();
		const record: RunStep = { id: `s${steps.length + 1}`, t: (started - startedAt) / 1000, duration_ms: 0, action: recordedAction(action), status: "ok" };
		const abortRequest = () => ac.abort();
		requestSignal?.addEventListener("abort", abortRequest, { once: true });
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const operation = (async () => {
				if (action.tab) selected = action.tab;
				record.action.tab = selected;
				await control.cdp.send("Page.bringToFront", {}, tab().sessionId);
				record.before = await screenshot(`${record.id}-before`);
				await perform(action);
				ensureActive();
				if (dialog) throw new Error("A browser dialog interrupted this action; it was dismissed, not approved.");
				const snapshot = await observe(`${record.id}-after`);
				record.after = snapshot.screenshot;
				return snapshot;
			})();
			const deadline = new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => { stepTimeout = true; ac.abort(); reject(new Error("Step timed out; the run was stopped to prevent late actions.")); }, action.timeout_ms);
			});
			const snapshot = await Promise.race([operation, deadline]);
			record.duration_ms = Date.now() - started;
			steps.push(record);
			await save("steps.json", steps);
			return { step: record, snapshot };
		} catch (err) {
			record.status = "failed";
			record.error = message(err);
			record.duration_ms = Date.now() - started;
			if (!steps.includes(record)) steps.push(record);
			let snapshot: Snapshot | undefined;
			if (!ended && !ac.signal.aborted) {
				snapshot = await observe(`${record.id}-failed`).catch(() => undefined);
				record.after = snapshot?.screenshot;
			}
			await save("steps.json", steps);
			return { step: record, snapshot };
		} finally {
			if (timeout) clearTimeout(timeout);
			requestSignal?.removeEventListener("abort", abortRequest);
		}
	}
	async function perform(action: RunAction) {
		const args = JSON.stringify(action.target);
		const send = (method: string, params: object) => { ensureActive(); return control.cdp.send(method, params, tab().sessionId); };
		if (action.type === "observe") return;
		if (action.type === "navigate") {
			const result = await send("Page.navigate", { url: action.url });
			if (result.errorText) throw new Error("Navigation failed.");
			await loaded(action.url !== "about:blank", action.timeout_ms!);
			return;
		}
		if (action.type === "scroll") {
			const position = action.target
				? await evaluate<{ x: number; y: number }>(`window.__walkmateRuntime.prepare(${args}, "scroll")`)
				: await evaluate<{ x: number; y: number }>("({x: innerWidth / 2, y: innerHeight / 2})");
			await send("Input.dispatchMouseEvent", { type: "mouseWheel", ...position, deltaX: 0, deltaY: action.delta_y });
			await sleep(100);
			return;
		}
		if (action.type === "wait" || action.type === "assert") {
			const expression = `window.__walkmateRuntime.condition(${args ?? "null"}, ${JSON.stringify(action.condition)}, ${JSON.stringify(action.expected ?? "")})`;
			do {
				if (await evaluate<boolean>(expression)) return;
				if (action.type === "assert") throw new Error("Assertion failed.");
				await sleep(100);
				ensureActive();
			} while (true);
		}
		const position = await evaluate<{ x: number; y: number; checked?: boolean }>(`window.__walkmateRuntime.prepare(${args}, ${JSON.stringify(action.type)})`);
		if (action.type === "fill" || action.type === "select") {
			const value = action.value_env ? process.env[action.value_env] : action.value;
			if (value === undefined) throw new Error("The requested input environment variable is not configured.");
			if (action.type === "select") await evaluate(`window.__walkmateRuntime.select(${args}, ${JSON.stringify(value)})`);
			else {
				await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2, commands: ["selectAll"] });
				await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
				if (value) await send("Input.insertText", { text: value });
				else {
					await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", windowsVirtualKeyCode: 8 });
					await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", windowsVirtualKeyCode: 8 });
				}
				await evaluate(`window.__walkmateRuntime.blur(${args})`);
			}
			return;
		}
		if (action.type === "press") {
			const key = action.key === "Space" ? " " : action.key!;
			const code = action.key!;
			const keyCode = ({ Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Space: 32 } as Record<string, number>)[code];
			await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, ...(key === "Enter" ? { text: "\r" } : key === " " ? { text: " " } : {}) });
			await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode });
			return;
		}
		if (action.type === "check" && position.checked === action.checked) return;
		await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: position.x, y: position.y });
		await send("Input.dispatchMouseEvent", { type: "mousePressed", x: position.x, y: position.y, button: "left", buttons: 1, clickCount: 1 });
		await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: position.x, y: position.y, button: "left", buttons: 0, clickCount: 1 });
		if (action.type === "check" && await evaluate<boolean>(`window.__walkmateRuntime.checked(${args})`) !== action.checked) throw new Error("Checkbox/radio state did not match the requested state.");
	}
}

export function runStatus(status: LiveOutcome["status"], requestedFinish: boolean, failures: number, assertions: number, stepTimeout = false): RunResult["status"] {
	if (status === "timeout" || stepTimeout) return "timeout";
	if (status !== "submitted" || !requestedFinish) return "cancelled";
	if (failures) return "failed";
	return assertions ? "passed" : "completed";
}

export async function screenshotBytes(snapshot?: Snapshot): Promise<string | undefined> {
	if (!snapshot?.screenshot) return undefined;
	return (await readFile(snapshot.screenshot).catch(() => undefined))?.toString("base64");
}
