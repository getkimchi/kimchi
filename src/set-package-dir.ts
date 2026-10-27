import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
process.env.PI_PACKAGE_DIR = resolve(__dirname, "..")

// Dev-only warning (never blocks): older Buns have known fs.watch bugs the
// declared engine excludes. Stderr, because dev-overlay forwards modes whose
// stdout belongs to the caller. Structural typing avoids @types/bun here.
try {
	const bun = (
		globalThis as { Bun?: { version: string; semver: { satisfies(version: string, range: string): boolean } } }
	).Bun
	const engines = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8")).engines as
		| { bun?: string }
		| undefined
	if (bun && engines?.bun && !bun.semver.satisfies(bun.version, engines.bun)) {
		console.error(`warning: Bun ${bun.version} is below engines.bun "${engines.bun}" — run \`bun upgrade\``)
	}
} catch {
	// Best-effort warning only.
}
