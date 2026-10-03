import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { bundledPlaywright, stageSpec } from "../src/core/live/run-playwright.ts";

process.env.WALKMATE_HOME = await mkdtemp(join(tmpdir(), "walkmate-pwrun-home-"));
const { createReviewServer } = await import("../src/mcp/server.ts");

test("staging wraps the test with withWalkmate, keeps the source recording and points relative imports home", () => {
	const spec = [
		"// 원본 녹화: /proj/.walkmate/reviews/mcp/x",
		'import { test, expect, type Page } from "@playwright/test";',
		'import { login } from "./helpers/login";',
		'const data = await import("../data.json");',
		'test("t", async ({ page }) => {});',
	].join("\n");
	const out = stageSpec(spec, "/proj/e2e", true);
	assert.equal(out.replay, true);
	assert.match(out.code, /import \{ test as __walkmateBase, expect, type Page \} from "@playwright\/test";/);
	assert.match(out.code, /import \{ withWalkmate as __withWalkmate \} from "walkmate\/playwright";\nconst test = __withWalkmate\(__walkmateBase\);/);
	assert.match(out.code, /test\.use\(\{ walkmate: \{ sourceRecording: "\/proj\/\.walkmate\/reviews\/mcp\/x" \} \}\);/);
	assert.match(out.code, /from "\/proj\/e2e\/helpers\/login"/);
	assert.match(out.code, /import\("\/proj\/data\.json"\)/);

	const already = 'import { test as base } from "@playwright/test";\nimport { withWalkmate } from "walkmate/playwright";\nconst test = withWalkmate(base);';
	assert.deepEqual(stageSpec(already, "/p", true), { code: already, replay: true });
	const renamed = 'import { test as it } from "@playwright/test";';
	assert.equal(stageSpec(renamed, "/p", true).replay, false);
	assert.equal(stageSpec(spec, "/p", false).replay, false);
	assert.doesNotMatch(stageSpec(spec, "/p", false).code, /withWalkmate/);
});

test("Walkmate ships its own Playwright test runner", () => {
	const pw = bundledPlaywright();
	assert.match(pw.version, /^\d+\.\d+/);
	assert.match(pw.cli, /cli\.js$/);
});

test("run_playwright validates before starting and explains missing files", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "walkmate-pwrun-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await mkdir(join(cwd, "e2e"));
	await writeFile(join(cwd, "e2e", "notes.md"), "# not a test");
	const { server, shutdown } = createReviewServer({ cwd });
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" });
	await Promise.all([server.connect(a), client.connect(b)]);
	t.after(async () => { await shutdown(); await client.close(); });
	const textOf = (r: CallToolResult) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
	const call = (args: Record<string, unknown>) => client.callTool({ name: "run_playwright", arguments: args }) as Promise<CallToolResult>;

	const description = (await client.listTools()).tools.find((tool) => tool.name === "run_playwright")?.description ?? "";
	assert.match(description, /do not install @playwright\/test/);
	assert.match(textOf(await call({})), /spec is required/);
	assert.match(textOf(await call({ spec: "e2e/x.spec.ts", nope: 1 })), /Unknown field: nope/);
	assert.match(textOf(await call({ spec: "e2e/x.spec.ts", env: { A: 1 } })), /env must map names to string values/);
	assert.match(textOf(await call({ spec: "e2e/missing.spec.ts" })), /테스트 파일이 없습니다/);
	assert.match(textOf(await call({ spec: "e2e/notes.md" })), /Playwright 테스트 파일/);
	assert.match(textOf(await call({ id: "p99" })), /No Playwright run p99/);
	assert.match(client.getInstructions() ?? "", /run_playwright\(\{ spec \}\)/);
});
