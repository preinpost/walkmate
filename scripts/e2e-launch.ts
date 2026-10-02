// Optional Chrome integration: a blank live session, manual navigation, toolbar, click capture and submission.
//   node scripts/e2e-launch.ts
// Uses an isolated headless Chrome profile; no microphone, voice tools or external websites.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "../src/core/live/cdp.ts";
import { runLiveSession } from "../src/core/live/session.ts";
import { normalizeUrl } from "../src/core/review.ts";
import { createReviewDir } from "../src/core/storage.ts";

const cwd = await mkdtemp(join(tmpdir(), "walkmate-launch-e2e-"));
const ac = new AbortController();
let ready!: (info: { port: number; targetId: string }) => void;
const opened = new Promise<{ port: number; targetId: string }>((resolve) => { ready = resolve; });
let microphoneCalls = 0;
const session = runLiveSession({
	url: normalizeUrl("about:blank"), title: "Walkmate", points: [],
	dir: await createReviewDir(cwd, "mcp"), userDataDir: join(cwd, "chrome-profile"),
	headless: true, signal: ac.signal, timeoutMs: 20_000, onReady: ready,
	recorder: async () => { microphoneCalls++; throw new Error("Microphone must stay off"); },
});
let cdp: Cdp | undefined;
try {
	const first = await Promise.race([opened, session.then(() => { throw new Error("Session ended before opening"); })]);
	const version = await fetch(`http://127.0.0.1:${first.port}/json/version`).then((r) => r.json()) as { webSocketDebuggerUrl: string };
	cdp = await Cdp.connect(version.webSocketDebuggerUrl);
	const targets = await cdp.send<{ targetInfos: { targetId: string; url: string }[] }>("Target.getTargets");
	assert.equal(targets.targetInfos.find((t) => t.targetId === first.targetId)?.url, "about:blank");
	assert.equal(microphoneCalls, 0);
	const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: first.targetId, flatten: true });
	await cdp.send("Page.enable", {}, sessionId);
	const url = "data:text/html," + encodeURIComponent('<!doctype html><title>Walkmate launch test</title><button data-testid="demo">Demo</button>');
	await cdp.send("Page.navigate", { url }, sessionId);
	let toolbar = false;
	for (let i = 0; i < 100 && !toolbar; i++) {
		const result = await cdp.send<{ result: { value?: boolean } }>("Runtime.evaluate", {
			expression: '!!document.querySelector("pi-review-toolbar")', returnByValue: true,
		}, sessionId).catch(() => undefined);
		toolbar = result?.result.value === true;
		if (!toolbar) await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.equal(toolbar, true, "review toolbar appears after navigating from about:blank");
	await cdp.send("Runtime.evaluate", { expression: 'document.querySelector("button[data-testid=demo]").click()' }, sessionId);
	await cdp.send("Runtime.evaluate", { expression: 'window.__piReview(JSON.stringify({kind:"cmd",cmd:"submit"}))' }, sessionId);
	const outcome = await session;
	assert.equal(outcome.status, "submitted");
	assert.ok(outcome.events.some((event) => event.type === "nav" && event.url === url));
	assert.ok(outcome.events.some((event) => event.type === "click" && event.d?.testid === "demo"));
	assert.equal(outcome.clips.length, 0);
	assert.equal(microphoneCalls, 0);
	console.log("PASS: blank Chrome launch → manual navigation → toolbar → click capture → submit; microphone stayed off.");
} finally {
	ac.abort();
	await session.catch(() => {});
	cdp?.close();
	await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
