import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../config.ts";

type Listener = (params: any, sessionId?: string) => void;

/** Minimal Chrome DevTools Protocol client over one browser-level WebSocket, using flat sessions. */
export class Cdp {
	private ws: WebSocket;
	private nextId = 0;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private listeners = new Map<string, Set<Listener>>();
	closed: Promise<void>;

	private constructor(ws: WebSocket) {
		this.ws = ws;
		ws.addEventListener("message", (m) => {
			const msg = JSON.parse(String(m.data));
			if (msg.id !== undefined) {
				const p = this.pending.get(msg.id);
				this.pending.delete(msg.id);
				if (msg.error) p?.reject(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ""}`));
				else p?.resolve(msg.result);
				return;
			}
			for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
		});
		this.closed = new Promise((resolve) => {
			ws.addEventListener("close", () => {
				for (const p of this.pending.values()) p.reject(new Error("CDP connection closed"));
				this.pending.clear();
				resolve();
			});
		});
	}

	static async connect(url: string): Promise<Cdp> {
		const ws = new WebSocket(url);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
		});
		return new Cdp(ws);
	}

	send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
		if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("CDP connection closed"));
		const id = ++this.nextId;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}

	on(method: string, fn: Listener): () => void {
		let set = this.listeners.get(method);
		if (!set) this.listeners.set(method, (set = new Set()));
		set.add(fn);
		return () => set.delete(fn);
	}

	close() {
		this.ws.close();
	}
}

export interface Browser {
	cdp: Cdp;
	port: number;
	/** Set when this call started Chrome, so the caller knows whether to quit it. */
	process?: ChildProcess;
}

export const CHROME_BIN =
	env("CHROME") ??
	(process.platform === "darwin"
		? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
		: process.platform === "win32"
			? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
			: "google-chrome");

/**
 * Start Chrome on a dedicated profile with remote debugging, or attach to the one already running
 * on that profile. Recent Chrome refuses remote debugging on the default profile, and a dedicated
 * profile keeps logins between reviews.
 */
export async function launchChrome(opts: { userDataDir: string; headless?: boolean; args?: string[] }): Promise<Browser> {
	await mkdir(opts.userDataDir, { recursive: true });
	const portFile = join(opts.userDataDir, "DevToolsActivePort");

	const existing = await readPortFile(portFile);
	if (existing) {
		const ws = await browserWs(existing.port);
		if (ws) return { cdp: await Cdp.connect(ws), port: existing.port };
	}
	await rm(portFile, { force: true });

	if (!existsSync(CHROME_BIN) && CHROME_BIN.includes("/")) throw new Error(`Chrome을 찾지 못했습니다: ${CHROME_BIN} (REVIEW_RECORDER_CHROME로 지정)`);
	const proc = spawn(
		CHROME_BIN,
		[
			`--user-data-dir=${opts.userDataDir}`,
			"--remote-debugging-port=0",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-timer-throttling",
			"--disable-renderer-backgrounding",
			"--window-size=1440,960",
			...(opts.headless ? ["--headless=new"] : []),
			...(opts.args ?? []),
			"about:blank",
		],
		{ stdio: "ignore" },
	);
	let exited = false;
	proc.once("exit", () => (exited = true));

	for (let i = 0; i < 150; i++) {
		await new Promise((r) => setTimeout(r, 100));
		const info = await readPortFile(portFile);
		if (info) {
			const ws = await browserWs(info.port);
			if (ws) return { cdp: await Cdp.connect(ws), port: info.port, process: proc };
		}
		if (exited && i > 20) break;
	}
	proc.kill();
	throw new Error("Chrome 원격 디버깅 연결에 실패했습니다.");
}

async function readPortFile(file: string): Promise<{ port: number } | undefined> {
	const text = await readFile(file, "utf8").catch(() => "");
	const port = Number(text.split("\n")[0]);
	return port > 0 ? { port } : undefined;
}

async function browserWs(port: number): Promise<string | undefined> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
		const json = (await res.json()) as { webSocketDebuggerUrl?: string };
		return json.webSocketDebuggerUrl;
	} catch {
		return undefined;
	}
}
