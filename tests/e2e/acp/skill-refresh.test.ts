// ACP integration: skill changes on disk re-advertise session palettes.
// The harness watches skill roots (global harness dir, Claude-compat dirs,
// project roots); adding a skill under a watched root must produce a fresh
// available_commands_update for the live session without any client request.

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { commandNames, newSession, prompt } from "./support/scenarios.js"

const WATCHER_TIMEOUT_MS = 20_000

function writeTestSkill(root: string, name: string, description: string): void {
	mkdirSync(join(root, name), { recursive: true })
	writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`, "utf-8")
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

// An initial palette says resources were loaded, not that native file watching
// has attached. A separate probe skill establishes readiness through an actual
// palette update before the single upload/delete operation under test.
async function waitForSkillWatcher(fixture: AcpFixture, sessionId: string, root: string): Promise<void> {
	const deadline = Date.now() + WATCHER_TIMEOUT_MS
	let revision = 0
	while (Date.now() < deadline) {
		writeTestSkill(root, "e2e-watcher-ready", `Watcher readiness probe ${revision++}`)
		// Allow both 250ms debounce stages to flush before another probe write.
		await delay(1000)
		if (commandNames(fixture, sessionId).includes("skill:e2e-watcher-ready")) return
	}
	throw new Error("skill watcher never re-advertised the readiness probe")
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
			await waitForSkillWatcher(fixture, sessionId, harnessSkills)
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
			await waitForSkillWatcher(fixture, sessionId, harnessSkills)

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

	it(
		"serves the refreshed skill list in the next request's system prompt without restarting anything",
		async () => {
			fixture = await startAcpFixture({ artifactName: "skill-refresh-prompt", responses: [{ stream: ["Done."] }] })
			const sessionId = await newSession(fixture, fixture.workDir)
			await waitForBaseline(fixture, sessionId)

			const harnessSkills = join(fixture.homeDir, ".config", "kimchi", "harness", "skills")
			await waitForSkillWatcher(fixture, sessionId, harnessSkills)
			writeTestSkill(harnessSkills, "e2e-prompt-skill", "E2E prompt-injected skill")
			expect(await lastUpdateIncludes(fixture, sessionId, "skill:e2e-prompt-skill")).toBe(true)

			// The palette update alone is not enough: the next outgoing model
			// request must carry the refreshed skill list in its system prompt.
			// The refresh sweep rebuilds the prompt options against the committed
			// skills snapshot — no session restart, no extension reload (the
			// single-load contract: same runner, same tool set).
			const result = await prompt(fixture, sessionId, "say done")
			expect(result.stopReason, "turn stop reason").toBe("end_turn")

			// Select the CONVERSATION request (the one carrying the user's
			// prompt) — a session-title namer request races alongside it.
			const chatRequests = fixture.fake.requests.filter(
				(request) =>
					request.url.endsWith("/chat/completions") &&
					request.body !== null &&
					typeof request.body === "object" &&
					Array.isArray((request.body as { messages?: unknown[] }).messages) &&
					(request.body as { messages: Array<{ role: string; content: unknown }> }).messages.some(
						(m) => m.role === "user" && JSON.stringify(m.content).includes("say done"),
					),
			)
			expect(chatRequests.length).toBeGreaterThan(0)
			const system = (
				chatRequests[0]?.body as { messages: Array<{ role: string; content: unknown }> }
			).messages.find((m) => m.role === "system")
			const systemText = typeof system?.content === "string" ? system.content : JSON.stringify(system?.content ?? "")
			expect(systemText).toContain("e2e-prompt-skill")
		},
		STARTUP_TIMEOUT_MS + WATCHER_TIMEOUT_MS,
	)
})
