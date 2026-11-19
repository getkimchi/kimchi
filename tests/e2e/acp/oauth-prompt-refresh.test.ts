import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	chatAuthorization,
	EXPIRING_ACCESS_TOKEN,
	type FakeOAuthRefreshServer,
	REFRESH_CONTINUED_REPLY,
	REPLACEMENT_ACCESS_TOKEN,
	seedExpiringOAuthCredential,
	startFakeOAuthRefreshServer,
} from "../tui/support/oauth-refresh.js"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

describe("ACP integration — OAuth refresh during an active prompt", () => {
	let fixture: AcpFixture
	let oauth: FakeOAuthRefreshServer
	let authPath = ""

	beforeEach(async () => {
		oauth = await startFakeOAuthRefreshServer()
		fixture = await startAcpFixture({
			artifactName: "oauth-prompt-refresh",
			providerId: "kimchi-dev/openai",
			defaultModel: "basic",
			responses: [
				{
					match: (request) => request.headers.authorization === `Bearer ${EXPIRING_ACCESS_TOKEN}`,
					status: 401,
					body: { error: "Expired fake token" },
				},
				{
					match: (request) => request.headers.authorization === `Bearer ${REPLACEMENT_ACCESS_TOKEN}`,
					stream: [REFRESH_CONTINUED_REPLY],
				},
				{
					match: (request) => request.headers.authorization === `Bearer ${REPLACEMENT_ACCESS_TOKEN}`,
					stream: ["Refreshed follow-up continued."],
				},
			],
			seedHome: (homeDir) => {
				authPath = seedExpiringOAuthCredential(homeDir, oauth.tokenUrl)
			},
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
		await oauth.close()
	})

	it("refreshes and persists OAuth while preserving the prompt and ordinary session updates", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		const result = await prompt(fixture, sessionId, "Continue with the refreshed credential")

		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toBe(REFRESH_CONTINUED_REPLY)
		expect(oauth.grants).toEqual([{ grantType: "refresh_token", refreshToken: "e2e-original-refresh" }])
		const stored = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, { access?: string; refresh?: string }>
		for (const providerId of ["kimchi-dev", "kimchi-dev/openai"]) {
			expect(stored[providerId]?.access).toBe(REPLACEMENT_ACCESS_TOKEN)
			expect(stored[providerId]?.refresh).toBe("e2e-rotated-refresh")
		}
		const followUp = await prompt(fixture, sessionId, "Continue again with the persisted credential")
		expect(followUp.stopReason).toBe("end_turn")
		expect(followUp.chunks).toBe(`${REFRESH_CONTINUED_REPLY}Refreshed follow-up continued.`)
		expect(oauth.grants).toHaveLength(1)
		const authorizations = fixture.fake.requests.map(chatAuthorization).filter((value) => value !== undefined)
		expect(authorizations).toEqual([`Bearer ${REPLACEMENT_ACCESS_TOKEN}`, `Bearer ${REPLACEMENT_ACCESS_TOKEN}`])

		const updatesBeforeReplay = fixture.client.sessionUpdates.length
		await fixture.conn.loadSession({ sessionId, cwd: fixture.workDir, mcpServers: [] })
		const replayedText = fixture.client.sessionUpdates
			.slice(updatesBeforeReplay)
			.filter(({ update }) => update.sessionUpdate === "agent_message_chunk")
			.map(({ update }) =>
				update.sessionUpdate === "agent_message_chunk" && update.content.type === "text" ? update.content.text : "",
			)
			.join("")
		expect(replayedText).toBe(`${REFRESH_CONTINUED_REPLY}Refreshed follow-up continued.`)

		expect(fixture.client.permissionRequests).toHaveLength(0)
		expect(fixture.client.elicitationRequests).toHaveLength(0)
		expect(fixture.client.sessionUpdates.every(({ sessionId: updateSessionId }) => updateSessionId === sessionId)).toBe(
			true,
		)
	})
})
