// ACP integration: sessionless path-trust methods (LLM-3628).
//
// `_kimchi.dev/get_path_trust` resolves an arbitrary path's trust state
// through the store's nearest-wins ancestor walk; `_kimchi.dev/set_path_trust`
// persists trust/deny for any path (writes go through ProjectTrustStore, the
// canonicalizing write path) and live-refreshes every session under it.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { AvailableCommand } from "@agentclientprotocol/sdk"
import { afterEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession } from "./support/scenarios.js"

const WAIT_MS = 20_000
const GET_PATH_TRUST = "_kimchi.dev/get_path_trust"
const SET_PATH_TRUST = "_kimchi.dev/set_path_trust"

function writeTestSkill(root: string, name: string): void {
	mkdirSync(join(root, name), { recursive: true })
	writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: E2E ${name}\n---\nBody.\n`, "utf-8")
}

function commandNames(fixture: AcpFixture, sessionId: string): string[] {
	const updates = fixture.client.sessionUpdates.filter(
		(u) => u.sessionId === sessionId && u.update.sessionUpdate === "available_commands_update",
	)
	const last = updates[updates.length - 1]
	if (last?.update.sessionUpdate !== "available_commands_update") return []
	return last.update.availableCommands.map((c: AvailableCommand) => c.name)
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

describe("ACP integration — sessionless path trust", () => {
	let fixture: AcpFixture

	afterEach(async () => {
		await fixture.stop()
	})

	it(
		"resolves, writes, inherits, and live-refreshes path trust",
		async () => {
			fixture = await startAcpFixture({ artifactName: "path-trust", responses: [] })

			const projectSkills = join(fixture.workDir, ".kimchi", "skills")
			writeTestSkill(projectSkills, "e2e-path-trust-skill")
			const nested = join(fixture.workDir, "packages", "a")
			mkdirSync(nested, { recursive: true })

			// A live session under the (undecided) path starts untrusted.
			const sessionId = await newSession(fixture, nested)
			await waitFor(
				() => commandNames(fixture, sessionId),
				(names) => names.includes("bug"),
			)
			expect(commandNames(fixture, sessionId)).not.toContain("skill:e2e-path-trust-skill")

			// get_path_trust: undecided, fail-closed, blocked categories.
			const undecided = await fixture.conn.extMethod(GET_PATH_TRUST, { path: fixture.workDir })
			expect(undecided).toEqual({
				decided: false,
				trusted: false,
				blocked: ["skills"],
				decisionSource: null,
			})

			// set_path_trust trust: persisted, canonicalized source, live refresh.
			const granted = await fixture.conn.extMethod(SET_PATH_TRUST, {
				path: fixture.workDir,
				decision: "trust",
			})
			expect(granted).toEqual({
				decided: true,
				trusted: true,
				blocked: [],
				decisionSource: realpathSync(fixture.workDir),
			})
			await waitFor(
				() => commandNames(fixture, sessionId),
				(names) => names.includes("skill:e2e-path-trust-skill"),
			)

			// Inheritance: a nested query resolves via the ancestor entry.
			const inherited = await fixture.conn.extMethod(GET_PATH_TRUST, { path: nested })
			expect(inherited).toEqual({
				decided: true,
				trusted: true,
				blocked: [],
				decisionSource: realpathSync(fixture.workDir),
			})

			// New sessions under the path come up trusted.
			const second = await newSession(fixture, nested)
			await waitFor(
				() =>
					fixture.client.sessionUpdates.filter(
						(u) => u.sessionId === second && u.update.sessionUpdate === "available_commands_update",
					).length,
				(n) => n > 0,
			)
			expect(commandNames(fixture, second)).toContain("skill:e2e-path-trust-skill")

			// set_path_trust deny: live revoke for sessions under the path.
			const denied = await fixture.conn.extMethod(SET_PATH_TRUST, {
				path: fixture.workDir,
				decision: "deny",
			})
			expect(denied).toEqual({
				decided: true,
				trusted: false,
				blocked: ["skills"],
				decisionSource: realpathSync(fixture.workDir),
			})
			await waitFor(
				() => commandNames(fixture, sessionId),
				(names) => !names.includes("skill:e2e-path-trust-skill"),
			)
			const trustPath = join(fixture.homeDir, ".config", "kimchi", "harness", "trust.json")
			const stored = JSON.parse(readFileSync(trustPath, "utf-8")) as Record<string, boolean>
			expect(stored[realpathSync(fixture.workDir)]).toBe(false)
		},
		STARTUP_TIMEOUT_MS + WAIT_MS,
	)

	it(
		"accepts the filesystem root and rejects relative paths and bad decisions",
		async () => {
			fixture = await startAcpFixture({ artifactName: "path-trust-root", responses: [] })

			// Root is a deliberate power-user capability — allowed.
			const rootResult = await fixture.conn.extMethod(SET_PATH_TRUST, { path: "/", decision: "trust" })
			expect(rootResult).toMatchObject({ decided: true, trusted: true, decisionSource: "/" })

			await expect(fixture.conn.extMethod(GET_PATH_TRUST, { path: "relative/path" })).rejects.toThrow()
			await expect(
				fixture.conn.extMethod(SET_PATH_TRUST, { path: fixture.workDir, decision: "trust_session" }),
			).rejects.toThrow()
		},
		STARTUP_TIMEOUT_MS + WAIT_MS,
	)
})
