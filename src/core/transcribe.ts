import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { env, MODELS_DIR, WHISPER_MODEL_NAME } from "./config.ts";
import type { ClipInfo, Word } from "./types.ts";

export interface TranscribeConfig {
	/** auto | whisper-cpp | openai | none */
	engine: string;
	lang: string;
	whisperBin: string;
	whisperModel: string;
	openaiKey?: string;
}

export interface Transcript {
	words: Word[];
	engine: string;
	warnings: string[];
}

export const DEFAULT_WHISPER_MODEL = join(MODELS_DIR, WHISPER_MODEL_NAME);

export function configFromEnv(openaiKey?: string): TranscribeConfig {
	return {
		engine: env("TRANSCRIBER") ?? "auto",
		lang: env("LANG") ?? "ko",
		whisperBin: env("WHISPER_BIN") ?? "whisper-cli",
		whisperModel: env("WHISPER_MODEL") ?? DEFAULT_WHISPER_MODEL,
		openaiKey: process.env.OPENAI_API_KEY || openaiKey,
	};
}

/** Transcribe every clip and return words on the page clock. */
export async function transcribeClips(clips: ClipInfo[], cfg: TranscribeConfig, signal?: AbortSignal): Promise<Transcript> {
	const warnings: string[] = [];
	if (!clips.length) return { words: [], engine: "none", warnings };

	const engine = await pickEngine(cfg, warnings);
	if (engine === "none") {
		warnings.push(`음성을 받아쓰지 못했습니다. 녹음 파일: ${clips.map((c) => c.file).join(", ")}`);
		return { words: [], engine, warnings };
	}

	const words: Word[] = [];
	for (const clip of clips) {
		try {
			// Whisper invents sentences for silence ("한글자막 by …"), so never send it a silent clip.
			const peak = await peakDb(clip.file, signal);
			if (peak !== undefined && peak < SILENCE_DB) {
				warnings.push(`${basename(clip.file)} 무음 (최대 ${peak.toFixed(0)}dB): 마이크 음소거나 입력 장치를 확인하세요`);
				continue;
			}
			const clipWords = engine === "whisper-cpp" ? await whisperCpp(clip, cfg, signal) : await openai(clip, cfg, signal);
			for (const w of clipWords) words.push({ start: w.start + clip.offset, end: w.end + clip.offset, text: w.text });
		} catch (err) {
			warnings.push(`${basename(clip.file)} 받아쓰기 실패: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	words.sort((a, b) => a.start - b.start);
	return { words, engine, warnings };
}

async function pickEngine(cfg: TranscribeConfig, warnings: string[]): Promise<"whisper-cpp" | "openai" | "none"> {
	const whisperReady = async () => existsSync(cfg.whisperModel) && (await run("which", [cfg.whisperBin]).then(() => true, () => false));
	switch (cfg.engine) {
		case "none":
			return "none";
		case "whisper-cpp":
			if (await whisperReady()) return "whisper-cpp";
			warnings.push(`whisper-cpp 준비 안 됨 (${cfg.whisperBin}, 모델 ${cfg.whisperModel})`);
			return "none";
		case "openai":
			if (cfg.openaiKey) return "openai";
			warnings.push("OPENAI_API_KEY 없음");
			return "none";
		default:
			if (await whisperReady()) return "whisper-cpp";
			if (cfg.openaiKey) return "openai";
			warnings.push(`받아쓰기 엔진 없음: ${cfg.whisperBin} + ${cfg.whisperModel} 또는 OPENAI_API_KEY 가 필요합니다`);
			return "none";
	}
}

async function whisperCpp(clip: ClipInfo, cfg: TranscribeConfig, signal?: AbortSignal): Promise<Word[]> {
	const wav = clip.file.replace(/\.[^.]+$/, ".wav");
	const out = clip.file.replace(/\.[^.]+$/, ".whisper");
	await run("ffmpeg", ["-y", "-loglevel", "error", "-i", clip.file, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], signal);
	// -ml 1 -sow makes every segment a single word, which gives word-level offsets.
	await run(cfg.whisperBin, ["-m", cfg.whisperModel, "-f", wav, "-l", cfg.lang, "-ml", "1", "-sow", "-oj", "-of", out, "-np"], signal);
	const json = JSON.parse(await readFile(`${out}.json`, "utf8")) as {
		transcription?: { offsets: { from: number; to: number }; text: string }[];
	};
	return (json.transcription ?? [])
		.map((s) => ({ start: s.offsets.from / 1000, end: s.offsets.to / 1000, text: s.text.trim() }))
		.filter((w) => w.text && !/^[[(].*[\])]$/.test(w.text));
}

async function openai(clip: ClipInfo, cfg: TranscribeConfig, signal?: AbortSignal): Promise<Word[]> {
	const form = new FormData();
	form.append("file", new Blob([await readFile(clip.file)], { type: clip.mime }), basename(clip.file));
	// Only whisper-1 returns word timestamps.
	form.append("model", "whisper-1");
	form.append("language", cfg.lang);
	form.append("response_format", "verbose_json");
	form.append("timestamp_granularities[]", "word");
	const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
		method: "POST",
		headers: { authorization: `Bearer ${cfg.openaiKey}` },
		body: form,
		signal,
	});
	if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
	const json = (await res.json()) as { words?: { word: string; start: number; end: number }[] };
	return (json.words ?? []).map((w) => ({ start: w.start, end: w.end, text: w.word.trim() })).filter((w) => w.text);
}

const SILENCE_DB = -50;

/** Loudest sample in dBFS, or undefined when ffmpeg cannot tell. */
async function peakDb(file: string, signal?: AbortSignal): Promise<number | undefined> {
	const out = await new Promise<string>((resolve) => {
		// volumedetect reports on stderr.
		execFile("ffmpeg", ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { signal }, (_err, _stdout, stderr) =>
			resolve(stderr),
		);
	});
	const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(out);
	if (!m) return undefined;
	return m[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(m[1]);
}

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(cmd, args, { signal, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) reject(new Error(`${cmd}: ${(stderr || err.message).trim().split("\n").slice(-3).join(" ")}`));
			else resolve(stdout);
		});
	});
}
