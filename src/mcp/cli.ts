#!/usr/bin/env node
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { CHROME_PROFILE, DATA_DIR, WHISPER_MODEL_URL } from "../core/config.ts";
import { findExecutable, ffmpegInstallHint, whisperInstallHint } from "../core/dependencies.ts";
import { CHROME_BIN } from "../core/live/cdp.ts";
import { ffmpegRecorder } from "../core/live/mic.ts";
import { exportPlaywright } from "../core/live/export-playwright.ts";
import { writePlaybook } from "../core/live/playbook.ts";
import { runPlaywrightSpec } from "../core/live/run-playwright.ts";
import { configFromEnv } from "../core/transcribe.ts";
import { createReviewServer } from "./server.ts";
import { projectPaths } from "../core/storage.ts";

const HELP = `walkmate — 시연 기록과 피드백을 코딩 에이전트에게 전달

  walkmate mcp        stdio MCP 서버 (Claude Code, Codex 등에서 실행)
  walkmate doctor     기본 도구 점검 (음성 도구는 선택)
  walkmate doctor --voice  음성 녹음·전사 도구 점검
  walkmate doctor --mic    음성 도구 점검 + 마이크 2초 녹음 테스트
  walkmate setup      whisper.cpp 모델(약 1.6GB) 내려받기
  walkmate playbook <리뷰 폴더> [--from 초] [--to 초] [--title 제목] [--out 폴더]
                             시연을 playbook.json / playbook.md 초안으로 변환 (자동 실행 없음)
  walkmate playwright [리뷰 폴더] [--out 파일] [--title 제목] [--from 초] [--to 초] [--walkmate | --no-walkmate] [--overwrite]
                             시연을 Playwright 테스트(.spec.ts)로 내보내기 (폴더를 빼면 가장 최근 녹화)
  walkmate test <spec> [--headed] [--grep 제목] [--env 이름=값]... [--no-replay]
                             Walkmate에 들어 있는 Playwright와 Chrome으로 테스트 실행 (프로젝트에 설치 불필요)

등록 (npm link 안 했으면 walkmate 대신 node <저장소>/dist/mcp/cli.js):
  claude mcp add -s user walkmate -- walkmate mcp
  codex mcp add walkmate -- walkmate mcp
  pi mcp add walkmate --exposure direct -- walkmate mcp

프로젝트 녹화·skill·메모: ${projectPaths(process.cwd()).root}
공유 모델·Chrome 로그인 프로필: ${DATA_DIR}`;

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
	case "mcp":
		await serve();
		break;
	case "doctor":
		process.exitCode = (await doctor(args.includes("--mic"), args.includes("--voice") || args.includes("--mic"))) ? 0 : 1;
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
	case "playwright":
		try {
			const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
				out: { type: "string" }, title: { type: "string" }, from: { type: "string" }, to: { type: "string" },
				walkmate: { type: "boolean" }, "no-walkmate": { type: "boolean" }, overwrite: { type: "boolean" },
			} });
			if (positionals.length > 1) throw new Error("playwright에는 리뷰 폴더를 하나만 지정하세요.");
			const seconds = (v?: string) => {
				if (v === undefined) return undefined;
				const n = Number(v);
				if (!Number.isFinite(n) || n < 0) throw new Error(`시간은 0 이상의 초여야 합니다: ${v}`);
				return n;
			};
			const result = await exportPlaywright(positionals[0], {
				cwd: process.cwd(), out: values.out, title: values.title, from: seconds(values.from), to: seconds(values.to),
				withWalkmate: values["no-walkmate"] ? false : values.walkmate, overwrite: values.overwrite,
			});
			console.log(`Playwright 테스트 ${result.steps}단계: ${result.path}`);
			for (const w of result.warnings) console.log(`△ ${w}`);
			for (const t of result.todos) console.log(`TODO ${t}`);
			console.log(`실행: walkmate test ${result.path}${result.env.map((e) => ` --env ${e}=...`).join("")}`);
		} catch (err) {
			console.error(err instanceof Error ? err.message : String(err));
			process.exitCode = 2;
		}
		break;
	case "test":
		try {
			const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
				headed: { type: "boolean" }, grep: { type: "string" }, env: { type: "string", multiple: true }, "no-replay": { type: "boolean" },
			} });
			if (positionals.length !== 1) throw new Error("test에는 테스트 파일 하나를 지정하세요.");
			const env: Record<string, string> = {};
			for (const pair of values.env ?? []) {
				const at = pair.indexOf("=");
				if (at < 1) throw new Error(`--env는 이름=값 형식이어야 합니다: ${pair}`);
				env[pair.slice(0, at)] = pair.slice(at + 1);
			}
			const ac = new AbortController();
			process.once("SIGINT", () => ac.abort());
			const r = await runPlaywrightSpec({ cwd: process.cwd(), spec: positionals[0], env, headed: values.headed, grep: values.grep, replay: !values["no-replay"], signal: ac.signal });
			console.log(r.output);
			for (const t of r.tests) if (t.replay) console.log(`replay: ${t.replay}`);
			console.log(`${r.status} · ${r.dir}`);
			process.exitCode = r.status === "passed" ? 0 : 1;
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

async function doctor(testMic: boolean, checkVoice: boolean): Promise<boolean> {
	let ok = true;
	const line = (pass: boolean | "warn", what: string, hint?: string) => {
		if (pass === false) ok = false;
		console.log(`${pass === true ? "✔" : pass === "warn" ? "△" : "✖"} ${what}${hint ? `\n    → ${hint}` : ""}`);
	};

	const major = Number(process.versions.node.split(".")[0]);
	line(major >= 22, `Node ${process.versions.node}`, major >= 22 ? undefined : "Node 22 이상이 필요합니다");

	const chrome = existsSync(CHROME_BIN) || (await findExecutable(CHROME_BIN));
	line(!!chrome, chrome ? `Chrome (${CHROME_BIN})` : `Chrome 없음: ${CHROME_BIN}`, chrome ? undefined : "Chrome을 설치하거나 WALKMATE_CHROME 으로 경로 지정");

	line(true, `리뷰 브라우저 프로필: ${CHROME_PROFILE}`);
	if (!checkVoice) {
		console.log("  음성은 선택 기능입니다. 필요한 경우 walkmate doctor --voice 또는 --mic 으로 점검하세요.");
		return ok;
	}

	const ffmpeg = await findExecutable("ffmpeg");
	line(!!ffmpeg, ffmpeg ? `ffmpeg (${ffmpeg})` : "ffmpeg 없음", ffmpeg ? undefined : ffmpegInstallHint());

	const cfg = configFromEnv();
	const whisper = await findExecutable(cfg.whisperBin);
	const model = existsSync(cfg.whisperModel);
	if (cfg.engine === "none") line("warn", "받아쓰기 꺼짐: 녹음 파일만 저장합니다 (WALKMATE_TRANSCRIBER=none)");
	else if (cfg.engine !== "openai" && whisper && model) line(true, `받아쓰기: whisper.cpp (${cfg.whisperModel})`);
	else if (cfg.engine !== "whisper-cpp" && cfg.openaiKey) line("warn", "받아쓰기: OpenAI whisper-1 (녹음이 OpenAI로 전송됩니다)", `로컬로 하려면: ${whisperInstallHint()}`);
	else line(false, `받아쓰기 엔진 없음 (whisper-cli ${whisper ? "있음" : "없음"}, 모델 ${model ? "있음" : "없음"})`, `${whisperInstallHint()} 또는 OPENAI_API_KEY 설정`);

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
			line(db > -50, `마이크 최대 음량 ${db.toFixed(0)}dB`, db > -50 ? undefined : "무음입니다. OS 마이크 권한과 WALKMATE_MIC 입력 장치를 확인하세요");
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
	if (!(await findExecutable(cfg.whisperBin))) console.log(`whisper-cli 가 없습니다. ${whisperInstallHint()}`);
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
