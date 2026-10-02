import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface DiffLine {
	kind: "+" | "-" | " ";
	text: string;
	oldNo?: number;
	newNo?: number;
}

export interface Hunk {
	header: string;
	newStart: number;
	newEnd: number;
	lines: DiffLine[];
}

export interface DiffFile {
	path: string;
	hunks: Hunk[];
	binary?: boolean;
	truncated?: boolean;
}

const MAX_LINES_PER_FILE = 800;
/** git's well-known empty tree, used as the base before the first commit. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function git(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
			const code = err ? (typeof err.code === "number" ? err.code : 128) : 0;
			resolve({ code, stdout, stderr });
		});
	});
}

/** Collect a diff for the given paths (or every uncommitted change) and split it into files and hunks. */
export async function collectDiff(cwd: string, paths: string[] | undefined, base = "HEAD"): Promise<DiffFile[]> {
	const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0) throw new Error(`not a git repository: ${cwd}`);
	const root = top.stdout.trim();
	if (base === "HEAD" && (await git(root, ["rev-parse", "--verify", "-q", "HEAD"])).code !== 0) base = EMPTY_TREE;

	// Paths are repo-relative, so run everything from the repo root.
	let untracked: string[];
	let tracked: string[] | undefined;
	if (paths?.length) {
		const others = await git(root, ["ls-files", "--others", "--exclude-standard", "--", ...paths]);
		untracked = others.stdout.split("\n").filter(Boolean);
		tracked = paths.filter((p) => !untracked.includes(p));
	} else {
		const others = await git(root, ["ls-files", "--others", "--exclude-standard"]);
		untracked = others.stdout.split("\n").filter(Boolean);
	}

	let text = "";
	if (!tracked || tracked.length) {
		const res = await git(root, ["diff", "--no-color", "--no-ext-diff", base, "--", ...(tracked ?? [])]);
		if (res.code !== 0) throw new Error(`git diff ${base} failed: ${res.stderr.trim()}`);
		text += res.stdout;
	}
	for (const p of untracked) {
		if (!existsSync(join(root, p))) continue;
		// --no-index exits 1 when the files differ, which is always the case here.
		const res = await git(root, ["diff", "--no-color", "--no-index", "--", "/dev/null", p]);
		text += res.stdout;
	}
	return parseUnifiedDiff(text);
}

export function parseUnifiedDiff(text: string): DiffFile[] {
	const files: DiffFile[] = [];
	let file: DiffFile | undefined;
	let hunk: Hunk | undefined;
	let oldNo = 0;
	let newNo = 0;
	let count = 0;

	for (const raw of text.split("\n")) {
		if (raw.startsWith("diff --git ")) {
			const m = /^diff --git a\/(.*) b\/(.*)$/.exec(raw);
			file = { path: m?.[2] ?? raw.slice(11), hunks: [] };
			files.push(file);
			hunk = undefined;
			count = 0;
			continue;
		}
		if (!file) continue;
		if (raw.startsWith("+++ ")) {
			if (raw !== "+++ /dev/null") file.path = raw.slice(4).replace(/^b\//, "");
			continue;
		}
		if (raw.startsWith("--- ") && !hunk) continue;
		if (raw.startsWith("Binary files ")) {
			file.binary = true;
			continue;
		}
		const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
		if (h) {
			oldNo = Number(h[1]);
			newNo = Number(h[3]);
			const len = h[4] === undefined ? 1 : Number(h[4]);
			hunk = { header: raw, newStart: newNo, newEnd: newNo + Math.max(len, 1) - 1, lines: [] };
			file.hunks.push(hunk);
			continue;
		}
		if (!hunk || raw.startsWith("\\")) continue;
		if (count >= MAX_LINES_PER_FILE) {
			file.truncated = true;
			continue;
		}
		const kind = raw[0];
		if (kind === "+") hunk.lines.push({ kind: "+", text: raw.slice(1), newNo: newNo++ });
		else if (kind === "-") hunk.lines.push({ kind: "-", text: raw.slice(1), oldNo: oldNo++ });
		else if (kind === " ") hunk.lines.push({ kind: " ", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
		else continue;
		count++;
	}
	return files;
}
