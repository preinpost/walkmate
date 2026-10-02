import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "*.spec.ts",
	outputDir: process.env.WALKMATE_PW_OUT ?? "test-results",
	reporter: [["json", { outputFile: process.env.WALKMATE_PW_REPORT ?? "report.json" }]],
	workers: 1,
	use: { channel: "chrome", headless: true },
});
