import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { ENV_VARS, IGNORED_ENV_VARS, TEST_SUITE_ENV_VARS } from "./env-vars.js"

/**
 * The env-var registry is hand-maintained (same model as `gh environment`),
 * but unlike gh we enforce it: this test scans src/** for environment
 * variable references and fails when any enforced-prefix variable is
 * used anywhere without an entry in src/env-vars.ts. Adding a new env var
 * therefore requires documenting it in the registry — which keeps
 * `kimchi env` complete by construction.
 */

const SRC = resolve(__dirname)

/** Enforced prefixes — generic vars (HOME, SHELL, COLORTERM, OLLAMA_HOST…) are out of scope. */
const ENFORCED_PREFIX = /^(KIMCHI_|PI_|CASTAI_)/

/**
 * Reference forms recognised in sources:
 *   process.env.KIMCHI_FOO
 *   process.env["KIMCHI_FOO"]
 *   vi.stubEnv("KIMCHI_FOO", ...)
 *
 * The FULL identifier is captured (not only its SCREAMING prefix part), so a
 * truncated match cannot silently alias a registered var — e.g. a typo like
 * `process.env.KIMCHI_TEST_HARNESSs` previously extracted KIMCHI_TEST_HARNESS
 * and passed by accident. Mixed-case prefixed names are reported as typos.
 *
 * Vars referenced only via a named constant (e.g. REGION_ENV) or set only in
 * object literals passed to child processes are not machine-detectable with
 * this pattern — keep their registry entries accurate by hand.
 */
const REFERENCE_RE = /(?:process\.env\s*(?:\.|\[\s*["'])|(?:vi\.)?stubEnv\(\s*["'])([A-Za-z_][A-Za-z0-9_]*)/g

/** A well-formed env var name is entirely SCREAMING_SNAKE_CASE. */
const SCREAMING = /^[A-Z][A-Z0-9_]+$/

function* listSourceFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) {
			yield* listSourceFiles(path)
		} else if (entry.name.endsWith(".ts")) {
			yield path
		}
	}
}

/** The registry itself and this test file (regex examples in comments) are not usage. */
const SCAN_SELF_FILES = new Set(["env-vars.ts", "env-vars.test.ts"])

function readAllSources(): Map<string, string> {
	const sources = new Map<string, string>()
	for (const file of listSourceFiles(SRC)) {
		const rel = file.replace(`${SRC}/`, "")
		if (SCAN_SELF_FILES.has(rel)) continue
		sources.set(rel, readFileSync(file, "utf-8"))
	}
	return sources
}

/**
 * Strip block comments and full-line // comments so that prose mentions of a
 * variable (docs, module headers) cannot keep a deleted variable "alive" for
 * the stale check. Inline trailing comments are kept — good enough for this
 * purpose and avoids a full tokenizer.
 */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*$/gm, "")
}

function collectReferencedEnvVars(sources: Map<string, string>): Map<string, string[]> {
	const referenced = new Map<string, string[]>()
	for (const [file, source] of sources) {
		for (const match of source.matchAll(REFERENCE_RE)) {
			const name = match[1]
			if (!ENFORCED_PREFIX.test(name)) continue
			const files = referenced.get(name) ?? []
			files.push(file)
			referenced.set(name, files)
		}
	}
	return referenced
}

/** Every name the scan test knows about: printed user vars + ignored internals + test-suite vars. */
function allRegisteredNames(): Set<string> {
	return new Set([...ENV_VARS.map((v) => v.name), ...IGNORED_ENV_VARS, ...TEST_SUITE_ENV_VARS])
}

describe("env var registry", () => {
	it("registers every KIMCHI_*/PI_*/CASTAI_* variable referenced in src", () => {
		const registered = allRegisteredNames()
		const missing: string[] = []
		const typos: string[] = []
		for (const [name, files] of collectReferencedEnvVars(readAllSources())) {
			if (!SCREAMING.test(name)) {
				// Prefixed but not SCREAMING (e.g. KIMCHI_TEST_HARNESSs) — almost
				// certainly a typo of a registered name; flag it explicitly.
				typos.push(`  ${name} — in ${files[0]}`)
				continue
			}
			if (!registered.has(name)) {
				missing.push(`  ${name} — referenced in ${files[0]}${files.length > 1 ? ` (+${files.length - 1} more)` : ""}`)
			}
		}
		expect(missing, `unregistered environment variables — add them to src/env-vars.ts:\n${missing.join("\n")}`).toEqual(
			[],
		)
		expect(typos, `prefixed names that are not SCREAMING_SNAKE_CASE — typos?:\n${typos.join("\n")}`).toEqual([])
	})

	it("flags registry entries for variables removed from business logic", () => {
		// Reverse direction of the scan above. For ENV_VARS and
		// IGNORED_ENV_VARS, ONLY non-test code counts as usage: constants
		// (KIMCHI_REGION via REGION_ENV) and child-process env keys
		// (KIMCHI_TOOL_INPUT_COMMAND) are genuine references, but a var that
		// survives solely in test files was removed from business logic and
		// must be dropped from the registry. Comments never count — a var
		// kept alive solely by prose is dead code. Matches word boundaries,
		// so KIMCHI_PROXY cannot false-match KIMCHI_PROXY_HELPER.
		const sources = readAllSources()
		const nonTestCode = [...sources.entries()]
			.filter(([file]) => !file.endsWith(".test.ts"))
			.map(([, source]) => stripComments(source))
		const allCode = [...sources.values()].map(stripComments)

		const isUsedIn = (codeCorpus: string[]) => (name: string) => {
			const wordBoundary = new RegExp(`\\b${name}\\b`)
			return codeCorpus.some((source) => wordBoundary.test(source))
		}

		const stale: string[] = []
		const usedInNonTestCode = isUsedIn(nonTestCode)
		for (const name of [...ENV_VARS.map((v) => v.name), ...IGNORED_ENV_VARS]) {
			if (!usedInNonTestCode(name)) stale.push(name)
		}
		expect(
			stale,
			`registry entries with no reference left in non-test src code (removed from business logic) — remove them from src/env-vars.ts:\n${stale.join("\n")}`,
		).toEqual([])

		// Test-suite-only vars: the test suite IS their consumer, so any code
		// reference (including .test.ts files) keeps them registered.
		const staleTestOnly = TEST_SUITE_ENV_VARS.filter((name) => !isUsedIn(allCode)(name))
		expect(
			staleTestOnly,
			`test-suite registry entries no longer referenced anywhere in src — remove from TEST_SUITE_ENV_VARS:\n${staleTestOnly.join("\n")}`,
		).toEqual([])
	})

	it("has unique, non-empty entries across all lists", () => {
		const names = new Set<string>()
		for (const def of ENV_VARS) {
			expect(names.has(def.name), `duplicate registry entry: ${def.name}`).toBe(false)
			names.add(def.name)
			expect(def.description.trim().length, `empty description for ${def.name}`).toBeGreaterThan(0)
		}
		for (const name of [...IGNORED_ENV_VARS, ...TEST_SUITE_ENV_VARS]) {
			expect(names.has(name), `duplicate registry entry: ${name}`).toBe(false)
			names.add(name)
		}
	})

	it("keeps the curated user-facing subset in the printed list", () => {
		const user = ENV_VARS.map((v) => v.name)
		for (const expected of [
			"KIMCHI_API_KEY",
			"KIMCHI_PERMISSIONS",
			"KIMCHI_TELEMETRY_ENABLED",
			"KIMCHI_TAGS",
			"KIMCHI_NO_UPDATE_CHECK",
		]) {
			expect(user).toContain(expected)
		}
	})
})
