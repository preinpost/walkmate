import { createHash } from "node:crypto";
import { createWriteStream, readFileSync, type WriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClipInfo } from "../types.ts";
import { type Browser, launchChrome } from "./cdp.ts";
import type { Recorder, Recording } from "./mic.ts";

/** What the page reports about an element. */
export interface Desc {
	tag: string;
	text: string;
	comps?: string[];
	file?: string;
	testid?: string;
	/** Viewport CSS px: x, y, width, height. */
	rect: [number, number, number, number];
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
}

export interface Shot {
	t: number;
	tab: number;
	file: string;
	url: string;
	dpr: number;
	ptr?: { x: number; y: number };
	reason: string;
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
	warnings: string[];
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
	/** Called once the page is open, with the CDP port, for tests that drive the browser. */
	onReady?: (info: { port: number; targetId: string }) => void;
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

function pageScript(): string {
	const rrweb = readFileSync(new URL("../../node_modules/@rrweb/record/dist/record.umd.min.cjs", import.meta.url), "utf8");
	const live = readFileSync(new URL("../page/live.js", import.meta.url), "utf8");
	// Load the UMD bundle as a CommonJS module so it does not touch the app's globals.
	return `(function(){if(window.top!==window||window.__piRrweb||location.href==="about:blank")return;var module={exports:{}};var exports=module.exports;\n${rrweb}\n;window.__piRrweb=module.exports;})();\n${live}`;
}

/** Open the app in the review browser and record until the reviewer submits, cancels, or closes it. */
export async function runLiveSession(opts: LiveOptions): Promise<LiveOutcome> {
	const t0 = Date.now();
	const sec = (at: number) => Math.round(at - t0) / 1000;
	const shotsDir = join(opts.dir, "shots");
	await mkdir(shotsDir, { recursive: true });

	const script = pageScript();
	const browser: Browser = await launchChrome({ userDataDir: opts.userDataDir, headless: opts.headless, args: opts.chromeArgs });
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
	async function shoot(tab: Tab | undefined, reason: string) {
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
			shots.push({ t, tab: tab.n, file, url: tab.url, dpr: tab.dpr, ptr: tab.ptr && { ...tab.ptr }, reason });
		} catch {
			// The tab went away or is not painting; the next tick will try again.
		} finally {
			shooting.delete(tab);
		}
	}
	const ticker = setInterval(() => {
		if (rec) shoot(activeTab, "tick");
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
		activeTab ??= tab;
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
		if (activeTab === tab) activeTab = [...tabs.values()].at(-1);
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
				return;
			case "focus":
				activeTab = tab;
				tab.hidden = false;
				return;
			case "ptr":
				tab.ptr = { x: msg.x, y: msg.y };
				activeTab = tab;
				return;
			case "rr": {
				if (!tab.rr) {
					const file = join(opts.dir, `rrweb-tab${tab.n}.jsonl`);
					tab.rr = createWriteStream(file);
					rrweb.push({ tab: tab.n, file });
				}
				for (const e of msg.events) tab.rr.write(`${JSON.stringify(e)}\n`);
				return;
			}
			case "cmd":
				activeTab = tab;
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
				if (e.type === "away") tab.hidden = true;
				else if (e.type === "back") {
					tab.hidden = false;
					activeTab = tab;
				} else if (e.type !== "nav") activeTab = tab;
				if (e.type === "nav" && e.url) tab.url = e.url;
				if (e.x !== undefined && e.y !== undefined) tab.ptr = { x: e.x, y: e.y };
				if (e.type === "pin") {
					pins++;
					shoot(tab, "pin");
					broadcast();
				} else if (rec && e.type === "click") setTimeout(() => shoot(tab, "click"), 350);
				else if (rec && e.type === "nav") setTimeout(() => shoot(tab, "nav"), 900);
				return;
			}
		}
	});

	async function finish(status: LiveOutcome["status"]) {
		if (busy) return;
		busy = status === "submitted" ? "제출 중…" : "취소 중…";
		broadcast();
		await stopRec().catch(() => {});
		settle(status);
	}

	const onAbort = () => finish("aborted");
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = opts.timeoutMs ? setTimeout(() => finish("timeout"), opts.timeoutMs) : undefined;

	try {
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
		let tab: Tab | undefined;
		for (let i = 0; i < 100 && !tab; i++) {
			tab = [...tabs.values()].find((x) => x.targetId === targetId && x.ready);
			if (!tab) await new Promise((r) => setTimeout(r, 50));
		}
		if (!tab) throw new Error("리뷰 탭을 열지 못했습니다.");
		activeTab = tab;
		await cdp.send("Page.navigate", { url: opts.url }, tab.sessionId);
		await cdp.send("Page.bringToFront", {}, tab.sessionId).catch(() => {});
		opts.onReady?.({ port: browser.port, targetId: tab.targetId });

		const raw = await done;
		await stopRec().catch(() => {});
		const left = clips.length > 0 || pins > 0;
		const status = raw === "closed" ? (left ? "submitted" : "cancelled") : raw;
		return { status, t0, duration: sec(Date.now()), events, clips, shots, rrweb, warnings };
	} finally {
		clearInterval(ticker);
		if (timeout) clearTimeout(timeout);
		opts.signal?.removeEventListener("abort", onAbort);
		for (const tab of tabs.values()) tab.rr?.end();
		await cdp.send("Browser.close").catch(() => {});
		cdp.close();
		browser.process?.kill();
	}
}
