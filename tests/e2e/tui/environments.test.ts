// TUI E2E — harness environments. Each scenario pins where session state lands
// under the test's isolated HOME for a given --env selection:
//
//   - fresh HOME (no legacy state) → ~/.config/kimchi/envs/default/
//   - legacy layout in place → ~/.config/kimchi/ used in place (no envs/)
//   - named env → ~/.config/kimchi/envs/<name>/, invisible from the default env
//
// The fixture seeds the legacy layout (~/.config/kimchi/config.json +
// harness/) before `seedHome` runs, so the fresh-HOME and named-env scenarios
// move/copy that seeded state inside `seedHome` (before kimchi launches) —
// no shared-fixture changes are needed.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { basename, join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import {
	createKimchiFixture,
	launchKimchi,
	PROMPT_READY,
	runKimchiSession,
	stopKimchi,
	TUI_TEST_CONFIG,
} from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** Every .jsonl session log under a sessions root (pi stores them in
 *  per-project subdirectories, so walk recursively). */
function sessionLogFiles(sessionsRoot: string): string[] {
	if (!existsSync(sessionsRoot)) return []
	return readdirSync(sessionsRoot, { recursive: true })
		.map((entry) => join(sessionsRoot, String(entry)))
		.filter((path) => path.endsWith(".jsonl"))
		.sort()
}

test("a fresh HOME without --env keeps its session state under envs/default", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "environments-fresh-home",
			responses: [{ stream: ["Hello", " from", " envs/default."] }],
			// Nullify a stray KIMCHI_ENV inherited from the harness shell: the
			// launched kimchi must resolve its env from the fresh HOME alone.
			env: { KIMCHI_ENV: "" },
			// The fixture seeds the legacy layout before seedHome runs; move it
			// wholesale into envs/default and delete the legacy entries so the
			// default env resolves to a fresh tree under envs/.
			seedHome: (homeDir) => {
				const configDir = join(homeDir, ".config", "kimchi")
				const legacyHarness = join(configDir, "harness")
				const defaultEnvRoot = join(configDir, "envs", "default")
				mkdirSync(defaultEnvRoot, { recursive: true })
				cpSync(legacyHarness, join(defaultEnvRoot, "harness"), { recursive: true })
				cpSync(join(configDir, "config.json"), join(defaultEnvRoot, "config.json"))
				rmSync(join(configDir, "config.json"))
				rmSync(legacyHarness, { recursive: true, force: true })
				return undefined
			},
		},
		async (fixture, trace) => {
			terminal.submit("Say hello")
			await expect(terminal.getByText("Hello from envs/default.", { full: true })).toBeVisible()
			trace.step("turn completed")

			const envHarness = join(fixture.homeDir, ".config", "kimchi", "envs", "default", "harness")
			expect(existsSync(envHarness)).toBe(true)
			expect(sessionLogFiles(join(envHarness, "sessions")).length).toBeGreaterThan(0)
			// Nothing fell back to the legacy top-level harness dir.
			expect(existsSync(join(fixture.homeDir, ".config", "kimchi", "harness"))).toBe(false)
		},
	)
})

test("a HOME with the legacy layout in place keeps state under the legacy harness dir", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "environments-legacy-home",
			responses: [{ stream: ["Hello", " from", " the legacy layout."] }],
			// The fixture already pre-seeds ~/.config/kimchi/config.json and
			// ~/.config/kimchi/harness/ (models.json, settings.json) — exactly
			// the "legacy layout in place" HOME this scenario needs, so no extra
			// seeding is required.
			env: { KIMCHI_ENV: "" },
		},
		async (fixture, trace) => {
			terminal.submit("Say hello")
			await expect(terminal.getByText("Hello from the legacy layout.", { full: true })).toBeVisible()
			trace.step("turn completed")

			const legacySessionsRoot = join(fixture.homeDir, ".config", "kimchi", "harness", "sessions")
			expect(sessionLogFiles(legacySessionsRoot).length).toBeGreaterThan(0)
			// The legacy layout is used IN PLACE — no envs/ tree is created.
			expect(existsSync(join(fixture.homeDir, ".config", "kimchi", "envs"))).toBe(false)
		},
	)
})

test("--env test keeps its sessions out of the default env's tree", async ({ terminal }) => {
	const fixture = await createKimchiFixture({
		responses: [{ stream: ["Hello", " from", " the test env."] }, { stream: ["Hello", " from", " the default env."] }],
		// The named env needs its own state tree: mirror the fixture-seeded
		// legacy config/models/settings into envs/test before kimchi launches.
		// The legacy layout stays in place so the second, flag-less launch
		// resolves the default env to it.
		seedHome: (homeDir) => {
			const configDir = join(homeDir, ".config", "kimchi")
			const testEnvRoot = join(configDir, "envs", "test")
			const testHarness = join(testEnvRoot, "harness")
			mkdirSync(testHarness, { recursive: true })
			cpSync(join(configDir, "config.json"), join(testEnvRoot, "config.json"))
			for (const file of ["models.json", "settings.json"]) {
				const source = join(configDir, "harness", file)
				if (existsSync(source)) cpSync(source, join(testHarness, file))
			}
			return undefined
		},
	})

	try {
		// Launch 1: the named env owns the whole state tree under envs/test.
		const exitMarker = "__KIMCHI_ENV_TEST_EXITED__"
		launchKimchi(terminal, fixture, ["--env", "test"], { ...fixture.seedEnv, KIMCHI_ENV: "" }, { exitMarker })
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		terminal.submit("Say hello")
		await waitForText(terminal, "Hello from the test env.", { timeoutMs: STREAM_TIMEOUT_MS })
		terminal.submit("/quit")
		await waitForText(terminal, exitMarker, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		const testSessionsRoot = join(fixture.homeDir, ".config", "kimchi", "envs", "test", "harness", "sessions")
		const namedSessionFiles = sessionLogFiles(testSessionsRoot)
		expect(namedSessionFiles.length).toBeGreaterThan(0)

		// Launch 2: no --env (KIMCHI_ENV explicitly blanked) — the legacy
		// layout is in place, so the default env resolves to it and the
		// second session's state must never touch envs/test.
		launchKimchi(terminal, fixture, [], { ...fixture.seedEnv, KIMCHI_ENV: "" })
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		terminal.submit("Say hello again")
		await waitForText(terminal, "Hello from the default env.", { timeoutMs: STREAM_TIMEOUT_MS })

		const legacySessionsRoot = join(fixture.homeDir, ".config", "kimchi", "harness", "sessions")
		const defaultSessionFiles = sessionLogFiles(legacySessionsRoot)
		expect(defaultSessionFiles.length).toBeGreaterThan(0)
		// The named env's sessions are invisible from the default env…
		const namedBasenames = new Set(namedSessionFiles.map((path) => basename(path)))
		expect(defaultSessionFiles.filter((path) => namedBasenames.has(basename(path)))).toEqual([])
		// …and the default-env launch did not grow the named env's tree.
		expect(sessionLogFiles(testSessionsRoot)).toEqual(namedSessionFiles)
	} finally {
		await stopKimchi(terminal).catch(() => {})
		await fixture.stop().catch(() => {})
	}
})
