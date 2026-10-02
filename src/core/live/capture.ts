import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Cdp } from "./cdp.ts";

/** One network request, as seen by the browser. Times are seconds on the review clock. */
export interface NetEntry {
	id: string;
	tab: number;
	t: number;
	/** Seconds until the response finished or failed. */
	duration?: number;
	method: string;
	url: string;
	/** CDP resource type: Document, XHR, Fetch, Script, Image, Font, ... */
	type: string;
	status?: number;
	mime?: string;
	bytes?: number;
	failed?: string;
	fromCache?: boolean;
	/** Request body, truncated. Never headers: those carry credentials. */
	postData?: string;
	/** Saved response body, relative to the review folder. */
	body?: string;
	/** First characters of a text response, for failed requests. */
	preview?: string;
}

export interface ConsoleEntry {
	t: number;
	tab: number;
	level: string;
	text: string;
	/** file:line of the code that logged it. */
	source?: string;
	/** How many identical messages in a row this entry stands for. */
	count: number;
}

const API_TYPES = new Set(["XHR", "Fetch", "EventSource"]);
const ASSET_TYPES = new Set(["Image", "Font", "Media"]);
const MAX_ENTRIES = 5000;
const MAX_CONSOLE = 3000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_ASSET_BYTES = 15 * 1024 * 1024;
const MAX_ASSETS_TOTAL = 200 * 1024 * 1024;
const TEXT_MIME = /json|text|xml|javascript|graphql|x-www-form-urlencoded/;

/**
 * Network, console and assets of every tab: what rrweb does not record. API response bodies go to
 * network/, images and fonts to assets/ so the replay works without the dev server.
 */
export class Capture {
	readonly network: NetEntry[] = [];
	readonly console: ConsoleEntry[] = [];
	/** Original URL → file under the review folder. */
	readonly assets = new Map<string, string>();
	private byId = new Map<string, NetEntry & { mono: number; wall: number; session: string }>();
	private pending = new Set<Promise<unknown>>();
	private queue: (() => Promise<void>)[] = [];
	private running = 0;
	private bodySeq = 0;
	private assetBytes = 0;
	private ready: Promise<void>;
	private cdp: Cdp;
	private dir: string;
	private sec: (epochMs: number) => number;
	private tabOf: (sessionId: string) => number | undefined;

	constructor(cdp: Cdp, dir: string, sec: (epochMs: number) => number, tabOf: (sessionId: string) => number | undefined) {
		this.cdp = cdp;
		this.dir = dir;
		this.sec = sec;
		this.tabOf = tabOf;
		this.ready = Promise.all([mkdir(join(dir, "network"), { recursive: true }), mkdir(join(dir, "assets"), { recursive: true })]).then(() => {});
		cdp.on("Network.requestWillBeSent", (p, s) => this.onRequest(p, s));
		cdp.on("Network.responseReceived", (p) => this.onResponse(p));
		cdp.on("Network.loadingFinished", (p) => this.onFinished(p));
		cdp.on("Network.loadingFailed", (p) => this.onFailed(p));
		cdp.on("Runtime.consoleAPICalled", (p, s) => this.onConsole(p, s));
		cdp.on("Runtime.exceptionThrown", (p, s) => this.onException(p, s));
		cdp.on("Log.entryAdded", (p, s) => this.onLog(p, s));
	}

	/** Turn capture on for a tab; Runtime is enabled by the session already. */
	async enable(sessionId: string) {
		await this.cdp.send("Network.enable", { maxPostDataSize: 16 * 1024 }, sessionId).catch(() => {});
		await this.cdp.send("Log.enable", {}, sessionId).catch(() => {});
	}

	/** Wait for response bodies still being fetched, then write network.json and console.json. */
	async finish(): Promise<void> {
		for (let i = 0; i < 50 && (this.pending.size || this.queue.length); i++) await Promise.race([...this.pending, sleep(200)]);
		await this.ready;
		await Promise.all([
			writeFile(join(this.dir, "network.json"), JSON.stringify(this.network, null, 1)),
			writeFile(join(this.dir, "console.json"), JSON.stringify(this.console, null, 1)),
			writeFile(join(this.dir, "assets.json"), JSON.stringify(Object.fromEntries(this.assets), null, 1)),
		]);
	}

	private onRequest(p: any, sessionId?: string) {
		const tab = sessionId ? this.tabOf(sessionId) : undefined;
		if (tab === undefined || /^(data|blob|chrome-extension|devtools):/.test(p.request.url)) return;
		// Our own request for a copy of a PDF the reviewer opened.
		if (p.request.headers?.["x-pi-review"]) return;
		const prev = this.byId.get(p.requestId);
		// A redirect reuses the request id: close the previous hop.
		if (prev && p.redirectResponse) {
			prev.status = p.redirectResponse.status;
			prev.duration = round(p.timestamp - prev.mono);
			this.byId.delete(p.requestId);
		}
		if (this.network.length >= MAX_ENTRIES) return;
		const e = {
			id: p.requestId,
			tab,
			t: this.sec(p.wallTime * 1000),
			method: p.request.method,
			url: p.request.url,
			type: p.type ?? "Other",
			postData: p.request.postData?.slice(0, 4000),
			mono: p.timestamp,
			wall: p.wallTime,
			session: sessionId!,
		};
		// The entry is shared with network[]; strip() keeps the bookkeeping fields out of JSON.
		this.byId.set(p.requestId, e);
		this.network.push(strip(e));
	}

	private onResponse(p: any) {
		const e = this.byId.get(p.requestId);
		if (!e) return;
		e.status = p.response.status;
		e.mime = p.response.mimeType;
		e.fromCache = p.response.fromDiskCache || p.response.fromServiceWorker || undefined;
		if (!e.type || e.type === "Other") e.type = p.type ?? e.type;
	}

	private onFinished(p: any) {
		const e = this.byId.get(p.requestId);
		if (!e) return;
		this.byId.delete(p.requestId);
		e.duration = round(p.timestamp - e.mono);
		e.bytes = p.encodedDataLength;
		const api = API_TYPES.has(e.type) || (e.type === "Other" && TEXT_MIME.test(e.mime ?? ""));
		if (api && TEXT_MIME.test(e.mime ?? "") && (e.bytes ?? 0) < 8 * MAX_BODY_BYTES) this.enqueue(() => this.saveBody(e));
		else if (ASSET_TYPES.has(e.type) && (e.bytes ?? 0) < MAX_ASSET_BYTES && this.assetBytes < MAX_ASSETS_TOTAL) this.enqueue(() => this.saveAsset(e));
	}

	private onFailed(p: any) {
		const e = this.byId.get(p.requestId);
		if (!e) return;
		this.byId.delete(p.requestId);
		e.duration = round(p.timestamp - e.mono);
		e.failed = p.canceled ? "canceled" : p.blockedReason ? `blocked: ${p.blockedReason}` : p.errorText || "failed";
	}

	private async saveBody(e: NetEntry & { session: string }) {
		const res = await this.cdp.send<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", { requestId: e.id }, e.session).catch(() => undefined);
		if (!res) return;
		let text = res.base64Encoded ? Buffer.from(res.body, "base64").toString("utf8") : res.body;
		const truncated = text.length > MAX_BODY_BYTES;
		if (truncated) text = text.slice(0, MAX_BODY_BYTES);
		const ext = /json/.test(e.mime ?? "") ? "json" : "txt";
		const name = `network/${String(++this.bodySeq).padStart(4, "0")}.${ext}`;
		await this.ready;
		await writeFile(join(this.dir, name), truncated ? `${text}\n… (잘림)` : text);
		e.body = name;
		if ((e.status ?? 0) >= 400) e.preview = text.replace(/\s+/g, " ").slice(0, 300);
	}

	private async saveAsset(e: NetEntry & { session: string }) {
		if (this.assets.has(e.url)) return;
		const res = await this.cdp.send<{ body: string; base64Encoded: boolean }>("Network.getResponseBody", { requestId: e.id }, e.session).catch(() => undefined);
		if (!res) return;
		const buf = res.base64Encoded ? Buffer.from(res.body, "base64") : Buffer.from(res.body);
		this.assetBytes += buf.length;
		const name = `assets/${createHash("sha1").update(buf).digest("hex").slice(0, 16)}${extFor(e.mime, e.url)}`;
		await this.ready;
		await writeFile(join(this.dir, name), buf);
		this.assets.set(e.url, name);
	}

	private onConsole(p: any, sessionId?: string) {
		const tab = sessionId ? this.tabOf(sessionId) : undefined;
		if (tab === undefined) return;
		const text = (p.args ?? []).map(formatArg).join(" ").slice(0, 2000);
		this.addConsole({ t: this.sec(p.timestamp), tab, level: p.type === "warning" ? "warn" : p.type, text, source: frameOf(p.stackTrace), count: 1 });
	}

	private onException(p: any, sessionId?: string) {
		const tab = sessionId ? this.tabOf(sessionId) : undefined;
		if (tab === undefined) return;
		const d = p.exceptionDetails ?? {};
		const text = (d.exception?.description ?? d.text ?? "exception").split("\n").slice(0, 4).join("\n").slice(0, 2000);
		const source = frameOf(d.stackTrace) ?? (d.url ? `${shortUrl(d.url)}:${(d.lineNumber ?? 0) + 1}` : undefined);
		this.addConsole({ t: this.sec(p.timestamp), tab, level: "exception", text, source, count: 1 });
	}

	private onLog(p: any, sessionId?: string) {
		const tab = sessionId ? this.tabOf(sessionId) : undefined;
		const e = p.entry;
		// Failed loads are already in the network log with more detail.
		if (tab === undefined || e.source === "network" || (e.level !== "error" && e.level !== "warning")) return;
		const text = `[${e.source}] ${e.text}${e.url ? ` (${shortUrl(e.url)})` : ""}`.slice(0, 2000);
		this.addConsole({ t: this.sec(e.timestamp), tab, level: e.level === "warning" ? "warn" : "error", text, count: 1 });
	}

	private addConsole(c: ConsoleEntry) {
		const last = this.console.at(-1);
		if (last && last.tab === c.tab && last.level === c.level && last.text === c.text) {
			last.count++;
			return;
		}
		if (this.console.length < MAX_CONSOLE) this.console.push(c);
	}

	private enqueue(job: () => Promise<void>) {
		this.queue.push(job);
		this.pump();
	}

	private pump() {
		while (this.running < 4 && this.queue.length) {
			const job = this.queue.shift()!;
			this.running++;
			const p = job()
				.catch(() => {})
				.finally(() => {
					this.running--;
					this.pending.delete(p);
					this.pump();
				});
			this.pending.add(p);
		}
	}
}

function formatArg(a: any): string {
	if (a.type === "string") return a.value;
	if (a.value !== undefined) return JSON.stringify(a.value);
	if (a.unserializableValue) return a.unserializableValue;
	const pv = a.preview;
	if (pv?.properties) {
		const inner = pv.properties.map((x: any) => (pv.subtype === "array" ? x.value : `${x.name}: ${x.value}`)).join(", ");
		const open = pv.subtype === "array" ? "[" : "{";
		const close = pv.subtype === "array" ? "]" : "}";
		return `${pv.subtype === "array" ? "" : a.className && a.className !== "Object" ? `${a.className} ` : ""}${open}${inner}${pv.overflow ? ", …" : ""}${close}`;
	}
	return a.description ?? a.type;
}

function frameOf(stack: any): string | undefined {
	for (const f of stack?.callFrames ?? []) {
		if (!f.url || /node_modules|\/\.vite\/deps\//.test(f.url)) continue;
		return `${shortUrl(f.url)}:${f.lineNumber + 1}`;
	}
	const f = stack?.callFrames?.[0];
	return f?.url ? `${shortUrl(f.url)}:${f.lineNumber + 1}` : undefined;
}

export function shortUrl(url: string): string {
	try {
		const u = new URL(url);
		const i = u.pathname.indexOf("/src/");
		return i >= 0 ? u.pathname.slice(i + 1) : `${u.pathname}${u.search}`;
	} catch {
		return url;
	}
}

function extFor(mime: string | undefined, url: string): string {
	const m = (mime ?? "").split(";")[0];
	const known: Record<string, string> = {
		"image/png": ".png",
		"image/jpeg": ".jpg",
		"image/gif": ".gif",
		"image/webp": ".webp",
		"image/avif": ".avif",
		"image/svg+xml": ".svg",
		"image/x-icon": ".ico",
		"image/vnd.microsoft.icon": ".ico",
		"font/woff2": ".woff2",
		"font/woff": ".woff",
		"font/ttf": ".ttf",
		"font/otf": ".otf",
		"application/font-woff": ".woff",
		"video/mp4": ".mp4",
		"audio/mpeg": ".mp3",
	};
	if (known[m]) return known[m];
	const ext = /\.([a-z0-9]{2,5})(?:$|[?#])/i.exec(url)?.[1];
	return ext ? `.${ext.toLowerCase()}` : "";
}

/** Drop the bookkeeping fields from what gets serialized. */
function strip<T extends { mono?: number; wall?: number; session?: string }>(e: T): T {
	Object.defineProperty(e, "mono", { enumerable: false, writable: true, value: e.mono });
	Object.defineProperty(e, "wall", { enumerable: false, writable: true, value: e.wall });
	Object.defineProperty(e, "session", { enumerable: false, writable: true, value: e.session });
	return e;
}

const round = (s: number) => Math.round(s * 1000) / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
