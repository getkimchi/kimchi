// ACP integration: skill changes on disk re-advertise session palettes.
// The harness watches skill roots (global harness dir, Claude-compat dirs,
// project roots); adding a skill under a watched root must produce a fresh
// available_commands_update for the live session without any client request.

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { AvailableCommand } from "@agentclientprotocol/sdk"
import { afterEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession } from "./support/scenarios.js"

const WATCHER_TIMEOUT_MS = 20_000

function writeTestSkill(root: string, name: string, description: string): void {
	mkdirSync(join(root, name), { recursive: true })
	writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`, "utf-8")
}

function commandNames(fixture: AcpFixture, sessionId: string): string[] {
	const updates = fixture.client.sessionUpdates.filter(
		(u) => u.sessionId === sessionId && u.update.sessionUpdate === "available_commands_update",
	)
	const last = updates[updates.length - 1]
	if (last?.update.sessionUpdate !== "available_commands_update") return []
	return last.update.availableCommands.map((c: AvailableCommand) => c.name)
}

async function lastUpdateIncludes(
	fixture: AcpFixture,
	sessionId: string,
	name: string,
	timeoutMs = WATCHER_TIMEOUT_MS,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (commandNames(fixture, sessionId).includes(name)) return true
		await delay(100)
	}
	return false
}

// The session's initial palette is scheduled with setImmediate after the
// session/new response; wait for it before mutating anything on disk.
async function waitForBaseline(fixture: AcpFixture, sessionId: string): Promise<string[]> {
	const deadline = Date.now() + WATCHER_TIMEOUT_MS
	while (Date.now() < deadline) {
		const names = commandNames(fixture, sessionId)
		if (names.includes("bug")) return names
		await delay(100)
	}
	throw new Error("initial available_commands_update never arrived")
}

describe("ACP integration — skill change re-advertises palettes", () => {
	let fixture: AcpFixture

	afterEach(async () => {
		await fixture.stop()
	})

	it(
		"re-broadcasts available_commands_update when a global skill appears",
		async () => {
			fixture = await startAcpFixture({ artifactName: "skill-refresh-global", responses: [] })
			const sessionId = await newSession(fixture, fixture.workDir)
			const baseline = await waitForBaseline(fixture, sessionId)
			expect(baseline).not.toContain("skill:e2e-global-skill")

			// Upload a skill to the global harness skills dir while the session is live.
			const harnessSkills = join(fixture.homeDir, ".config", "kimchi", "harness", "skills")
			writeTestSkill(harnessSkills, "e2e-global-skill", "E2E global skill")

			expect(await lastUpdateIncludes(fixture, sessionId, "skill:e2e-global-skill")).toBe(true)

			// The refresh must not drop baseline commands: extension-contributed
			// skills (bundled, project, configured paths) are re-derived only via
			// resources_discover, which a bare loader reload() skips.
			for (const name of baseline) {
				expect(commandNames(fixture, sessionId), `lost after refresh: ${name}`).toContain(name)
			}
		},
		STARTUP_TIMEOUT_MS + WATCHER_TIMEOUT_MS,
	)

	it(
		"re-broadcasts available_commands_update when a skill is deleted",
		async () => {
			fixture = await startAcpFixture({ artifactName: "skill-refresh-delete", responses: [] })
			const harnessSkills = join(fixture.homeDir, ".config", "kimchi", "harness", "skills")
			writeTestSkill(harnessSkills, "e2e-doomed-skill", "E2E doomed skill")
			const sessionId = await newSession(fixture, fixture.workDir)
			const baseline = await waitForBaseline(fixture, sessionId)
			expect(baseline).toContain("skill:e2e-doomed-skill")

			rmSync(join(harnessSkills, "e2e-doomed-skill"), { recursive: true, force: true })

			// The refreshed palette must drop the deleted skill.
			const deadline = Date.now() + WATCHER_TIMEOUT_MS
			let gone = false
			while (Date.now() < deadline && !gone) {
				gone = !commandNames(fixture, sessionId).includes("skill:e2e-doomed-skill")
				if (!gone) await delay(100)
			}
			expect(gone).toBe(true)
		},
		STARTUP_TIMEOUT_MS + WATCHER_TIMEOUT_MS,
	)
})
