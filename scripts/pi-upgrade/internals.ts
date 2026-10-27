import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type RunConfig, readJson, writeJson } from "./config.ts"
import { pkgDir } from "./fetch.ts"
import { HOOKED_METHODS, type HookedMethod, OVERWRITTEN_FILES, type OverwrittenFile } from "./hooks.ts"
import type { SettleResult } from "./settle.ts"

export type InternalStatus = "identical" | "changed" | "missing"

export interface InternalsResult {
	methods: Array<HookedMethod & { status: InternalStatus }>
	overwrites: Array<OverwrittenFile & { status: InternalStatus }>
}

const escape = (s: string) => s.replace(/[$]/g, "\\$")

/** Index just past the token starting at `i` if it is a string, comment or regex literal; else -1. */
function skipLiteral(src: string, i: number): number {
	const c = src[i]
	if (c === '"' || c === "'" || c === "`") {
		let j = i + 1
		while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1
		return j + 1
	}
	if (c === "/" && src[i + 1] === "/") {
		const end = src.indexOf("\n", i)
		return end < 0 ? src.length : end
	}
	if (c === "/" && src[i + 1] === "*") {
		const end = src.indexOf("*/", i + 2)
		return end < 0 ? src.length : end + 2
	}
	if (c === "/") {
		// A regex literal can only follow an operator or opening punctuation, never a value.
		const prev = src.slice(0, i).trimEnd().slice(-1)
		if (prev === "" || "(,=:[!&|?{};".includes(prev)) {
			let j = i + 1
			let inClass = false
			while (j < src.length && (inClass || src[j] !== "/") && src[j] !== "\n") {
				if (src[j] === "\\") j++
				else if (src[j] === "[") inClass = true
				else if (src[j] === "]") inClass = false
				j++
			}
			return j + 1
		}
	}
	return -1
}

/** Index just past the bracket matching the one at `open`. */
function matchBracket(src: string, open: number): number {
	const [o, c] = src[open] === "(" ? ["(", ")"] : ["{", "}"]
	let depth = 0
	let i = open
	while (i < src.length) {
		const skipped = skipLiteral(src, i)
		if (skipped >= 0) {
			i = skipped
			continue
		}
		if (src[i] === o) depth++
		else if (src[i] === c && --depth === 0) return i + 1
		i++
	}
	return src.length
}

/**
 * Source of a class method / function named `name` (signature through closing brace), or of the
 * first `this.name = …` / `name = …` line for a field. Heuristic, built for bundled npm dist.
 */
export function extractMember(src: string, name: string): string | null {
	const method = new RegExp(
		`^[ \\t]*((?:static\\s+)?(?:async\\s+)?(?:function\\s*)?\\*?\\s*${escape(name)}\\s*)\\(`,
		"m",
	).exec(src)
	if (method) {
		const start = method.index + method[0].length - method[1].length - 1
		const paramsEnd = matchBracket(src, method.index + method[0].length - 1)
		const bodyOpen = src.indexOf("{", paramsEnd)
		if (bodyOpen >= 0 && /^\s*$/.test(src.slice(paramsEnd, bodyOpen))) {
			return src.slice(start, matchBracket(src, bodyOpen))
		}
	}
	const field = new RegExp(`^[ \\t]*((?:this\\.)?${escape(name)}\\s*=[^=].*)$`, "m").exec(src)
	return field ? field[1].trim() : null
}

function readIf(path: string): string | null {
	return existsSync(path) ? readFileSync(path, "utf8") : null
}

export function compareInternals(input: {
	methods: HookedMethod[]
	overwrites: OverwrittenFile[]
	baseDir: (pkg: string) => string
	targetDir: (pkg: string) => string
}): InternalsResult {
	const status = (base: string | null, target: string | null): InternalStatus =>
		target === null ? "missing" : base === target ? "identical" : "changed"
	return {
		methods: input.methods.map((m) => {
			const base = readIf(join(input.baseDir(m.pkg), m.distFile))
			const target = readIf(join(input.targetDir(m.pkg), m.distFile))
			return {
				...m,
				status: status(base && extractMember(base, m.name), target && extractMember(target, m.name)),
			}
		}),
		overwrites: input.overwrites.map((f) => ({
			...f,
			status: status(readIf(join(input.baseDir(f.pkg), f.distFile)), readIf(join(input.targetDir(f.pkg), f.distFile))),
		})),
	}
}

export async function runInternals(cfg: RunConfig): Promise<InternalsResult> {
	const { baseline, target } = readJson<SettleResult>(cfg, "settle")
	if (!target) throw new Error("no target version: nothing to compare")
	const result = compareInternals({
		methods: HOOKED_METHODS,
		overwrites: OVERWRITTEN_FILES,
		baseDir: (pkg) => pkgDir(cfg, pkg, baseline),
		targetDir: (pkg) => pkgDir(cfg, pkg, target),
	})
	writeJson(cfg, "internals", result)
	return result
}
