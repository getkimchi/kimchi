// TUI E2E — harness profiles. Each scenario pins where session state lands
// under the test's isolated HOME for a given profile selection:
//
//   - default profile: ~/.config/kimchi/ itself, for every machine
//   - named profile: ~/.config/kimchi/profiles/<name>/, invisible from the
//     default profile
//
// The fixture seeds a minimal ~/.config/kimchi (config.json + harness/)
// before `seedHome` runs — which is now simply the default profile's own
// state, so no special seeding is needed for the default scenarios.

import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs"
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

test("the default profile keeps its session state at ~/.config/kimchi/harness", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "profiles-default",
			responses: [{ stream: ["Hello", " from", " the default profile."] }],
			// Nullify a stray KIMCHI_PROFILE inherited from the harness shell:
			// the launched kimchi must resolve its profile from the fresh HOME alone.
			env: { KIMCHI_PROFILE: "" },
		},
		async (fixture, trace) => {
			terminal.submit("Say hello")
			await expect(terminal.getByText("Hello from the default profile.", { full: true })).toBeVisible()
			trace.step("turn completed")

			const harness = join(fixture.homeDir, ".config", "kimchi", "harness")
			expect(existsSync(harness)).toBe(true)
			expect(sessionLogFiles(join(harness, "sessions")).length).toBeGreaterThan(0)
			// No profiles/ tree is created for the default profile.
			expect(existsSync(join(fixture.homeDir, ".config", "kimchi", "profiles"))).toBe(false)
		},
	)
})

test("--profile test keeps its sessions out of the default profile's tree", async ({ terminal }) => {
	const fixture = await createKimchiFixture({
		responses: [
			{ stream: ["Hello", " from", " the test profile."] },
			{ stream: ["Hello", " again", " from", " the default profile."] },
		],
		// The named profile needs its own state tree: mirror the fixture-seeded
		// config/models/settings into profiles/test before kimchi launches. The
		// default profile stays at ~/.config/kimchi, so the second, flag-less
		// launch resolves it.
		seedHome: (homeDir) => {
			const configDir = join(homeDir, ".config", "kimchi")
			const testRoot = join(configDir, "profiles", "test")
			const testHarness = join(testRoot, "harness")
			mkdirSync(testHarness, { recursive: true })
			cpSync(join(configDir, "config.json"), join(testRoot, "config.json"))
			for (const file of ["models.json", "settings.json"]) {
				const source = join(configDir, "harness", file)
				if (existsSync(source)) cpSync(source, join(testHarness, file))
			}
			return undefined
		},
	})

	try {
		// Launch 1: the named profile owns the whole state tree under profiles/test.
		const exitMarker = "__KIMCHI_PROFILE_TEST_EXITED__"
		launchKimchi(terminal, fixture, ["--profile", "test"], { ...fixture.seedEnv, KIMCHI_PROFILE: "" }, { exitMarker })
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		terminal.submit("Say hello")
		await waitForText(terminal, "Hello from the test profile.", { timeoutMs: STREAM_TIMEOUT_MS })
		terminal.submit("/quit")
		await waitForText(terminal, exitMarker, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

		const testSessionsRoot = join(fixture.homeDir, ".config", "kimchi", "profiles", "test", "harness", "sessions")
		const namedSessionFiles = sessionLogFiles(testSessionsRoot)
		expect(namedSessionFiles.length).toBeGreaterThan(0)

		// Launch 2: no --profile (KIMCHI_PROFILE explicitly blanked) — the
		// default profile at ~/.config/kimchi must not see the named profile's
		// sessions, and its own state must never touch profiles/test.
		launchKimchi(terminal, fixture, [], { ...fixture.seedEnv, KIMCHI_PROFILE: "" })
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		terminal.submit("Say hello again")
		await waitForText(terminal, "Hello again from the default profile.", { timeoutMs: STREAM_TIMEOUT_MS })

		const defaultSessionsRoot = join(fixture.homeDir, ".config", "kimchi", "harness", "sessions")
		const defaultSessionFiles = sessionLogFiles(defaultSessionsRoot)
		expect(defaultSessionFiles.length).toBeGreaterThan(0)
		// The named profile's sessions are invisible from the default profile…
		const namedBasenames = new Set(namedSessionFiles.map((path) => basename(path)))
		expect(defaultSessionFiles.filter((path) => namedBasenames.has(basename(path)))).toEqual([])
		// …and the default-profile launch did not grow the named profile's tree.
		expect(sessionLogFiles(testSessionsRoot)).toEqual(namedSessionFiles)
	} finally {
		await stopKimchi(terminal).catch(() => {})
		await fixture.stop().catch(() => {})
	}
})
