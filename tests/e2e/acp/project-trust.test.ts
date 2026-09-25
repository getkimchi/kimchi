// ACP integration: project-trust surfacing (LLM-3628).
//
// A session in an untrusted project must (1) push a
// `_kimchi.dev/project_trust_update` extNotification with trusted=false and
// the coarse blocked categories, (2) omit the project skill from the palette,
// and (3) after the client answers the survey via
// `_kimchi.dev/set_project_trust`, refresh the palette live — no session
// restart — while persisting the decision to trust.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession } from "./support/scenarios.js"

const WAIT_MS = 20_000

const PROJECT_TRUST_UPDATE = "_kimchi.dev/project_trust_update"
const SET_PROJECT_TRUST = "_kimchi.dev/set_project_trust"

function writeTestSkill(root: string, name: string, description: string): void {
	mkdirSync(join(root, name), { recursive: true })
	writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`, "utf-8")
}

function lastTrustUpdate(fixture: AcpFixture, sessionId: string) {
	const updates = fixture.client.extNotifications.filter(
		(n) => n.method === PROJECT_TRUST_UPDATE && (n.params as { sessionId?: string }).sessionId === sessionId,
	)
	return updates[updates.length - 1]?.params as { sessionId: string; trusted: boolean; blocked: string[] } | undefined
}

function commandNames(fixture: AcpFixture, sessionId: string): string[] {
	const updates = fixture.client.sessionUpdates.filter(
		(u) => u.sessionId === sessionId && u.update.sessionUpdate === "available_commands_update",
	)
	const last = updates[updates.length - 1]
	if (last?.update.sessionUpdate !== "available_commands_update") return []
	return last.update.availableCommands.map((c) => c.name)
}

async function waitFor<T>(probe: () => T, predicate: (v: T) => boolean, timeoutMs = WAIT_MS): Promise<T> {
	const deadline = Date.now() + timeoutMs
	let last: T | undefined
	while (Date.now() < deadline) {
		const value = probe()
		if (predicate(value)) return value
		last = value
		await delay(100)
	}
	throw new Error(`condition not met within ${timeoutMs}ms; last value: ${JSON.stringify(last)}`)
}

describe("ACP integration — project trust surfacing", () => {
	let fixture: AcpFixture

	afterEach(async () => {
		await fixture.stop()
	})

	it(
		"pushes untrusted state, then refreshes skills live after set_project_trust grants trust",
		async () => {
			// Deliberately NOT pretrustWorkDir: the session must come up
			// untrusted, like a brand-new Studio project.
			fixture = await startAcpFixture({ artifactName: "project-trust", responses: [] })

			const projectSkills = join(fixture.workDir, ".kimchi", "skills")
			writeTestSkill(projectSkills, "e2e-gated-skill", "E2E gated skill")

			const sessionId = await newSession(fixture, fixture.workDir)

			// 1. The untrusted push arrives after session/new.
			const untrusted = await waitFor(
				() => lastTrustUpdate(fixture, sessionId),
				(u) => u !== undefined,
			)
			expect(untrusted?.trusted).toBe(false)
			expect(untrusted?.blocked).toContain("skills")

			// 2. The palette omits the gated project skill while untrusted.
			await waitFor(
				() => commandNames(fixture, sessionId),
				(names) => names.includes("bug"),
			)
			expect(commandNames(fixture, sessionId)).not.toContain("skill:e2e-gated-skill")

			// 3. The client answers the survey; trust lands and is persisted.
			const result = await fixture.conn.extMethod(SET_PROJECT_TRUST, { sessionId, decision: "trust" })
			expect(result).toEqual({ trusted: true, blocked: [] })

			// 4. The palette refreshes live — no session restart.
			await waitFor(
				() => commandNames(fixture, sessionId),
				(names) => names.includes("skill:e2e-gated-skill"),
			)

			// 4b. The watcher now watches the project root too: a NEW project
			// skill added after the grant must re-advertise the palette without
			// any further client action (while untrusted, the root was never in
			// the watch set — the grant handler has to re-derive it).
			writeTestSkill(projectSkills, "e2e-post-grant-skill", "E2E post-grant skill")
			await waitFor(
				() => commandNames(fixture, sessionId),
				(names) => names.includes("skill:e2e-post-grant-skill"),
			)

			// 5. A fresh push reports trusted with nothing blocked.
			await waitFor(
				() => lastTrustUpdate(fixture, sessionId),
				(u) => u?.trusted === true,
			)

			// 6. The decision was persisted for future sessions.
			const trustPath = join(fixture.homeDir, ".config", "kimchi", "harness", "trust.json")
			expect(existsSync(trustPath)).toBe(true)
			expect(readFileSync(trustPath, "utf-8")).toContain(fixture.workDir)

			// 7. Revocation sweeps too: deny_persist must drop the project skill
			// from the live palette (not just stop advertising new ones) and
			// store the denied decision.
			const denyResult = await fixture.conn.extMethod(SET_PROJECT_TRUST, {
				sessionId,
				decision: "deny_persist",
			})
			expect(denyResult).toEqual({ trusted: false, blocked: ["skills"] })
			await waitFor(
				() => commandNames(fixture, sessionId),
				(names) => !names.includes("skill:e2e-gated-skill"),
			)
			const stored = JSON.parse(readFileSync(trustPath, "utf-8")) as Record<string, unknown>
			expect(Object.values(stored)).toContain(false)

			// 8. A new session on the denied project comes up untrusted, with the
			// project skill gated again.
			const secondSession = await newSession(fixture, fixture.workDir)
			const second = await waitFor(
				() => lastTrustUpdate(fixture, secondSession),
				(u) => u !== undefined,
			)
			expect(second?.trusted).toBe(false)
			expect(second?.blocked).toContain("skills")
		},
		STARTUP_TIMEOUT_MS + WAIT_MS,
	)

	it(
		"rejects an invalid decision with a JSON-RPC error and changes nothing",
		async () => {
			fixture = await startAcpFixture({ artifactName: "project-trust-invalid", responses: [] })
			// Seed a project skill so the cwd has trust-requiring resources and
			// the session resolves untrusted (a bare workDir is trivially trusted).
			writeTestSkill(join(fixture.workDir, ".kimchi", "skills"), "e2e-invalid-skill", "E2E invalid skill")
			const sessionId = await newSession(fixture, fixture.workDir)
			await waitFor(
				() => lastTrustUpdate(fixture, sessionId),
				(u) => u !== undefined,
			)

			await expect(fixture.conn.extMethod(SET_PROJECT_TRUST, { sessionId, decision: "maybe" })).rejects.toThrow()

			// State unchanged: still untrusted, no decision persisted.
			expect(lastTrustUpdate(fixture, sessionId)?.trusted).toBe(false)
			const trustPath = join(fixture.homeDir, ".config", "kimchi", "harness", "trust.json")
			expect(existsSync(trustPath)).toBe(false)

			// A plain deny is in-memory only: the session is refused, but nothing
			// is written to the trust store.
			const denyResult = await fixture.conn.extMethod(SET_PROJECT_TRUST, { sessionId, decision: "deny" })
			expect(denyResult).toEqual({ trusted: false, blocked: ["skills"] })
			expect(existsSync(trustPath)).toBe(false)
		},
		STARTUP_TIMEOUT_MS + WAIT_MS,
	)
})
