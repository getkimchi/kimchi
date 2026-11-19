import { readFileSync } from "node:fs"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import {
	chatAuthorization,
	EXPIRING_ACCESS_TOKEN,
	REFRESH_CONTINUED_REPLY,
	REPLACEMENT_ACCESS_TOKEN,
	seedExpiringOAuthCredential,
	startFakeOAuthRefreshServer,
} from "./support/oauth-refresh.js"

test.use(TUI_TEST_CONFIG)

test("an active prompt refreshes and persists OAuth before continuing without sign-in", async ({ terminal }) => {
	const oauth = await startFakeOAuthRefreshServer()
	let authPath = ""
	try {
		await runKimchiSession(
			terminal,
			{
				artifactName: "oauth-prompt-refresh",
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
			async (fixture) => {
				terminal.submit("Continue with the refreshed credential")
				await expect(terminal.getByText(REFRESH_CONTINUED_REPLY, { full: true })).toBeVisible()

				expect(oauth.grants).toEqual([{ grantType: "refresh_token", refreshToken: "e2e-original-refresh" }])
				const stored = JSON.parse(readFileSync(authPath, "utf-8")) as Record<
					string,
					{ access?: string; refresh?: string }
				>
				for (const providerId of ["kimchi-dev", "kimchi-dev/openai"]) {
					expect(stored[providerId]?.access).toBe(REPLACEMENT_ACCESS_TOKEN)
					expect(stored[providerId]?.refresh).toBe("e2e-rotated-refresh")
				}

				terminal.submit("Continue again with the persisted credential")
				await expect(terminal.getByText("Refreshed follow-up continued.", { full: true })).toBeVisible()

				const authorizations = fixture.fake.requests.map(chatAuthorization).filter((value) => value !== undefined)
				expect(authorizations).toEqual([`Bearer ${REPLACEMENT_ACCESS_TOKEN}`, `Bearer ${REPLACEMENT_ACCESS_TOKEN}`])
				expect(oauth.grants).toHaveLength(1)
				await expect(terminal.getByText("Sign in", { full: false })).not.toBeVisible()
				await expect(terminal.getByText("auth required", { full: false })).not.toBeVisible()
			},
		)
	} finally {
		await oauth.close()
	}
})

test("a revoked grant exposes the existing sign-in action without crashing the session", async ({ terminal }) => {
	const oauth = await startFakeOAuthRefreshServer()
	try {
		await runKimchiSession(
			terminal,
			{
				artifactName: "oauth-prompt-refresh-revoked",
				providerId: "kimchi-dev/openai",
				responses: [],
				seedHome: (homeDir) => seedExpiringOAuthCredential(homeDir, oauth.tokenUrl),
			},
			async () => {
				oauth.revokeGrants()
				terminal.submit("Use the revoked credential")
				await waitForText(terminal, "Run /login to sign in again", { timeoutMs: STREAM_TIMEOUT_MS })
				await waitForText(terminal, PROMPT_READY, { timeoutMs: STREAM_TIMEOUT_MS })
			},
		)
	} finally {
		await oauth.close()
	}
})
