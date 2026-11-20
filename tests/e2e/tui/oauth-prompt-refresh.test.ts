import { readFileSync } from "node:fs"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import {
	chatAuthorization,
	EXPIRING_ACCESS_TOKEN,
	expireSeededOAuthCredential,
	REFRESH_CONTINUED_REPLY,
	REPLACEMENT_ACCESS_TOKEN,
	seedExpiringOAuthCredential,
	startFakeOAuthRefreshServer,
} from "./support/oauth-refresh.js"

test.use(TUI_TEST_CONFIG)

for (const replacementExpiresInSeconds of [3600, 60]) {
	test(`an active prompt reuses a ${replacementExpiresInSeconds}s replacement without a second grant`, async ({
		terminal,
	}) => {
		const oauth = await startFakeOAuthRefreshServer({ expiresInSeconds: replacementExpiresInSeconds })
		let authPath = ""
		try {
			await runKimchiSession(
				terminal,
				{
					artifactName: `oauth-prompt-refresh-${replacementExpiresInSeconds}`,
					providerId: "kimchi-dev/openai",
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
				},
				async (fixture, trace) => {
					expireSeededOAuthCredential(authPath)
					terminal.submit("Continue with the refreshed credential")
					await expect(terminal.getByText(REFRESH_CONTINUED_REPLY, { full: true })).toBeVisible()

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

					trace.step("refreshed continuation persisted on canonical and active providers")

					terminal.submit("Continue again with the persisted credential")
					await expect(terminal.getByText("Refreshed follow-up continued.", { full: true })).toBeVisible()

					const authorizations = fixture.fake.requests.map(chatAuthorization).filter((value) => value !== undefined)
					expect(authorizations).toEqual([`Bearer ${REPLACEMENT_ACCESS_TOKEN}`, `Bearer ${REPLACEMENT_ACCESS_TOKEN}`])
					expect(oauth.grants).toHaveLength(replacementExpiresInSeconds === 60 ? 2 : 1)
					const afterFollowUp = JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, Record<string, unknown>>
					for (const field of ["access", "refresh", "expires"]) {
						expect(afterFollowUp["kimchi-dev/openai"]?.[field]).toBe(afterFollowUp["kimchi-dev"]?.[field])
					}
					await expect(terminal.getByText("Sign in", { full: false })).not.toBeVisible()
					await expect(terminal.getByText("auth required", { full: false })).not.toBeVisible()
					trace.step("persisted follow-up completed without another same-prompt grant or sign-in")
				},
			)
		} finally {
			await oauth.close()
		}
	})
}

test("a revoked grant exposes the existing sign-in action without crashing the session", async ({ terminal }) => {
	const oauth = await startFakeOAuthRefreshServer()
	let authPath = ""
	try {
		await runKimchiSession(
			terminal,
			{
				artifactName: "oauth-prompt-refresh-revoked",
				providerId: "kimchi-dev/openai",
				responses: [],
				seedHome: (homeDir) => {
					authPath = seedExpiringOAuthCredential(homeDir, oauth.tokenUrl)
				},
			},
			async (_fixture, trace) => {
				expireSeededOAuthCredential(authPath)
				oauth.revokeGrants()
				terminal.submit("Use the revoked credential")
				await waitForText(terminal, "Run /login to sign in again", { timeoutMs: STREAM_TIMEOUT_MS })
				await waitForText(terminal, PROMPT_READY, { timeoutMs: STREAM_TIMEOUT_MS })
				trace.step("revoked grant exposed the sign-in action and returned to a ready prompt")
			},
		)
	} finally {
		await oauth.close()
	}
})
