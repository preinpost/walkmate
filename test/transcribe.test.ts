import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { transcribeClips } from "../src/transcribe.ts";

test("skips silent clips instead of letting whisper invent text", async () => {
	const file = join(mkdtempSync(join(tmpdir(), "prr-")), "clip-0.webm");
	execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "2", "-c:a", "libopus", file]);
	// The silence check runs before any request, so the fake key is never used.
	const t = await transcribeClips([{ idx: 0, offset: 0, mime: "audio/webm", file }], {
		engine: "openai",
		lang: "ko",
		whisperBin: "whisper-cli",
		whisperModel: "",
		openaiKey: "unused",
	});
	assert.deepEqual(t.words, []);
	assert.match(t.warnings.join("\n"), /무음/);
});
