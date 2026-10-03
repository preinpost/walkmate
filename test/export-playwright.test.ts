import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, InMemoryTransport, type CallToolResult } from "@modelcontextprotocol/client";
import { buildPlaywrightSpec, locatorFor } from "../src/core/live/export-playwright.ts";
import type { Desc, LiveEvent, LocatorHints } from "../src/core/live/session.ts";

process.env.WALKMATE_HOME = await mkdtemp(join(tmpdir(), "walkmate-export-home-"));
const { createReviewServer } = await import("../src/mcp/server.ts");

const el = (tag: string, text: string, loc?: Partial<LocatorHints>): Desc =>
	({ tag, text, rect: [0, 0, 10, 10], loc: loc ? { tag: tag.match(/^[a-z0-9]+/)![0], ...loc } : undefined });
const spec = (events: LiveEvent[], extra: Partial<Parameters<typeof buildPlaywrightSpec>[0]> = {}) =>
	buildPlaywrightSpec({ dir: "/rec", title: "로그인", events, withWalkmate: false, ...extra });

test("locators prefer unique testid, then role+name, label, placeholder, id and name attribute", () => {
	assert.equal(locatorFor("page", el("button", "저장", { testid: "save", testidCount: 1, role: "button", name: "저장", roleCount: 1 })).code, 'page.getByTestId("save")');
	assert.equal(locatorFor("page", el("button", "저장", { testid: "save", testidCount: 2, role: "button", name: "저장", roleCount: 1 })).code,
		'page.getByRole("button", { name: "저장", exact: true })');
	const row = locatorFor("page", el("button", "삭제", { role: "button", name: "삭제", roleCount: 3, roleIndex: 1, scope: "row-2", scopeCount: 1 }));
	assert.equal(row.code, 'page.getByTestId("row-2").getByRole("button", { name: "삭제", exact: true })');
	assert.equal(row.todo, undefined);
	assert.equal(locatorFor("page", el("input", "", { type: "password", label: "비밀번호", labelCount: 1 })).code, 'page.getByLabel("비밀번호", { exact: true })');
	assert.equal(locatorFor("page", el("input", "", { type: "text", placeholder: "검색", placeholderCount: 1, role: "textbox", roleCount: 2 })).code,
		'page.getByPlaceholder("검색", { exact: true })');
	assert.equal(locatorFor("page", el("input", "", { id: "email", idCount: 1 })).code, 'page.locator("#email")');
	assert.equal(locatorFor("page", el("input", "", { id: ":r3:", idCount: 1, field: "email", fieldCount: 1 })).code, 'page.locator("input[name=\\"email\\"]")');
	const nth = locatorFor("p2", el("a", "보기", { role: "link", name: "보기", roleCount: 4, roleIndex: 2 }));
	assert.equal(nth.code, 'p2.getByRole("link", { name: "보기", exact: true }).nth(2)');
	assert.match(nth.todo ?? "", /4개/);
	assert.match(locatorFor("page", el("div", "합계")).todo ?? "", /보이는 글자/);
});

test("a login demonstration becomes steps with literal recorded inputs, Enter submission and URL checks", () => {
	const email = el("input", "", { type: "email", role: "textbox", name: "이메일", roleCount: 1, label: "이메일", labelCount: 1 });
	const password = el("input", "", { type: "password", label: "비밀번호", labelCount: 1, field: "password", fieldCount: 1 });
	const remember = el("input", "", { type: "checkbox", role: "checkbox", name: "로그인 유지", roleCount: 1 });
	const tier = el("select", "", { role: "combobox", name: "플랜", roleCount: 1 });
	const result = spec([
		{ t: 0, tab: 1, type: "nav", url: "http://app/login" },
		{ t: 0.5, tab: 1, type: "hover", d: email },
		{ t: 1, tab: 1, type: "click", x: 5, y: 5, d: email },
		{ t: 2, tab: 1, type: "input", d: email, value: "qa@example.com" },
		{ t: 2.5, tab: 1, type: "click", x: 5, y: 5, d: el("label", "로그인 유지") },
		{ t: 2.51, tab: 1, type: "click", x: 5, y: 5, d: remember },
		{ t: 2.52, tab: 1, type: "input", d: remember, value: "true" },
		{ t: 3, tab: 1, type: "click", x: 5, y: 5, d: tier },
		{ t: 3.5, tab: 1, type: "input", d: tier, value: "pro" },
		{ t: 4, tab: 1, type: "click", x: 5, y: 5, d: password },
		{ t: 5, tab: 1, type: "key", key: "Enter", d: password },
		{ t: 5.01, tab: 1, type: "input", d: password, value: "p@ss w0rd!" },
		{ t: 5.02, tab: 1, type: "click", x: 0, y: 0, d: el("button", "로그인", { role: "button", name: "로그인", roleCount: 1 }) },
		{ t: 5.6, tab: 1, type: "nav", url: "http://app/dashboard" },
		{ t: 9, tab: 1, type: "scroll", pct: 50 },
	], { recordInputs: true });
	const steps = [...result.code.matchAll(/test\.step\("([^"]+)"/g)].map((m) => m[1]);
	assert.deepEqual(steps, ["1. 이동: http://app/login", "2. 입력: 이메일", "3. 체크: 로그인 유지", "4. 선택: 플랜", "5. 입력: 비밀번호", "6. Enter: 비밀번호"]);
	assert.match(result.code, /await page\.getByRole\("textbox", \{ name: "이메일", exact: true \}\)\.fill\("qa@example\.com"\);/);
	assert.match(result.code, /await page\.getByRole\("checkbox", \{ name: "로그인 유지", exact: true \}\)\.check\(\);/);
	assert.match(result.code, /\.selectOption\("pro"\);/);
	assert.match(result.code, /await page\.getByLabel\("비밀번호", \{ exact: true \}\)\.fill\("p@ss w0rd!"\);/);
	assert.match(result.code, /\.press\("Enter"\);\n\s+await expect\(page\)\.toHaveURL\("http:\/\/app\/dashboard"\);/);
	assert.doesNotMatch(result.code, /\.click\(\)/, "focus clicks, label clicks and the implicit submit click are covered by other steps");
	assert.equal(result.credentials, true);
	assert.match(result.code, /테스트 계정 값\(비밀번호 포함\)/);
	assert.deepEqual(result.env, []);
	assert.match(result.todos.join("\n"), /목적이 이뤄졌는지/);
});

test("masked inputs become required environment variables instead of placeholders", () => {
	const password = el("input", "", { type: "password", label: "Password", labelCount: 1, field: "password", fieldCount: 1 });
	const result = spec([
		{ t: 0, tab: 1, type: "nav", url: "http://app/login" },
		{ t: 1, tab: 1, type: "input", d: password, value: "••••" },
		{ t: 2, tab: 1, type: "input", d: el("input", "", { type: "password", label: "Confirm", labelCount: 1 }), value: "••••" },
	]);
	assert.deepEqual(result.env, ["WALKMATE_PASSWORD", "WALKMATE_CONFIRM"]);
	assert.match(result.code, /\.fill\(env\("WALKMATE_PASSWORD"\)\);/);
	assert.match(result.code, /function env\(name: string\): string/);
	assert.equal(result.credentials, false);
	assert.doesNotMatch(result.code, /••••/);
});

test("popups, typed URLs, pins and speech become popup waits, gotos, visibility checks and comments", () => {
	const result = buildPlaywrightSpec({
		dir: "/rec", title: "청구서", withWalkmate: true, words: [{ start: 3.9, end: 4.2, text: "여기 합계 확인" }],
		events: [
			{ t: 0, tab: 1, type: "nav", url: "http://app/" },
			{ t: 1, tab: 1, type: "click", x: 3, y: 3, d: el("a", "청구서", { role: "link", name: "청구서", roleCount: 1 }) },
			{ t: 1.2, tab: 1, type: "nav", url: "http://app/invoice" },
			{ t: 4, tab: 1, type: "pin", id: "p1", d: el("td", "1,000원", { text: "1,000원" }) },
			{ t: 5, tab: 1, type: "pin-note", id: "p1", text: "합계" },
			{ t: 6, tab: 1, type: "click", x: 3, y: 3, d: el("button", "PDF", { testid: "pdf", testidCount: 1 }) },
			{ t: 6.5, tab: 2, type: "nav", url: "http://app/doc.pdf" },
			{ t: 7, tab: 2, type: "key", key: "Escape" },
			{ t: 20, tab: 1, type: "nav", url: "http://app/settings" },
		],
	});
	assert.match(result.code, /import \{ withWalkmate \} from "walkmate\/playwright";/);
	assert.match(result.code, /test\.use\(\{ walkmate: \{ sourceRecording: "\/rec" \} \}\);/);
	assert.match(result.code, /import \{ test as base, expect, type Page \} from "@playwright\/test";/);
	assert.match(result.code, /let page2: Page;/);
	assert.match(result.code, /const page2Promise = page\.waitForEvent\("popup"\);\n\s+await page\.getByTestId\("pdf"\)\.click\(\);\n\s+page2 = await page2Promise;\n\s+await expect\(page2\)\.toHaveURL\("http:\/\/app\/doc\.pdf"\);/);
	assert.match(result.code, /await page2\.keyboard\.press\("Escape"\);/);
	assert.match(result.code, /await expect\(page\)\.toHaveURL\("http:\/\/app\/invoice"\);/);
	assert.match(result.code, /\/\/ 핀 메모: "합계"\n\s+\/\/ 🗣 "여기 합계 확인"\n\s+await test\.step\("3\. 확인: 1,000원"/);
	assert.match(result.code, /await expect\(page\.getByText\("1,000원", \{ exact: true \}\)\)\.toBeVisible\(\);/);
	assert.match(result.code, /await page\.goto\("http:\/\/app\/settings"\);/, "a navigation long after the last action is a typed URL");
	assert.doesNotMatch(result.code, /TODO: 시연의 목적/, "a pin already checks the outcome");
});

test("from/to start at the page the slice begins on", () => {
	const result = spec([
		{ t: 0, tab: 1, type: "nav", url: "http://app/a" },
		{ t: 1, tab: 1, type: "click", x: 1, y: 1, d: el("a", "B", { role: "link", name: "B", roleCount: 1 }) },
		{ t: 1.1, tab: 1, type: "nav", url: "http://app/b" },
		{ t: 5, tab: 1, type: "click", x: 1, y: 1, d: el("button", "C", { role: "button", name: "C", roleCount: 1 }) },
	], { from: 4 });
	assert.match(result.code, /1\. 이동: http:\/\/app\/b/);
	assert.doesNotMatch(result.code, /"B"/);
	assert.throws(() => spec([{ t: 1, tab: 1, type: "hover" }]), /테스트로 옮길/);
});

async function project(t: { after(fn: () => Promise<void>): void }) {
	const cwd = await mkdtemp(join(tmpdir(), "walkmate-export-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const rec = async (name: string, events: LiveEvent[], request: object) => {
		const dir = join(cwd, ".walkmate", "reviews", "mcp", name);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "events.json"), JSON.stringify({ status: "submitted", duration: 10, events }));
		await writeFile(join(dir, "request.json"), JSON.stringify(request));
		return dir;
	};
	const { server, shutdown } = createReviewServer({ cwd });
	const [a, b] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" });
	await Promise.all([server.connect(a), client.connect(b)]);
	t.after(async () => { await shutdown(); await client.close(); });
	return { cwd, rec, client };
}
const textOf = (r: CallToolResult) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

test("export_to_playwright writes the newest recording into the project's test folder and refuses to overwrite", async (t) => {
	const { cwd, rec, client } = await project(t);
	const login = el("input", "", { type: "password", label: "Password", labelCount: 1 });
	const older = await rec("older", [{ t: 0, tab: 1, type: "nav", url: "http://app/old" }], { title: "Old" });
	await utimes(join(older, "events.json"), new Date(0), new Date(0));
	await rec("newer", [
		{ t: 0, tab: 1, type: "nav", url: "http://app/login" },
		{ t: 1, tab: 1, type: "input", d: login, value: "secret-test-pw" },
	], { title: "Sign in flow", url: "http://app/login", isolated: true, record_inputs: true });
	await writeFile(join(cwd, "playwright.config.ts"), 'export default { testDir: "./specs" };');

	const tools = await client.listTools();
	assert.ok(tools.tools.some((tool) => tool.name === "export_to_playwright"));
	const done = await client.callTool({ name: "export_to_playwright", arguments: { cwd } });
	assert.ok(!done.isError, textOf(done));
	const path = join(cwd, "specs", "sign-in-flow.spec.ts");
	assert.match(textOf(done), new RegExp(`Playwright test written: ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	assert.match(textOf(done), /Contains recorded test credentials/);
	assert.match(textOf(done), /withWalkmate: no/);
	const code = await readFile(path, "utf8");
	assert.match(code, /test\("Sign in flow"/);
	assert.match(code, /\.fill\("secret-test-pw"\)/);
	assert.match(textOf(done), /```ts\n\/\/ Walkmate 시연에서 만든/);

	const again = await client.callTool({ name: "export_to_playwright", arguments: { cwd } });
	assert.equal(again.isError, true);
	assert.match(textOf(again), /이미 있습니다/);
	const replaced = await client.callTool({ name: "export_to_playwright", arguments: { cwd, recording: older, out: "specs/sign-in-flow.spec.ts", overwrite: true, title: "Old one" } });
	assert.ok(!replaced.isError, textOf(replaced));
	assert.match(await readFile(path, "utf8"), /test\("Old one"/);

	const bad = await client.callTool({ name: "export_to_playwright", arguments: { cwd, from: 5, to: 2 } });
	assert.equal(bad.isError, true);
	const unknown = await client.callTool({ name: "export_to_playwright", arguments: { cwd, nope: 1 } });
	assert.match(textOf(unknown), /Unknown field: nope/);
});

test("export_to_playwright explains when there is no live recording", async (t) => {
	const { cwd, client } = await project(t);
	const none = await client.callTool({ name: "export_to_playwright", arguments: { cwd } });
	assert.equal(none.isError, true);
	assert.match(textOf(none), /라이브 시연 녹화가 없습니다/);
});
