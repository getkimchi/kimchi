// ACP integration — harness environment scoping. One workflow: an ACP server
// started with `--env test` creates a session whose state lives under
// ~/.config/kimchi/envs/test/, and a second server instance WITHOUT the env
// selection must not list that session — session stores are scoped per env.
//
// The two-server form (rather than a single filesystem-only assertion) is
// practical here: the ACP fixture supports homeDirOverride/workDirOverride +
// keepDirsOnStop, so the second process shares the first one's HOME while
// resolving a different env.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

interface ListedSessions {
	sessions: Array<{ sessionId: string }>
}

async function listSessions(fixture: AcpFixture, cwd: string): Promise<ListedSessions> {
	// The lister only honors the env-scoped session store when `cwd` is
	// supplied (a cwd-less request degrades to pi's listAll, which has no
	// agentDir slot and would not reflect env scoping).
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

describe("ACP integration — environments", () => {
	it("scopes sessions per harness environment: a --env test session is invisible without the env", async () => {
		// Process 1: ACP server on the named env. The fixture seeds the
		// legacy layout before seedHome runs; mirror config/models/settings
		// into envs/test so the env-selected server finds its provider.
		const first = await startAcpFixture({
			artifactName: "acp-environments-named",
			responses: [{ stream: ["Hello from the test env."] }],
			extraArgs: ["--env", "test"],
			keepDirsOnStop: true,
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

		// The named env's session log lives under envs/test, never the
		// legacy harness dir the default env would use.
		const testSessionsRoot = join(homeDir, ".config", "kimchi", "envs", "test", "harness", "sessions")
		const namedLogs = sessionLogFiles(testSessionsRoot)
		expect(namedLogs.some((path) => path.endsWith(`_${sessionId}.jsonl`))).toBe(true)
		expect(sessionLogFiles(join(homeDir, ".config", "kimchi", "harness", "sessions"))).toEqual([])

		// The ACP fixture spreads `process.env` into the spawned kimchi, so a
		// stray KIMCHI_ENV from the enclosing shell would silently scope the
		// second server back to the test env. Drop it before spawning and
		// restore afterwards so this test never leak its scrub into the worker.
		const savedKimchiEnv = process.env.KIMCHI_ENV
		delete process.env.KIMCHI_ENV

		// Process 2: same HOME, no env selection — the legacy layout in
		// place resolves the default env, whose session store must not
		// list the env-scoped session.
		const second = await startAcpFixture({
			artifactName: "acp-environments-default",
			responses: [{ stream: ["Hello from the default env."] }],
			homeDirOverride: homeDir,
			workDirOverride: workDir,
		})
		try {
			const listed = await listSessions(second, workDir)
			expect(listed.sessions.some((session) => session.sessionId === sessionId)).toBe(false)

			// Its own session lands under the legacy harness dir — and the
			// named env's tree does not grow from the default-env server.
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
			if (savedKimchiEnv === undefined) delete process.env.KIMCHI_ENV
			else process.env.KIMCHI_ENV = savedKimchiEnv
			await second.stop()
			// Both fixtures kept the dirs (hand-off + override): the test
			// owns the cleanup.
			rmSync(homeDir, { recursive: true, force: true })
			rmSync(workDir, { recursive: true, force: true })
		}
	}, 90_000)
})
