import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Replicates pi's resolveToCwd (pi-coding-agent path-utils: unicode-space
// normalization, @-prefix strip, ~ expansion, file:// URLs) because the
// write tool resolves args.path with it and pi does not export the
// helper. Shared by the artifact sniffer and the per-turn diff reader.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g
export function resolveToolPath(input: string, cwd: string): string {
	let p = input.replace(UNICODE_SPACES, " ")
	if (p.startsWith("@")) p = p.slice(1)
	if (p === "~") {
		p = homedir()
	} else if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) {
		p = join(homedir(), p.slice(2))
	}
	if (/^file:\/\//.test(p)) p = fileURLToPath(p)
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p)
}
