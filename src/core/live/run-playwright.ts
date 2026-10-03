import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findExecutable } from "../dependencies.ts";
import { createPlaywrightDir, projectPaths } from "../storage.ts";
import { CHROME_BIN } from "./cdp.ts";

export interface PlaywrightRunOptions {
	/** Project directory: relative spec paths, .walkmate artifacts and the test's working directory. */
	cwd: string;
	spec: string;
	/** Extra environment for the test process only, e.g. WALKMATE_PASSWORD. Not written to disk. */
	env?: Record<string, string>;
	headed?: boolean;
	/** Only tests whose title matches. */
	grep?: string;
	/** Record each test with withWalkmate (replay.html) when the spec does not already. Default true. */
	replay?: boolean;
	/** Per-test timeout. Default: Playwright's 30 seconds. */
	testTimeoutSec?: number;
	signal?: AbortSignal;
}

export interface PlaywrightTestResult {
	title: string;
	status: string;
	duration: number;
	error?: string;
	/** Innermost test.step that failed. */
	failedStep?: string;
	/** .walkmate/runs/<run> written by withWalkmate: rrweb, network, console, steps and replay.html. */
	run?: string;
	replay?: string;
	attachments: { name: string; path: string }[];
}

export interface PlaywrightRunResult {
	status: "passed" | "failed" | "interrupted" | "error";
	spec: string;
	/** Staging folder with the copied spec, config, report.json and results (screenshots, traces). */
	dir: string;
	version: string;
	browser: string;
	replay: boolean;
	tests: PlaywrightTestResult[];
	/** Errors outside tests, e.g. a syntax error or a missing import. */
	errors: string[];
	/** Tail of the runner's console output. */
	output: string;
	duration: number;
}

const require = createRequire(import.meta.url);
/** Walkmate's package root, from src/core/live or dist/core/live. */
const WALKMATE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MAX_OUTPUT = 20_000;
const MAX_ERROR = 3000;
const ansi = /\x1b\[[0-9;]*[A-Za-z]/g;

/** Walkmate's own @playwright/test, so projects without Playwright can still run exported tests. */
export function bundledPlaywright(): { dir: string; cli: string; version: string } {
	const pkg = require.resolve("@playwright/test/package.json");
	const dir = dirname(pkg);
	return { dir, cli: join(dir, "cli.js"), version: JSON.parse(readFileSync(pkg, "utf8")).version };
}

async function link(target: string, path: string) {
	if ((await readlink(path).catch(() => undefined)) === target) return;
	await rm(path, { recursive: true, force: true });
	await mkdir(dirname(path), { recursive: true });
	await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

/**
 * Prepare the copied spec: relative imports point back at the original folder, and unless the spec
 * already uses walkmate/playwright, its test is wrapped with withWalkmate so every run leaves a replay.
 */
export function stageSpec(code: string, specDir: string, replay: boolean): { code: string; replay: boolean } {
	let out = code.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.\.?\/[^"']*)\2/g,
		(_m, lead: string, _q: string, path: string) => `${lead}${JSON.stringify(resolve(specDir, path))}`);
	if (!replay || /["']walkmate\/playwright["']/.test(out)) return { code: out, replay: /["']walkmate\/playwright["']/.test(out) };
	const imp = /import\s*\{([^}]*)\}\s*from\s*(["'])@playwright\/test\2\s*;?/.exec(out);
	const names = imp?.[1].split(",").map((n) => n.trim());
	if (!imp || !names?.includes("test")) return { code: out, replay: false };
	const recording = /^\/\/ 원본 녹화: (.+)$/m.exec(out)?.[1]?.trim();
	const wrapped = [
		`import { ${names.filter(Boolean).map((n) => (n === "test" ? "test as __walkmateBase" : n)).join(", ")} } from "@playwright/test";`,
		`import { withWalkmate as __withWalkmate } from "walkmate/playwright";`,
		"const test = __withWalkmate(__walkmateBase);",
		...(recording ? [`test.use({ walkmate: { sourceRecording: ${JSON.stringify(recording)} } });`] : []),
	].join("\n");
	out = out.slice(0, imp.index) + wrapped + out.slice(imp.index + imp[0].length);
	return { code: out, replay: true };
}

interface JsonStep { title: string; error?: unknown; steps?: JsonStep[] }
interface JsonAnnotation { type: string; description?: string }
interface JsonResult { annotations?: JsonAnnotation[]; status: string; duration: number; error?: { message?: string; stack?: string }; errors?: { message?: string }[]; steps?: JsonStep[]; attachments?: { name: string; path?: string }[] }
interface JsonSuite { title: string; specs?: { title: string; tests: { annotations?: JsonAnnotation[]; results: JsonResult[] }[] }[]; suites?: JsonSuite[] }
interface JsonReport { suites?: JsonSuite[]; errors?: { message?: string }[]; stats?: { duration?: number } }

const clip = (s: string, n = MAX_ERROR) => {
	const t = s.replace(ansi, "").trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
};

function failedStep(steps: JsonStep[] = []): string | undefined {
	for (const s of steps) {
		if (!s.error) continue;
		return failedStep(s.steps) ?? s.title;
	}
}

function collect(report: JsonReport): PlaywrightTestResult[] {
	const out: PlaywrightTestResult[] = [];
	const walk = (suite: JsonSuite, path: string[]) => {
		for (const spec of suite.specs ?? []) {
			for (const t of spec.tests) {
				const r = t.results.at(-1);
				if (!r) continue;
				const attachments = (r.attachments ?? []).filter((a) => a.path).map((a) => ({ name: a.name, path: a.path! }));
				const error = r.error?.message ?? r.errors?.map((e) => e.message).filter(Boolean).join("\n");
				// withWalkmate notes its run folder; the attachment is only Playwright's copy of replay.html.
				const run = [...(r.annotations ?? []), ...(t.annotations ?? [])].find((a) => a.type === "walkmate")?.description;
				const replay = run && existsSync(join(run, "replay.html")) ? join(run, "replay.html") : attachments.find((a) => a.name === "walkmate replay")?.path;
				out.push({
					title: [...path, spec.title].join(" › "), status: r.status, duration: r.duration,
					error: error ? clip(error) : undefined, failedStep: failedStep(r.steps), run, replay,
					attachments: attachments.filter((a) => a.name !== "walkmate replay"),
				});
			}
		}
		for (const child of suite.suites ?? []) walk(child, [...path, child.title]);
	};
	// The top-level suite is the file; nested ones are describe blocks.
	for (const file of report.suites ?? []) walk(file, []);
	return out;
}

async function chrome(): Promise<{ launch: Record<string, unknown>; name: string }> {
	if (existsSync(CHROME_BIN)) return { launch: { launchOptions: { executablePath: CHROME_BIN } }, name: CHROME_BIN };
	const found = !CHROME_BIN.includes("/") && !CHROME_BIN.includes("\\") ? await findExecutable(CHROME_BIN) : undefined;
	if (found) return { launch: { launchOptions: { executablePath: found } }, name: found };
	return { launch: { channel: "chrome" }, name: "Playwright channel chrome" };
}

/** Run one spec with Walkmate's bundled Playwright and the system Chrome; nothing has to be installed in the project. */
export async function runPlaywrightSpec(opts: PlaywrightRunOptions): Promise<PlaywrightRunResult> {
	const started = Date.now();
	const cwd = resolve(opts.cwd);
	const spec = resolve(cwd, opts.spec);
	if (!(await stat(spec).catch(() => undefined))?.isFile()) throw new Error(`테스트 파일이 없습니다: ${spec}`);
	if (!/\.(spec|test)\.[cm]?[jt]sx?$/.test(spec)) throw new Error(`Playwright 테스트 파일(.spec.ts / .test.ts)이 아닙니다: ${spec}`);
	for (const [k, v] of Object.entries(opts.env ?? {})) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== "string") throw new Error(`env는 이름이 올바른 문자열 값이어야 합니다: ${k}`);
	}
	const pw = bundledPlaywright();
	const modules = join(projectPaths(cwd).playwright, "node_modules");
	await link(pw.dir, join(modules, "@playwright", "test"));
	await link(WALKMATE_ROOT.replace(/[\\/]$/, ""), join(modules, "walkmate"));
	const dir = await createPlaywrightDir(cwd);

	// walkmate/playwright resolves to the built fixture.
	const fixture = existsSync(join(WALKMATE_ROOT, "dist", "playwright", "index.js"));
	const staged = stageSpec(await readFile(spec, "utf8"), dirname(spec), (opts.replay ?? true) && fixture);
	const file = basename(spec);
	await writeFile(join(dir, file), staged.code);
	const browser = await chrome();
	const config = {
		testDir: ".", testMatch: [file], outputDir: "results", workers: 1, retries: 0,
		...(opts.testTimeoutSec ? { timeout: opts.testTimeoutSec * 1000 } : {}),
		reporter: [["json", { outputFile: "report.json" }], ["line"]],
		use: { headless: !opts.headed, screenshot: "only-on-failure", trace: "retain-on-failure", ...browser.launch },
	};
	const configPath = join(dir, "playwright.config.mjs");
	await writeFile(configPath, `export default ${JSON.stringify(config, null, 2)};\n`);

	let output = "";
	const keep = (chunk: Buffer) => {
		output = (output + chunk.toString()).slice(-MAX_OUTPUT);
	};
	const args = [pw.cli, "test", "-c", configPath, ...(opts.grep ? ["-g", opts.grep] : [])];
	const code = await new Promise<number | null>((done, fail) => {
		const child = spawn(process.execPath, args, {
			cwd,
			env: {
				...process.env, ...opts.env, WALKMATE_CWD: cwd, FORCE_COLOR: "0", PLAYWRIGHT_HTML_OPEN: "never",
				// For project files the spec imports: CommonJS resolution falls back to Walkmate's Playwright.
				NODE_PATH: [modules, process.env.NODE_PATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		const abort = () => {
			child.kill("SIGINT");
			setTimeout(() => child.kill("SIGKILL"), 5000).unref();
		};
		opts.signal?.addEventListener("abort", abort, { once: true });
		if (opts.signal?.aborted) abort();
		child.on("error", fail);
		child.on("close", (c) => {
			opts.signal?.removeEventListener("abort", abort);
			done(c);
		});
	});

	const report = await readFile(join(dir, "report.json"), "utf8").then((t) => JSON.parse(t) as JsonReport, () => undefined);
	const tests = report ? collect(report) : [];
	const errors = (report?.errors ?? []).map((e) => clip(e.message ?? "")).filter(Boolean);
	const failed = tests.some((t) => t.status !== "passed" && t.status !== "skipped");
	const status: PlaywrightRunResult["status"] = opts.signal?.aborted ? "interrupted"
		: !report || errors.length || !tests.length ? "error"
		: failed || code !== 0 ? "failed" : "passed";
	return {
		status, spec, dir, version: pw.version, browser: browser.name, replay: staged.replay, tests, errors,
		output: clip(output, MAX_OUTPUT), duration: (Date.now() - started) / 1000,
	};
}
