import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { parseRunAction, parseRunStart, recordedAction, runUrl } from "../src/core/runtime/types.ts";
import { runStatus } from "../src/core/runtime/run.ts";

const target = { kind: "testid", value: "login" };

test("runtime starts with safe defaults and an explicit project directory", () => {
	const req = parseRunStart({}, ".");
	assert.equal(req.cwd, resolve("."));
	assert.equal(req.url, "about:blank");
	assert.equal(req.allow_actions, false);
	assert.equal(req.headless, false);
	assert.equal(req.isolated, false);
	assert.equal(req.timeout_sec, 3600);
	assert.equal(parseRunStart({ cwd: "client", allow_actions: true, isolated: true }, ".").cwd, resolve("client"));
});

test("execution accepts only web URLs or a blank tab, without embedded credentials", () => {
	assert.equal(runUrl("localhost:5173/login"), "http://localhost:5173/login");
	assert.equal(runUrl("about:blank"), "about:blank");
	assert.equal(runUrl("https://example.com"), "https://example.com/");
	for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hello", "chrome://settings", "ftp://host", "https://user:password@host/"]) {
		assert.throws(() => runUrl(url));
	}
});

test("start validation rejects invalid flags, timeouts and unknown fields", () => {
	for (const input of [null, [], { title: 1 }, { allow_actions: "yes" }, { timeout_sec: NaN }, { timeout_sec: 0 }, { timeout_sec: 3601 }, { evaluate: "code" }]) {
		assert.throws(() => parseRunStart(input, "."));
	}
});

test("action validation requires stable targets, input bindings and meaningful checks", () => {
	assert.equal(parseRunAction({ type: "observe" }).timeout_ms, 10000);
	assert.equal(parseRunAction({ type: "check", target }).checked, true);
	assert.equal(parseRunAction({ type: "fill", target, value: "" }).value, "");
	assert.equal(parseRunAction({ type: "fill", target, value_env: "E2E_PASSWORD" }).value_env, "E2E_PASSWORD");
	assert.equal(parseRunAction({ type: "wait", condition: "url", expected: "/dashboard" }).expected, "/dashboard");
	for (const input of [
		{ type: "evaluate", value: "code" }, { type: "click" }, { type: "fill", target },
		{ type: "fill", target, value: "x", value_env: "PASSWORD" }, { type: "fill", target, value_env: "" },
		{ type: "fill", target, value_env: "NOT VALID" }, { type: "press", target, key: "arbitrary" },
		{ type: "assert" }, { type: "assert", condition: "visible" }, { type: "assert", target, condition: "text" },
		{ type: "click", target, timeout_ms: 0 }, { type: "click", target, timeout_ms: Infinity },
		{ type: "click", target, timeout_ms: 30001 }, { type: "click", target: { kind: "coords", value: "1,2" } },
		{ type: "click", target: { ...target, index: 0 } }, { type: "observe", evaluate: "code" },
	]) assert.throws(() => parseRunAction(input));
});

test("literal input values never enter the step log", () => {
	const action = parseRunAction({ type: "fill", target, value: "secret-value", source_step: "login-password" });
	const record = recordedAction(action);
	assert.equal(record.value, "[redacted]");
	assert.equal(record.source_step, "login-password");
	assert.equal(action.value, "secret-value", "execution still has the input in memory");
	assert.equal(JSON.stringify(record).includes("secret-value"), false);
});

test("result status cannot report a pass without assertions or hide failures/interruption", () => {
	assert.equal(runStatus("submitted", true, 0, 0), "completed");
	assert.equal(runStatus("submitted", true, 0, 1), "passed");
	assert.equal(runStatus("submitted", true, 1, 5), "failed");
	assert.equal(runStatus("submitted", false, 0, 5), "cancelled");
	assert.equal(runStatus("cancelled", false, 0, 5), "cancelled");
	assert.equal(runStatus("aborted", false, 1, 5), "cancelled");
	assert.equal(runStatus("timeout", false, 0, 5), "timeout");
	assert.equal(runStatus("aborted", false, 1, 0, true), "timeout");
});
