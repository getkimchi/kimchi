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

function findChains(entryFile: string, isTarget: (spec: string) => boolean): string[] {
	const chains: string[] = []
	const visited = new Set<string>()
	const walk = (file: string, trail: string[]) => {
		if (visited.has(file)) return
		visited.add(file)
		const source = readFileSync(file, "utf-8")
		for (const spec of staticImportSpecifiers(source)) {
			const trailHere = [...trail, file.replace(`${SRC}/`, "")]
			if (isTarget(spec)) {
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

const isPiMono = (spec: string) => spec.startsWith("@earendil-works/")
// Modules whose evaluation freezes env-derived paths: config.ts (agent dir,
// config path) and config/settings.ts (settings base dir). env-root-init
// must precede every entry.ts import whose static graph reaches either.
const isKimchiConfig = (spec: string) =>
	spec === "./config.js" || spec === "../config.js" || spec === "./settings.js" || spec === "../settings.js"

describe("entry.ts static import graph", () => {
	it("does not reach @earendil-works before PI_PACKAGE_DIR is set", () => {
		const chains = findChains(resolve(SRC, "entry.ts"), isPiMono)
		expect(chains, `pi-mono is statically reachable from entry.ts:\n${chains.join("\n")}`).toEqual([])
	})

	it("resolves the harness env (env-root-init) before any relative import that freezes config paths", () => {
		// src/entry.ts → ssh-proxy.ts → config.ts freezes KIMCHI_CONFIG_PATH /
		// AGENT_CONFIG_DIR at module evaluation; env-root-init publishes
		// KIMCHI_ENV_ROOT as a side effect and must evaluate first. ESM
		// evaluates imports in listed order, so the invariant is: in entry.ts's
		// static import list, ./env-root-init.js appears before every import
		// whose transitive static graph reaches src/config.ts. (This tolerates
		// biome's organizeImports sorting as long as the order relation holds.)
		const source = readFileSync(resolve(SRC, "entry.ts"), "utf-8")
		const specs = staticImportSpecifiers(source)
		const initIndex = specs.indexOf("./env-root-init.js")
		expect(initIndex, "entry.ts must import ./env-root-init.js").toBeGreaterThanOrEqual(0)
		for (const [index, spec] of specs.entries()) {
			if (index >= initIndex || !spec.startsWith(".")) continue
			const resolved = resolveRelative(resolve(SRC, "entry.ts"), spec)
			if (!resolved) continue
			const chains = findChains(resolved, isKimchiConfig)
			expect(
				chains,
				`"${spec}" reaches config.ts and must be imported after ./env-root-init.js:\n${chains.join("\n")}`,
			).toEqual([])
		}

		// The init module itself must not reach config.ts (or pi-mono): it only
		// publishes env vars, and importing config there would be circular.
		const configChains = findChains(resolve(SRC, "env-root-init.ts"), isKimchiConfig)
		expect(configChains, `env-root-init reaches config.ts:\n${configChains.join("\n")}`).toEqual([])
		const piChains = findChains(resolve(SRC, "env-root-init.ts"), isPiMono)
		expect(piChains, `env-root-init reaches pi-mono:\n${piChains.join("\n")}`).toEqual([])
	})
})
