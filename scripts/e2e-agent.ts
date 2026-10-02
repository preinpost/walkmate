// Runs a real coding agent against the MCP server and plays the reviewer.
//   npm run build && node scripts/e2e-agent.ts claude    (or: codex, pi)
// The agent opens a document review; this script submits an answer after 25s, longer than one
// review_wait, so the agent has to keep calling it. Then it checks the agent saw the answer.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const agent = process.argv[2] ?? "claude";
const home = mkdtempSync(join(tmpdir(), "prr-agent-"));
const work = mkdtempSync(join(tmpdir(), "prr-agent-work-"));
const cli = new URL("../dist/mcp/cli.js", import.meta.url).pathname;
const serverEnv = { REVIEW_RECORDER_HOME: home, REVIEW_RECORDER_OPEN: "0", REVIEW_RECORDER_TRANSCRIBER: "none", REVIEW_RECORDER_WAIT_SEC: "10" };

// E2E_PROMPT replaces the request, e.g. "/review-recorder:review_changes" to test the MCP prompt.
const custom = process.env.E2E_PROMPT;
const prompt =
	custom ??
	"review-recorder MCP 도구로 문서 리뷰를 열어줘. 제목은 '만료 정책', 섹션은 하나: id q1, kind question, title '토큰 만료 시간?', options ['15분', '1시간']. " +
	"그다음 review_wait로 피드백이 올 때까지 기다려. 피드백을 받으면 사용자가 고른 답과 코멘트를 한 줄로만 알려줘. 다른 작업은 하지 마.";

// pi uses the server registered in ~/.pi/agent/mcp.json, which inherits this process's environment:
//   pi mcp add review-recorder --exposure direct -- node <repo>/dist/mcp/cli.js mcp
const [cmd, args] =
	agent === "pi"
		? ["pi", ["--print", "--no-session", prompt]]
		: agent === "codex"
		? [
				"codex",
				[
					"exec",
					"--skip-git-repo-check",
					"-c", `mcp_servers.review-recorder.command="node"`,
					"-c", `mcp_servers.review-recorder.args=["${cli}","mcp"]`,
					"-c", `mcp_servers.review-recorder.env=${toToml(serverEnv)}`,
					"-c", `mcp_servers.review-recorder.default_tools_approval_mode="approve"`,
					prompt,
				],
			]
		: [
				"claude",
				[
					"-p", prompt,
					"--strict-mcp-config",
					"--mcp-config", JSON.stringify({ mcpServers: { "review-recorder": { command: "node", args: [cli, "mcp"], env: serverEnv } } }),
					"--allowedTools", "mcp__review-recorder__review_start,mcp__review-recorder__review_wait",
				],
			];

const started = Date.now();
const child = spawn(cmd, args as string[], { cwd: work, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...serverEnv } });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

// Play the reviewer: find the page, wait past one review_wait, submit.
const reviews = join(home, "reviews", "mcp");
let url: string | undefined;
while (!url && Date.now() - started < 180_000 && child.exitCode === null) {
	await new Promise((r) => setTimeout(r, 500));
	if (!existsSync(reviews)) continue;
	for (const d of readdirSync(reviews)) {
		const f = join(reviews, d, "url.txt");
		if (existsSync(f)) url = readFileSync(f, "utf8").trim();
	}
}
if (!url) {
	child.kill();
	console.log(out);
	throw new Error("the agent never opened a review");
}
console.log(`review opened after ${((Date.now() - started) / 1000).toFixed(0)}s: ${url}`);
await new Promise((r) => setTimeout(r, custom ? 3_000 : 25_000));
const payload = { events: [], comments: { q1: "모바일은 더 길게" }, answers: { q1: "1시간" }, general: "", duration: 25 };
const res = await fetch(`${url}/submit`, { method: "POST", body: JSON.stringify(payload) });
console.log(`submitted: ${res.status}`);

await new Promise((r) => child.once("exit", r));
console.log(`\n--- ${agent} output (exit ${child.exitCode}, ${((Date.now() - started) / 1000).toFixed(0)}s) ---\n${out.trim().split("\n").slice(-25).join("\n")}`);
const ok = custom ? res.status === 200 : out.includes("1시간") && out.includes("모바일");
console.log(`\n${ok ? "PASS" : "FAIL"}: agent ${ok ? "reported" : "did not report"} the answer and comment`);
process.exitCode = ok ? 0 : 1;

function toToml(o: Record<string, string>): string {
	return `{${Object.entries(o).map(([k, v]) => `${k}="${v}"`).join(",")}}`;
}
