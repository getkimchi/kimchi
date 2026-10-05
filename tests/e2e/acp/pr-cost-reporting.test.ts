import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

let fixture: AcpFixture | undefined
afterEach(async () => {
	await fixture?.stop()
})

it("exposes explicit PR-reporting consent and status in Studio without inference", async () => {
	const active = await startAcpFixture({
		artifactName: "pr-cost-reporting",
		responses: [],
		clientMeta: { "kimchi.dev": { pi_notify: true } },
	})
	fixture = active
	const sessionId = await newSession(active, active.workDir)
	const path = join(active.homeDir, ".config/kimchi/harness/pr-cost-reporting/state.json")
	const command = async (text: string, message: string) => {
		const after = active.client.extNotifications.length
		expect((await prompt(active, sessionId, text)).stopReason).toBe("end_turn")
		await expect
			.poll(() => active.client.extNotifications.slice(after))
			.toContainEqual({
				method: "_kimchi.dev/pi_notify",
				params: expect.objectContaining({ sessionId, message: expect.stringContaining(message) }),
			})
	}
	await command("/pr-reporting status", "PR reporting: off")
	expect(existsSync(path)).toBe(false)
	await command("/pr-reporting on", "PR reporting on.")
	expect(JSON.parse(readFileSync(path, "utf8")).enabled).toBe(true)
	await command("/pr-reporting off", "Pending uploads were deleted")
	expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ enabled: false, entries: {} })
	expect(active.fake.requests.filter((request) => request.url.includes("/chat/completions"))).toHaveLength(0)
})
