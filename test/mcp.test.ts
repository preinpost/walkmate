import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Config is read when the modules load, so set it before importing the server.
process.env.REVIEW_RECORDER_HOME = mkdtempSync(join(tmpdir(), "prr-mcp-"));
process.env.REVIEW_RECORDER_OPEN = "0";
process.env.REVIEW_RECORDER_TRANSCRIBER = "none";
const { createReviewServer } = await import("../src/mcp/server.ts");

async function connect() {
	const { server, shutdown } = createReviewServer({ cwd: process.cwd() });
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" });
	await Promise.all([server.connect(a), client.connect(b)]);
	return { client, shutdown };
}

const textOf = (r: any) => r.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");

test("start, wait while open, submit, get the feedback", async () => {
	const { client, shutdown } = await connect();
	const tools = await client.listTools();
	assert.deepEqual(tools.tools.map((t) => t.name), ["review_start", "review_wait", "review_cancel"]);
	assert.ok(client.getInstructions()?.includes("review_wait"));

	const started = await client.callTool({
		name: "review_start",
		arguments: { title: "만료", sections: [{ id: "q1", kind: "question", title: "만료 시간?", options: ["15분", "1시간"] }] },
	});
	assert.ok(!started.isError, textOf(started));
	const url = /http:\/\/127\.0\.0\.1:\d+\/r\/\S+/.exec(textOf(started))?.[0];
	assert.ok(url, textOf(started));

	const busy = await client.callTool({ name: "review_start", arguments: { title: "x", sections: [{ id: "n", kind: "note", title: "n" }] } });
	assert.equal(busy.isError, true);

	const pending = await client.callTool({ name: "review_wait", arguments: { id: "r1", timeout_sec: 1 } });
	assert.match(textOf(pending), /still in progress/);

	const payload = { events: [], comments: { q1: "짧을수록 좋아요" }, answers: { q1: "1시간" }, general: "", duration: 3 };
	assert.equal((await fetch(`${url}/submit`, { method: "POST", body: JSON.stringify(payload) })).status, 200);

	const done = await client.callTool({ name: "review_wait", arguments: { id: "r1", timeout_sec: 10 } });
	assert.ok(!done.isError, textOf(done));
	assert.match(textOf(done), /✅ 답: 1시간/);
	assert.match(textOf(done), /💬 코멘트: 짧을수록 좋아요/);

	const gone = await client.callTool({ name: "review_wait", arguments: { id: "r1" } });
	assert.equal(gone.isError, true);
	await shutdown();
	await client.close();
});

test("rejects bad requests and cancels open reviews", async () => {
	const { client, shutdown } = await connect();
	const bad = await client.callTool({ name: "review_start", arguments: { title: "x", sections: [{ id: "bad id!", kind: "note", title: "n" }] } });
	assert.equal(bad.isError, true);
	assert.match(textOf(bad), /sections\[0\]\.id/);
	const empty = await client.callTool({ name: "review_start", arguments: { title: "x" } });
	assert.equal(empty.isError, true);

	const started = await client.callTool({ name: "review_start", arguments: { title: "c", sections: [{ id: "n", kind: "note", title: "n" }] } });
	const id = /Review (r\d+)/.exec(textOf(started))?.[1];
	const cancelled = await client.callTool({ name: "review_cancel", arguments: { id } });
	assert.match(textOf(cancelled), /cancelled/);
	await shutdown();
	await client.close();
});

test("prompts tell the agent to start and keep waiting", async () => {
	const { client, shutdown } = await connect();
	const { prompts } = await client.listPrompts();
	assert.deepEqual(prompts.map((p) => p.name), ["live_review", "review_changes"]);
	const p = await client.getPrompt({ name: "live_review", arguments: { url: "localhost:5173/dashboard" } });
	const msg = p.messages[0].content;
	assert.ok(msg.type === "text" && /review_start/.test(msg.text) && /review_wait/.test(msg.text) && /localhost:5173/.test(msg.text));
	await shutdown();
	await client.close();
});
