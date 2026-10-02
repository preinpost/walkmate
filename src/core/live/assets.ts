import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * Read a file from a dependency's dist folder. The packages only export their entry points, so
 * resolve that and look next to it; this works however npm hoisted the dependency.
 */
export function distFile(pkg: string, file: string): string {
	return readFileSync(join(dirname(require.resolve(pkg)), file), "utf8");
}
