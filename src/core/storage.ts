import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Project-local artifacts; shared Chrome profiles and voice models stay in config.DATA_DIR. */
export function projectPaths(cwd: string) {
	const root = join(resolve(cwd), ".walkmate");
	return { root, reviews: join(root, "reviews"), runs: join(root, "runs"), skills: join(root, "skills"), notes: join(root, "notes") };
}

export function createReviewDir(cwd: string, group: string): Promise<string> {
	return createArtifactDir(cwd, "reviews", group);
}

export function createRunDir(cwd: string): Promise<string> {
	return createArtifactDir(cwd, "runs");
}

async function createArtifactDir(cwd: string, kind: "reviews" | "runs", group?: string): Promise<string> {
	const paths = projectPaths(cwd);
	await mkdir(paths.root, { recursive: true, mode: 0o700 });
	// Keep recordings (including sensitive request bodies) out of Git without editing the project's ignore rules.
	await writeFile(join(paths.root, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }).catch((err: NodeJS.ErrnoException) => {
		if (err.code !== "EEXIST") throw err;
	});
	const parent = group === undefined ? paths[kind] : join(paths[kind], group.replace(/[^\w-]/g, "_") || "review");
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	return mkdtemp(join(parent, `${stamp}-`));
}
