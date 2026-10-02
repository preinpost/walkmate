import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createReviewDir, createRunDir, projectPaths } from "../src/core/storage.ts";
import { normalizeUrl } from "../src/core/review.ts";

async function project(t: { after(fn: () => Promise<void>): void }) {
	const cwd = await mkdtemp(join(tmpdir(), "walkmate-storage-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	return cwd;
}

test("project paths resolve recordings, skills and notes inside the selected project", () => {
	const root = resolve("example-project", ".walkmate");
	assert.deepEqual(projectPaths("example-project"), {
		root, reviews: join(root, "reviews"), runs: join(root, "runs"), skills: join(root, "skills"), notes: join(root, "notes"),
	});
});

test("recordings are project-local, unique and ignored by Git", async (t) => {
	const cwd = await project(t);
	execFileSync("git", ["init", "-q"], { cwd });
	const first = await createReviewDir(cwd, "mcp");
	const second = await createReviewDir(cwd, "mcp");
	assert.notEqual(first, second);
	assert.equal(first.startsWith(join(cwd, ".walkmate", "reviews", "mcp")), true);
	assert.equal(await readFile(join(cwd, ".walkmate", ".gitignore"), "utf8"), "*\n");
	const recording = join(first, "network.json");
	await writeFile(recording, "[]");
	assert.equal(execFileSync("git", ["check-ignore", recording], { cwd, encoding: "utf8" }).trim(), recording);
});

test("agent runs use unique project-local artifact folders and the same ignore policy", async (t) => {
	const cwd = await project(t);
	const first = await createRunDir(cwd);
	const second = await createRunDir(cwd);
	assert.notEqual(first, second);
	assert.equal(first.startsWith(projectPaths(cwd).runs), true);
	assert.equal(first.startsWith(projectPaths(cwd).reviews), false);
	assert.equal(await readFile(join(cwd, ".walkmate", ".gitignore"), "utf8"), "*\n");
});

test("project isolation and safe group names prevent recordings escaping their directory", async (t) => {
	const a = await project(t);
	const b = await project(t);
	for (const group of ["mcp", "../other", "..", "", "/absolute/path"]) {
		const dir = await createReviewDir(a, group);
		assert.equal(dir.startsWith(projectPaths(a).reviews), true);
		assert.equal(dir.startsWith(projectPaths(b).root), false);
	}
});

test("existing project-local ignore rules are preserved", async (t) => {
	const cwd = await project(t);
	const root = projectPaths(cwd).root;
	await mkdir(root);
	await writeFile(join(root, ".gitignore"), "reviews/\n");
	await createReviewDir(cwd, "mcp");
	assert.equal(await readFile(join(root, ".gitignore"), "utf8"), "reviews/\n");
});

test("blank launch URL is preserved and app URLs retain their normalization", () => {
	assert.equal(normalizeUrl("about:blank"), "about:blank");
	assert.equal(normalizeUrl("localhost:5173/dashboard"), "http://localhost:5173/dashboard");
	assert.equal(normalizeUrl("http://localhost:5173"), "http://localhost:5173");
	assert.equal(normalizeUrl("https://example.com/"), "https://example.com/");
});
