import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { transcribeClips } from "../src/core/transcribe.ts";
import { findExecutable } from "../src/core/dependencies.ts";

const ffmpeg = await findExecutable("ffmpeg");
test("skips silent clips instead of letting whisper invent text", { skip: !ffmpeg && "optional ffmpeg is not installed" }, async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "prr-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "clip-0.webm");
	execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "2", "-c:a", "libopus", file]);
	// The silence check runs before any request, so the fake key is never used.
	const transcript = await transcribeClips([{ idx: 0, offset: 0, mime: "audio/webm", file }], {
		engine: "openai",
		lang: "ko",
		whisperBin: "whisper-cli",
		whisperModel: "",
		openaiKey: "unused",
	});
	assert.deepEqual(transcript.words, []);
	assert.match(transcript.warnings.join("\n"), /무음/);
});
