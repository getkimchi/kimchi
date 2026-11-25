import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	chatAuthorization,
	EXPIRING_ACCESS_TOKEN,
	expireSeededOAuthCredential,
	type FakeOAuthRefreshServer,
	REFRESH_CONTINUED_REPLY,
	REPLACEMENT_ACCESS_TOKEN,
	seedExpiringOAuthCredential,
	startFakeOAuthRefreshServer,
} from "../tui/support/oauth-refresh.js"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

for (const replacementExpiresInSeconds of [3600, 60]) {
	describe(`ACP integration — active prompt with a ${replacementExpiresInSeconds}s OAuth replacement`, () => {
		let fixture: AcpFixture
		let oauth: FakeOAuthRefreshServer
		let authPath = ""

		beforeEach(async () => {
			oauth = await startFakeOAuthRefreshServer({ expiresInSeconds: replacementExpiresInSeconds })
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
			expireSeededOAuthCredential(authPath)

			const result = await prompt(fixture, sessionId, "Continue with the refreshed credential")

			expect(result.stopReason).toBe("end_turn")
			expect(result.chunks).toBe(REFRESH_CONTINUED_REPLY)
			expect(oauth.grants).toEqual([{ grantType: "refresh_token", refreshToken: "e2e-original-refresh" }])
			const stored = JSON.parse(readFileSync(authPath, "utf-8")) as Record<
				string,
				{ access?: string; refresh?: string; expires?: number }
			>
			for (const providerId of ["kimchi-dev", "kimchi-dev/openai"]) {
				expect(stored[providerId]?.access).toBe(REPLACEMENT_ACCESS_TOKEN)
				expect(stored[providerId]?.refresh).toBe("e2e-rotated-refresh")
				expect(stored[providerId]?.expires).toBe(stored["kimchi-dev"]?.expires)
			}
			const followUp = await prompt(fixture, sessionId, "Continue again with the persisted credential")
			expect(followUp.stopReason).toBe("end_turn")
			expect(followUp.chunks).toBe(`${REFRESH_CONTINUED_REPLY}Refreshed follow-up continued.`)
			expect(oauth.grants).toHaveLength(replacementExpiresInSeconds === 60 ? 2 : 1)
			const afterFollowUp = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, Record<string, unknown>>
			for (const field of ["access", "refresh", "expires"]) {
				expect(afterFollowUp["kimchi-dev/openai"]?.[field]).toBe(afterFollowUp["kimchi-dev"]?.[field])
			}
			const authorizations = fixture.fake.requests.map(chatAuthorization).filter((value) => value !== undefined)
			expect(authorizations).toEqual([`Bearer ${REPLACEMENT_ACCESS_TOKEN}`, `Bearer ${REPLACEMENT_ACCESS_TOKEN}`])

			const updatesBeforeReplay = fixture.client.sessionUpdates.length
			await fixture.conn.request("session/load", { sessionId, cwd: fixture.workDir, mcpServers: [] })
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
			expect(
				fixture.client.sessionUpdates.every(({ sessionId: updateSessionId }) => updateSessionId === sessionId),
			).toBe(true)
		})

		it("keeps prepared credentials independent across two sessions using the same auth store", async () => {
			const sessionA = await newSession(fixture, fixture.workDir)
			const sessionB = await newSession(fixture, fixture.workDir)
			expireSeededOAuthCredential(authPath)
			const resultA = await prompt(fixture, sessionA, "Continue in the first session")
			const resultB = await prompt(fixture, sessionB, "Continue in the second session")

			expect(resultA.stopReason).toBe("end_turn")
			expect(resultB.stopReason).toBe("end_turn")
			expect(oauth.grants).toHaveLength(replacementExpiresInSeconds === 60 ? 2 : 1)
			const stored = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, Record<string, unknown>>
			for (const field of ["access", "refresh", "expires"]) {
				expect(stored["kimchi-dev/openai"]?.[field]).toBe(stored["kimchi-dev"]?.[field])
			}
			const authorizations = fixture.fake.requests.map(chatAuthorization).filter((value) => value !== undefined)
			expect(authorizations).toEqual([`Bearer ${REPLACEMENT_ACCESS_TOKEN}`, `Bearer ${REPLACEMENT_ACCESS_TOKEN}`])
		})

		it("returns the ordinary auth-required outcome for a revoked refresh grant", async () => {
			oauth.revokeGrants()
			const sessionId = await newSession(fixture, fixture.workDir)
			expireSeededOAuthCredential(authPath)

			const error = await fixture.conn
				.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "Use the revoked credential" }] })
				.then(
					() => undefined,
					(failure: unknown) => failure,
				)

			expect(error).toMatchObject({ code: -32000, message: expect.stringContaining("auth required") })
			expect(oauth.grants).toHaveLength(1)
		})
	})
}

describe("ACP integration — short-lived replacement through a tool continuation", () => {
	let fixture: AcpFixture
	let oauth: FakeOAuthRefreshServer
	let authPath = ""
	const command = "printf 'oauth-continuation-done\\n'"

	beforeEach(async () => {
		oauth = await startFakeOAuthRefreshServer({ expiresInSeconds: 60 })
		fixture = await startAcpFixture({
			artifactName: "oauth-prompt-refresh-tool-continuation",
			providerId: "kimchi-dev/openai",
			defaultModel: "basic",
			responses: [
				{
					match: (request) => request.headers.authorization === `Bearer ${REPLACEMENT_ACCESS_TOKEN}`,
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({ command, description: "Check OAuth tool continuation" }),
							},
						},
					],
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

	it("shares one grant across both model requests and clears reuse for the next prompt", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		expireSeededOAuthCredential(authPath)

		const result = await prompt(fixture, sessionId, "Use a tool with the refreshed credential")

		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toBe(REFRESH_CONTINUED_REPLY)
		expect(oauth.grants).toHaveLength(1)
		expect(fixture.fake.requests.map(chatAuthorization).filter((value) => value !== undefined)).toEqual([
			`Bearer ${REPLACEMENT_ACCESS_TOKEN}`,
			`Bearer ${REPLACEMENT_ACCESS_TOKEN}`,
		])
		const toolCalls = fixture.client.sessionUpdates
			.map(({ update }) => update)
			.filter((update) => update.sessionUpdate === "tool_call")
		expect(toolCalls).toHaveLength(1)
		expect(toolCalls[0]).toMatchObject({ rawInput: { command, description: "Check OAuth tool continuation" } })
		const stored = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, Record<string, unknown>>
		for (const field of ["access", "refresh", "expires"]) {
			expect(stored["kimchi-dev/openai"]?.[field]).toBe(stored["kimchi-dev"]?.[field])
		}

		const followUp = await prompt(fixture, sessionId, "Continue in a separate prompt")
		expect(followUp.stopReason).toBe("end_turn")
		expect(followUp.chunks).toBe(`${REFRESH_CONTINUED_REPLY}Refreshed follow-up continued.`)
		expect(oauth.grants).toHaveLength(2)
		const afterFollowUp = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, Record<string, unknown>>
		for (const field of ["access", "refresh", "expires"]) {
			expect(afterFollowUp["kimchi-dev/openai"]?.[field]).toBe(afterFollowUp["kimchi-dev"]?.[field])
		}
	})
})

describe("ACP integration — transient canonical refresh failure", () => {
	let fixture: AcpFixture
	let oauth: FakeOAuthRefreshServer
	let authPath = ""

	beforeEach(async () => {
		oauth = await startFakeOAuthRefreshServer({ failFirstGrant: true })
		fixture = await startAcpFixture({
			artifactName: "oauth-prompt-refresh-transient",
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

	it("rejects unsafe active-only fallback and synchronizes on the next prompt", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		expireSeededOAuthCredential(authPath)

		const error = await fixture.conn
			.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "Request before a transient refresh failure" }],
			})
			.then(
				() => undefined,
				(failure: unknown) => failure,
			)

		expect(error).toMatchObject({ code: -32603, message: expect.stringContaining("Retry this prompt") })
		expect(oauth.grants).toHaveLength(1)
		const beforeRetry = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, { access?: string }>
		for (const providerId of ["kimchi-dev", "kimchi-dev/openai"]) {
			expect(beforeRetry[providerId]?.access).toBe(EXPIRING_ACCESS_TOKEN)
		}

		const result = await prompt(fixture, sessionId, "Retry after transient refresh failure")
		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toBe(REFRESH_CONTINUED_REPLY)
		expect(oauth.grants).toEqual([
			{ grantType: "refresh_token", refreshToken: "e2e-original-refresh" },
			{ grantType: "refresh_token", refreshToken: "e2e-original-refresh" },
		])
		const stored = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, Record<string, unknown>>
		for (const field of ["access", "refresh", "expires"]) {
			expect(stored["kimchi-dev/openai"]?.[field]).toBe(stored["kimchi-dev"]?.[field])
		}
		const authorizations = fixture.fake.requests.map(chatAuthorization).filter((value) => value !== undefined)
		expect(authorizations).toEqual([`Bearer ${REPLACEMENT_ACCESS_TOKEN}`])
	})
})
