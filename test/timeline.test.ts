import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport, compressEvents, groupUtterances } from "../src/timeline.ts";
import type { ReviewEvent } from "../src/types.ts";

test("groups words into utterances at pauses", () => {
	const u = groupUtterances([
		{ start: 1, end: 1.3, text: "이건" },
		{ start: 1.4, end: 1.8, text: "이상한데" },
		{ start: 3, end: 3.4, text: "아" },
		{ start: 3.5, end: 3.9, text: "괜찮아" },
		{ start: 4, end: 4.1, text: "." },
	]);
	assert.deepEqual(
		u.map((x) => x.text),
		["이건 이상한데", "아 괜찮아."],
	);
});

test("drops glances and repeated hovers", () => {
	const ev: ReviewEvent[] = [
		{ t: 0, type: "view", rid: "d1" },
		{ t: 0.2, type: "view", rid: "d2" },
		{ t: 0.4, type: "view", rid: "d1" },
		{ t: 5, type: "view", rid: "c1:a.go#h1" },
		{ t: 5.5, type: "hover", rid: "c1:a.go#h1", line: "+3" },
		{ t: 5.6, type: "hover", rid: "c1:a.go#h1", line: "+4" },
		{ t: 7, type: "hover", rid: "c1:a.go#h1" },
	];
	const out = compressEvents(ev, 10);
	assert.deepEqual(
		out.map((e) => `${e.type}:${e.rid}:${e.line ?? ""}`),
		["view:d1:", "view:c1:a.go#h1:", "hover:c1:a.go#h1:+4"],
	);
});

test("ties speech to what was pointed at", () => {
	const report = buildReport({
		title: "t",
		labels: { d1: "결정 · nullable", c1: "변경 · auth", "c1:a.go#h2": "a.go L40-58", q1: "질문 · 만료" },
		sectionIds: ["d1", "c1", "q1"],
		words: [
			{ start: 2, end: 2.5, text: "왜" },
			{ start: 2.6, end: 3, text: "nullable이지" },
			{ start: 12, end: 12.5, text: "여기서" },
			{ start: 12.6, end: 13, text: "쓰는구나" },
		],
		payload: {
			events: [
				{ t: 0, type: "view", rid: "d1" },
				{ t: 0.5, type: "rec-start" },
				{ t: 10, type: "view", rid: "c1:a.go#h2" },
				{ t: 11.5, type: "hover", rid: "c1:a.go#h2", line: "+42", text: "if u.ID == nil {" },
				{ t: 15, type: "answer", rid: "q1", value: "1시간" },
				{ t: 16, type: "rec-stop" },
			],
			comments: { c1: "에러 메시지 영어로" },
			answers: { q1: "1시간" },
			general: "",
			duration: 20,
		},
		engine: "test",
		warnings: [],
		dir: "/tmp/x",
	});
	assert.match(report.full, /### d1 · 결정 · nullable[^\n]*\n- 🗣 \[00:02.0\] "왜 nullable이지"/);
	assert.match(report.full, /"여기서 쓰는구나"  ← a\.go L40-58 L42\(추가\)/);
	assert.match(report.full, /### q1[^\n]*\n- ✅ 답: 1시간/);
	assert.match(report.full, /- 💬 코멘트: 에러 메시지 영어로/);
	assert.match(report.full, /\[00:11.5\] 👉 a\.go L40-58 L42\(추가\): `if u\.ID == nil \{`/);
	assert.equal(report.stats.recorded, 15.5);
	assert.equal(report.text, report.full);
});
