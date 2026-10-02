import { createHash } from "node:crypto";
import { createWriteStream, readFileSync, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClipInfo } from "../types.ts";
import { env } from "../config.ts";
import { distFile } from "./assets.ts";
import { Capture, type ConsoleEntry, type NetEntry } from "./capture.ts";
import { type Browser, type Cdp, launchChrome } from "./cdp.ts";
import type { Recorder, Recording } from "./mic.ts";

/** What the page reports about an element. */
export interface Desc {
	tag: string;
	text: string;
	comps?: string[];
	file?: string;
	testid?: string;
	/** Viewport CSS px: x, y, width, height. For an area pin, the area itself. */
	rect: [number, number, number, number];
	/** Area pin: `rect` is the dragged area and the rest describes the smallest element holding it. */
	area?: boolean;
	inside?: { tag: string; text: string; comps?: string[]; file?: string }[];
	areaText?: string;
}

export interface LiveEvent {
	/** Seconds since the review started. */
	t: number;
	tab: number;
	type: string;
	url?: string;
	title?: string;
	d?: Desc;
	x?: number;
	y?: number;
	text?: string;
	value?: string;
	id?: string;
	pct?: number;
	area?: boolean;
}

export interface Shot {
	t: number;
	tab: number;
	file: string;
	url: string;
	dpr: number;
	ptr?: { x: number; y: number };
	reason: string;
	/** Id of the pin this screenshot was taken for. */
	pin?: string;
}

export interface Point {
	id: string;
	title: string;
	body?: string;
	url?: string;
}

export interface LiveOutcome {
	status: "submitted" | "cancelled" | "timeout" | "aborted";
	/** Epoch ms the review clock counts from. */
	t0: number;
	duration: number;
	events: LiveEvent[];
	clips: ClipInfo[];
	shots: Shot[];
	/** One rrweb event stream (JSON lines) per tab. */
	rrweb: { tab: number; file: string }[];
	network: NetEntry[];
	console: ConsoleEntry[];
	/** Original URL → saved file (relative to the review folder), for the replay. */
	assets: Record<string, string>;
	/** Non-HTML documents the reviewer opened (PDF previews, images, JSON), with a saved copy. */
	docs: DocEntry[];
	warnings: string[];
}

export interface DocEntry {
	t: number;
	tab: number;
	url: string;
	mime: string;
	file?: string;
	bytes?: number;
	error?: string;
}

/** Internal seam used by the agent runtime; the recorder owns browser cleanup. */
export interface LiveControl {
	cdp: Cdp;
	tabs(): { id: string; targetId: string; sessionId: string; url: string }[];
	finish(status: LiveOutcome["status"]): Promise<void>;
}

export interface LiveOptions {
	url: string;
	title: string;
	points: Point[];
	dir: string;
	recorder: Recorder;
	userDataDir: string;
	headless?: boolean;
	chromeArgs?: string[];
	signal?: AbortSignal;
	timeoutMs?: number;
	shotEveryMs?: number;
	/** Agent executions record screenshots and mask inputs independently of microphone state. */
	agent?: boolean;
	/** Called once the page is open; control is for the internal runtime, port is for CDP tests. */
	onReady?: (info: { port: number; targetId: string; control: LiveControl }) => void;
}

interface Tab {
	n: number;
	sessionId: string;
	targetId: string;
	url: string;
	dpr: number;
	hidden: boolean;
	ready?: boolean;
	ptr?: { x: number; y: number };
	lastHash?: string;
	lastFile?: string;
	rr?: WriteStream;
}

const BINDING = "__piReview";

function pageScript(agent = false): string {
	const rrweb = distFile("@rrweb/record", "record.umd.min.cjs");
	const live = readFileSync(new URL("../page/live.js", import.meta.url), "utf8");
	const cfg = JSON.stringify({ canvasFps: Number(env("CANVAS_FPS") ?? 1), maskAllInputs: agent });
	// Load the UMD bundle as a CommonJS module so it does not touch the app's globals.
	return `window.__piReviewCfg=${cfg};(function(){if(window.top!==window||window.__piRrweb||location.href==="about:blank")return;var module={exports:{}};var exports=module.exports;\n${rrweb}\n;window.__piRrweb=module.exports;})();\n${live}`;
}

/** Open the app in the review browser and record until the reviewer submits, cancels, or closes it. */
export async function runLiveSession(opts: LiveOptions): Promise<LiveOutcome> {
	const t0 = Date.now();
	const sec = (at: number) => Math.round(at - t0) / 1000;
	const shotsDir = join(opts.dir, "shots");
	await mkdir(shotsDir, { recursive: true });

	const script = pageScript(opts.agent);
	const browser: Browser = await launchChrome({ userDataDir: opts.userDataDir, headless: opts.headless, args: opts.chromeArgs, signal: opts.signal });
	const { cdp } = browser;

	const events: LiveEvent[] = [];
	const clips: ClipInfo[] = [];
	const shots: Shot[] = [];
	const warnings: string[] = [];
	const tabs = new Map<string, Tab>();
	const targets = new Set<string>();
	let tabCount = 0;
	let activeTab: Tab | undefined;
	let activePoint: string | null = null;
	let pins = 0;
	let busy: string | null = null;
	let firstTab: string | undefined;
	const docs: DocEntry[] = [];

	// Which tab the reviewer is looking at. Logged so the report knows what each sentence was about.
	// Blank start-up tabs are not something the reviewer looked at, so nothing counts until the review tab opens.
	let started = false;
	const setActive = (tab: Tab | undefined) => {
		if (!tab || tab === activeTab || (!started && tab.targetId !== firstTab)) return;
		started = true;
		activeTab = tab;
		events.push({ t: sec(Date.now()), tab: tab.n, type: "tab", url: tab.url });
	};

	const capture = new Capture(cdp, opts.dir, sec, (sessionId) => tabs.get(sessionId)?.n);

	const MAX_DOC = 50 * 1024 * 1024;
	/** Save a copy of a non-HTML document from inside the tab, so blob: URLs and logged-in pages work too. */
	async function saveDoc(tab: Tab, url: string, mime: string) {
		if (docs.some((d) => d.url === url)) return;
		const doc: DocEntry = { t: sec(Date.now()), tab: tab.n, url, mime };
		docs.push(doc);
		events.push({ t: doc.t, tab: tab.n, type: "doc", url, value: mime });
		const expr = `(async () => {
			const r = await fetch(location.href, { headers: { "x-pi-review": "doc" } });
			const b = new Uint8Array(await r.arrayBuffer());
			if (b.length > ${MAX_DOC}) return { tooBig: b.length };
			let s = "";
			for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
			return { b64: btoa(s) };
		})()`;
		try {
			const res = await cdp.send<{ result: { value?: { b64?: string; tooBig?: number } }; exceptionDetails?: unknown }>(
				"Runtime.evaluate",
				{ expression: expr, awaitPromise: true, returnByValue: true },
				tab.sessionId,
			);
			const v = res.result.value;
			if (!v?.b64) throw new Error(v?.tooBig ? `너무 큼 (${v.tooBig} bytes)` : "읽지 못함");
			const buf = Buffer.from(v.b64, "base64");
			const ext = mime.includes("pdf") ? "pdf" : (mime.split("/")[1]?.split(/[;+]/)[0] ?? "bin");
			doc.file = `docs/tab${tab.n}-${docs.length}.${ext}`;
			doc.bytes = buf.length;
			await mkdir(join(opts.dir, "docs"), { recursive: true });
			await writeFile(join(opts.dir, doc.file), buf);
		} catch (err) {
			doc.error = err instanceof Error ? err.message : String(err);
		}
	}

	// "closed": the reviewer closed the window, which counts as submitting if they left anything.
	type Status = LiveOutcome["status"] | "closed";
	let settle!: (s: Status) => void;
	let settled = false;
	const done = new Promise<Status>((resolve) => {
		settle = (s) => {
			if (settled) return;
			settled = true;
			resolve(s);
		};
	});

	// ---------- recording ----------
	let rec: { handle: Recording; idx: number; file: string } | undefined;
	let recMs = 0;
	let clipIdx = 0;
	let recBusy = false;
	let lastLevel = 0;

	async function startRec() {
		const idx = clipIdx++;
		const file = join(opts.dir, `clip-${idx}.flac`);
		try {
			const handle = await opts.recorder(file, (peak) => {
				if (!activeTab || Date.now() - lastLevel < 120) return;
				lastLevel = Date.now();
				evaluate(activeTab, `window.__piReviewLevel?.(${peak.toFixed(3)})`);
			});
			rec = { handle, idx, file };
			events.push({ t: sec(handle.startedAt), tab: activeTab?.n ?? 0, type: "rec-start" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			warnings.push(msg);
			toast(`🎙 ${msg}`, 6000);
		}
	}
	async function stopRec() {
		if (!rec) return;
		const r = rec;
		rec = undefined;
		await r.handle.stop();
		const end = Date.now();
		events.push({ t: sec(end), tab: activeTab?.n ?? 0, type: "rec-stop" });
		recMs += end - r.handle.startedAt;
		clips.push({ idx: r.idx, offset: sec(r.handle.startedAt), mime: "audio/flac", file: r.file });
	}
	async function toggleRec() {
		if (opts.agent) { toast("에이전트 실행 중에는 마이크를 사용하지 않습니다."); return; }
		if (recBusy || busy) return;
		recBusy = true;
		try {
			if (rec) await stopRec();
			else await startRec();
		} finally {
			recBusy = false;
			broadcast();
		}
	}

	// ---------- page communication ----------
	function evaluate(tab: Tab, expression: string) {
		return cdp.send("Runtime.evaluate", { expression }, tab.sessionId).catch(() => undefined);
	}
	function state() {
		return {
			rec: !!rec,
			recMs,
			recSince: rec?.handle.startedAt ?? null,
			points: opts.points,
			active: activePoint,
			pins,
			busy,
		};
	}
	function broadcast() {
		const json = JSON.stringify(state());
		for (const tab of tabs.values()) evaluate(tab, `window.__piReviewSet?.(${json})`);
	}
	function toast(text: string, ms = 2500) {
		if (activeTab) evaluate(activeTab, `window.__piReviewToast?.(${JSON.stringify(text)}, ${ms})`);
	}

	// ---------- screenshots ----------
	let shotSeq = 0;
	const shooting = new Set<Tab>();
	async function shoot(tab: Tab | undefined, reason: string, pin?: string) {
		if (!tab || tab.hidden || shooting.has(tab) || settled) return;
		shooting.add(tab);
		const t = sec(Date.now());
		try {
			const res = await cdp.send<{ data: string }>(
				"Page.captureScreenshot",
				{ format: "jpeg", quality: 70, optimizeForSpeed: true },
				tab.sessionId,
			);
			const buf = Buffer.from(res.data, "base64");
			const hash = createHash("sha1").update(buf).digest("hex");
			let file = tab.lastFile;
			if (hash !== tab.lastHash || !file) {
				file = join(shotsDir, `${String(++shotSeq).padStart(4, "0")}.jpg`);
				await writeFile(file, buf);
				tab.lastHash = hash;
				tab.lastFile = file;
			}
			shots.push({ t, tab: tab.n, file, url: tab.url, dpr: tab.dpr, ptr: tab.ptr && { ...tab.ptr }, reason, pin });
		} catch {
			// The tab went away or is not painting; the next tick will try again.
		} finally {
			shooting.delete(tab);
		}
	}
	const ticker = setInterval(() => {
		if (rec || opts.agent) shoot(activeTab, "tick");
	}, opts.shotEveryMs ?? 1500);

	// ---------- tabs ----------

	async function setupTab(sessionId: string, targetId: string, url: string, waiting: boolean) {
		if (targets.has(targetId)) {
			await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
			return;
		}
		targets.add(targetId);
		const tab: Tab = { n: ++tabCount, sessionId, targetId, url, dpr: 1, hidden: false };
		tabs.set(sessionId, tab);
		const s = (method: string, params: object = {}) => cdp.send(method, params, sessionId);
		try {
			await s("Page.enable");
			await s("Runtime.enable");
			await capture.enable(sessionId);
			await s("Page.setBypassCSP", { enabled: true });
			await s("Runtime.addBinding", { name: BINDING });
			await s("Page.addScriptToEvaluateOnNewDocument", { source: script });
			if (!waiting && url !== "about:blank") await s("Runtime.evaluate", { expression: script });
		} catch {
			// Target closed during setup.
		} finally {
			// A new tab stays paused until resumed, even if instrumenting it failed.
			if (waiting) await s("Runtime.runIfWaitingForDebugger").catch(() => {});
		}
		tab.ready = true;
		// Tabs opened after the first one (window.open, a PDF preview, ctrl+T) come to the front.
		if (firstTab && firstTab !== targetId) setActive(tab);
	}

	cdp.on("Target.attachedToTarget", (p) => {
		const info = p.targetInfo;
		if (info.type !== "page") {
			if (p.waitingForDebugger) cdp.send("Runtime.runIfWaitingForDebugger", {}, p.sessionId).catch(() => {});
			return;
		}
		setupTab(p.sessionId, info.targetId, info.url, p.waitingForDebugger);
	});
	cdp.on("Target.detachedFromTarget", (p) => {
		const tab = tabs.get(p.sessionId);
		if (!tab) return;
		tabs.delete(p.sessionId);
		targets.delete(tab.targetId);
		tab.rr?.end();
		if (activeTab === tab) setActive([...tabs.values()].filter((t) => !t.hidden).at(-1) ?? [...tabs.values()].at(-1));
		if (!tabs.size) settle("closed");
	});
	// A tab opened by the page reuses its initial about:blank window for the real page, and Chrome
	// does not rerun new-document scripts then. Injecting again is harmless: the script runs once.
	cdp.on("Page.domContentEventFired", (_p, sessionId) => {
		const tab = sessionId ? tabs.get(sessionId) : undefined;
		if (tab) evaluate(tab, script);
	});
	cdp.on("Page.frameNavigated", (p, sessionId) => {
		const tab = sessionId ? tabs.get(sessionId) : undefined;
		if (tab && !p.frame.parentId) tab.url = p.frame.url;
	});
	cdp.closed.then(() => settle("closed"));

	const rrweb: LiveOutcome["rrweb"] = [];
	const rrStreams = new Set<WriteStream>();
	cdp.on("Runtime.bindingCalled", (p, sessionId) => {
		if (p.name !== BINDING || !sessionId || settled) return;
		const tab = tabs.get(sessionId);
		if (!tab) return;
		let msg: any;
		try {
			msg = JSON.parse(p.payload);
		} catch {
			return;
		}
		switch (msg.kind) {
			case "hello":
				tab.dpr = Number(msg.dpr) || 1;
				tab.url = msg.url;
				evaluate(tab, `window.__piReviewSet?.(${JSON.stringify(state())})`);
				if (msg.contentType && !/html|xml/.test(msg.contentType)) saveDoc(tab, msg.url, msg.contentType);
				return;
			case "focus":
				tab.hidden = false;
				setActive(tab);
				return;
			case "ptr":
				tab.ptr = { x: msg.x, y: msg.y };
				setActive(tab);
				return;
			case "rr": {
				if (!tab.rr) {
					const file = join(opts.dir, `rrweb-tab${tab.n}.jsonl`);
					tab.rr = createWriteStream(file);
					rrStreams.add(tab.rr);
					tab.rr.on("error", (err) => warnings.push(`rrweb: ${err.message}`));
					rrweb.push({ tab: tab.n, file });
				}
				for (const e of msg.events) tab.rr.write(`${JSON.stringify(e)}\n`);
				return;
			}
			case "cmd":
				setActive(tab);
				if (msg.cmd === "rec") toggleRec();
				else if (msg.cmd === "submit") finish("submitted");
				else if (msg.cmd === "cancel") finish("cancelled");
				else if (msg.cmd === "point") {
					activePoint = msg.id;
					broadcast();
				}
				return;
			case "ev": {
				const { kind: _k, at, ...rest } = msg;
				const e: LiveEvent = { ...rest, t: sec(at), tab: tab.n };
				events.push(e);
				if (e.type === "away") {
					tab.hidden = true;
					if (activeTab === tab) setActive([...tabs.values()].filter((t) => !t.hidden).at(-1));
				} else if (e.type === "back") {
					tab.hidden = false;
					setActive(tab);
				} else if (e.type !== "nav") setActive(tab);
				if (e.type === "nav" && e.url) tab.url = e.url;
				if (e.x !== undefined && e.y !== undefined) tab.ptr = { x: e.x, y: e.y };
				if (e.type === "pin") {
					pins++;
					shoot(tab, "pin", e.id);
					broadcast();
				} else if ((rec || opts.agent) && e.type === "click") setTimeout(() => shoot(tab, "click"), 350);
				else if ((rec || opts.agent) && e.type === "nav") setTimeout(() => shoot(tab, "nav"), 900);
				return;
			}
		}
	});

	async function finish(status: LiveOutcome["status"]) {
		if (busy) return;
		busy = status === "submitted" ? "제출 중…" : "취소 중…";
		broadcast();
		await Promise.all([...tabs.values()].map((tab) => evaluate(tab, "window.__piReviewFlush?.()")));
		await stopRec().catch(() => {});
		settle(status);
	}

	const onAbort = () => finish("aborted");
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = opts.timeoutMs ? setTimeout(() => finish("timeout"), opts.timeoutMs) : undefined;

	try {
		if (opts.signal?.aborted) throw new Error("Session was cancelled before opening.");
		await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
		// Pages that existed before auto-attach (the first window) are attached by hand.
		const { targetInfos } = await cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
		const first = targetInfos.find((t) => t.type === "page" && t.url === "about:blank" && !targets.has(t.targetId));
		for (const t of targetInfos) {
			if (t.type !== "page" || targets.has(t.targetId)) continue;
			const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: t.targetId, flatten: true });
			await setupTab(sessionId, t.targetId, t.url, false);
		}
		const targetId =
			first?.targetId ?? (await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
		firstTab = targetId;
		let tab: Tab | undefined;
		for (let i = 0; i < 100 && !tab; i++) {
			tab = [...tabs.values()].find((x) => x.targetId === targetId && x.ready);
			if (!tab) await new Promise((r) => setTimeout(r, 50));
		}
		if (!tab) throw new Error("리뷰 탭을 열지 못했습니다.");
		setActive(tab);
		await cdp.send("Page.navigate", { url: opts.url }, tab.sessionId);
		await cdp.send("Page.bringToFront", {}, tab.sessionId).catch(() => {});
		if (opts.signal?.aborted) throw new Error("Session was cancelled while opening.");
		opts.onReady?.({ port: browser.port, targetId: tab.targetId, control: {
			cdp,
			tabs: () => [...tabs.values()].filter((t) => t.ready).map((t) => ({ id: `t${t.n}`, targetId: t.targetId, sessionId: t.sessionId, url: t.url })),
			finish,
		} });

		const raw = await done;
		await stopRec().catch(() => {});
		await capture.finish().catch(() => {});
		const left = clips.length > 0 || pins > 0;
		const status = raw === "closed" ? (left ? "submitted" : "cancelled") : raw;
		return {
			status,
			t0,
			duration: sec(Date.now()),
			events,
			clips,
			shots,
			rrweb,
			network: capture.network,
			console: capture.console,
			assets: Object.fromEntries(capture.assets),
			docs,
			warnings,
		};
	} finally {
		clearInterval(ticker);
		if (timeout) clearTimeout(timeout);
		opts.signal?.removeEventListener("abort", onAbort);
		await Promise.all([...rrStreams].map((stream) => new Promise<void>((resolve) => {
			if (stream.writableFinished || stream.destroyed) resolve();
			else stream.end(() => resolve());
		})));
		await cdp.send("Browser.close").catch(() => {});
		cdp.close();
		if (browser.process) {
			const proc = browser.process;
			await new Promise<void>((resolve) => {
				if (proc.exitCode !== null || proc.signalCode !== null) { resolve(); return; }
				const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve(); }, 2000);
				proc.once("exit", () => { clearTimeout(timer); resolve(); });
				proc.kill();
			});
		}
	}
}
