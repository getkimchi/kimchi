import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"
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
 *   process.env?.KIMCHI_FOO                 (optional chaining)
 *   process.env["KIMCHI_FOO"]
 *   env.KIMCHI_FOO / env["KIMCHI_FOO"]      (env = process.env parameter alias,
 *                                            e.g. uploadSkipReason(mode, env))
 *   vi.stubEnv("KIMCHI_FOO", ...)
 *   readE2eSeam("KIMCHI_FOO")               (src/** e2e seam helper)
 *   parseEnvInt("KIMCHI_FOO", ...)          (numeric env helper)
 *   const { KIMCHI_FOO, KIMCHI_BAR } = process.env
 *                                         (destructuring — also let/var; the
 *                                          braced list lands in capture group 2
 *                                          and is split into individual keys;
 *                                          `process?.env` is not supported)
 *
 * Known blind spots (ACCEPTED gaps — the scan deliberately does not see these):
 *   (a) Dynamically composed names: `KIMCHI_OAUTH_CLIENT_ID_${regionTag}` in
 *       oauth-config.ts is a template, so neither regex sees a complete name.
 *       A new region needs a hand-added TEST_SUITE_ENV_VARS entry.
 *   (b) Per-session dynamic keys: `KIMCHI_PERMISSIONS_<sessionId>` read/written
 *       in src/extensions/permissions/mode-controller.ts — unregistrable by
 *       design (the name exists only at runtime).
 *   (c) LITERAL_EXEMPT_FILES disables the literal backstop within those files,
 *       so a new constant-indirection env read there would escape the scan —
 *       keep the exemption list narrow.
 *
 * The FULL identifier is captured (not only its SCREAMING prefix part), so a
 * truncated match cannot silently alias a registered var — e.g. a typo like
 * `process.env.KIMCHI_TEST_HARNESSs` previously extracted KIMCHI_TEST_HARNESS
 * and passed by accident. Mixed-case prefixed names are reported as typos.
 *
 * Vars referenced only via a named constant (e.g. REGION_ENV,
 * INFRA_BREAKER_THRESHOLD_ENV) are covered separately: LITERAL_RE below
 * matches any string literal that IS a prefixed variable name, which catches
 * constant declarations regardless of how the constant is dereferenced.
 */
const REFERENCE_RE =
	/(?:process\.env\s*\??\s*(?:\.|\[\s*["'])|\benv\s*\??\s*(?:\.|\[\s*["'])|(?:vi\.)?stubEnv\(\s*["']|readE2eSeam\(\s*["']|parseEnvInt\(\s*["'])([A-Za-z_][A-Za-z0-9_]*)|\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\.env/g

/**
 * String literals holding exactly a variable name — catches the named-constant
 * indirection (`export const FOO_ENV = "KIMCHI_FOO"`) that REFERENCE_RE cannot
 * see. The ENFORCED_PREFIX filter makes unrelated literals inert; requiring
 * the literal to be exactly the identifier (quote on both sides) keeps
 * template literals like `KIMCHI_OAUTH_CLIENT_ID_${regionTag}` and prose
 * strings from matching. Names ending in "_" are prefix compositions
 * (e.g. KIMCHI_RESOURCE_POLICY_PREFIX), not complete variable names.
 */
const LITERAL_RE = /["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g

/**
 * Files whose prefixed string literals are NOT environment variables:
 * proto enum wire names (api/org-settings*) and a log-message prefix
 * (infrastructure-error*, cli-infrastructure-exit.test.ts). REFERENCE_RE
 * still applies to these files — only the literal scan is exempt.
 */
const LITERAL_EXEMPT_FILES = new Set([
	"api/org-settings.ts",
	"api/org-settings.test.ts",
	"infrastructure-error.ts",
	"infrastructure-error.test.ts",
	"cli-infrastructure-exit.test.ts",
	"org-policy.test.ts", // KIMCHI_REDACTION_STATE_* proto enum wire names
	"extensions/pii-redaction/policy.ts",
	"extensions/pii-redaction/policy.test.ts",
	"extensions/pii-redaction/redactor.test.ts",
])

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
		const rel = relative(SRC, file).split(sep).join("/")
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
	const addName = (name: string, file: string) => {
		if (!ENFORCED_PREFIX.test(name) || name.endsWith("_")) return
		const files = referenced.get(name) ?? []
		if (!files.includes(file)) files.push(file)
		referenced.set(name, files)
	}
	for (const [file, source] of sources) {
		// Strip comments (as the stale check does) so prose like
		// "// set process.env.KIMCHI_FOO to..." cannot trigger a spurious
		// "unregistered" failure.
		const code = stripComments(source)
		const matches = [...code.matchAll(REFERENCE_RE)]
		if (!LITERAL_EXEMPT_FILES.has(file)) matches.push(...code.matchAll(LITERAL_RE))
		for (const match of matches) {
			if (match[1]) {
				addName(match[1], file)
				continue
			}
			// Destructuring alternative (capture group 2): the whole braced list —
			// capture each key individually. Handles renames (`A: alias`) and
			// defaults (`A = "x"`); rest elements (`...env`) are skipped by the
			// identifier check.
			for (const part of (match[2] ?? "").split(",")) {
				const key = part.split(/[:=]/)[0].trim()
				if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) addName(key, file)
			}
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
		expect(
			missing,
			`unregistered environment variables — add them to src/env-vars.ts. Prefixed names that are NOT env vars (proto enum wire names, log prefixes) can be exempted from the literal scan via LITERAL_EXEMPT_FILES:\n${missing.join("\n")}`,
		).toEqual([])
		expect(typos, `prefixed names that are not SCREAMING_SNAKE_CASE — typos?:\n${typos.join("\n")}`).toEqual([])
	})

	it("detects prefixed names destructured from process.env", () => {
		const sources = new Map([
			[
				"fake-scan-target.ts",
				"const { KIMCHI_FAKE_SCAN_VAR, KIMCHI_FAKE_RENAMED: alias, KIMCHI_FAKE_DEFAULT = 'x', OTHER, ...rest } = process.env",
			],
		])
		const referenced = collectReferencedEnvVars(sources)
		expect([...referenced.keys()].sort()).toEqual([
			"KIMCHI_FAKE_DEFAULT",
			"KIMCHI_FAKE_RENAMED",
			"KIMCHI_FAKE_SCAN_VAR",
		])
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
