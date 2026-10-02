// Optional Playwright fixture integration with the system Chrome:
//   WALKMATE_E2E=1 node --test test/playwright.test.ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const enabled = process.env.WALKMATE_E2E === "1";

test("Playwright fixture records rrweb, step markers and redacted network into .walkmate/runs", { skip: !enabled, timeout: 120_000 }, async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "walkmate-playwright-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const secret = "fixture-only-password";
	const report = join(cwd, "report.json");
	await promisify(execFile)("npx", ["playwright", "test", "-c", "test/playwright/playwright.config.ts"], {
		env: { ...process.env, WALKMATE_CWD: cwd, WALKMATE_PW_SECRET: secret, WALKMATE_PW_REPORT: report, WALKMATE_PW_OUT: join(cwd, "test-results") },
	}).catch((err) => assert.fail(`${err.stdout}\n${err.stderr}`));

	const runsDir = join(cwd, ".walkmate", "runs");
	const runs = await Promise.all((await readdir(runsDir)).map(async (name) => JSON.parse(await readFile(join(runsDir, name, "run.json"), "utf8"))));
	assert.equal(runs.length, 2, "the passing retain-on-failure test leaves nothing behind");
	const passed = runs.find((run) => run.title === "logs in");
	const failed = runs.find((run) => run.title === "records failures");
	assert.equal(passed.status, "passed");
	assert.equal(failed.status, "failed");
	assert.equal(failed.expected, "failed");
	assert.match(failed.error, /toHaveText/);

	const replay = await readFile(passed.replay, "utf8");
	for (const marker of ["1-open-login", "2-fill-credentials", "3-submit", "결과 · passed"]) assert.match(replay, new RegExp(marker));
	assert.match(replay, /rrweb.Replayer/);
	const events = (await readFile(join(passed.dir, "rrweb-tab1.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	assert.ok(events.some((event) => event.type === 2), "full snapshot");
	assert.ok(events.at(-1).timestamp > events[0].timestamp);

	const network = JSON.parse(await readFile(join(passed.dir, "network.json"), "utf8"));
	const login = network.find((entry: { url: string }) => entry.url.endsWith("/api/login"));
	assert.equal(login.status, 200);
	assert.match(login.postData, /"password":"\[redacted\]"/);
	assert.match(await readFile(join(passed.dir, login.body), "utf8"), /"access_token":"\[redacted\]"/);
	for (const file of ["network.json", "rrweb-tab1.jsonl", "replay.html", login.body]) {
		assert.equal((await readFile(join(passed.dir, file), "utf8")).includes(secret), false, `${file} must not contain the password`);
	}

	const results = JSON.parse(await readFile(report, "utf8"));
	const spec = results.suites[0].specs.find((s: { title: string }) => s.title === "logs in");
	const result = spec.tests[0].results[0];
	assert.ok(result.attachments.some((a: { name: string }) => a.name === "walkmate replay"));
	const step = result.steps.find((s: { title: string }) => s.title === "3-submit");
	assert.ok(step, "test.step still reports to Playwright");
});
