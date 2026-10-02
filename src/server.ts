import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { ClipInfo, SubmitPayload } from "./types.ts";

export type ServerOutcome =
	| { status: "submitted"; payload: SubmitPayload; clips: ClipInfo[] }
	| { status: "cancelled" | "timeout" | "aborted"; clips: ClipInfo[] };

export interface ReviewServer {
	url: string;
	/** Resolves once: on submit, cancel from the page, timeout, abort, or close(). */
	outcome: Promise<ServerOutcome>;
	close(): void;
}

const MAX_AUDIO_BYTES = 500 * 1024 * 1024;
const MAX_JSON_BYTES = 20 * 1024 * 1024;

export const newToken = () => randomBytes(18).toString("base64url");

/**
 * Serve one review page on 127.0.0.1. Every route lives under /r/<token>, so other local
 * pages cannot guess their way in. The page is sent with a nonce-only script policy so
 * markdown in the review cannot run its own scripts.
 */
export async function startReviewServer(opts: {
	html: (base: string, nonce: string) => string;
	token: string;
	dir: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}): Promise<ReviewServer> {
	const base = `/r/${opts.token}`;
	const nonce = randomBytes(12).toString("base64url");
	const page = opts.html(base, nonce);
	const clips: ClipInfo[] = [];

	let settle!: (o: ServerOutcome) => void;
	let settled = false;
	const outcome = new Promise<ServerOutcome>((resolve) => {
		settle = (o) => {
			if (settled) return;
			settled = true;
			resolve(o);
			// Let the in-flight response finish before tearing the server down.
			setTimeout(close, 200);
		};
	});

	const server = createServer((req, res) => {
		handle(req, res).catch((err: unknown) => {
			if (!res.headersSent) send(res, 500, String(err instanceof Error ? err.message : err));
		});
	});

	async function handle(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method === "GET" && url.pathname === base) {
			res.writeHead(200, {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: https:; connect-src 'self'; media-src blob:`,
			});
			res.end(page);
			return;
		}
		if (req.method !== "POST" || !url.pathname.startsWith(`${base}/`)) return send(res, 404, "not found");
		if (settled) return send(res, 410, "review already closed");

		switch (url.pathname.slice(base.length + 1)) {
			case "audio": {
				const idx = Number(url.searchParams.get("idx"));
				const offset = Number(url.searchParams.get("offset"));
				const mime = url.searchParams.get("mime") ?? "audio/webm";
				if (!Number.isInteger(idx) || idx < 0 || !Number.isFinite(offset)) return send(res, 400, "bad clip");
				const file = join(opts.dir, `clip-${idx}.${extFor(mime)}`);
				await writeFile(file, await readBody(req, MAX_AUDIO_BYTES));
				clips.push({ idx, offset, mime, file });
				return send(res, 200, "ok");
			}
			case "submit": {
				const payload = JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString("utf8")) as SubmitPayload;
				send(res, 200, "ok");
				settle({ status: "submitted", payload, clips: sorted(clips) });
				return;
			}
			case "cancel":
				send(res, 200, "ok");
				settle({ status: "cancelled", clips: sorted(clips) });
				return;
			default:
				return send(res, 404, "not found");
		}
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const { port } = server.address() as AddressInfo;

	const timer = opts.timeoutMs ? setTimeout(() => settle({ status: "timeout", clips: sorted(clips) }), opts.timeoutMs) : undefined;
	const onAbort = () => settle({ status: "aborted", clips: sorted(clips) });
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	if (opts.signal?.aborted) onAbort();

	let closed = false;
	function close() {
		if (closed) return;
		closed = true;
		if (timer) clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
		if (!settled) settle({ status: "aborted", clips: sorted(clips) });
		server.close();
		server.closeAllConnections();
	}

	return { url: `http://127.0.0.1:${port}${base}`, outcome, close };
}

function send(res: ServerResponse, code: number, text: string) {
	res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
	res.end(text);
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > limit) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

function extFor(mime: string): string {
	if (mime.includes("mp4")) return "m4a";
	if (mime.includes("ogg")) return "ogg";
	if (mime.includes("wav")) return "wav";
	return "webm";
}

const sorted = (clips: ClipInfo[]) => [...clips].sort((a, b) => a.idx - b.idx);
