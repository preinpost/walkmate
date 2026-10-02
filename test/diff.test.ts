import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collectDiff, parseUnifiedDiff } from "../src/core/diff.ts";

test("parses hunks with line numbers", () => {
	const files = parseUnifiedDiff(
		[
			"diff --git a/a.go b/a.go",
			"--- a/a.go",
			"+++ b/a.go",
			"@@ -1,3 +1,4 @@ func x()",
			" one",
			"-two",
			"+TWO",
			"+three",
			" four",
			"\\ No newline at end of file",
			"",
		].join("\n"),
	);
	assert.equal(files.length, 1);
	assert.equal(files[0].path, "a.go");
	const h = files[0].hunks[0];
	assert.deepEqual([h.newStart, h.newEnd], [1, 4]);
	assert.deepEqual(
		h.lines.map((l) => `${l.kind}${l.oldNo ?? ""}/${l.newNo ?? ""}`),
		[" 1/1", "-2/", "+/2", "+/3", " 3/4"],
	);
});

test("collects tracked and untracked changes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "walkmate-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
	git("init", "-q");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	writeFileSync(join(dir, "a.txt"), "1\n2\n3\n");
	git("add", ".");
	git("commit", "-qm", "init");
	writeFileSync(join(dir, "a.txt"), "1\nTWO\n3\n");
	writeFileSync(join(dir, "new.txt"), "hello\n");

	const all = await collectDiff(dir, undefined);
	assert.deepEqual(all.map((f) => f.path).sort(), ["a.txt", "new.txt"]);
	assert.equal(all.find((f) => f.path === "new.txt")?.hunks[0].lines[0].text, "hello");

	const only = await collectDiff(dir, ["new.txt"]);
	assert.deepEqual(only.map((f) => f.path), ["new.txt"]);
});

test("works before the first commit", async () => {
	const dir = mkdtempSync(join(tmpdir(), "walkmate-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	writeFileSync(join(dir, "staged.txt"), "s\n");
	writeFileSync(join(dir, "loose.txt"), "l\n");
	execFileSync("git", ["add", "staged.txt"], { cwd: dir });
	const files = await collectDiff(dir, undefined);
	assert.deepEqual(files.map((f) => f.path).sort(), ["loose.txt", "staged.txt"]);
});
