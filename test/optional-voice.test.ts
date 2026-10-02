import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../src/mcp/cli.ts", import.meta.url));

async function isolated(t: { after(fn: () => Promise<void>): void }) {
	const dir = await mkdtemp(join(tmpdir(), "walkmate-no-voice-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const env = {
		...process.env, PATH: dir, Path: dir,
		WALKMATE_HOME: dir, WALKMATE_CHROME: process.execPath,
		WALKMATE_WHISPER_BIN: "missing-whisper-cli", WALKMATE_WHISPER_MODEL: join(dir, "missing-model"),
		WALKMATE_TRANSCRIBER: "auto", OPENAI_API_KEY: "",
	};
	return { dir, env };
}

test("doctor succeeds without audio tools, while explicit voice checks fail with an installation hint", async (t) => {
	const { env } = await isolated(t);
	const { stdout } = await exec(process.execPath, [cli, "doctor"], { env });
	assert.match(stdout, /음성.*선택|선택.*음성/);
	await assert.rejects(exec(process.execPath, [cli, "doctor", "--voice"], { env }), (err: Error & { code?: number; stdout?: string }) => {
		assert.equal(err.code, 1);
		assert.match(err.stdout ?? "", /ffmpeg 없음/);
		assert.match(err.stdout ?? "", /brew install|apt install|ffmpeg.org/);
		return true;
	});
});

test("pin screenshots remain attached when ffmpeg is unavailable", async (t) => {
	const { dir, env } = await isolated(t);
	// A tiny source image; the fallback must retain its bytes without invoking an image tool.
	const bytes = Buffer.from("/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAxAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEsAAQEAAAAAAAAAAAAAAAAAAAAHAQEAAAAAAAAAAAAAAAAAAAAAEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAEAAQAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8Av4AP/9k=", "base64");
	const source = join(dir, "shot.jpg");
	await writeFile(source, bytes);
	const reportModule = new URL("../src/core/live/report.ts", import.meta.url).href;
	const script = `
		import { buildLiveReport, loadImages } from ${JSON.stringify(reportModule)};
		const dir = process.argv[1];
		const file = process.argv[2];
		const report = await buildLiveReport({
			title: 'No voice', url: 'http://app/', points: [], words: [], engine: 'none', warnings: [], dir, maxShots: 1,
			outcome: {
				status: 'submitted', t0: 0, duration: 2, clips: [], rrweb: [], warnings: [], network: [], console: [], docs: [], assets: {},
				events: [{ t: 1, tab: 1, type: 'pin', id: 'p1', d: { tag: 'button', text: 'Save', rect: [1, 1, 10, 10] } }],
				shots: [{ t: 1, tab: 1, file, url: 'http://app/', dpr: 1, reason: 'pin', pin: 'p1' }]
			}
		});
		console.log(JSON.stringify({ report, images: await loadImages(report.attached) }));
	`;
	const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script, dir, source], { env });
	const { report, images } = JSON.parse(stdout);
	assert.equal(report.attached[0].file, source);
	assert.equal(images.length, 1);
	assert.equal(images[0].data, bytes.toString("base64"));
	assert.match(report.full, /원본 스크린샷/);
	assert.deepEqual(await readFile(source), bytes);
});

test("requesting a microphone without ffmpeg rejects cleanly instead of crashing the host", async (t) => {
	const { dir, env } = await isolated(t);
	const micModule = new URL("../src/core/live/mic.ts", import.meta.url).href;
	const script = `
		import { ffmpegRecorder } from ${JSON.stringify(micModule)};
		try {
			await ffmpegRecorder(process.argv[1]);
			process.exitCode = 1;
		} catch (err) {
			console.log(err.message);
		}
	`;
	const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script, join(dir, "clip.flac")], { env });
	assert.match(stdout, /ffmpeg/);
	assert.match(stdout, /brew install|apt install|ffmpeg.org/);
});
