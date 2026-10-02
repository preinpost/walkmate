import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import type { BrowserRun } from "../src/core/runtime/run.ts";
import type { RunAction, RunResult, RunStart, Snapshot } from "../src/core/runtime/types.ts";
import { createRunTools } from "../src/mcp/runtime.ts";

process.env.WALKMATE_HOME = mkdtempSync(join(tmpdir(), "walkmate-runtime-mcp-"));
process.env.WALKMATE_OPEN = "0";
const { createReviewServer } = await import("../src/mcp/server.ts");
const textOf = (r: CallToolResult) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

function fake(req: RunStart, signal?: AbortSignal): BrowserRun {
	let active = true;
	let settle!: (result: RunResult) => void;
	const outcome = new Promise<RunResult>((resolve) => { settle = resolve; });
	const dir = join(req.cwd, ".walkmate", "runs", "test");
	const snapshot: Snapshot = { tab: "t1", url: req.url, title: "Test", text: "Page", elements: [], tabs: [{ id: "t1", url: req.url }] };
	const run: BrowserRun = {
		dir, initial: snapshot, get active() { return active; }, outcome,
		async step(action) { return { step: { id: "s1", t: 0, duration_ms: 1, action: action as RunAction, status: "ok" }, snapshot }; },
		async finish(cancel) {
			active = false;
			settle({ version: 1, title: req.title, dir, status: cancel ? "cancelled" : "completed", steps: 1, assertions: 0, failures: 0, warnings: [] });
			return outcome;
		},
	};
	signal?.addEventListener("abort", () => { void run.finish(true); }, { once: true });
	return run;
}

async function connect() {
	const requests: RunStart[] = [];
	const cwd = mkdtempSync(join(tmpdir(), "walkmate-runtime-project-"));
	const { server, shutdown } = createReviewServer({ cwd, startRun: async (req, signal) => { requests.push(req); return fake(req, signal); } });
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" });
	await Promise.all([server.connect(a), client.connect(b)]);
	return { client, shutdown, requests, cwd };
}

test("MCP runtime exposes the native run lifecycle with scoped defaults and evidence", async () => {
	const { client, shutdown, requests, cwd } = await connect();
	try {
		const tools = await client.listTools();
		assert.ok(tools.tools.some((tool) => tool.name === "run_start"));
		assert.match(client.getInstructions() ?? "", /Do not call review_wait for an agent run/);
		assert.match(client.getInstructions() ?? "", /without.*|external browser CLI/);
		const started = await client.callTool({ name: "run_start", arguments: {} });
		assert.ok(!started.isError, textOf(started));
		const info = JSON.parse(textOf(started));
		assert.equal(info.id, "u1");
		assert.equal(requests[0].cwd, cwd);
		assert.equal(requests[0].allow_actions, false);
		assert.equal(info.snapshot.url, "about:blank");
		assert.ok(info.dir.startsWith(join(cwd, ".walkmate", "runs")));
		assert.equal((await client.callTool({ name: "run_start", arguments: {} })).isError, true);
		assert.equal((await client.callTool({ name: "review_start", arguments: {} })).isError, true);
		const observed = await client.callTool({ name: "run_step", arguments: { id: "u1" } });
		assert.equal(JSON.parse(textOf(observed)).step.action.type, "observe");
		const finished = await client.callTool({ name: "run_finish", arguments: { id: "u1" } });
		assert.equal(JSON.parse(textOf(finished)).status, "completed");
		assert.equal((await client.callTool({ name: "run_step", arguments: { id: "u1" } })).isError, true);
		const next = await client.callTool({ name: "run_start", arguments: { allow_actions: true, isolated: true, headless: true } });
		assert.equal(JSON.parse(textOf(next)).id, "u2");
		assert.equal(requests[1].isolated, true);
		assert.equal(requests[1].headless, true);
		await shutdown();
		assert.equal((await client.callTool({ name: "run_finish", arguments: { id: "u2" } })).isError, undefined);
	} finally { await shutdown(); await client.close(); }
});

test("human review blocks agent execution and run ids do not alias review ids", async () => {
	const { client, shutdown } = await connect();
	try {
		const review = await client.callTool({ name: "review_start", arguments: { sections: [{ id: "n", kind: "note", title: "Review" }] } });
		assert.ok(!review.isError, textOf(review));
		assert.equal((await client.callTool({ name: "run_start", arguments: {} })).isError, true);
		assert.equal((await client.callTool({ name: "run_finish", arguments: { id: "r1" } })).isError, true);
		await client.callTool({ name: "review_cancel", arguments: { id: "r1" } });
		const run = await client.callTool({ name: "run_start", arguments: {} });
		assert.ok(!run.isError, textOf(run));
		assert.equal((await client.callTool({ name: "review_wait", arguments: { id: "u1" } })).isError, true);
		await client.callTool({ name: "run_finish", arguments: { id: "u1", cancel: true } });
	} finally { await shutdown(); await client.close(); }
});

test("startup reserves the single browser slot and shutdown aborts pending startup", async () => {
	let entered!: () => void;
	const opening = new Promise<void>((resolve) => { entered = resolve; });
	const tools = createRunTools({ cwd: ".", reviewBusy: () => false, startRun: async (_req, signal) => new Promise((_resolve, reject) => {
		entered();
		signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
	}) });
	const pending = tools.call("run_start", {}, new AbortController().signal);
	await opening;
	assert.equal(tools.active(), true);
	await assert.rejects(() => tools.call("run_start", {}, new AbortController().signal), /already open/);
	await tools.shutdown();
	await assert.rejects(pending, /cancelled/);
	assert.equal(tools.active(), false);
});
