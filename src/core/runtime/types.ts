import { resolve } from "node:path";
import { normalizeUrl } from "../review.ts";

export interface RunStart {
	cwd: string;
	title: string;
	url: string;
	allow_actions: boolean;
	headless: boolean;
	isolated: boolean;
	timeout_sec: number;
	source_recording?: string;
}

export interface Target {
	kind: "ref" | "testid" | "css" | "role";
	value: string;
	name?: string;
	scope?: string;
}

export interface RunAction {
	type: "observe" | "navigate" | "click" | "fill" | "select" | "check" | "press" | "scroll" | "wait" | "assert";
	tab?: string;
	target?: Target;
	url?: string;
	value?: string;
	value_env?: string;
	checked?: boolean;
	delta_y?: number;
	key?: string;
	condition?: "visible" | "hidden" | "text" | "url";
	expected?: string;
	timeout_ms?: number;
	source_step?: string;
}

export interface Snapshot {
	tab: string;
	url: string;
	title: string;
	text: string;
	elements: { ref: string; tag: string; role: string; name: string; testid?: string; disabled: boolean; checked?: boolean }[];
	tabs: { id: string; url: string }[];
	screenshot?: string;
}

export interface RunStep {
	id: string;
	t: number;
	duration_ms: number;
	action: RunAction;
	status: "ok" | "failed";
	error?: string;
	before?: string;
	after?: string;
}

export interface StepResult {
	step: RunStep;
	snapshot?: Snapshot;
}

export interface RunResult {
	version: 1;
	title: string;
	status: "completed" | "passed" | "failed" | "cancelled" | "timeout";
	dir: string;
	source_recording?: string;
	steps: number;
	assertions: number;
	failures: number;
	replay?: string;
	warnings: string[];
}

const ACTIONS = ["observe", "navigate", "click", "fill", "select", "check", "press", "scroll", "wait", "assert"];
export const KEYS = ["Enter", "Tab", "Escape", "Backspace", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Space"];
export const MUTATING = new Set(["click", "fill", "select", "check", "press"]);

function object(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected an object.");
	return input as Record<string, unknown>;
}
function string(value: unknown, name: string, required = false): string | undefined {
	if (value === undefined && !required) return undefined;
	if (typeof value !== "string" || (required && !value.trim()) || value.length > 8192) throw new Error(`${name} must be a valid string (maximum 8192 characters).`);
	return value as string;
}
function boolean(value: unknown, name: string, fallback: boolean): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
	return value;
}
function number(value: unknown, name: string, fallback: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > max) throw new Error(`${name} must be between 1 and ${max}.`);
	return value;
}
function keys(o: Record<string, unknown>, allowed: string[]) {
	for (const key of Object.keys(o)) if (!allowed.includes(key)) throw new Error(`Unknown field: ${key}.`);
}

export function runUrl(value: string): string {
	if (/^(?:file|data|javascript|chrome|devtools|ftp|blob):/i.test(value.trim())) throw new Error("Unsupported run URL protocol.");
	const url = normalizeUrl(value.trim());
	if (url === "about:blank") return url;
	const parsed = new URL(url);
	if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
		throw new Error("Runs accept only HTTP(S) URLs without embedded credentials, or about:blank.");
	}
	return parsed.href;
}

export function parseRunStart(input: unknown, cwd: string): RunStart {
	const o = object(input);
	keys(o, ["cwd", "title", "url", "allow_actions", "headless", "isolated", "timeout_sec", "source_recording"]);
	return {
		cwd: resolve(string(o.cwd, "cwd", o.cwd !== undefined) ?? cwd),
		title: string(o.title, "title", o.title !== undefined) ?? "Walkmate execution",
		url: runUrl(string(o.url, "url", o.url !== undefined) ?? "about:blank"),
		allow_actions: boolean(o.allow_actions, "allow_actions", false),
		headless: boolean(o.headless, "headless", false),
		isolated: boolean(o.isolated, "isolated", false),
		timeout_sec: number(o.timeout_sec, "timeout_sec", 3600, 3600),
		source_recording: string(o.source_recording, "source_recording"),
	};
}

export function parseRunAction(input: unknown): RunAction {
	const o = object(input);
	keys(o, ["type", "tab", "target", "url", "value", "value_env", "checked", "delta_y", "key", "condition", "expected", "timeout_ms", "source_step"]);
	if (!ACTIONS.includes(String(o.type))) throw new Error("Unknown run action.");
	const a: RunAction = { type: o.type as RunAction["type"], timeout_ms: number(o.timeout_ms, "timeout_ms", 10_000, 30_000) };
	for (const field of ["tab", "url", "value", "value_env", "key", "expected", "source_step"] as const) a[field] = string(o[field], field);
	if (o.target !== undefined) {
		const target = object(o.target);
		keys(target, ["kind", "value", "name", "scope"]);
		if (!["ref", "testid", "css", "role"].includes(String(target.kind))) throw new Error("Unknown target kind.");
		a.target = { kind: target.kind as Target["kind"], value: string(target.value, "target.value", true)!, name: string(target.name, "target.name"), scope: string(target.scope, "target.scope") };
	}
	if (MUTATING.has(a.type) && !a.target) throw new Error(`${a.type} requires a target.`);
	if (a.type === "navigate") a.url = runUrl(string(o.url, "url", true)!);
	if (a.type === "fill" || a.type === "select") {
		if ((o.value === undefined) === (o.value_env === undefined)) throw new Error("Supply exactly one of value or value_env.");
		if (a.value_env && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.value_env)) throw new Error("Invalid value_env name.");
		if (o.value_env === "") throw new Error("value_env must not be empty.");
	}
	if (a.type === "check") a.checked = boolean(o.checked, "checked", true);
	if (a.type === "scroll") {
		if (o.delta_y !== undefined && (typeof o.delta_y !== "number" || !Number.isFinite(o.delta_y) || Math.abs(o.delta_y) > 2000)) throw new Error("delta_y must be between -2000 and 2000.");
		a.delta_y = o.delta_y as number | undefined ?? 600;
	}
	if (a.type === "press" && !KEYS.includes(a.key ?? "")) throw new Error(`key must be one of ${KEYS.join(", ")}.`);
	if (a.type === "wait" || a.type === "assert") {
		if (!["visible", "hidden", "text", "url"].includes(String(o.condition))) throw new Error("wait/assert requires a condition.");
		a.condition = o.condition as RunAction["condition"];
		if (a.condition !== "url" && !a.target) throw new Error("This condition requires a target.");
		if (a.condition === "text" || a.condition === "url") a.expected = string(o.expected, "expected", true)!;
	}
	return a;
}

/** Never persist literal input values, even when the caller forgot to mark them as credentials. */
export function recordedAction(action: RunAction): RunAction {
	return { ...action, ...(action.value !== undefined ? { value: "[redacted]" } : {}) };
}
