import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * entry.ts must set PI_PACKAGE_DIR before ANY pi-mono code loads: pi's
 * config.js snapshots package.json (branding, CONFIG_DIR_NAME, version) at
 * module load, so if the static import graph of entry.ts reaches
 * @earendil-works/pi-coding-agent, every compiled binary run without an
 * explicit PI_PACKAGE_DIR comes up unbranded (π window title, `.pi` project
 * config dir instead of `.config/kimchi/harness`). This happened once via
 * entry.ts → http/proxy.ts → stream-idle-timeout.ts → settings-watcher.ts;
 * this test walks the static graph so the next such chain fails CI instead of
 * shipping.
 */

const SRC = resolve(__dirname)

/** Static (hoisted) import/export-from specifiers; `import type` is erased and ignored. */
function staticImportSpecifiers(source: string): string[] {
	const noComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
	const specs: string[] = []
	const re = /^\s*(import|export)\s+([\s\S]*?)from\s+["']([^"']+)["']/gm
	for (const match of noComments.matchAll(re)) {
		if (/^type\s/.test(match[2].trim())) continue
		specs.push(match[3])
	}
	// Bare side-effect imports: import "./x.js"
	for (const match of noComments.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) {
		specs.push(match[1])
	}
	return specs
}

function resolveRelative(fromFile: string, spec: string): string | undefined {
	const base = resolve(dirname(fromFile), spec)
	for (const candidate of [base.replace(/\.js$/, ".ts"), base, resolve(base, "index.ts")]) {
		if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate
	}
	return undefined
}

function findPiChains(entryFile: string): string[] {
	const chains: string[] = []
	const visited = new Set<string>()
	const walk = (file: string, trail: string[]) => {
		if (visited.has(file)) return
		visited.add(file)
		const source = readFileSync(file, "utf-8")
		for (const spec of staticImportSpecifiers(source)) {
			const trailHere = [...trail, file.replace(`${SRC}/`, "")]
			if (spec.startsWith("@earendil-works/")) {
				chains.push(`${trailHere.join(" → ")} → ${spec}`)
				continue
			}
			if (!spec.startsWith(".")) continue
			const resolved = resolveRelative(file, spec)
			if (resolved) walk(resolved, trailHere)
		}
	}
	walk(entryFile, [])
	return chains
}

describe("entry.ts static import graph", () => {
	it("does not reach @earendil-works before PI_PACKAGE_DIR is set", () => {
		const chains = findPiChains(resolve(SRC, "entry.ts"))
		expect(chains, `pi-mono is statically reachable from entry.ts:\n${chains.join("\n")}`).toEqual([])
	})
})
