import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function config(overrides: Record<string, string> = {}) {
	const env = { ...process.env };
	for (const name of Object.keys(env)) {
		if (name.startsWith("WALKMATE_")) delete env[name];
	}
	const module = new URL("../src/core/config.ts", import.meta.url).href;
	const script = `
		import { DATA_DIR, MODELS_DIR, CHROME_PROFILE, env } from ${JSON.stringify(module)};
		console.log(JSON.stringify({ DATA_DIR, MODELS_DIR, CHROME_PROFILE, lang: env('LANG') }));
	`;
	return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		env: { ...env, ...overrides }, encoding: "utf8",
	}));
}

test("default data, models and persistent Chrome profile use the Walkmate directory", () => {
	const home = join(homedir(), ".walkmate");
	assert.deepEqual(config(), {
		DATA_DIR: home,
		MODELS_DIR: join(home, "models"),
		CHROME_PROFILE: join(home, "chrome-profile"),
	});
});

test("WALKMATE_HOME and WALKMATE_LANG configure the data paths and environment lookup", () => {
	const home = join(tmpdir(), "walkmate-config");
	assert.deepEqual(config({ WALKMATE_HOME: home, WALKMATE_LANG: "en" }), {
		DATA_DIR: home,
		MODELS_DIR: join(home, "models"),
		CHROME_PROFILE: join(home, "chrome-profile"),
		lang: "en",
	});
});

test("WALKMATE_CHROME_PROFILE overrides the persistent browser profile path", () => {
	const profile = join(tmpdir(), "walkmate-custom-profile");
	assert.equal(config({ WALKMATE_CHROME_PROFILE: profile }).CHROME_PROFILE, profile);
});

test("package manifests expose only the walkmate CLI", () => {
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
	assert.equal(pkg.name, "walkmate");
	assert.deepEqual(pkg.bin, { walkmate: "./dist/mcp/cli.js" });
	assert.equal(lock.name, "walkmate");
	assert.equal(lock.packages[""].name, "walkmate");
	assert.deepEqual(lock.packages[""].bin, { walkmate: "dist/mcp/cli.js" });
});
