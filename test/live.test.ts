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

test("a click that leaves the page mid-sentence is not what the sentence is about", () => {
	const events: LiveEvent[] = [
		{ t: 10, tab: 1, type: "click", d: d("청구서 보기") },
		{ t: 14.4, tab: 1, type: "click", d: d("설정") },
		{ t: 14.5, tab: 1, type: "nav", url: "http://x/settings" },
	];
	const [u] = attributeLive([{ start: 14, end: 16, text: "청구서 화면은 로딩이 길어요" }], events);
	assert.equal(u.focus?.d?.text, "청구서 보기");
});

test("an area pin reads as its size and contents, not as <body>", () => {
	const area: Desc = { tag: "body", text: "everything", rect: [0, 0, 210, 132], area: true, inside: [], areaText: "Compute" };
	assert.equal(describeTarget(area), "영역 210×132");
	assert.equal(describeTarget({ ...area, tag: "section", comps: ["Panel"] }), "영역 210×132 안 (<Panel> section)");
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

test("replay uses saved copies of images, srcset and CSS url()", async () => {
	const { rewriteAssets } = await import("../src/core/live/replay.ts");
	const assets = { "http://x/logo.png": "assets/a.png", "http://x/f.woff2": "assets/b.woff2", "http://x/2x.png": "assets/c.png" };
	const events: any[] = [
		{
			type: 2,
			data: {
				node: {
					childNodes: [
						{ attributes: { src: "http://x/logo.png", srcset: "http://x/logo.png 1x, http://x/2x.png 2x" } },
						{ attributes: { _cssText: "@font-face{src:url(\"http://x/f.woff2\")}" } },
						{ attributes: { src: "http://x/other.png" } },
					],
				},
			},
		},
		{ type: 3, data: { source: 0, adds: [{ node: { attributes: { style: "background:url(http://x/logo.png)" } } }], attributes: [{ attributes: { src: "http://x/2x.png" } }] } },
	];
	rewriteAssets(events, assets);
	const [img, style, other] = events[0].data.node.childNodes;
	assert.equal(img.attributes.src, "assets/a.png");
	assert.equal(img.attributes.srcset, "assets/a.png 1x, assets/c.png 2x");
	assert.equal(style.attributes._cssText, '@font-face{src:url("assets/b.woff2")}');
	assert.equal(other.attributes.src, "http://x/other.png");
	assert.equal(events[1].data.adds[0].node.attributes.style, "background:url(assets/a.png)");
	assert.equal(events[1].data.attributes[0].attributes.src, "assets/c.png");
});
