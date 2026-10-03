import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { groupUtterances } from "../timeline.ts";
import { projectPaths } from "../storage.ts";
import type { Word } from "../types.ts";
import type { Desc, LiveEvent, LocatorHints } from "./session.ts";

export interface PlaywrightExportOptions {
	/** Project directory: default test folder, package lookup and the latest recording. */
	cwd: string;
	/** Output .spec.ts path, relative to cwd. Default: <testDir>/<title>.spec.ts. */
	out?: string;
	title?: string;
	/** Seconds since the recording started. */
	from?: number;
	to?: number;
	/** Wrap the test with withWalkmate from walkmate/playwright. Default: when walkmate is installed in the project. */
	withWalkmate?: boolean;
	overwrite?: boolean;
}

export interface PlaywrightSpec {
	code: string;
	steps: number;
	/** Recorded secret-looking values (passwords, tokens) written into the code as literals. */
	credentials: boolean;
	/** Environment variables the test reads for values the recording masked. */
	env: string[];
	/** Lines marked TODO in the code, as "step: reason". */
	todos: string[];
	warnings: string[];
}

export interface PlaywrightExport extends PlaywrightSpec {
	path: string;
	recording: string;
	withWalkmate: boolean;
}

export interface SpecSource {
	dir: string;
	title: string;
	events: LiveEvent[];
	/** Start URL of the review, used when the recording has no navigation before the first action. */
	url?: string;
	recordInputs?: boolean;
	words?: Word[];
	from?: number;
	to?: number;
	withWalkmate: boolean;
}

interface Step {
	t: number;
	tab: number;
	title: string;
	lines: string[];
	/** Page variable assigned from a popup this step's action opens. */
	popup?: string;
	/** Expected URL per page variable after the step, from navigations that followed it. */
	expects: Map<string, string>;
	comments: string[];
	acts: boolean;
}

/** A navigation this soon after an action is treated as its result; later ones as the user going to a URL. */
const FOLLOW = 5;
const KEEP = new Set(["nav", "click", "input", "key", "pin"]);
const s = (v: string) => JSON.stringify(v);
const short = (v: string, n = 40) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);
const masked = (v?: string) => v === undefined || /^(?:•+|\*+)$/.test(v);

type Control = "text" | "check" | "select" | "file" | "other";
function control(d?: Desc): Control {
	const tag = d?.loc?.tag ?? d?.tag.match(/^[a-z0-9]+/)?.[0];
	if (tag === "select") return "select";
	if (tag === "textarea") return "text";
	if (tag !== "input") return "other";
	const type = d?.loc?.type ?? "text";
	if (type === "checkbox" || type === "radio") return "check";
	if (type === "file") return "file";
	return /^(button|submit|reset|image)$/.test(type) ? "other" : "text";
}

const targetKey = (d?: Desc) => d ? JSON.stringify([d.tag, d.text, d.testid, d.loc?.id, d.loc?.field, d.loc?.label, d.loc?.placeholder, d.loc?.name]) : "";
const sameTarget = (a?: Desc, b?: Desc) => !!a && !!b && targetKey(a) === targetKey(b);

/** Ids that look generated (React useId, UI library counters) change between renders and builds. */
const stableId = (id: string) => !/[:\s]|\d{3,}|^\d|^(radix|headlessui|mui|rc|react|ember|downshift)[-_]/i.test(id);
const cssString = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const cssId = (id: string) => (/^[A-Za-z_][\w-]*$/.test(id) ? `#${id}` : `[id="${cssString(id)}"]`);

interface Located { code: string; todo?: string }

function roleCall(role: string, name?: string): string {
	return `getByRole(${s(role)}${name ? `, { name: ${s(name)}, exact: true }` : ""})`;
}

/** Most specific unique locator recorded for the element; ambiguous fallbacks carry a TODO. */
export function locatorFor(page: string, d?: Desc): Located {
	const l: LocatorHints | undefined = d?.loc;
	if (l) {
		if (l.testid && l.testidCount === 1) return { code: `${page}.getByTestId(${s(l.testid)})` };
		if (l.role && l.roleCount === 1) return { code: `${page}.${roleCall(l.role, l.name)}` };
		if (l.role && l.scope && l.scopeCount === 1) return { code: `${page}.getByTestId(${s(l.scope)}).${roleCall(l.role, l.name)}` };
		if (l.label && l.labelCount === 1) return { code: `${page}.getByLabel(${s(l.label)}, { exact: true })` };
		if (l.placeholder && l.placeholderCount === 1) return { code: `${page}.getByPlaceholder(${s(l.placeholder)}, { exact: true })` };
		if (l.id && l.idCount === 1 && stableId(l.id)) return { code: `${page}.locator(${s(cssId(l.id))})` };
		if (l.field && l.fieldCount === 1) return { code: `${page}.locator(${s(`${l.tag}[name="${cssString(l.field)}"]`)})` };
		if (l.role && l.scope && l.scopeCount && l.scopeCount > 1) {
			return { code: `${page}.getByTestId(${s(l.scope)}).${roleCall(l.role, l.name)}.nth(${l.scopeIndex ?? 0})`,
				todo: `같은 요소가 ${l.scopeCount}개라 녹화 당시 순서(${(l.scopeIndex ?? 0) + 1}번째)로 골랐습니다. 행이나 컨테이너로 범위를 좁히세요.` };
		}
		if (l.role && l.roleCount && l.roleCount > 1) {
			return { code: `${page}.${roleCall(l.role, l.name)}.nth(${l.roleIndex ?? 0})`,
				todo: `같은 요소가 ${l.roleCount}개라 녹화 당시 순서(${(l.roleIndex ?? 0) + 1}번째)로 골랐습니다. 행이나 컨테이너로 범위를 좁히세요.` };
		}
		if (l.text) return { code: `${page}.getByText(${s(l.text)}, { exact: true })`, todo: "글자로 찾습니다. 같은 글자가 여러 곳에 있으면 범위를 좁히세요." };
	}
	// Recordings without locator hints only have the short description.
	if (d?.text && !d.text.endsWith("…")) {
		return { code: `${page}.getByText(${s(d.text)}, { exact: true })`, todo: "녹화에 요소 탐색 정보가 없어 보이는 글자로 찾습니다. 확인하세요." };
	}
	const css = d?.tag.replace(/\[role=([^\]]+)\]/, '[role="$1"]').replace(/\[type=([^\]]+)\]/, '[type="$1"]') || "body";
	return { code: `${page}.locator(${s(css)}).first()`, todo: "요소를 특정할 정보가 부족합니다. 알맞은 locator로 바꾸세요." };
}

const targetName = (d?: Desc) => short(d?.loc?.name || d?.loc?.label || d?.loc?.placeholder || d?.text || d?.loc?.testid || d?.testid || d?.tag || "요소");
const secretField = (d?: Desc) => d?.loc?.type === "password" || /pass|secret|token|card|비밀번호|암호/i.test([d?.loc?.field, d?.loc?.label, d?.loc?.placeholder, d?.text].join(" "));

function envName(d: Desc | undefined, taken: Set<string>): string {
	const raw = (d?.loc?.field || d?.loc?.label || d?.loc?.placeholder || d?.text || "").normalize("NFKD");
	let base = raw.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
	if (!base) base = d?.loc?.type === "password" ? "PASSWORD" : `INPUT_${taken.size + 1}`;
	let name = `WALKMATE_${base}`;
	for (let i = 2; taken.has(name); i++) name = `WALKMATE_${base}_${i}`;
	taken.add(name);
	return name;
}

/** Drop events that repeat another one and put Enter after the value it submits. */
function normalize(events: LiveEvent[]): LiveEvent[] {
	// Implicit form submission clicks the default button at (0, 0) right after Enter: pressing Enter again covers it.
	let ev = events.filter((e, i) => {
		if (e.type !== "click" || e.x || e.y) return true;
		const enter = events.slice(0, i).reverse().find((k) => k.tab === e.tab && k.type === "key");
		return !(enter?.key === "Enter" && e.t - enter.t <= 0.5);
	}).map((e) => ({ ...e }));
	// Chrome reports Enter on keydown, before the change event of the field it submits.
	for (const key of ev) {
		if (key.type !== "key" || key.key !== "Enter") continue;
		const input = ev.find((e) => e.type === "input" && e.tab === key.tab && e.t >= key.t && e.t - key.t <= 0.5 && sameTarget(e.d, key.d));
		if (input) key.t = input.t + 0.0001;
	}
	ev.sort((a, b) => a.t - b.t);
	const drop = new Set<LiveEvent>();
	ev.forEach((e, i) => {
		if (e.type !== "click") return;
		// Focusing a field before typing, or opening a select or file chooser: fill/selectOption/setInputFiles cover it.
		const kind = control(e.d);
		if (kind === "text" || kind === "select" || kind === "file") {
			const next = ev.slice(i + 1).find((n) => n.tab === e.tab && (n.type === "click" || n.type === "input" || n.type === "key"));
			if (next?.type === "input" && sameTarget(next.d, e.d)) drop.add(e);
		}
	});
	// A checkbox change follows the click on it or on its label (and the label's forwarded click): check() covers them.
	ev.forEach((e, i) => {
		if (e.type !== "input" || control(e.d) !== "check") return;
		for (const c of ev.slice(0, i).reverse()) {
			if (c.tab !== e.tab || ["nav", "pin"].includes(c.type)) continue;
			if (c.type !== "click" || e.t - c.t > 1) break;
			drop.add(c);
		}
	});
	ev = ev.filter((e) => !drop.has(e));
	return ev;
}

/** Turn a recorded demonstration into a Playwright test. Pure: no file access. */
export function buildPlaywrightSpec(src: SpecSource): PlaywrightSpec {
	const from = src.from ?? 0;
	const to = src.to ?? Infinity;
	const sorted = [...src.events].filter((e) => Number.isFinite(e.t) && typeof e.type === "string").sort((a, b) => a.t - b.t);
	const notes = new Map(sorted.filter((e) => e.type === "pin-note").map((e) => [e.id, e.text]));
	const known = new Map<number, string>();
	for (const e of sorted) if (e.t < from && e.type === "nav" && e.url) known.set(e.tab, e.url);
	const events = normalize(sorted.filter((e) => KEEP.has(e.type) && e.t >= from && e.t <= to));
	const warnings: string[] = [];
	const todos: string[] = [];
	const envNames = new Set<string>();
	let credentials = false;
	let needsContext = false;

	const steps: Step[] = [];
	const pages = new Map<number, string>();
	const lastUrl = new Map<number, string>();
	/** The step whose action last touched each tab, for attaching the navigations it caused. */
	const lastAct = new Map<number, { step: Step; t: number }>();
	const pageVar = (tab: number) => pages.get(tab)!;

	const add = (t: number, tab: number, title: string, lines: string[] = [], acts = true): Step => {
		const step: Step = { t, tab, title, lines, expects: new Map(), comments: [], acts };
		steps.push(step);
		if (acts) lastAct.set(tab, { step, t });
		return step;
	};
	const todo = (step: Step, reason: string) => {
		step.lines.unshift(`// TODO: ${reason}`);
		todos.push(`${steps.indexOf(step) + 1}. ${step.title}: ${reason}`);
	};
	const goto = (tab: number, url: string, t: number) => {
		const v = pageVar(tab);
		add(t, tab, `이동: ${short(url, 60)}`, [`await ${v}.goto(${s(url)});`]);
		lastUrl.set(tab, url);
	};
	/** Give a tab a page variable: the first one is the test's page, later ones are popups or new pages. */
	const open = (tab: number, t: number, url?: string) => {
		const first = pages.size === 0;
		const v = first ? "page" : `page${pages.size + 1}`;
		pages.set(tab, v);
		if (!first) {
			const opener = [...lastAct.entries()].filter(([other, a]) => other !== tab && t - a.t <= FOLLOW && a.step.acts && !a.step.popup)
				.sort((a, b) => b[1].t - a[1].t)[0];
			if (opener && url) {
				opener[1].step.popup = v;
				lastAct.set(tab, opener[1]);
				lastUrl.set(tab, url);
				if (!url.startsWith("blob:") && !url.startsWith("data:")) opener[1].step.expects.set(v, url);
				return;
			}
			needsContext = true;
			const step = add(t, tab, "새 탭", [`${v} = await context.newPage();`]);
			if (url) {
				step.lines.push(`await ${v}.goto(${s(url)});`);
				lastUrl.set(tab, url);
			}
			return;
		}
		const start = url ?? src.url;
		if (start && start !== "about:blank") {
			goto(tab, start, t);
		} else {
			const step = add(t, tab, "시작 페이지", []);
			todo(step, "녹화에 시작 주소가 없습니다. page.goto로 첫 화면을 여세요.");
		}
	};
	const ensure = (tab: number, t: number) => {
		if (!pages.has(tab)) open(tab, t, known.get(tab));
	};

	for (const e of events) {
		if (e.type === "nav") {
			if (!e.url || e.url === "about:blank" || /^(chrome|devtools|chrome-extension):/.test(e.url)) continue;
			if (!pages.has(e.tab)) {
				open(e.tab, e.t, e.url);
				continue;
			}
			if (lastUrl.get(e.tab) === e.url) continue;
			const prev = lastAct.get(e.tab);
			if (prev && e.t - prev.t <= FOLLOW) {
				if (!e.url.startsWith("blob:") && !e.url.startsWith("data:")) prev.step.expects.set(pageVar(e.tab), e.url);
				lastUrl.set(e.tab, e.url);
			} else goto(e.tab, e.url, e.t);
			continue;
		}
		ensure(e.tab, e.t);
		const v = pageVar(e.tab);
		if (e.type === "key") {
			if (e.key === "Escape") add(e.t, e.tab, "Escape", [`await ${v}.keyboard.press("Escape");`]);
			else {
				const at = locatorFor(v, e.d);
				const step = add(e.t, e.tab, `Enter: ${targetName(e.d)}`, [`await ${at.code}.press("Enter");`]);
				if (at.todo) todo(step, at.todo);
			}
			continue;
		}
		if (e.type === "click") {
			const at = locatorFor(v, e.d);
			const step = add(e.t, e.tab, `클릭: ${targetName(e.d)}`, [`await ${at.code}.click();`]);
			if (at.todo) todo(step, at.todo);
			continue;
		}
		if (e.type === "input") {
			const at = locatorFor(v, e.d);
			const kind = control(e.d);
			const name = targetName(e.d);
			let step: Step;
			if (kind === "check" || (!e.d?.loc && (e.value === "true" || e.value === "false"))) {
				const on = e.value === "true";
				step = add(e.t, e.tab, `${on ? "체크" : "체크 해제"}: ${name}`, [`await ${at.code}.${on ? "check" : "uncheck"}();`]);
				if (!e.d?.loc) todo(step, "녹화에 입력 종류가 없어 체크박스로 추정했습니다.");
			} else if (kind === "file") {
				step = add(e.t, e.tab, `파일 첨부: ${name}`, [`// await ${at.code}.setInputFiles("path/to/file");`]);
				todo(step, "첨부할 파일 경로를 지정하세요. 녹화에는 파일 이름만 남습니다.");
			} else {
				let value: string;
				if (masked(e.value)) {
					const env = envName(e.d, envNames);
					value = `env(${s(env)})`;
				} else {
					value = s(e.value!);
					if (secretField(e.d)) credentials = true;
					if (!src.recordInputs && e.value!.length >= 120) warnings.push(`${name}: 값이 120자에서 잘렸을 수 있습니다.`);
				}
				step = kind === "select"
					? add(e.t, e.tab, `선택: ${name}`, [`await ${at.code}.selectOption(${value});`])
					: add(e.t, e.tab, `입력: ${name}`, [`await ${at.code}.fill(${value});`]);
			}
			if (at.todo) todo(step, at.todo);
			continue;
		}
		if (e.type === "pin") {
			const note = e.text ?? notes.get(e.id);
			if (!e.d || e.d.tag === "document") continue;
			if (e.d.area) {
				const step = add(e.t, e.tab, "영역 핀", [], false);
				step.comments.push(`영역 핀${note ? ` 메모: ${s(note)}` : ""}${e.d.areaText ? ` · 글자: ${s(short(e.d.areaText, 120))}` : ""}`);
				todo(step, "영역 핀입니다. 확인할 내용을 expect로 적으세요.");
				continue;
			}
			const at = locatorFor(v, e.d);
			const step = add(e.t, e.tab, `확인: ${targetName(e.d)}`, [`await expect(${at.code}).toBeVisible();`], false);
			if (note) step.comments.push(`핀 메모: ${s(note)}`);
			if (at.todo) todo(step, at.todo);
		}
	}

	if (!steps.length) throw new Error("선택한 구간에 테스트로 옮길 이동·클릭·입력이 없습니다.");
	for (const u of groupUtterances(src.words ?? [])) {
		if (u.end < from || u.start > to) continue;
		const step = steps.find((st) => st.t >= u.start) ?? steps.at(-1)!;
		step.comments.push(`🗣 ${s(short(u.text, 200))}`);
	}
	if (envNames.size) warnings.push(`가려진 입력값은 환경 변수(${[...envNames].join(", ")})에서 읽습니다. 녹화된 값을 그대로 쓰려면 record_inputs=true로 다시 시연하세요.`);
	if (credentials) warnings.push("녹화된 테스트 계정 값(비밀번호 포함)이 코드에 그대로 들어 있습니다. 테스트 전용 계정인지 확인하세요.");
	const hasCheck = steps.some((st) => st.lines.some((l) => l.includes("expect(") && !l.includes("toHaveURL")));
	if (!hasCheck) todos.push("마지막: 시연의 목적이 이뤄졌는지 확인하는 expect가 없습니다. 결과 메시지나 저장된 항목을 확인하세요.");

	const extra = [...pages.values()].filter((v) => v !== "page");
	const lines: string[] = [
		"// Walkmate 시연에서 만든 Playwright 테스트 초안 (export_to_playwright).",
		`// 원본 녹화: ${src.dir}`,
		"// 실행해 보고 TODO 줄과 완료 조건을 확인하세요.",
	];
	if (credentials) lines.push("// ⚠ 녹화된 테스트 계정 값(비밀번호 포함)이 그대로 들어 있습니다. 테스트 전용 계정에만 쓰세요.");
	const types = extra.length ? ", type Page" : "";
	if (src.withWalkmate) {
		lines.push(`import { test as base, expect${types} } from "@playwright/test";`, `import { withWalkmate } from "walkmate/playwright";`, "",
			"const test = withWalkmate(base);", `test.use({ walkmate: { sourceRecording: ${s(src.dir)} } });`);
	} else {
		lines.push(`import { test, expect${types} } from "@playwright/test";`);
	}
	if (envNames.size) {
		lines.push("", "function env(name: string): string {", "  const value = process.env[name];",
			"  if (!value) throw new Error(`${name} 환경 변수를 설정하세요 (녹화에서 가려진 입력값).`);", "  return value;", "}");
	}
	lines.push("", `test(${s(src.title)}, async ({ page${needsContext ? ", context" : ""} }) => {`);
	if (extra.length) lines.push(`  let ${extra.map((v) => `${v}: Page`).join(", ")};`, "");
	steps.forEach((st, i) => {
		for (const c of st.comments) lines.push(`  // ${c.replace(/[\r\n]+/g, " ")}`);
		lines.push(`  await test.step(${s(`${i + 1}. ${st.title}`)}, async () => {`);
		const body = [...st.lines];
		if (st.popup) {
			const act = body.findIndex((l) => !l.startsWith("//"));
			body.splice(act, 1, `const ${st.popup}Promise = ${pageVar(st.tab)}.waitForEvent("popup");`, body[act], `${st.popup} = await ${st.popup}Promise;`);
		}
		for (const [v, url] of st.expects) body.push(`await expect(${v}).toHaveURL(${s(url)});`);
		for (const l of body) lines.push(`    ${l}`);
		lines.push("  });");
	});
	if (!hasCheck) lines.push("  // TODO: 시연의 목적이 이뤄졌는지 확인하는 expect를 추가하세요 (결과 메시지, 저장된 항목 등).");
	lines.push("});", "");
	return { code: lines.join("\n"), steps: steps.length, credentials, env: [...envNames], todos, warnings };
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(() => true, () => false);
}

async function optionalJson<T>(path: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

/** Whether node would resolve the package from this directory. */
async function resolvable(from: string, name: string): Promise<boolean> {
	for (let dir = resolve(from); ; dir = dirname(dir)) {
		if (await exists(join(dir, "node_modules", name, "package.json"))) return true;
		if (dirname(dir) === dir) return false;
	}
}

/** The newest live recording under the project's .walkmate/reviews. */
export async function latestRecording(cwd: string): Promise<string> {
	const root = projectPaths(cwd).reviews;
	let best: { dir: string; mtime: number } | undefined;
	for (const group of await readdir(root, { withFileTypes: true }).catch(() => [])) {
		if (!group.isDirectory()) continue;
		for (const rec of await readdir(join(root, group.name), { withFileTypes: true }).catch(() => [])) {
			if (!rec.isDirectory()) continue;
			const dir = join(root, group.name, rec.name);
			const info = await stat(join(dir, "events.json")).catch(() => undefined);
			if (info && (!best || info.mtimeMs > best.mtime)) best = { dir, mtime: info.mtimeMs };
		}
	}
	if (!best) throw new Error(`${root}에 라이브 시연 녹화가 없습니다. review_start로 시연을 먼저 녹화하세요.`);
	return best.dir;
}

async function defaultTestDir(cwd: string): Promise<string> {
	for (const name of ["playwright.config.ts", "playwright.config.mts", "playwright.config.js", "playwright.config.mjs", "playwright.config.cjs"]) {
		const config = await readFile(join(cwd, name), "utf8").catch(() => undefined);
		const dir = config?.match(/testDir\s*:\s*["'`]([^"'`]+)["'`]/)?.[1];
		if (dir) return resolve(cwd, dir);
	}
	// Without testDir Playwright searches the whole project, so a subfolder is still picked up.
	for (const name of ["e2e", "tests"]) if (await exists(join(cwd, name))) return join(cwd, name);
	return join(cwd, "e2e");
}

function slug(title: string, dir: string): string {
	const s = title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
	return s && s !== "walkmate" ? s : `walkmate-${basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-")}`;
}

/** Read a live recording and write a Playwright spec for it. Refuses to overwrite unless asked. */
export async function exportPlaywright(recording: string | undefined, opts: PlaywrightExportOptions): Promise<PlaywrightExport> {
	const cwd = resolve(opts.cwd);
	const dir = resolve(cwd, recording ?? (await latestRecording(cwd)));
	const rec = await optionalJson<{ status?: string; events?: LiveEvent[] }>(join(dir, "events.json"));
	if (!rec || !Array.isArray(rec.events)) throw new Error(`${dir}에 라이브 시연 기록(events.json)이 없습니다. 문서 리뷰는 테스트로 옮길 수 없습니다.`);
	const request = await optionalJson<{ title?: string; url?: string; record_inputs?: boolean }>(join(dir, "request.json"));
	const transcript = await optionalJson<{ words?: Word[] }>(join(dir, "transcript.json"));
	const title = opts.title ?? (request?.title && request.title !== "Walkmate" ? request.title : "시연 재현");
	const path = resolve(cwd, opts.out ?? join(await defaultTestDir(cwd), `${slug(title, dir)}.spec.ts`));
	const withWalkmate = opts.withWalkmate ?? (await resolvable(dirname(path), "walkmate"));
	const spec = buildPlaywrightSpec({
		dir, title, events: rec.events, url: request?.url, recordInputs: request?.record_inputs,
		words: transcript?.words, from: opts.from, to: opts.to, withWalkmate,
	});
	if (rec.status && rec.status !== "submitted") spec.warnings.push(`녹화가 제출되지 않고 끝났습니다 (${rec.status}). 단계가 빠졌을 수 있습니다.`);
	if (!(await resolvable(dirname(path), "@playwright/test"))) {
		spec.warnings.push("이 프로젝트에서 @playwright/test를 찾지 못했습니다: npm i -D @playwright/test && npx playwright install chromium");
	}
	if (withWalkmate && !(await resolvable(dirname(path), "walkmate"))) {
		spec.warnings.push("walkmate 패키지를 찾지 못했습니다. 설치하거나 with_walkmate=false로 다시 내보내세요.");
	}
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeFile(path, spec.code, { flag: opts.overwrite ? "w" : "wx" });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${relative(cwd, path) || path} 파일이 이미 있습니다. 다른 out을 주거나 overwrite=true로 덮어쓰세요.`);
		throw err;
	}
	return { ...spec, path, recording: dir, withWalkmate };
}
