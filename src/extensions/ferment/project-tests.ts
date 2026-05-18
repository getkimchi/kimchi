/**
 * Project test/lint/typecheck *validation*.
 *
 * Originally this module ran the project's own checks at complete_ferment_phase time.
 * That had a fatal flaw: when ferment runs against its own repo (kimchi-dev),
 * `npm test` shells back into vitest, which re-imports phases.ts, which calls
 * `runProjectChecks` again — recursive vitest spawning, fork-bomb territory.
 *
 * The deterministic-gate idea is still good, but executing the suite is the
 * wrong scope here. Instead we now *validate the command*:
 *
 *   - Discover the same way (package.json scripts; pytest/cargo/go fallbacks).
 *   - For each discovered command, confirm the command is sensible —
 *     resolves to a known runner, the runner binary exists, etc.
 *   - Never spawn the test suite itself.
 *
 * The result is consumed by phases.ts as ground truth for "you claim a test
 * suite exists; we can see it's wired up correctly" — not "the tests pass".
 * Actually running the suite is the agent's job (or CI's), not the gate's.
 *
 * Discovery (first hit wins, in priority order):
 *   1. package.json scripts: test, lint, typecheck
 *   2. Python: pytest if pytest.ini / pyproject.toml [tool.pytest] / tests/
 *   3. Rust: cargo test if Cargo.toml
 *   4. Go: go test ./... if go.mod
 *   5. None — return empty result, signal "no project checks discovered"
 *
 * Field shape is preserved so phases.ts + review-evidence.ts don't need to
 * change: `exitCode` is 0 when the command validates, non-zero when not;
 * `timedOut` is always false (no execution → no timeout); stdout/stderr
 * carry the human-readable validation note.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export type ProjectCheckKind = "test" | "lint" | "typecheck"

export interface ProjectCheck {
	kind: ProjectCheckKind
	command: string
	exitCode: number
	durationMs: number
	stdout: string
	stderr: string
	timedOut: boolean
}

export interface ProjectCheckResult {
	/** Path that was probed. */
	cwd: string
	/** True when at least one check was discovered AND failed validation. */
	anyFailed: boolean
	/** True when no project checks were discovered at all. */
	discovered: boolean
	checks: ProjectCheck[]
}

const MAX_OUTPUT_BYTES = 4_096
const PROBE_TIMEOUT_MS = 5_000

interface DiscoveredCommand {
	kind: ProjectCheckKind
	command: string
	/** Validator that decides whether `command` is sensible without running it. */
	validate: (cwd: string) => ValidationOutcome
}

interface ValidationOutcome {
	ok: boolean
	note: string
}

function tryReadPackageJson(cwd: string): Record<string, unknown> | undefined {
	const path = resolve(cwd, "package.json")
	if (!existsSync(path)) return undefined
	try {
		return JSON.parse(readFileSync(path, "utf-8"))
	} catch {
		return undefined
	}
}

/** Known JS test/lint/typecheck runners we can recognize by name. The list is
 *  intentionally narrow: validation is "this looks like a real suite", not
 *  "we exhaustively support every tool". */
const KNOWN_RUNNERS: Record<ProjectCheckKind, string[]> = {
	test: ["vitest", "jest", "mocha", "ava", "tap", "node --test", "playwright test", "bun test"],
	lint: ["biome", "eslint", "tsc", "oxlint"],
	typecheck: ["tsc", "tsgo", "vue-tsc", "svelte-check"],
}

function nodeModulesBinExists(cwd: string, bin: string): boolean {
	return existsSync(resolve(cwd, "node_modules", ".bin", bin))
}

function validateNodeScript(kind: ProjectCheckKind, scriptBody: string, cwd: string): ValidationOutcome {
	const trimmed = scriptBody.trim()
	if (!trimmed) return { ok: false, note: `empty ${kind} script in package.json` }
	const lower = trimmed.toLowerCase()
	const matched = KNOWN_RUNNERS[kind].find((r) => lower.includes(r))
	if (!matched) {
		return {
			ok: false,
			note: `${kind} script does not reference a known runner (${KNOWN_RUNNERS[kind].join(", ")}); got: ${trimmed.slice(0, 120)}`,
		}
	}
	// Resolve the runner binary — first token, ignoring "npx"/"pnpm exec" prefix.
	// We only check the local node_modules/.bin; that's enough signal for "the
	// runner is installed for this project".
	const head = matched.split(" ")[0]
	if (head === "node") {
		return { ok: true, note: `${kind} uses 'node --test' (builtin)` }
	}
	if (nodeModulesBinExists(cwd, head)) {
		return { ok: true, note: `${kind} runner '${head}' resolves under node_modules/.bin` }
	}
	return {
		ok: false,
		note: `${kind} script references '${head}' but node_modules/.bin/${head} is missing — run install first`,
	}
}

function discoverNodeChecks(cwd: string): DiscoveredCommand[] {
	const pkg = tryReadPackageJson(cwd)
	if (!pkg) return []
	const scripts = pkg.scripts && typeof pkg.scripts === "object" ? (pkg.scripts as Record<string, unknown>) : {}
	const out: DiscoveredCommand[] = []
	const candidates: Array<{ kind: ProjectCheckKind; scriptName: string; display: string }> = [
		{ kind: "test", scriptName: "test", display: "npm test" },
		{ kind: "lint", scriptName: "lint", display: "npm run lint" },
		{ kind: "typecheck", scriptName: "typecheck", display: "npm run typecheck" },
	]
	for (const { kind, scriptName, display } of candidates) {
		const body = scripts[scriptName]
		if (typeof body !== "string") continue
		out.push({
			kind,
			command: display,
			validate: () => validateNodeScript(kind, body, cwd),
		})
	}
	return out
}

function which(bin: string): boolean {
	const probe = spawnSync("which", [bin], { encoding: "utf-8", timeout: PROBE_TIMEOUT_MS })
	return probe.status === 0 && (probe.stdout?.trim().length ?? 0) > 0
}

function discoverPythonChecks(cwd: string): DiscoveredCommand[] {
	const hasPytestIni = existsSync(resolve(cwd, "pytest.ini")) || existsSync(resolve(cwd, "setup.cfg"))
	const hasTestsDir = existsSync(resolve(cwd, "tests"))
	const hasPyProject = existsSync(resolve(cwd, "pyproject.toml"))
	if (!(hasPytestIni || (hasTestsDir && hasPyProject))) return []
	return [
		{
			kind: "test",
			command: "pytest -q",
			validate: () =>
				which("pytest")
					? { ok: true, note: "pytest resolves on PATH" }
					: { ok: false, note: "pytest not found on PATH — install before running" },
		},
	]
}

function discoverRustChecks(cwd: string): DiscoveredCommand[] {
	if (!existsSync(resolve(cwd, "Cargo.toml"))) return []
	return [
		{
			kind: "test",
			command: "cargo test --quiet",
			validate: () =>
				which("cargo") ? { ok: true, note: "cargo resolves on PATH" } : { ok: false, note: "cargo not found on PATH" },
		},
	]
}

function discoverGoChecks(cwd: string): DiscoveredCommand[] {
	if (!existsSync(resolve(cwd, "go.mod"))) return []
	return [
		{
			kind: "test",
			command: "go test ./...",
			validate: () =>
				which("go") ? { ok: true, note: "go resolves on PATH" } : { ok: false, note: "go not found on PATH" },
		},
	]
}

/** Return the list of project-level checks to consider for the given cwd, in
 *  priority order. Empty array = nothing discovered. */
export function discoverProjectChecks(cwd: string): DiscoveredCommand[] {
	const all = [
		...discoverNodeChecks(cwd),
		...discoverPythonChecks(cwd),
		...discoverRustChecks(cwd),
		...discoverGoChecks(cwd),
	]
	const seen = new Set<string>()
	return all.filter((c) => (seen.has(c.command) ? false : seen.add(c.command)))
}

function validateOne(cwd: string, cmd: DiscoveredCommand): ProjectCheck {
	const started = Date.now()
	const outcome = cmd.validate(cwd)
	const durationMs = Date.now() - started
	const note = outcome.note.slice(0, MAX_OUTPUT_BYTES)
	return {
		kind: cmd.kind,
		command: cmd.command,
		exitCode: outcome.ok ? 0 : 1,
		durationMs,
		stdout: outcome.ok ? note : "",
		stderr: outcome.ok ? "" : note,
		timedOut: false,
	}
}

/** Discover project tests/lint/typecheck at `cwd` and validate each command
 *  *without running it*. Returns a result describing what was discovered + what
 *  validated. Pure I/O — fast, safe for the post-phase path. */
export function runProjectChecks(cwd: string): ProjectCheckResult {
	const discovered = discoverProjectChecks(cwd)
	if (discovered.length === 0) {
		return { cwd, anyFailed: false, discovered: false, checks: [] }
	}
	const checks = discovered.map((d) => validateOne(cwd, d))
	return {
		cwd,
		anyFailed: checks.some((c) => c.exitCode !== 0),
		discovered: true,
		checks,
	}
}

/** Render the result as a one-line summary suitable for tool responses or
 *  judge prompts. */
export function summarizeProjectChecks(result: ProjectCheckResult): string {
	if (!result.discovered) return "Project checks: (none discovered)"
	if (result.checks.length === 0) return "Project checks: (none ran)"
	const parts = result.checks.map((c) => `${c.kind}=${c.exitCode === 0 ? "valid" : "invalid"}`)
	return `Project checks (validated, not executed): ${parts.join(" · ")}`
}
