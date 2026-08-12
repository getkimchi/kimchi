import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createToolVisibility } from "./prompt-construction/tool-visibility.js"

/**
 * Benchmark profiles.
 *
 * The terminal-bench harness (`benchmark/terminal-bench-2` agent.py) sets
 * `KIMCHI_BENCHMARK_PROFILE` in the container environment to select a prompt /
 * tooling profile for the run. Profiles are off by default; an interactive
 * `kimchi` session is completely unaffected.
 *
 * `lean` — "bench-lean". Strips process-bookkeeping surface that headless
 * single-model benchmark runs pay for but get no value from:
 *   - todo tools (create_todos/update_todos/add_todo/mark_todo/clear_todos)
 *     are not registered (todos extension skipped),
 *   - the questionnaire tool is not registered,
 *   - set_phase is hidden (tags.keeps everything else),
 *   - the system prompt drops the Orchestration chapter, the user-orientation
 *     directive (headless runs have no user to orient), and the Phase
 *     Management section.
 *
 * The profile is mutually exclusive with multi-model orchestration and
 * ferment-oneshot: both rely on the scaffolding the lean profile removes.
 */
export const KIMCHI_BENCHMARK_PROFILE_ENV = "KIMCHI_BENCHMARK_PROFILE"
export const LEAN_BENCHMARK_PROFILE = "lean"

export function getBenchmarkProfile(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const raw = env[KIMCHI_BENCHMARK_PROFILE_ENV]?.trim()
	return raw ? raw : undefined
}

export function isLeanBenchmarkProfile(env: NodeJS.ProcessEnv = process.env): boolean {
	return getBenchmarkProfile(env) === LEAN_BENCHMARK_PROFILE
}

/**
 * Hides `set_phase` under the lean profile. The todo and questionnaire
 * surfaces are excluded at extension registration (see todos/index.ts and
 * questionnaire/questionnaire.ts), so they never reach the tool registry at
 * all; `set_phase` lives inside tags.ts which registers much more, so it is
 * hidden via a visibility vote instead.
 */
export default function benchmarkProfileExtension(pi: ExtensionAPI): void {
	if (!isLeanBenchmarkProfile()) return
	const visibility = createToolVisibility(pi)
	pi.on("session_start", () => {
		visibility.disable(["set_phase"])
	})
}
