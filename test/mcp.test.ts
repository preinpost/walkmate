import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import type { ReviewRequest } from "../src/core/types.ts";

// Config is read when the modules load, so set it before importing the server.
process.env.WALKMATE_HOME = mkdtempSync(join(tmpdir(), "walkmate-mcp-"));
process.env.WALKMATE_OPEN = "0";
process.env.WALKMATE_TRANSCRIBER = "none";
const { createReviewServer } = await import("../src/mcp/server.ts");

async function connect(opts: Parameters<typeof createReviewServer>[0] = {}) {
	const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), "walkmate-project-"));
	const { server, shutdown } = createReviewServer({ ...opts, cwd });
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" });
	await Promise.all([server.connect(a), client.connect(b)]);
	return { client, shutdown, cwd };
}

const textOf = (r: CallToolResult) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

test("start, wait while open, submit, get the feedback", async () => {
	const { client, shutdown, cwd } = await connect();
	const tools = await client.listTools();
	assert.deepEqual(tools.tools.map((t) => t.name), ["review_start", "review_wait", "review_cancel", "export_to_playwright", "run_start", "run_step", "run_finish"]);
	assert.ok(client.getInstructions()?.includes("review_wait"));

	const started = await client.callTool({
		name: "review_start",
		arguments: { title: "만료", sections: [{ id: "q1", kind: "question", title: "만료 시간?", options: ["15분", "1시간"] }] },
	});
	assert.ok(!started.isError, textOf(started));
	const recording = /Recording directory: (.+)/.exec(textOf(started))?.[1];
	assert.ok(recording?.startsWith(join(cwd, ".walkmate", "reviews", "mcp") + sep));
	assert.equal(await readFile(join(cwd, ".walkmate", ".gitignore"), "utf8"), "*\n");
	assert.match(textOf(started), /do not use global agent memory/);
	const url = /http:\/\/127\.0\.0\.1:\d+\/r\/\S+/.exec(textOf(started))?.[0];
	assert.ok(url, textOf(started));

	const busy = await client.callTool({ name: "review_start", arguments: { title: "x", sections: [{ id: "n", kind: "note", title: "n" }] } });
	assert.equal(busy.isError, true);

	const progressMessages: string[] = [];
	const pending = await client.callTool(
		{ name: "review_wait", arguments: { id: "r1", timeout_sec: 1 } },
		{ onprogress: (progress) => { if (progress.message) progressMessages.push(progress.message); } },
	);
	assert.match(textOf(pending), /still in progress/);
	assert.ok(progressMessages.length > 0, "waiting emits MCP progress to the client");

	const payload = { events: [], comments: { q1: "짧을수록 좋아요" }, answers: { q1: "1시간" }, general: "", duration: 3 };
	assert.equal((await fetch(`${url}/submit`, { method: "POST", body: JSON.stringify(payload) })).status, 200);

	const done = await client.callTool({ name: "review_wait", arguments: { id: "r1", timeout_sec: 10 } });
	assert.ok(!done.isError, textOf(done));
	assert.match(textOf(done), /✅ 답: 1시간/);
	assert.match(textOf(done), /💬 코멘트: 짧을수록 좋아요/);
	assert.ok(textOf(done).includes(`Recording directory: ${recording}`));
	assert.ok(textOf(done).includes(join(cwd, ".walkmate", "skills")));
	assert.ok(textOf(done).includes(join(cwd, ".walkmate", "notes")));
	assert.match(textOf(done), /Never copy plaintext credentials/);

	const gone = await client.callTool({ name: "review_wait", arguments: { id: "r1" } });
	assert.equal(gone.isError, true);
	await shutdown();
	await client.close();
});

test("explicit cwd saves recordings and reports artifact paths for the client's project, not the server project", async (t) => {
	const { client, shutdown, cwd: serverCwd } = await connect();
	const cwd = mkdtempSync(join(tmpdir(), "walkmate-client-project-"));
	t.after(async () => {
		await shutdown();
		await client.close();
		await Promise.all([serverCwd, cwd].map((dir) => rm(dir, { recursive: true, force: true })));
	});
	const started = await client.callTool({ name: "review_start", arguments: {
		cwd, sections: [{ id: "n1", kind: "note", title: "시연" }],
	} });
	assert.ok(!started.isError, textOf(started));
	const recording = /Recording directory: (.+)/.exec(textOf(started))?.[1];
	assert.ok(recording?.startsWith(join(cwd, ".walkmate", "reviews") + sep));
	assert.equal(JSON.parse(await readFile(join(recording!, "request.json"), "utf8")).title, "Walkmate");
	await assert.rejects(stat(join(serverCwd, ".walkmate")), { code: "ENOENT" });
	const url = /http:\/\/127\.0\.0\.1:\d+\/r\/\S+/.exec(textOf(started))?.[0];
	assert.ok(url);
	assert.equal((await fetch(`${url}/submit`, { method: "POST", body: JSON.stringify({
		events: [], comments: {}, answers: {}, general: "기록해 주세요", duration: 1,
	}) })).status, 200);
	const id = /Review (r\d+)/.exec(textOf(started))?.[1];
	const done = await client.callTool({ name: "review_wait", arguments: { id, timeout_sec: 5 } });
	assert.ok(!done.isError, textOf(done));
	assert.ok(textOf(done).includes(join(cwd, ".walkmate", "skills")));
	assert.ok(textOf(done).includes(join(cwd, ".walkmate", "notes")));
	assert.equal(textOf(done).includes(join(serverCwd, ".walkmate")), false);
});

test("rejects bad requests and cancels open reviews", async () => {
	const { client, shutdown } = await connect();
	const bad = await client.callTool({ name: "review_start", arguments: { title: "x", sections: [{ id: "bad id!", kind: "note", title: "n" }] } });
	assert.equal(bad.isError, true);
	assert.match(textOf(bad), /sections\[0\]\.id/);
	const invalidUrl = await client.callTool({ name: "review_start", arguments: { url: 123 } });
	assert.equal(invalidUrl.isError, true);

	const started = await client.callTool({ name: "review_start", arguments: { title: "c", sections: [{ id: "n", kind: "note", title: "n" }] } });
	const id = /Review (r\d+)/.exec(textOf(started))?.[1];
	const cancelled = await client.callTool({ name: "review_cancel", arguments: { id } });
	assert.match(textOf(cancelled), /cancelled/);
	await shutdown();
	await client.close();
});

test("instructions and tool description distinguish Walkmate usage requests from discussion", async () => {
	const { client, shutdown } = await connect();
	try {
		const instructions = client.getInstructions() ?? "";
		assert.match(instructions, /Walkmate로 확인하자/);
		assert.match(instructions, /Walkmate 열어줘/);
		assert.match(instructions, /워크메이트로 보여줄게/);
		assert.match(instructions, /Do not open a review for questions about Walkmate/);
		assert.match(instructions, /requests to change its code or documentation/);
		assert.match(instructions, /walkmate 켜봐/);
		assert.match(instructions, /call review_start\(\{ isolated \}\)/);
		assert.match(instructions, /로그아웃된 임시 프로필\(isolated\)/);
		assert.match(instructions, /Do not choose for the user/);
		assert.match(instructions, /Do not ask for a URL/);
		assert.match(instructions, /If tools are deferred, search for the Walkmate review_start MCP tool first/);
		assert.match(instructions, /Do not save walkthrough-derived notes or skills in global agent memory/);
		assert.match(instructions, /Never copy plaintext passwords/);
		assert.match(instructions, /record_inputs=true \(only when the user explicitly asked/);
		assert.match(instructions, /Playwright test, call export_to_playwright/);
		assert.match(instructions, /\.walkmate\/skills\/<name>\/SKILL\.md/);

		const { tools } = await client.listTools();
		const description = tools.find((tool) => tool.name === "review_start")?.description ?? "";
		assert.match(description, /Walkmate로 확인하자/);
		assert.match(description, /Walkmate 열어줘/);
		assert.match(description, /Do not use for questions about Walkmate/);
		assert.match(description, /requests to change its code or documentation/);
		assert.match(description, /walkmate 켜봐/);
		assert.match(description, /call review_start\(\{ isolated \}\)/);
		assert.match(description, /Live reviews require isolated; the user decides it/);
		assert.match(description, /Do not ask for a URL, search files\/CLI\/apps, or scan ports/);
		assert.deepEqual(tools.find((tool) => tool.name === "review_start")?.inputSchema.required, []);
	} finally {
		await shutdown();
		await client.close();
	}
});

test("bare launch starts a blank live browser while explicit targets retain their mode", async () => {
	const requests: ReviewRequest[] = [];
	const { client, shutdown } = await connect({
		runReview: (req, env) => new Promise((resolve) => {
			requests.push(req);
			env.onWaiting?.({ url: req.url ?? "http://document-review/", title: req.title, live: !!req.url, dir: join(env.cwd, ".walkmate", "reviews", "test") });
			env.signal?.addEventListener("abort", () => resolve({
				text: "cancelled", details: { status: "cancelled", title: req.title, dir: "test", mode: req.url ? "live" : "doc" },
			}), { once: true });
		}),
	});
	try {
		const cases = [
			{ args: { isolated: false }, expected: { title: "Walkmate", url: "about:blank", isolated: false } },
			{ args: { title: "시연", isolated: true }, expected: { title: "시연", url: "about:blank", isolated: true } },
			{ args: { sections: [], isolated: false }, expected: { title: "Walkmate", url: "about:blank", sections: [], isolated: false } },
			{ args: { url: "localhost:5173", isolated: false }, expected: { title: "Walkmate", url: "localhost:5173", isolated: false } },
			{ args: { sections: [{ id: "n1", kind: "note", title: "변경 사항" }] }, expected: { title: "Walkmate", sections: [{ id: "n1", kind: "note", title: "변경 사항" }] } },
			{ args: { url: "http://app/", isolated: false, sections: [{ id: "n1", kind: "note", title: "확인할 부분" }] }, expected: { title: "Walkmate", url: "http://app/", isolated: false, sections: [{ id: "n1", kind: "note", title: "확인할 부분" }] } },
			{ args: { url: "localhost:5173/login", isolated: true }, expected: { title: "Walkmate", url: "localhost:5173/login", isolated: true } },
			{ args: { isolated: true, record_inputs: true }, expected: { title: "Walkmate", url: "about:blank", isolated: true, record_inputs: true } },
		];
		for (const { args, expected } of cases) {
			const started = await client.callTool({ name: "review_start", arguments: args });
			assert.ok(!started.isError, textOf(started));
			assert.deepEqual(JSON.parse(JSON.stringify(requests.at(-1))), expected);
			assert.match(textOf(started), /Now call review_wait/);
			if (expected.url === "about:blank") {
				assert.match(textOf(started), /user can enter an address now/);
				assert.match(textOf(started), /microphone is off/);
			}
			const id = /Review (r\d+)/.exec(textOf(started))?.[1];
			const busy = await client.callTool({ name: "review_start", arguments: { isolated: false } });
			assert.equal(busy.isError, true);
			const cancelled = await client.callTool({ name: "review_cancel", arguments: { id } });
			assert.ok(!cancelled.isError, textOf(cancelled));
		}
	} finally {
		await shutdown();
		await client.close();
	}
});

test("live reviews ask the user about isolated before opening; document reviews do not", async () => {
	const requests: ReviewRequest[] = [];
	const { client, shutdown } = await connect({ runReview: async (req) => {
		requests.push(req);
		return { text: "ok", details: { status: "submitted", title: req.title, dir: "test", mode: req.url ? "live" : "doc" } };
	} });
	try {
		for (const args of [{}, { url: "localhost:5173" }, { title: "시연", sections: [] }]) {
			const asked = await client.callTool({ name: "review_start", arguments: args });
			assert.equal(asked.isError, true);
			assert.match(textOf(asked), /Not opened yet/);
			assert.match(textOf(asked), /로그인된 평소 프로필로 열까요, 로그아웃된 임시 프로필\(isolated\)로 열까요\?/);
			assert.match(textOf(asked), /Do not choose for them/);
		}
		assert.equal(requests.length, 0, "nothing opens until the user decides");
		const doc = await client.callTool({ name: "review_start", arguments: { sections: [{ id: "n1", kind: "note", title: "변경" }] } });
		assert.ok(!doc.isError, textOf(doc));
		const bad = await client.callTool({ name: "review_start", arguments: { isolated: "yes" } });
		assert.equal(bad.isError, true);
		assert.match(textOf(bad), /isolated must be a boolean/);
	} finally {
		await shutdown();
		await client.close();
	}
});

test("prompts tell the agent to start and keep waiting", async () => {
	const { client, shutdown } = await connect();
	const { prompts } = await client.listPrompts();
	assert.deepEqual(prompts.map((p) => p.name), ["live_review", "review_changes"]);
	const p = await client.getPrompt({ name: "live_review", arguments: { url: "localhost:5173/dashboard" } });
	const msg = p.messages[0].content;
	assert.ok(msg.type === "text" && /review_start/.test(msg.text) && /review_wait/.test(msg.text) && /localhost:5173/.test(msg.text));
	const blank = await client.getPrompt({ name: "live_review", arguments: {} });
	const blankMsg = blank.messages[0].content;
	assert.ok(blankMsg.type === "text" && /review_start/.test(blankMsg.text) && /Do not ask for a URL/.test(blankMsg.text) && /logged-out temporary one/.test(blankMsg.text));
	assert.ok(msg.type === "text" && /pass isolated accordingly/.test(msg.text));
	assert.equal(prompts.find((prompt) => prompt.name === "live_review")?.arguments?.find((arg) => arg.name === "url")?.required, false);
	await shutdown();
	await client.close();
});
