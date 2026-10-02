import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Not import.meta: Playwright loads a linked walkmate (npm link, file:) as transpiled CommonJS.
const require = createRequire(ownFile());

/**
 * Read a file from a dependency's dist folder. The packages only export their entry points, so
 * resolve that and look next to it; this works however npm hoisted the dependency.
 */
export function distFile(pkg: string, file: string): string {
	return readFileSync(join(dirname(require.resolve(pkg)), file), "utf8");
}

/** This module's path from the V8 call site, which works in both ES modules and CommonJS. */
function ownFile(): string {
	const prepare = Error.prepareStackTrace;
	try {
		Error.prepareStackTrace = (_err, frames) => frames;
		const name = (new Error().stack as unknown as NodeJS.CallSite[])[0].getFileName()!;
		return name.startsWith("file:") ? fileURLToPath(name) : name;
	} finally {
		Error.prepareStackTrace = prepare;
	}
}
