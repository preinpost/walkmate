#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CHROME_PROFILE, DATA_DIR, WHISPER_MODEL_URL } from "../core/config.ts";
import { CHROME_BIN } from "../core/live/cdp.ts";
import { ffmpegRecorder } from "../core/live/mic.ts";
import { writePlaybook } from "../core/live/playbook.ts";
import { configFromEnv } from "../core/transcribe.ts";
import { createReviewServer } from "./server.ts";

const HELP = `walkmate — 화면을 보며 말로 하는 리뷰를 코딩 에이전트에게 전달

  walkmate mcp        stdio MCP 서버 (Claude Code, Codex 등에서 실행)
  walkmate doctor     필요한 도구 점검 (--mic: 마이크 2초 녹음 테스트)
  walkmate setup      whisper.cpp 모델(약 1.6GB) 내려받기
  walkmate playbook <리뷰 폴더> [--from 초] [--to 초] [--title 제목] [--out 폴더]
                             시연을 playbook.json / playbook.md 초안으로 변환 (자동 실행 없음)

등록 (npm link 안 했으면 walkmate 대신 node <저장소>/dist/mcp/cli.js):
  claude mcp add -s user walkmate -- walkmate mcp
  codex mcp add walkmate -- walkmate mcp
  pi mcp add walkmate --exposure direct -- walkmate mcp

데이터: ${DATA_DIR}`;

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
	case "mcp":
		await serve();
		break;
	case "doctor":
		process.exitCode = (await doctor(args.includes("--mic"))) ? 0 : 1;
		break;
	case "setup":
		await setup();
		break;
	case "playbook":
		try {
			const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
				from: { type: "string" }, to: { type: "string" }, title: { type: "string" }, out: { type: "string" },
			} });
			if (positionals.length !== 1) throw new Error("playbook에는 리뷰 폴더 하나를 지정하세요.");
			const result = await writePlaybook(positionals[0], {
				from: values.from === undefined ? undefined : Number(values.from),
				to: values.to === undefined ? undefined : Number(values.to),
				title: values.title, out: values.out,
			});
			console.log(`플레이북 초안 ${result.playbook.steps.length}단계\n${result.json}\n${result.markdown}\n실행 전에 단계와 완료 조건을 검토하세요.`);
		} catch (err) {
			console.error(err instanceof Error ? err.message : String(err));
			process.exitCode = 2;
		}
		break;
	default:
		console.log(HELP);
		if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exitCode = 2;
}

async function serve() {
	// stdout carries the protocol; anything else printed there would corrupt it.
	console.log = console.error;
	const { server, shutdown } = createReviewServer();
	let closing = false;
	const close = async () => {
		if (closing) return;
		closing = true;
		await shutdown();
		process.exit(0);
	};
	server.onclose = close;
	process.on("SIGINT", close);
	process.on("SIGTERM", close);
	process.stdin.on("end", close);
	await server.connect(new StdioServerTransport());
}

async function doctor(testMic: boolean): Promise<boolean> {
	let ok = true;
	const line = (pass: boolean | "warn", what: string, hint?: string) => {
		if (pass === false) ok = false;
		console.log(`${pass === true ? "✔" : pass === "warn" ? "△" : "✖"} ${what}${hint ? `\n    → ${hint}` : ""}`);
	};

	const major = Number(process.versions.node.split(".")[0]);
	line(major >= 22, `Node ${process.versions.node}`, major >= 22 ? undefined : "Node 22 이상이 필요합니다");

	const ffmpeg = await which("ffmpeg");
	line(!!ffmpeg, ffmpeg ? `ffmpeg (${ffmpeg})` : "ffmpeg 없음", ffmpeg ? undefined : "brew install ffmpeg");

	const chrome = existsSync(CHROME_BIN) || (!CHROME_BIN.includes("/") && (await which(CHROME_BIN)));
	line(!!chrome, chrome ? `Chrome (${CHROME_BIN})` : `Chrome 없음: ${CHROME_BIN}`, chrome ? undefined : "Chrome을 설치하거나 REVIEW_RECORDER_CHROME 으로 경로 지정");

	const cfg = configFromEnv();
	const whisper = await which(cfg.whisperBin);
	const model = existsSync(cfg.whisperModel);
	const openai = !!cfg.openaiKey;
	if (whisper && model) line(true, `받아쓰기: whisper.cpp (${cfg.whisperModel})`);
	else if (openai) line("warn", "받아쓰기: OpenAI whisper-1 (OPENAI_API_KEY)", "로컬로 하려면: brew install whisper-cpp && walkmate setup");
	else
		line(
			false,
			`받아쓰기 엔진 없음 (whisper-cli ${whisper ? "있음" : "없음"}, 모델 ${model ? "있음" : "없음"})`,
			[!whisper && "brew install whisper-cpp", !model && "walkmate setup", "또는 OPENAI_API_KEY 설정"].filter(Boolean).join(" · "),
		);

	line(true, `리뷰 브라우저 프로필: ${CHROME_PROFILE}`);

	if (testMic && ffmpeg) {
		const file = `${DATA_DIR}/mic-test.flac`;
		await mkdir(DATA_DIR, { recursive: true });
		let peak = 0;
		try {
			const rec = await ffmpegRecorder(file, (p) => (peak = Math.max(peak, p)));
			console.log("  2초 동안 말해 보세요…");
			await new Promise((r) => setTimeout(r, 2000));
			await rec.stop();
			const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
			line(db > -50, `마이크 최대 음량 ${db.toFixed(0)}dB`, db > -50 ? undefined : "무음입니다. 시스템 설정 > 개인정보 보호 > 마이크에서 터미널 앱을 허용하세요");
		} catch (err) {
			line(false, "마이크", err instanceof Error ? err.message : String(err));
		} finally {
			await rm(file, { force: true });
		}
	} else if (!testMic) {
		console.log("  (마이크까지 확인하려면: walkmate doctor --mic)");
	}
	return ok;
}

async function setup() {
	const cfg = configFromEnv();
	if (!(await which(cfg.whisperBin))) console.log(`whisper-cli 가 없습니다. 먼저 설치하세요: brew install whisper-cpp`);
	if (existsSync(cfg.whisperModel)) {
		console.log(`모델이 이미 있습니다: ${cfg.whisperModel}`);
		return;
	}
	await mkdir(dirname(cfg.whisperModel), { recursive: true });
	const part = `${cfg.whisperModel}.part`;
	console.log(`내려받는 중: ${WHISPER_MODEL_URL}\n  → ${cfg.whisperModel}`);
	const res = await fetch(WHISPER_MODEL_URL);
	if (!res.ok || !res.body) throw new Error(`다운로드 실패: ${res.status}`);
	const total = Number(res.headers.get("content-length")) || 0;
	let got = 0;
	let shown = -1;
	const body = Readable.fromWeb(res.body as never);
	body.on("data", (c: Buffer) => {
		got += c.length;
		const pct = total ? Math.floor((got / total) * 100) : -1;
		if (pct !== shown && pct % 5 === 0) {
			shown = pct;
			process.stderr.write(`\r  ${pct}% (${(got / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB)`);
		}
	});
	await pipeline(body, createWriteStream(part));
	await rename(part, cfg.whisperModel);
	console.log("\n완료");
}

function which(bin: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		execFile(process.platform === "win32" ? "where" : "which", [bin], (err, stdout) => resolve(err ? undefined : stdout.trim().split("\n")[0]));
	});
}
