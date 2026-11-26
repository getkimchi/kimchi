// ACP integration — harness profile scoping. One workflow: an ACP server
// started with `--profile test` creates a session whose state lives under
// ~/.config/kimchi/profiles/test/, and a second server instance WITHOUT the
// profile selection must not list that session — session stores are scoped
// per profile.
//
// The two-server form (rather than a single filesystem-only assertion) is
// practical here: the ACP fixture supports homeDirOverride/workDirOverride +
// keepDirsOnStop, so the second process shares the first one's HOME while
// resolving a different profile.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

interface ListedSessions {
	sessions: Array<{ sessionId: string }>
}

async function listSessions(fixture: AcpFixture, cwd: string): Promise<ListedSessions> {
	// The lister only honors the profile-scoped session store when `cwd` is
	// supplied (a cwd-less request degrades to pi's listAll, which has no
	// agentDir slot and would not reflect profile scoping).
	return (await fixture.conn.request("session/list", { cwd })) as ListedSessions
}

/** Every .jsonl session log under a harness sessions root (pi stores them in per-project subdirectories). */
function sessionLogFiles(sessionsRoot: string): string[] {
	if (!existsSync(sessionsRoot)) return []
	return readdirSync(sessionsRoot, { recursive: true })
		.map((entry) => join(sessionsRoot, String(entry)))
		.filter((path) => path.endsWith(".jsonl"))
		.sort()
}

describe("ACP integration — profiles", () => {
	it("scopes sessions per harness profile: a --profile test session is invisible without the profile", async () => {
		// Process 1: ACP server on the named profile. The fixture seeds a
		// minimal ~/.config/kimchi (the default profile's own state); mirror
		// config/models/settings into profiles/test so the profile-selected
		// server finds its provider.
		const first = await startAcpFixture({
			artifactName: "acp-profiles-named",
			responses: [{ stream: ["Hello from the test profile."] }],
			extraArgs: ["--profile", "test"],
			keepDirsOnStop: true,
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
			},
		})
		let sessionId: string
		try {
			sessionId = await newSession(first, first.workDir)
			// The session log only lands on disk after a turn, and the lister
			// reads persisted JSONL headers — settle a turn before listing.
			const turn = await prompt(first, sessionId, "Say hello")
			expect(turn.stopReason).toBe("end_turn")
			const listed = await listSessions(first, first.workDir)
			expect(listed.sessions.some((session) => session.sessionId === sessionId)).toBe(true)
		} finally {
			await first.stop()
		}
		const { homeDir, workDir } = first

		// The named profile's session log lives under profiles/test, never the
		// default profile's harness dir.
		const testSessionsRoot = join(homeDir, ".config", "kimchi", "profiles", "test", "harness", "sessions")
		const namedLogs = sessionLogFiles(testSessionsRoot)
		expect(namedLogs.some((path) => path.endsWith(`_${sessionId}.jsonl`))).toBe(true)
		expect(sessionLogFiles(join(homeDir, ".config", "kimchi", "harness", "sessions"))).toEqual([])

		// The ACP fixture spreads `process.env` into the spawned kimchi, so a
		// stray KIMCHI_PROFILE from the enclosing shell would silently scope the
		// second server back to the test profile. Drop it before spawning and
		// restore afterwards so this test never leaks its scrub into the worker.
		const savedKimchiProfile = process.env.KIMCHI_PROFILE
		delete process.env.KIMCHI_PROFILE

		// Process 2: same HOME, no profile selection — the default profile
		// (~/.config/kimchi) must not list the profile-scoped session.
		const second = await startAcpFixture({
			artifactName: "acp-profiles-default",
			responses: [{ stream: ["Hello from the default profile."] }],
			homeDirOverride: homeDir,
			workDirOverride: workDir,
		})
		try {
			const listed = await listSessions(second, workDir)
			expect(listed.sessions.some((session) => session.sessionId === sessionId)).toBe(false)

			// Its own session lands under the default harness dir — and the
			// named profile's tree does not grow from the default-profile server.
			// (A turn is needed to persist the log — see the note above.)
			const defaultSessionId = await newSession(second, workDir)
			const defaultTurn = await prompt(second, defaultSessionId, "Say hello again")
			expect(defaultTurn.stopReason).toBe("end_turn")
			expect(
				sessionLogFiles(join(homeDir, ".config", "kimchi", "harness", "sessions")).some((path) =>
					path.endsWith(`_${defaultSessionId}.jsonl`),
				),
			).toBe(true)
			expect(sessionLogFiles(testSessionsRoot)).toEqual(namedLogs)
		} finally {
			if (savedKimchiProfile === undefined) delete process.env.KIMCHI_PROFILE
			else process.env.KIMCHI_PROFILE = savedKimchiProfile
			await second.stop()
			// Both fixtures kept the dirs (hand-off + override): the test
			// owns the cleanup.
			rmSync(homeDir, { recursive: true, force: true })
			rmSync(workDir, { recursive: true, force: true })
		}
	}, 90_000)
})
