import { afterEach, describe, expect, it } from "vitest"
import { requestToolNames } from "../tui/support/request-tools.js"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

describe("ACP integration — Director lifecycle", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
	})

	it(
		"starts visibly, restricts provider tools across steering, and restores tools on stop",
		async () => {
			fixture = await startAcpFixture({
				artifactName: "acp-director-lifecycle",
				responses: [
					{ stream: ["Director active."] },
					{ stream: ["Steering continues."] },
					{ stream: ["Normal chat."] },
				],
			})
			const sessionId = await newSession(fixture, fixture.workDir)
			await prompt(fixture, sessionId, "/skill:director demo objective")
			await prompt(fixture, sessionId, "continue with this objective")

			expect(JSON.stringify(fixture.client.extNotifications)).toContain(
				'"statusKey":"director","statusText":"Director — demo objective"',
			)
			const activeTools = requestToolNames(fixture.fake.requests.at(-1) ?? {})
			const allowed = new Set([
				"Agent",
				"resume_subagent",
				"steer_subagent",
				"get_subagent_result",
				"questionnaire",
				"skill_view",
				"director_plan",
				"director_finish",
			])
			for (const name of activeTools) expect(allowed.has(name)).toBe(true)
			// Existing agent deferral hides continuation tools until the first worker exists.
			expect(activeTools).toContain("Agent")
			expect(activeTools).toContain("director_plan")
			expect(activeTools).toContain("director_finish")

			await prompt(fixture, sessionId, "/director status")
			expect(JSON.stringify(fixture.client.extNotifications)).toContain("Director active: demo objective")
			await prompt(fixture, sessionId, "/director stop")
			await prompt(fixture, sessionId, "return to normal work")

			const restoredTools = requestToolNames(fixture.fake.requests.at(-1) ?? {})
			expect(restoredTools).toContain("read")
			expect(restoredTools).not.toContain("director_plan")
			const directorStatuses = fixture.client.extNotifications
				.map((notification) => notification.params as { statusKey?: string; statusText?: string })
				.filter((params) => params.statusKey === "director")
			expect(directorStatuses.at(-1)?.statusText).toBeUndefined()
		},
		STARTUP_TIMEOUT_MS * 2 + 30_000,
	)
})
