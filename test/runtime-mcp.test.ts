import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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

test("run_step batches stop at the first failure and return evidence only for the final step", async () => {
	const seen: RunAction[] = [];
	const shot = join(mkdtempSync(join(tmpdir(), "walkmate-batch-")), "shot.jpg");
	writeFileSync(shot, "jpeg");
	const snapshot = (n: number): Snapshot => ({ tab: "t1", screenshot: shot, url: `http://app/${n}`, title: `Page ${n}`, text: "x".repeat(1500),
		elements: [{ ref: "e1", tag: "button", role: "button", name: "Go", disabled: false }], tabs: [{ id: "t1", url: `http://app/${n}` }] });
	const run: BrowserRun = {
		dir: "/tmp/run", initial: snapshot(0), active: true, outcome: new Promise(() => {}),
		async step(input) {
			const action = input as RunAction;
			seen.push(action);
			if (action.type === "fill") throw new Error("UI actions are not authorized.");
			const status = action.type === "assert" ? "failed" : "ok";
			return { step: { id: `s${seen.length}`, t: 0, duration_ms: 1, action, status, ...(status === "failed" ? { error: "Assertion failed." } : {}) }, snapshot: snapshot(seen.length) };
		},
		async finish() { return { version: 1, title: "", dir: "", status: "completed", steps: 0, assertions: 0, failures: 0, warnings: [] }; },
	};
	const tools = createRunTools({ cwd: ".", reviewBusy: () => false, startRun: async () => run });
	const signal = new AbortController().signal;
	const call = (args: Record<string, unknown>) => tools.call("run_step", { id: "u1", ...args }, signal);
	await tools.call("run_start", {}, signal);
	const images = (r: CallToolResult) => r.content.filter((c) => c.type === "image").length;
	const json = (r: CallToolResult) => JSON.parse(textOf(r));

	const ok = await call({ actions: [{ type: "observe" }, { type: "wait", condition: "url", expected: "/" }], evidence: "summary" });
	assert.equal(ok.isError, undefined);
	assert.equal(images(ok), 0);
	assert.deepEqual({ ...json(ok), snapshot: undefined }, { id: "u1", dir: "/tmp/run", status: "ok", completed: 2, total: 2, snapshot: undefined,
		steps: [{ id: "s1", type: "observe", status: "ok", duration_ms: 1 }, { id: "s2", type: "wait", status: "ok", duration_ms: 1 }] });
	assert.equal(json(ok).snapshot.url, "http://app/2");
	assert.equal(json(ok).snapshot.element_count, 1);
	assert.equal(json(ok).snapshot.elements, undefined);
	assert.ok(json(ok).snapshot.text.length <= 1001);

	seen.length = 0;
	const failed = await call({ actions: [{ type: "observe", source_step: "a" }, { type: "assert", condition: "url", expected: "/x" }, { type: "observe" }], evidence: "none" });
	assert.equal(failed.isError, true);
	assert.equal(seen.length, 2, "actions after a failure must not run");
	assert.equal(images(failed), 1, "failures always return full evidence");
	assert.equal(json(failed).status, "failed");
	assert.equal(json(failed).completed, 1);
	assert.equal(json(failed).steps[0].source_step, "a");
	assert.equal(json(failed).steps[1].error, "Assertion failed.");
	assert.equal(json(failed).snapshot.elements.length, 1);

	seen.length = 0;
	await assert.rejects(() => call({ actions: [{ type: "observe" }, { type: "click" }] }), /actions\[1\]: click requires a target/);
	assert.equal(seen.length, 0, "malformed sequences are rejected before acting");
	await assert.rejects(() => call({ action: { type: "observe" }, actions: [{ type: "observe" }] }), /either action or actions/);
	await assert.rejects(() => call({ actions: [] }), /1 to 50/);
	await assert.rejects(() => call({ evidence: "all" }), /evidence must be/);
	await assert.rejects(() => call({ actions: [{ type: "fill", target: { kind: "testid", value: "x" }, value: "v" }] }), /not authorized/);

	const partial = await call({ actions: [{ type: "observe" }, { type: "fill", target: { kind: "testid", value: "x" }, value: "v" }] });
	assert.equal(partial.isError, true);
	assert.equal(json(partial).completed, 1);
	assert.match(json(partial).error, /not authorized/);

	const single = await call({ action: { type: "observe" }, evidence: "none" });
	assert.equal(images(single), 0);
	assert.equal(json(single).snapshot, undefined);
	assert.equal(json(single).step.action.type, "observe");
	const full = await call({});
	assert.equal(images(full), 1);
	assert.equal(json(full).snapshot.elements.length, 1);
});
