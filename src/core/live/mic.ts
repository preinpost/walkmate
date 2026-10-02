import { spawn } from "node:child_process";
import { env } from "../config.ts";
import { ffmpegInstallHint } from "../dependencies.ts";

export interface Recording {
	/** Epoch ms of the first captured sample. */
	startedAt: number;
	stop(): Promise<void>;
}

/** Records one clip to `file`. `onLevel` gets the peak (0..1) of roughly every 100ms of audio. */
export type Recorder = (file: string, onLevel?: (peak: number) => void) => Promise<Recording>;

const LEVEL_RATE = 8000;

/**
 * Microphone through ffmpeg, so recording survives page reloads and navigation in the browser.
 * One output is the clip; a second, low-rate raw stream feeds the level meter.
 */
export const ffmpegRecorder: Recorder = (file, onLevel) => {
	const device = env("MIC") ?? "default";
	const input =
		process.platform === "darwin"
			? ["-f", "avfoundation", "-i", `:${device}`]
			: process.platform === "win32"
				? ["-f", "dshow", "-i", `audio=${device}`]
				: ["-f", "pulse", "-i", device];
	const proc = spawn(
		"ffmpeg",
		[
			"-hide_banner",
			"-loglevel",
			"error",
			...input,
			...["-map", "0:a", "-ac", "1", "-ar", "48000", "-c:a", "flac", "-y", file],
			...["-map", "0:a", "-ac", "1", "-ar", String(LEVEL_RATE), "-f", "s16le", "pipe:1"],
		],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);

	let stderr = "";
	proc.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
	const exited = new Promise<number | null>((resolve) => proc.once("exit", resolve));

	return new Promise<Recording>((resolve, reject) => {
		let startedAt: number | undefined;
		let pending = Buffer.alloc(0);
		const block = (LEVEL_RATE / 10) * 2;

		proc.stdout.on("data", (chunk: Buffer) => {
			if (startedAt === undefined) {
				// The first chunk already holds this much audio, so the clip began that long ago.
				startedAt = Date.now() - (chunk.length / 2 / LEVEL_RATE) * 1000;
				resolve({ startedAt, stop });
			}
			if (!onLevel) return;
			pending = Buffer.concat([pending, chunk]);
			while (pending.length >= block) {
				let peak = 0;
				for (let i = 0; i < block; i += 2) peak = Math.max(peak, Math.abs(pending.readInt16LE(i)));
				onLevel(peak / 32768);
				pending = pending.subarray(block);
			}
		});

		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(new Error(`마이크가 응답하지 않습니다. ${stderr.trim()}`));
		}, 8000);
		proc.once("error", (err) => {
			clearTimeout(timer);
			reject(new Error(`마이크를 시작하지 못했습니다 (${err.message}). ${ffmpegInstallHint()}`));
		});
		exited.then((code) => {
			clearTimeout(timer);
			if (startedAt === undefined) reject(new Error(`마이크를 열지 못했습니다 (ffmpeg ${code}): ${stderr.trim() || "권한을 확인하세요"}`));
		});
		proc.stdout.once("data", () => clearTimeout(timer));

		async function stop() {
			if (proc.exitCode !== null) return;
			// "q" lets ffmpeg finish the flac file properly.
			proc.stdin.end("q");
			const t = setTimeout(() => proc.kill("SIGTERM"), 4000);
			await exited;
			clearTimeout(t);
		}
	});
};
