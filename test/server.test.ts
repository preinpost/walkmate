import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderPage } from "../src/render.ts";
import { newToken, startReviewServer } from "../src/server.ts";

test("serves the page, stores clips, resolves on submit", async () => {
	const dir = mkdtempSync(join(tmpdir(), "prr-"));
	const req = {
		title: "t",
		summary: "**hi** <script>alert(1)</script>",
		sections: [{ id: "q1", kind: "question" as const, title: "만료?", options: ["15분", "1시간"] }],
	};
	let labels: Record<string, string> = {};
	const server = await startReviewServer({
		html: (base, nonce) => {
			const r = renderPage(req, new Map(), { base, nonce });
			labels = r.labels;
			return r.html;
		},
		token: newToken(),
		dir,
	});

	const page = await fetch(server.url);
	assert.equal(page.status, 200);
	assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'nonce-/);
	const html = await page.text();
	assert.match(html, /data-answer-for="q1" data-value="1시간"/);
	assert.deepEqual(labels, { summary: "요약", q1: "질문 · 만료?" });

	assert.equal((await fetch(server.url.replace(/\/r\/.*/, "/r/wrong"))).status, 404);

	const audio = await fetch(`${server.url}/audio?idx=0&offset=1.5&mime=audio/webm`, { method: "POST", body: "fake" });
	assert.equal(audio.status, 200);
	const payload = { events: [], comments: {}, answers: { q1: "1시간" }, general: "", duration: 3 };
	await fetch(`${server.url}/submit`, { method: "POST", body: JSON.stringify(payload) });

	const outcome = await server.outcome;
	assert.equal(outcome.status, "submitted");
	assert.equal(outcome.clips[0].offset, 1.5);
	assert.ok(existsSync(join(dir, "clip-0.webm")));
	assert.equal((await fetch(`${server.url}/submit`, { method: "POST", body: "{}" }).catch(() => ({ status: 0 }))).status === 200, false);
	server.close();
});

test("aborting resolves as aborted", async () => {
	const ac = new AbortController();
	const server = await startReviewServer({ html: () => "", token: newToken(), dir: tmpdir(), signal: ac.signal });
	ac.abort();
	assert.equal((await server.outcome).status, "aborted");
});
