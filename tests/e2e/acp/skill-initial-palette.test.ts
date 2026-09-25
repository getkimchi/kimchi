// ACP integration: initial palette must include bundled and project skills.
// LLM-3628: built-in harness skills and workspace/project skills are not
// returned by ACP. This test pins the user-visible symptom: the first
// available_commands_update for a new session must contain skill:<name>
// entries for (a) skills bundled with the harness (resources/skills) and
// (b) skills placed in the trusted project's .kimchi/skills dir.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { AvailableCommand } from "@agentclientprotocol/sdk"
import { afterEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession } from "./support/scenarios.js"

const WAIT_MS = 20_000

function commandNames(fixture: AcpFixture, sessionId: string): string[] {
	const updates = fixture.client.sessionUpdates.filter(
		(u) => u.sessionId === sessionId && u.update.sessionUpdate === "available_commands_update",
	)
	const last = updates[updates.length - 1]
	if (last?.update.sessionUpdate !== "available_commands_update") return []
	return last.update.availableCommands.map((c: AvailableCommand) => c.name)
}

async function waitForBaseline(fixture: AcpFixture, sessionId: string): Promise<string[]> {
	const deadline = Date.now() + WAIT_MS
	while (Date.now() < deadline) {
		const names = commandNames(fixture, sessionId)
		if (names.includes("bug")) return names
		await delay(100)
	}
	throw new Error("initial available_commands_update never arrived")
}

describe("ACP integration — bundled and project skills in initial palette", () => {
	let fixture: AcpFixture

	afterEach(async () => {
		await fixture.stop()
	})

	it(
		"advertises bundled and project skills on session creation",
		async () => {
			fixture = await startAcpFixture({ artifactName: "skill-initial-palette", responses: [], pretrustWorkDir: true })

			// Project skill inside the (pre-trusted) session workDir.
			const projectSkills = join(fixture.workDir, ".kimchi", "skills", "e2e-project-skill")
			mkdirSync(projectSkills, { recursive: true })
			writeFileSync(
				join(projectSkills, "SKILL.md"),
				"---\nname: e2e-project-skill\ndescription: E2E project skill\n---\nBody.\n",
				"utf-8",
			)

			const sessionId = await newSession(fixture, fixture.workDir)
			const baseline = await waitForBaseline(fixture, sessionId)

			// Bundled skill shipped in resources/skills (dev tree).
			expect(baseline, `bundled skills missing; palette: ${baseline.join(",")}`).toContain("skill:dap-debugging")
			// Project skill from the trusted workDir.
			expect(baseline, `project skill missing; palette: ${baseline.join(",")}`).toContain("skill:e2e-project-skill")
		},
		STARTUP_TIMEOUT_MS + WAIT_MS,
	)
})
