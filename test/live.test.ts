import assert from "node:assert/strict";
import { test } from "node:test";
import { attributeLive, compressLive, describeTarget } from "../src/core/live/report.ts";
import type { Desc, LiveEvent } from "../src/core/live/session.ts";

const d = (text: string, comps?: string[]): Desc => ({ tag: "div", text, comps, rect: [0, 0, 10, 10] });

test("drops glances, scroll jitter and repeated pages; folds pin notes into the pin", () => {
	const ev: LiveEvent[] = [
		{ t: 0, tab: 1, type: "nav", url: "http://x/a" },
		{ t: 1, tab: 1, type: "hover", d: d("glance") },
		{ t: 1.2, tab: 1, type: "hover", d: d("dwell") },
		{ t: 3, tab: 1, type: "scroll", pct: 10 },
		{ t: 3.5, tab: 1, type: "scroll", pct: 40 },
		{ t: 4, tab: 1, type: "nav", url: "http://x/a" },
		{ t: 5, tab: 1, type: "pin", id: "p1", d: d("cell") },
		{ t: 7, tab: 1, type: "pin-note", id: "p1", text: "정렬" },
	];
	const out = compressLive(ev, 10);
	assert.deepEqual(
		out.map((e) => `${e.type}:${e.d?.text ?? e.pct ?? e.url ?? ""}${e.type === "pin" ? `:${e.text}` : ""}`),
		["nav:http://x/a", "hover:dwell", "scroll:40", "pin:cell:정렬"],
	);
});

test("attributes speech to what was pointed at before it, not what was clicked mid-sentence", () => {
	const events: LiveEvent[] = [
		{ t: 9, tab: 1, type: "hover", d: d("불러오는 중") },
		{ t: 12, tab: 1, type: "click", d: d("설정") },
	];
	const [u] = attributeLive([{ start: 10.8, end: 13, text: "로딩이 길어요" }], events);
	assert.equal(u.focus?.d?.text, "불러오는 중");
});

test("a pin beats a closer hover and the active review point is kept", () => {
	const events: LiveEvent[] = [
		{ t: 1, tab: 1, type: "point", id: "p2" },
		{ t: 3, tab: 1, type: "pin", d: d("pinned") },
		{ t: 4.9, tab: 1, type: "hover", d: d("nearby") },
	];
	const [u] = attributeLive([{ start: 5, end: 6, text: "여기" }], events);
	assert.equal(u.focus?.d?.text, "pinned");
	assert.equal(u.point, "p2");
});

test("describes a target with components and file", () => {
	assert.equal(
		describeTarget({ tag: "li", text: "Compute", comps: ["Chart", "Page", "App", "Root"], file: "src/Chart.tsx", rect: [0, 0, 1, 1] }),
		'<Chart › Page › App> li "Compute" (src/Chart.tsx)',
	);
});
