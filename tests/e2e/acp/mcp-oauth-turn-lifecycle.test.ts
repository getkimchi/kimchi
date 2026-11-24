import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import type * as acp from "@agentclientprotocol/sdk"
import { expect, it } from "vitest"
import type { FakeResponseScript } from "../tui/support/fake-openai-server.js"
import { createMcpFixture, mcpToolResult, oauthBrowserDriverScript } from "../tui/support/mcp-fixture.js"
import { gatewayMcpCall, modelReply, toolResultText } from "../tui/support/mcp-model-script.js"
import { type AcpMcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture, startAcpMcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const OAUTH_SETTLE_QUIET_MS = 300
const OAUTH_ACTION_TIMEOUT_MS = 15_000
const OAUTH_PROMPT_TEXT = "Authenticate the MCP server, then call its protected echo tool"
const LIFECYCLE_EXTENSION = fileURLToPath(new URL("./support/test-agent-lifecycle-extension.js", import.meta.url))
const OAUTH_TURN_META = { "kimchi.dev": { mcpOAuthTurn: true } }

type LifecycleEntry = { type: string; sessionId: string; toolName?: string; toolCallId?: string }

function lifecycleEntries(homeDir: string, sessionId: string): LifecycleEntry[] {
	const path = join(homeDir, ".config", "kimchi", "harness", "acp-test-agent-lifecycle.jsonl")
	if (!existsSync(path)) return []
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as LifecycleEntry)
		.filter((entry) => entry.sessionId === sessionId)
}

function agentEndCount(homeDir: string, sessionId: string): number {
	return lifecycleEntries(homeDir, sessionId).filter((entry) => entry.type === "agent_end").length
}

function oauthPrompt(): acp.PromptRequest["prompt"] {
	return [{ type: "text", text: OAUTH_PROMPT_TEXT }]
}

async function withTimeout<T>(promise: Promise<T>, description: string): Promise<T> {
	return Promise.race([
		promise,
		delay(OAUTH_ACTION_TIMEOUT_MS).then(() => {
			throw new Error(`${description} did not settle within ${OAUTH_ACTION_TIMEOUT_MS}ms`)
		}),
	])
}

async function openAuthorization(target: string): Promise<Response> {
	const response = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(OAUTH_ACTION_TIMEOUT_MS) })
	await response.text()
	return response
}

async function occupyOAuthCallbackPort(): Promise<() => Promise<void>> {
	const blocker = createServer()
	await new Promise<void>((resolve, reject) => {
		blocker.once("error", reject)
		blocker.listen(19_876, "127.0.0.1", resolve)
	})
	return () =>
		new Promise<void>((resolve, reject) => {
			blocker.close((error) => (error ? reject(error) : resolve()))
		})
}

function withPromptMatch(script: FakeResponseScript, promptText: string): FakeResponseScript {
	return { ...script, match: (request) => JSON.stringify(request.body).includes(promptText) }
}

function modelReplyForPrompt(promptText: string, responseText: string): FakeResponseScript {
	return withPromptMatch(modelReply(responseText), promptText)
}

function authStartForPrompt(
	serverName: string,
	promptText: string,
	id = `oauth-start-${serverName}`,
): FakeResponseScript {
	return withPromptMatch(
		{
			toolCalls: [
				{
					id,
					function: { name: "mcp", arguments: JSON.stringify({ action: "auth-start", server: serverName }) },
				},
			],
		},
		promptText,
	)
}

type ToolCallUpdate = Extract<acp.SessionUpdate, { sessionUpdate: "tool_call_update" }>

function oauthToolOutput(fixture: AcpMcpFixture, text: string, startIndex = 0): ToolCallUpdate["rawOutput"] {
	const match = fixture.client.sessionUpdates
		.slice(startIndex)
		.find(
			({ update }) =>
				update.sessionUpdate === "tool_call_update" && JSON.stringify(update.rawOutput ?? {}).includes(text),
		)
	if (match?.update.sessionUpdate !== "tool_call_update") {
		throw new Error(`missing ACP tool_call_update containing ${text}`)
	}
	return match.update.rawOutput
}

it(
	"preserves legacy OAuth boundaries for an unnegotiated client",
	async () => {
		const echo = gatewayMcpCall("echo", { message: "oauth-turn-legacy" })
		const fixture = await startAcpMcpFixture({
			artifactName: "acp-mcp-oauth-turn-legacy-capability",
			extensionPath: LIFECYCLE_EXTENSION,
			// A plain client declares no mcpOAuthTurn and no background-run opt-in.
			clientMeta: { "kimchi.dev": { backgroundRuns: false } },
			mcp: {
				transport: "oauth",
				oauthAutoComplete: false,
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: oauth-turn-legacy" }] },
							{ message: "oauth-turn-legacy" },
						),
					],
				},
			},
			responses: [
				authStartForPrompt("fixture", OAUTH_PROMPT_TEXT, "oauth-start-legacy"),
				echo.response,
				modelReply("Authorization instructions returned."),
				modelReply("OAuth follow-up completed after browser authorization."),
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const first = await withTimeout(prompt(fixture, sessionId, OAUTH_PROMPT_TEXT), "unnegotiated OAuth prompt")
			expect(first.stopReason).toBe("end_turn")
			expect(agentEndCount(fixture.homeDir, sessionId)).toBe(1)
			expect(fixture.mcp.eventsOfType("tool_called")).toHaveLength(0)
			const modelRequestsBeforeAuthorization = fixture.fake.requests.length

			const opened = await fixture.mcp.waitForEvent("oauth_browser_opened", {
				description: "legacy MCP OAuth authorization",
			})
			expect((await openAuthorization(opened.target)).ok).toBe(true)
			// Preserve the pre-gate lifecycle: the adapter's ordinary wake becomes
			// its own model run, not another phase of the original client prompt.
			await expect
				.poll(() => agentEndCount(fixture.homeDir, sessionId), { message: "legacy adapter follow-up" })
				.toBe(2)
			expect(fixture.fake.requests.length).toBeGreaterThan(modelRequestsBeforeAuthorization)
			expect(fixture.initializeResponse.agentCapabilities._meta).toMatchObject(OAUTH_TURN_META)

			await delay(OAUTH_SETTLE_QUIET_MS)
			expect(agentEndCount(fixture.homeDir, sessionId)).toBe(2)
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"keeps the originating prompt pending until OAuth and all resumed work complete",
	async () => {
		const echo = gatewayMcpCall("echo", { message: "oauth-turn-success" })
		const fixture = await startAcpMcpFixture({
			clientMeta: OAUTH_TURN_META,
			artifactName: "acp-mcp-oauth-turn-success",
			extensionPath: LIFECYCLE_EXTENSION,
			mcp: {
				transport: "oauth",
				oauthAutoComplete: false,
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: oauth-turn-success" }] },
							{ message: "oauth-turn-success" },
						),
					],
				},
			},
			responses: [
				authStartForPrompt("fixture", OAUTH_PROMPT_TEXT, "oauth-start-success"),
				echo.response,
				modelReply("OAuth and the protected call completed."),
				modelReplyForPrompt("Send the first follow-up", "The first prompt after OAuth is normal."),
				modelReplyForPrompt("Send the second follow-up", "The second prompt after OAuth is normal."),
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			let response: acp.PromptResponse | undefined
			let failure: unknown
			const pending = fixture.conn.request("session/prompt", { sessionId, prompt: oauthPrompt() }).then(
				(result) => {
					response = result
				},
				(error: unknown) => {
					failure = error
				},
			)

			const opened = await fixture.mcp.waitForEvent("oauth_browser_opened", {
				description: "held MCP OAuth authorization",
			})
			await delay(OAUTH_SETTLE_QUIET_MS)

			// Required invariant: waiting for browser authorization must not settle
			// the ACP request that started OAuth.
			expect(failure).toBeUndefined()
			expect(response).toBeUndefined()
			expect(agentEndCount(fixture.homeDir, sessionId)).toBe(0)

			const browserResponse = await openAuthorization(opened.target)
			expect(browserResponse.ok).toBe(true)
			await fixture.mcp.waitForEvent("oauth_token_issued", {
				where: { grantType: "authorization_code", pkceVerified: true },
			})
			await withTimeout(pending, "successful OAuth prompt")

			expect(failure).toBeUndefined()
			expect(response?.stopReason).toBe("end_turn")
			expect(fixture.client.agentTextBySession().get(sessionId)).toContain("OAuth and the protected call completed.")
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "oauth-turn-success" } },
			})
			expect(fixture.mcp.eventsOfType("tool_called")).toHaveLength(1)
			expect(
				fixture.client.extNotifications.filter((n) => n.method === "_kimchi.dev/background_run_start"),
			).toHaveLength(0)

			const completedEvents = lifecycleEntries(fixture.homeDir, sessionId)
			expect(agentEndCount(fixture.homeDir, sessionId)).toBe(1)
			const terminalIndex = completedEvents.findIndex((entry) => entry.type === "agent_end")
			const protectedCallIndex = completedEvents.findIndex(
				(entry) => entry.type === "tool_execution_end" && entry.toolCallId === echo.id,
			)
			const finalModelIndex = completedEvents.findLastIndex((entry) => entry.type === "message_end")
			expect(protectedCallIndex).toBeGreaterThanOrEqual(0)
			expect(finalModelIndex).toBeGreaterThan(protectedCallIndex)
			expect(terminalIndex).toBeGreaterThan(finalModelIndex)
			expect(completedEvents.at(-1)?.type).toBe("agent_end")

			// No model or connector work belonging to the completed turn may arrive
			// after its ACP and transcript terminal boundaries.
			const modelRequests = fixture.fake.requests.length
			const connectorCalls = fixture.mcp.eventsOfType("tool_called").length
			await delay(OAUTH_SETTLE_QUIET_MS)
			expect(fixture.fake.requests).toHaveLength(modelRequests)
			expect(fixture.mcp.eventsOfType("tool_called")).toHaveLength(connectorCalls)
			expect(agentEndCount(fixture.homeDir, sessionId)).toBe(1)

			for (const [request, expected] of [
				["Send the first follow-up", "The first prompt after OAuth is normal."],
				["Send the second follow-up", "The second prompt after OAuth is normal."],
			] as const) {
				const next = await prompt(fixture, sessionId, request)
				expect(next.stopReason).toBe("end_turn")
				expect(next.chunks).toContain(expected)
			}
			// Later prompts neither repeat the protected call nor inherit the
			// OAuth turn's lifecycle.
			expect(fixture.mcp.eventsOfType("tool_called")).toHaveLength(1)
			expect(agentEndCount(fixture.homeDir, sessionId)).toBe(3)
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"captures an OAuth callback that completes during auth-start execution",
	async () => {
		const echo = gatewayMcpCall("echo", { message: "oauth-fast-callback" })
		const fixture = await startAcpMcpFixture({
			clientMeta: OAUTH_TURN_META,
			artifactName: "acp-mcp-oauth-turn-fast-callback",
			extensionPath: LIFECYCLE_EXTENSION,
			mcp: {
				transport: "oauth",
				oauthAutoComplete: true,
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: oauth-fast-callback" }] },
							{ message: "oauth-fast-callback" },
						),
					],
				},
			},
			responses: [
				authStartForPrompt("fixture", OAUTH_PROMPT_TEXT, "oauth-fast-start"),
				echo.response,
				modelReply("The fast OAuth callback completed in the original run."),
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const result = await prompt(fixture, sessionId, OAUTH_PROMPT_TEXT)
			expect(result.stopReason).toBe("end_turn")
			expect(result.chunks).toContain("The fast OAuth callback completed in the original run.")
			await fixture.mcp.waitForEvent("oauth_browser_completed")
			await fixture.mcp.waitForEvent("oauth_token_issued", { where: { grantType: "authorization_code" } })
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "oauth-fast-callback" } },
			})
			expect(oauthToolOutput(fixture, "OAuth authentication successful")).toMatchObject({ isError: false })
			expect(agentEndCount(fixture.homeDir, sessionId)).toBe(1)
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"returns immediately when auth-start finds an existing OAuth grant",
	async () => {
		const fixture = await startAcpMcpFixture({
			clientMeta: OAUTH_TURN_META,
			artifactName: "acp-mcp-oauth-turn-existing-grant",
			extensionPath: LIFECYCLE_EXTENSION,
			mcp: { transport: "oauth", oauthAutoComplete: true },
			responses: [
				authStartForPrompt("fixture", OAUTH_PROMPT_TEXT, "oauth-existing-grant"),
				modelReply("The existing grant completed without waiting for a watcher."),
			],
		})
		try {
			await fixture.conn.request("_kimchi.dev/probe_mcp_server", {
				server: fixture.mcp.serverDefinition,
				serverName: "fixture",
				authenticate: true,
			})
			await fixture.mcp.waitForEvent("oauth_token_issued", { where: { grantType: "authorization_code" } })

			const sessionId = await newSession(fixture, fixture.workDir)
			const result = await prompt(fixture, sessionId, OAUTH_PROMPT_TEXT)
			expect(result.stopReason).toBe("end_turn")
			expect(result.chunks).toContain("The existing grant completed without waiting for a watcher.")
			expect(fixture.mcp.eventsOfType("oauth_browser_opened")).toHaveLength(1)
			const grantOutput = oauthToolOutput(fixture, "OAuth authentication successful")
			expect(grantOutput).toMatchObject({ details: { authenticated: true } })
			expect(grantOutput).not.toHaveProperty("details.authorizationUrl")
			expect(fixture.mcp.eventsOfType("tool_called")).toHaveLength(0)
			expect(agentEndCount(fixture.homeDir, sessionId)).toBe(1)
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"consumes a late watcher status after a cancelled remote browser launch fails",
	async () => {
		const initialPrompt = "Start remote OAuth with a browser launch that is cancelled"
		const nextPrompt = "Continue after the remote browser-launch failure"
		const browserToolCallId = "oauth-remote-browser-cancel"
		const releaseFilename = "release-cancelled-oauth-browser"
		const fixture = await startAcpMcpFixture({
			clientMeta: OAUTH_TURN_META,
			artifactName: "acp-mcp-oauth-turn-remote-browser-cancel",
			extensionPath: LIFECYCLE_EXTENSION,
			seedHome: (homeDir) => {
				const agentDir = join(homeDir, ".config", "kimchi", "harness")
				const browserPath = join(agentDir, "mcp-oauth-browser", "open")
				const browserReleasePath = join(homeDir, releaseFilename)
				const driver = `${oauthBrowserDriverScript(join(agentDir, "mcp-fixture-fixture.jsonl"), {
					autoComplete: false,
				})}
import { existsSync } from "node:fs"
const browserReleaseStarted = Date.now()
while (!existsSync(${JSON.stringify(browserReleasePath)})) {
  if (Date.now() - browserReleaseStarted > 10_000) throw new Error("OAuth browser release timed out")
  await new Promise((resolve) => setTimeout(resolve, 25))
}
throw new Error("Fixture remote browser launch failed after cancellation")
`
				writeFileSync(browserPath, driver, "utf8")
				chmodSync(browserPath, 0o755)
			},
			mcp: {
				transport: "oauth",
				scenario: "oauth-token-failure",
				oauthAutoComplete: false,
				oauth: {
					scope: "mcp:tools",
					clientId: "remote-loopback-fixture",
					redirectUri: "https://app.kimchi.dev/mcp-oauth/callback-v2",
				},
			},
			responses: [
				authStartForPrompt("fixture", initialPrompt, browserToolCallId),
				modelReplyForPrompt("mcp-oauth-status", "Unexpected late OAuth follow-up."),
				modelReplyForPrompt(nextPrompt, "The next prompt works after watcher cleanup."),
			],
		})
		const releasePath = join(fixture.homeDir, releaseFilename)
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const original = fixture.conn.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: initialPrompt }],
			})
			const opened = await fixture.mcp.waitForEvent("oauth_browser_opened")
			expect(new URL(new URL(opened.target).searchParams.get("redirect_uri") ?? "").protocol).toBe("https:")

			await fixture.conn.notify("session/cancel", { sessionId })
			writeFileSync(releasePath, "release failed browser launch\n", "utf8")
			expect((await withTimeout(original, "cancelled remote browser launch")).stopReason).toBe("cancelled")

			// Wait for the actual failed tool result, not just the ACP cancellation.
			// The adapter must have gone through its post-watcher cleanup path.
			const toolResultDeadline = Date.now() + OAUTH_ACTION_TIMEOUT_MS
			while (
				!lifecycleEntries(fixture.homeDir, sessionId).some(
					(entry) => entry.type === "tool_execution_end" && entry.toolCallId === browserToolCallId,
				)
			) {
				if (Date.now() >= toolResultDeadline) throw new Error("Cancelled browser auth-start did not finish")
				await delay(25)
			}

			// Let the remote provider bounce to this watcher's local loopback
			// callback. Its token failure is the owned watcher's terminal status.
			const authorization = await fetch(opened.target, {
				redirect: "manual",
				signal: AbortSignal.timeout(OAUTH_ACTION_TIMEOUT_MS),
			})
			expect(authorization.status).toBe(302)
			const bounced = new URL(authorization.headers.get("location") ?? "")
			const callback = new URL("http://127.0.0.1:19876/callback")
			for (const name of ["code", "state"]) {
				const value = bounced.searchParams.get(name)
				if (!value) throw new Error(`OAuth callback fixture omitted ${name}`)
				callback.searchParams.set(name, value)
			}
			const modelRequestsBeforeStatus = fixture.fake.requests.length
			const terminalCount = agentEndCount(fixture.homeDir, sessionId)
			const callbackResponse = await fetch(callback, { signal: AbortSignal.timeout(OAUTH_ACTION_TIMEOUT_MS) })
			await callbackResponse.text()
			await fixture.mcp.waitForEvent("oauth_token_rejected", { where: { grantType: "authorization_code" } })
			await delay(OAUTH_SETTLE_QUIET_MS)

			expect(fixture.fake.requests).toHaveLength(modelRequestsBeforeStatus)
			expect(agentEndCount(fixture.homeDir, sessionId)).toBe(terminalCount)
			expect(fixture.mcp.eventsOfType("tool_called")).toHaveLength(0)
			expect(
				fixture.client.extNotifications.filter((n) => n.method === "_kimchi.dev/background_run_start"),
			).toHaveLength(0)

			const next = await prompt(fixture, sessionId, nextPrompt)
			expect(next.stopReason).toBe("end_turn")
			expect(next.chunks).toContain("The next prompt works after watcher cleanup.")
			expect(agentEndCount(fixture.homeDir, sessionId)).toBe(terminalCount + 1)
		} finally {
			writeFileSync(releasePath, "release during cleanup\n", "utf8")
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"documents the paste-only scope exception with a follow-up completion prompt",
	async () => {
		const manualPrompt = "Authenticate with a remote HTTPS callback"
		const completionPrompt = "Complete manual OAuth with the pasted callback"
		const completeToolCall = {
			id: "oauth-manual-complete",
			function: { name: "mcp", arguments: "" },
		}
		const echo = gatewayMcpCall("echo", { message: "oauth-manual-callback" })
		const releaseCallbackPort = await occupyOAuthCallbackPort()
		const fixture = await startAcpMcpFixture({
			clientMeta: OAUTH_TURN_META,
			artifactName: "acp-mcp-oauth-turn-remote-manual",
			extensionPath: LIFECYCLE_EXTENSION,
			mcp: {
				transport: "oauth",
				oauthAutoComplete: false,
				oauth: { scope: "mcp:tools", redirectUri: "https://app.kimchi.dev/mcp-oauth/callback-v2" },
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: oauth-manual-callback" }] },
							{ message: "oauth-manual-callback" },
						),
					],
				},
			},
			responses: [
				authStartForPrompt("fixture", manualPrompt, "oauth-manual-start"),
				modelReplyForPrompt(manualPrompt, "Paste the remote OAuth callback in the next prompt."),
				withPromptMatch({ toolCalls: [completeToolCall] }, completionPrompt),
				echo.response,
				modelReply("Manual OAuth and the protected call completed."),
			],
		}).catch(async (error: unknown) => {
			await releaseCallbackPort()
			throw error
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			// Explicit #797 exception: there is no callback watcher to complete.
			// Return instructions now, then let the user's callback drive auth-complete
			// and protected work in the subsequent ACP prompt and its own agent run.
			const first = await withTimeout(prompt(fixture, sessionId, manualPrompt), "remote manual auth-start")
			expect(first.stopReason).toBe("end_turn")
			expect(first.chunks).toContain("Paste the remote OAuth callback in the next prompt.")
			expect(agentEndCount(fixture.homeDir, sessionId)).toBe(1)

			const opened = await fixture.mcp.waitForEvent("oauth_browser_opened")
			const authorization = await fetch(opened.target, {
				redirect: "manual",
				signal: AbortSignal.timeout(OAUTH_ACTION_TIMEOUT_MS),
			})
			expect(authorization.status).toBe(302)
			const bounced = new URL(authorization.headers.get("location") ?? "")
			const redirectUrl = new URL("https://app.kimchi.dev/mcp-oauth/callback-v2")
			for (const name of ["code", "state"]) {
				const value = bounced.searchParams.get(name)
				if (!value) throw new Error(`OAuth callback fixture omitted ${name}`)
				redirectUrl.searchParams.set(name, value)
			}
			expect(fixture.mcp.eventsOfType("oauth_token_issued")).toHaveLength(0)
			expect(oauthToolOutput(fixture, "auth-complete")).toMatchObject({
				details: { authorizationUrl: opened.target, handoff: "manual" },
			})

			// The user supplies the full remote callback on a subsequent prompt;
			// substitute it into the scripted model's actual auth complete call.
			completeToolCall.function.arguments = JSON.stringify({
				action: "auth-complete",
				server: "fixture",
				args: { redirectUrl: redirectUrl.toString() },
			})
			const second = await prompt(fixture, sessionId, completionPrompt)
			expect(second.stopReason).toBe("end_turn")
			expect(second.chunks).toContain("Manual OAuth and the protected call completed.")
			await fixture.mcp.waitForEvent("oauth_token_issued", { where: { grantType: "authorization_code" } })
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "oauth-manual-callback" } },
			})
			const completed = oauthToolOutput(fixture, "OAuth authentication successful")
			expect(completed).toMatchObject({ details: { authenticated: true } })
			expect(completed).not.toHaveProperty("isError")
			expect(agentEndCount(fixture.homeDir, sessionId)).toBe(2)
		} finally {
			await fixture.stop()
			await releaseCallbackPort()
		}
	},
	STARTUP_TIMEOUT_MS,
)

async function verifySettledOAuthOutcome(scenario: "oauth-deny" | "oauth-token-failure"): Promise<void> {
	const finalText = scenario === "oauth-deny" ? "The user cancelled OAuth." : "OAuth token issuance failed."
	const fixture = await startAcpMcpFixture({
		clientMeta: OAUTH_TURN_META,
		artifactName: `acp-mcp-oauth-turn-${scenario}`,
		extensionPath: LIFECYCLE_EXTENSION,
		mcp: { transport: "oauth", scenario, oauthAutoComplete: false },
		responses: [
			authStartForPrompt("fixture", OAUTH_PROMPT_TEXT, "oauth-start-negative"),
			modelReply(finalText),
			modelReply("The next prompt works after the OAuth outcome."),
		],
	})
	try {
		const sessionId = await newSession(fixture, fixture.workDir)
		let response: acp.PromptResponse | undefined
		let failure: unknown
		const pending = fixture.conn.request("session/prompt", { sessionId, prompt: oauthPrompt() }).then(
			(result) => {
				response = result
			},
			(error: unknown) => {
				failure = error
			},
		)
		const opened = await fixture.mcp.waitForEvent("oauth_browser_opened")
		await delay(OAUTH_SETTLE_QUIET_MS)
		expect(failure).toBeUndefined()
		expect(response).toBeUndefined()

		await openAuthorization(opened.target)
		if (scenario === "oauth-deny") await fixture.mcp.waitForEvent("oauth_authorization_denied")
		else await fixture.mcp.waitForEvent("oauth_token_rejected", { where: { grantType: "authorization_code" } })
		await withTimeout(pending, "OAuth outcome prompt")

		expect(failure).toBeUndefined()
		expect(response?.stopReason).toBe("end_turn")
		expect(fixture.client.agentTextBySession().get(sessionId)).toContain(finalText)
		expect(toolResultText(fixture.fake.requests, "oauth-start-negative")).toMatch(/OAuth authentication failed/i)
		expect(oauthToolOutput(fixture, "OAuth authentication failed")).toMatchObject({ isError: true })
		expect(fixture.mcp.eventsOfType("tool_called")).toHaveLength(0)
		expect(agentEndCount(fixture.homeDir, sessionId)).toBe(1)

		const next = await prompt(fixture, sessionId, "Continue after the OAuth outcome")
		expect(next.stopReason).toBe("end_turn")
		expect(next.chunks).toContain("The next prompt works after the OAuth outcome.")
		expect(agentEndCount(fixture.homeDir, sessionId)).toBe(2)
	} finally {
		await fixture.stop()
	}
}

it(
	"settles user-cancelled OAuth and accepts a subsequent prompt",
	async () => {
		await verifySettledOAuthOutcome("oauth-deny")
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"settles failed OAuth and accepts a subsequent prompt",
	async () => {
		await verifySettledOAuthOutcome("oauth-token-failure")
	},
	STARTUP_TIMEOUT_MS,
)

it.each([
	{ kind: "cancel" as const, promptText: "Continue after explicit cancellation" },
	{ kind: "close" as const, promptText: "Continue in a fresh session after close" },
])(
	"$kind during OAuth releases the session and prevents late continuation work",
	async ({ kind, promptText }) => {
		const fixture = await startAcpMcpFixture({
			clientMeta: OAUTH_TURN_META,
			artifactName: `acp-mcp-oauth-turn-${kind}`,
			extensionPath: LIFECYCLE_EXTENSION,
			mcp: { transport: "oauth", oauthAutoComplete: false },
			responses: [
				authStartForPrompt("fixture", OAUTH_PROMPT_TEXT, `oauth-start-${kind}`),
				modelReplyForPrompt(promptText, "The session accepted a prompt after interruption."),
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const original = fixture.conn.request("session/prompt", { sessionId, prompt: oauthPrompt() })
			const opened = await fixture.mcp.waitForEvent("oauth_browser_opened")
			await delay(OAUTH_SETTLE_QUIET_MS)

			if (kind === "cancel") await fixture.conn.notify("session/cancel", { sessionId })
			else await fixture.conn.request("session/close", { sessionId })
			const interrupted = await withTimeout(original, `${kind} OAuth prompt`)
			expect(interrupted.stopReason).toBe("cancelled")
			const modelRequests = fixture.fake.requests.length
			const terminalCount = agentEndCount(fixture.homeDir, sessionId)

			if (kind === "close") {
				// Disposal cancels the loopback callback listener itself. Following the
				// stale authorization cannot deliver a grant or revive the session.
				await expect(openAuthorization(opened.target)).rejects.toThrow()
			} else {
				// Cancellation releases the ACP turn but leaves the adapter watcher
				// alive; its late grant must be consumed without waking agent work.
				await openAuthorization(opened.target)
				await fixture.mcp.waitForEvent("oauth_token_issued", { where: { grantType: "authorization_code" } })
			}
			await delay(OAUTH_SETTLE_QUIET_MS)
			expect(fixture.fake.requests).toHaveLength(modelRequests)
			expect(fixture.mcp.eventsOfType("tool_called")).toHaveLength(0)
			expect(agentEndCount(fixture.homeDir, sessionId)).toBe(terminalCount)
			expect(
				fixture.client.extNotifications.filter((n) => n.method === "_kimchi.dev/background_run_start"),
			).toHaveLength(0)

			const nextSessionId = kind === "close" ? await newSession(fixture, fixture.workDir) : sessionId
			const next = await prompt(fixture, nextSessionId, promptText)
			expect(next.stopReason).toBe("end_turn")
			expect(next.chunks).toContain("The session accepted a prompt after interruption.")
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"resumes only the session that owns each independent OAuth flow",
	async () => {
		const homeDir = mkdtempSync(join(tmpdir(), "kimchi-acp-oauth-isolation-home-"))
		const workDir = mkdtempSync(join(tmpdir(), "kimchi-acp-oauth-isolation-work-"))
		const agentDir = join(homeDir, ".config", "kimchi", "harness")
		mkdirSync(agentDir, { recursive: true })
		const secondary = await createMcpFixture(agentDir, {
			serverName: "secondary",
			transport: "oauth",
			oauthAutoComplete: false,
			behavior: {
				tools: [
					mcpToolResult(
						"echo",
						{ content: [{ type: "text", text: "fixture echo: session-b" }] },
						{ message: "session-b" },
					),
				],
			},
		})
		let fixture: AcpMcpFixture | undefined
		const secondaryBaseUrl = secondary.url
		if (!secondaryBaseUrl) throw new Error("secondary OAuth fixture has no URL")
		try {
			const promptA = "Start OAuth for session A"
			const promptB = "Start OAuth for session B"
			const echoA = gatewayMcpCall("echo", { message: "session-a" })
			const echoB = gatewayMcpCall("echo", { message: "session-b" }, { serverName: "secondary" })
			fixture = await startAcpMcpFixture({
				clientMeta: OAUTH_TURN_META,
				artifactName: "acp-mcp-oauth-turn-session-isolation",
				homeDirOverride: homeDir,
				workDirOverride: workDir,
				extensionPath: LIFECYCLE_EXTENSION,
				seedHome: () => {
					const configPath = join(agentDir, "mcp.json")
					const config = JSON.parse(readFileSync(configPath, "utf8")) as {
						mcpServers: Record<string, typeof secondary.serverDefinition>
					}
					config.mcpServers.secondary = secondary.serverDefinition
					writeFileSync(configPath, JSON.stringify(config, null, "\t"), "utf8")
				},
				mcp: {
					transport: "oauth",
					oauthAutoComplete: false,
					behavior: {
						tools: [
							mcpToolResult(
								"echo",
								{ content: [{ type: "text", text: "fixture echo: session-a" }] },
								{ message: "session-a" },
							),
						],
					},
				},
				responses: [
					authStartForPrompt("fixture", promptA),
					authStartForPrompt("secondary", promptB),
					withPromptMatch(echoA.response, promptA),
					modelReplyForPrompt(promptA, "Session A resumed after its own grant."),
					withPromptMatch(echoB.response, promptB),
					modelReplyForPrompt(promptB, "Session B resumed after its own grant."),
				],
			})
			const sessionA = await newSession(fixture, fixture.workDir)
			let responseA: acp.PromptResponse | undefined
			let responseB: acp.PromptResponse | undefined
			let failureA: unknown
			let failureB: unknown
			const pendingA = fixture.conn
				.request("session/prompt", { sessionId: sessionA, prompt: [{ type: "text", text: promptA }] })
				.then(
					(result) => {
						responseA = result
					},
					(error: unknown) => {
						failureA = error
					},
				)
			const openedA = await fixture.mcp.waitForEvent("oauth_browser_opened")
			const sessionB = await newSession(fixture, fixture.workDir)
			const pendingB = fixture.conn
				.request("session/prompt", { sessionId: sessionB, prompt: [{ type: "text", text: promptB }] })
				.then(
					(result) => {
						responseB = result
					},
					(error: unknown) => {
						failureB = error
					},
				)
			const openedB = await fixture.mcp.waitForEvent("oauth_browser_opened", {
				predicate: (event) => new URL(event.target).origin === new URL(secondaryBaseUrl).origin,
				description: "session B's independent OAuth authorization",
			})
			await delay(OAUTH_SETTLE_QUIET_MS)
			expect(responseA).toBeUndefined()
			expect(responseB).toBeUndefined()

			await openAuthorization(openedA.target)
			await withTimeout(pendingA, "session A OAuth prompt")
			expect(failureA).toBeUndefined()
			expect(responseA?.stopReason).toBe("end_turn")
			expect(failureB).toBeUndefined()
			expect(responseB).toBeUndefined()
			await fixture.mcp.waitForEvent("tool_called", { where: { name: "echo", arguments: { message: "session-a" } } })
			expect(secondary.eventsOfType("tool_called")).toHaveLength(0)
			expect(agentEndCount(fixture.homeDir, sessionA)).toBe(1)
			expect(agentEndCount(fixture.homeDir, sessionB)).toBe(0)

			await openAuthorization(openedB.target)
			await withTimeout(pendingB, "session B OAuth prompt")
			expect(failureB).toBeUndefined()
			expect(responseB?.stopReason).toBe("end_turn")
			expect(fixture.client.agentTextBySession().get(sessionB)).toContain("Session B resumed after its own grant.")
			await secondary.waitForEvent("tool_called", { where: { name: "echo", arguments: { message: "session-b" } } })
			expect(fixture.mcp.eventsOfType("tool_called")).toHaveLength(1)
			expect(secondary.eventsOfType("tool_called")).toHaveLength(1)
			expect(agentEndCount(fixture.homeDir, sessionB)).toBe(1)
			expect(
				fixture.client.extNotifications.filter((n) => n.method === "_kimchi.dev/background_run_start"),
			).toHaveLength(0)
		} finally {
			try {
				await fixture?.stop()
			} finally {
				await secondary.stop()
				rmSync(homeDir, { recursive: true, force: true })
				rmSync(workDir, { recursive: true, force: true })
			}
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"completes an ordinary non-OAuth prompt immediately with one terminal lifecycle event",
	async () => {
		const fixture = await startAcpFixture({
			clientMeta: OAUTH_TURN_META,
			artifactName: "acp-mcp-oauth-turn-ordinary-prompt",
			extensionPath: LIFECYCLE_EXTENSION,
			responses: [modelReply("Ordinary prompts are unchanged.")],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const startedAt = performance.now()
			const result = await prompt(fixture, sessionId, "Answer without using MCP OAuth")
			expect(result.stopReason).toBe("end_turn")
			expect(result.chunks).toContain("Ordinary prompts are unchanged.")
			expect(performance.now() - startedAt).toBeLessThan(5_000)
			expect(agentEndCount(fixture.homeDir, sessionId)).toBe(1)
			expect(
				fixture.client.extNotifications.filter((n) => n.method === "_kimchi.dev/background_run_start"),
			).toHaveLength(0)
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"rejects a duplicate auth-start without replacing the original pending flow",
	async () => {
		const fixture = await startAcpMcpFixture({
			clientMeta: OAUTH_TURN_META,
			artifactName: "acp-mcp-oauth-turn-duplicate-start",
			extensionPath: LIFECYCLE_EXTENSION,
			mcp: { transport: "oauth", oauthAutoComplete: false },
			responses: [
				{
					toolCalls: [
						{
							id: "oauth-duplicate-a",
							index: 0,
							function: { name: "mcp", arguments: JSON.stringify({ action: "auth-start", server: "fixture" }) },
						},
						{
							id: "oauth-duplicate-b",
							index: 1,
							function: { name: "mcp", arguments: JSON.stringify({ action: "auth-start", server: "fixture" }) },
						},
					],
				},
				modelReply("Both duplicate OAuth calls settled."),
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			let response: acp.PromptResponse | undefined
			let failure: unknown
			const pending = fixture.conn.request("session/prompt", { sessionId, prompt: oauthPrompt() }).then(
				(result) => {
					response = result
				},
				(error: unknown) => {
					failure = error
				},
			)
			const opened = await fixture.mcp.waitForEvent("oauth_browser_opened")
			await delay(OAUTH_SETTLE_QUIET_MS)
			expect(response).toBeUndefined()
			expect(agentEndCount(fixture.homeDir, sessionId)).toBe(0)

			await openAuthorization(opened.target)
			await withTimeout(pending, "duplicate auth-start prompt")
			expect(failure).toBeUndefined()
			expect(response?.stopReason).toBe("end_turn")
			const outcomes = ["oauth-duplicate-a", "oauth-duplicate-b"].map((id) => toolResultText(fixture.fake.requests, id))
			expect(outcomes.some((text) => text.includes("already in progress"))).toBe(true)
			expect(outcomes.some((text) => text.includes("OAuth authentication successful"))).toBe(true)
			expect(agentEndCount(fixture.homeDir, sessionId)).toBe(1)
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"preserves the legacy remote manual rawOutput on live delivery and replay",
	async () => {
		const promptText = "Start remote manual OAuth with a legacy client"
		const releaseCallbackPort = await occupyOAuthCallbackPort()
		const fixture = await startAcpMcpFixture({
			// Deliberately no mcpOAuthTurn capability. The structured handoff is
			// host coordination data, not a new default rawOutput field.
			artifactName: "acp-mcp-oauth-turn-legacy-manual-result",
			mcp: {
				transport: "oauth",
				oauthAutoComplete: false,
				oauth: { scope: "mcp:tools", redirectUri: "https://app.kimchi.dev/mcp-oauth/callback-v2" },
			},
			responses: [
				authStartForPrompt("fixture", promptText, "oauth-legacy-manual-start"),
				modelReplyForPrompt(promptText, "Follow the remote OAuth instructions."),
			],
		}).catch(async (error: unknown) => {
			await releaseCallbackPort()
			throw error
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			expect((await withTimeout(prompt(fixture, sessionId, promptText), "legacy remote manual OAuth")).stopReason).toBe(
				"end_turn",
			)
			const opened = await fixture.mcp.waitForEvent("oauth_browser_opened")
			const authorization = await fetch(opened.target, {
				redirect: "manual",
				signal: AbortSignal.timeout(OAUTH_ACTION_TIMEOUT_MS),
			})
			expect(authorization.status).toBe(302)
			const expectedDetails = { mode: "auth-start", server: "fixture", authorizationUrl: opened.target }
			expect(oauthToolOutput(fixture, opened.target)?.details).toEqual(expectedDetails)

			const replayStart = fixture.client.sessionUpdates.length
			await fixture.conn.request("session/load", { sessionId, cwd: fixture.workDir, mcpServers: [] })
			expect(oauthToolOutput(fixture, opened.target, replayStart)?.details).toEqual(expectedDetails)
		} finally {
			await fixture.stop()
			await releaseCallbackPort()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"does not apply a cancelled watcher's outcome to a same-server retry",
	async () => {
		const firstPrompt = "Start the cancellable OAuth flow"
		const retryPrompt = "Retry OAuth after explicit cancel"
		const fixture = await startAcpMcpFixture({
			clientMeta: OAUTH_TURN_META,
			artifactName: "acp-mcp-oauth-turn-cancel-retry",
			extensionPath: LIFECYCLE_EXTENSION,
			mcp: { transport: "oauth", oauthAutoComplete: false },
			responses: [
				authStartForPrompt("fixture", firstPrompt, "oauth-cancel-original"),
				authStartForPrompt("fixture", retryPrompt, "oauth-cancel-retry"),
				modelReplyForPrompt(retryPrompt, "The retry was rejected while the original watcher finishes."),
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const original = fixture.conn.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: firstPrompt }],
			})
			const opened = await fixture.mcp.waitForEvent("oauth_browser_opened")
			await fixture.conn.notify("session/cancel", { sessionId })
			expect((await withTimeout(original, "cancelled original OAuth prompt")).stopReason).toBe("cancelled")

			const retry = fixture.conn.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: retryPrompt }],
			})
			const retried = await withTimeout(retry, "same-server OAuth retry")
			expect(retried.stopReason).toBe("end_turn")
			expect(toolResultText(fixture.fake.requests, "oauth-cancel-retry")).toContain("already in progress")
			expect(fixture.client.agentTextBySession().get(sessionId)).toContain(
				"The retry was rejected while the original watcher finishes.",
			)
			const modelRequests = fixture.fake.requests.length
			const terminalCount = agentEndCount(fixture.homeDir, sessionId)

			await openAuthorization(opened.target)
			await fixture.mcp.waitForEvent("oauth_token_issued", { where: { grantType: "authorization_code" } })
			await delay(OAUTH_SETTLE_QUIET_MS)
			expect(fixture.fake.requests).toHaveLength(modelRequests)
			expect(agentEndCount(fixture.homeDir, sessionId)).toBe(terminalCount)
			expect(fixture.mcp.eventsOfType("tool_called")).toHaveLength(0)
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)
