import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { writePlaybook } from "../src/core/live/playbook.ts";

const exec = promisify(execFile);
const cli = new URL("../src/mcp/cli.ts", import.meta.url).pathname;
const target = (tag: string, text: string, testid?: string) => ({ tag, text, testid, rect: [0, 0, 100, 30] });

async function fixture(t: { after(fn: () => Promise<void>): void }, recording: object): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "playbook-test-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "events.json"), JSON.stringify(recording));
	await writeFile(join(dir, "request.json"), JSON.stringify({ title: "시연", url: "http://app/customer" }));
	return dir;
}

test("CLI extracts a legacy time slice without inventing row identity, intent, or PDF MIME", async (t) => {
	const dir = await fixture(t, {
		duration: 30,
		events: [
			{ t: 0, tab: 2, type: "nav", url: "http://app/customer" },
			{ t: 1, tab: 9, type: "nav", url: "http://app/other" },
			{ t: 5, tab: 2, type: "click", d: target("button", "範囲外") },
			{ t: 10, tab: 2, type: "click", d: target("a", "청구", "nav-invoice") },
			{ t: 10.1, tab: 2, type: "nav", url: "http://app/invoice?status=Unissued" },
			{ t: 10.2, tab: 2, type: "nav", url: "http://app/invoice?status=Unissued" },
			{ t: 11, tab: 2, type: "click", d: target("div", "청구 현황 전체 1개월…", "page-invoice") },
			{ t: 11.1, tab: 9, type: "nav", url: "http://app/unrelated" },
			{ t: 11.5, tab: 2, type: "hover", d: target("button", "전체") },
			{ t: 12, tab: 2, type: "click", d: target("button", "전체", "page-invoice") },
			{ t: 12.1, tab: 2, type: "nav", url: "http://app/invoice?startDate=2026-08" },
			{ t: 14, tab: 2, type: "click", d: target("svg.MuiSvgIcon-root", "", "KeyboardArrowRightIcon") },
			{ t: 14.1, tab: 2, type: "nav", url: "http://app/invoice/12345" },
			{ t: 16, tab: 2, type: "click", d: target("button", "미리보기", "page-invoice-detail") },
			{ t: 17, tab: 2, type: "click", d: target("button", "전체(상세요금 포함)") },
			{ t: 17.5, tab: 3, type: "nav", url: "blob:http://app/ephemeral" },
			{ t: 18.1, tab: 2, type: "nav", url: "http://app/outside-range" },
		],
	});
	const original = await readFile(join(dir, "events.json"), "utf8");
	const { stdout } = await exec(process.execPath, [cli, "playbook", dir, "--from", "10", "--to", "18", "--title", "청구서 미리보기"]);
	const p = JSON.parse(await readFile(join(dir, "playbook/playbook.json"), "utf8"));
	const md = await readFile(join(dir, "playbook/playbook.md"), "utf8");
	assert.match(stdout, /6단계/);
	assert.equal(p.status, "draft");
	assert.equal(p.initial.url, "http://app/customer");
	assert.equal(p.steps[0].observedAfter.length, 1);
	assert.equal(p.steps[0].observedAfter[0].url, "http://app/invoice?status=Unissued");
	assert.equal(p.steps[1].observedAfter.length, 0);
	assert.equal(p.steps[2].url, "http://app/invoice?status=Unissued");
	assert.equal(p.steps[3].target.text, "");
	assert.match(p.steps[3].review.join(" "), /상위 행/);
	assert.equal(p.steps[5].observedAfter[0].kind, "new-tab");
	assert.equal(p.steps[5].observedAfter[0].mime, undefined);
	assert.match(p.steps[5].review.join(" "), /PDF라고 단정/);
	assert.match(md, /상위 컨테이너의 testid/);
	assert.match(md, /음성 설명이 없어/);
	assert.doesNotMatch(JSON.stringify(p), /unrelated|outside-range|範囲外/);
	assert.equal(await readFile(join(dir, "events.json"), "utf8"), original);
});

test("new recordings retain input candidates and notes, correlate only nearby same-tab APIs, and omit bodies", async (t) => {
	const dir = await fixture(t, {
		duration: 10,
		events: [
			{ t: 0, tab: 1, type: "nav", url: "http://app/form" },
			{ t: 1, tab: 1, type: "input", d: target("input", "고객사"), value: "다른 고객사" },
			{ t: 1.5, tab: 1, type: "pin", id: "p1", d: target("input", "고객사") },
			{ t: 2, tab: 1, type: "input", d: target("input", "비밀번호"), value: "••••" },
			{ t: 3, tab: 1, type: "pin-note", id: "p1", text: "#param 고객사" },
			{ t: 5, tab: 1, type: "click", d: target("button", "문서 보기") },
			{ t: 5.2, tab: 2, type: "nav", url: "blob:http://app/pdf" },
			{ t: 5.3, tab: 2, type: "doc", url: "blob:http://app/pdf", value: "application/pdf" },
		],
		docs: [{ t: 5.3, tab: 2, url: "blob:http://app/pdf", mime: "application/pdf" }],
	});
	await writeFile(join(dir, "transcript.json"), JSON.stringify({ words: [{ start: 1, end: 1.3, text: "여기 고객사 이름" }] }));
	await writeFile(join(dir, "network.json"), JSON.stringify([
		{ id: "a", t: 1.6, tab: 1, method: "GET", url: "http://app/api/customers", type: "Fetch", status: 200, postData: "PRIVATE_BODY", preview: "PRIVATE_PREVIEW", body: "network/private.json" },
		{ id: "b", t: 2.2, tab: 1, method: "POST", url: "http://app/api/login", type: "XHR", status: 401, postData: "PRIVATE_PASSWORD" },
		{ id: "c", t: 1.7, tab: 9, method: "GET", url: "http://app/unrelated-api", type: "Fetch", status: 200 },
		{ id: "d", t: 7.5, tab: 1, method: "GET", url: "http://app/late-api", type: "Fetch", status: 200 },
		{ id: "e", t: 1.8, tab: 1, method: "GET", url: "http://app/logo.png", type: "Image", status: 200 },
	]));
	const { playbook: p, json, markdown } = await writePlaybook(dir);
	assert.equal(p.parameters[0].recordedValue, "다른 고객사");
	assert.equal(p.parameters[1].recordedValue, undefined);
	assert.deepEqual(p.steps[0].observedAfter.map((o) => o.url), ["http://app/api/customers"]);
	assert.equal(p.steps[1].observedAfter[0].status, 401);
	assert.equal(p.steps[2].observedAfter.filter((o) => o.kind === "document").length, 1);
	assert.equal(p.steps[2].observedAfter[1].mime, "application/pdf");
	assert.deepEqual(p.notes.map((n) => n.text), ["여기 고객사 이름", "#param 고객사"]);
	const output = (await readFile(json, "utf8")) + (await readFile(markdown, "utf8"));
	assert.doesNotMatch(output, /PRIVATE_|network\/private|unrelated-api|late-api|logo.png/);
});

test("CLI refuses invalid intervals and existing drafts without changing the recording or draft", async (t) => {
	const dir = await fixture(t, { duration: 10, events: [{ t: 2, tab: 1, type: "click", d: target("button", "선택") }] });
	for (const args of [["--from", "no"], ["--from", "4", "--to", "2"], ["--to", "11"], ["--from", "3"]]) {
		await assert.rejects(exec(process.execPath, [cli, "playbook", dir, ...args]), (err: Error & { code?: number }) => err.code === 2);
	}
	const result = await writePlaybook(dir);
	const reviewed = "사용자가 검토한 초안";
	await writeFile(result.json, reviewed);
	await assert.rejects(exec(process.execPath, [cli, "playbook", dir]), (err: Error & { code?: number }) => err.code === 2);
	assert.equal(await readFile(result.json, "utf8"), reviewed);
	const partial = join(dir, "partial");
	await mkdir(partial);
	await writeFile(join(partial, "playbook.md"), reviewed);
	await assert.rejects(writePlaybook(dir, { out: partial }), { code: "EEXIST" });
	assert.equal(await readFile(join(partial, "playbook.md"), "utf8"), reviewed);
	await assert.rejects(readFile(join(partial, "playbook.json")), { code: "ENOENT" });
	await writeFile(join(dir, "network.json"), "not JSON");
	await assert.rejects(writePlaybook(dir, { out: join(dir, "another") }), SyntaxError);
});
