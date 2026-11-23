import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import type * as acp from "@agentclientprotocol/sdk"
import { expect, it } from "vitest"
import type { FakeResponseScript } from "../tui/support/fake-openai-server.js"
import { createMcpFixture, mcpToolResult } from "../tui/support/mcp-fixture.js"
import { gatewayMcpCall, modelReply, toolResultText } from "../tui/support/mcp-model-script.js"
import { type AcpMcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture, startAcpMcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const OAUTH_SETTLE_QUIET_MS = 300
const OAUTH_ACTION_TIMEOUT_MS = 15_000
const OAUTH_PROMPT_TEXT = "Authenticate the MCP server, then call its protected echo tool"
const LIFECYCLE_EXTENSION = fileURLToPath(new URL("./support/test-agent-lifecycle-extension.js", import.meta.url))

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

it(
	"keeps the originating prompt pending until OAuth and all resumed work complete",
	async () => {
		const echo = gatewayMcpCall("echo", { message: "oauth-turn-success" })
		const fixture = await startAcpMcpFixture({
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
			const pending = fixture.conn.prompt({ sessionId, prompt: oauthPrompt() }).then(
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

async function verifySettledOAuthOutcome(scenario: "oauth-deny" | "oauth-token-failure"): Promise<void> {
	const finalText = scenario === "oauth-deny" ? "The user cancelled OAuth." : "OAuth token issuance failed."
	const fixture = await startAcpMcpFixture({
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
		const pending = fixture.conn.prompt({ sessionId, prompt: oauthPrompt() }).then(
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
		const failureUpdate = fixture.client.sessionUpdates.find(
			({ update }) =>
				update.sessionUpdate === "tool_call_update" &&
				JSON.stringify(update.rawOutput ?? {}).includes("OAuth authentication failed"),
		)
		if (failureUpdate?.update.sessionUpdate !== "tool_call_update") {
			throw new Error("missing ACP tool_call_update for failed MCP OAuth")
		}
		expect(failureUpdate.update.rawOutput).toMatchObject({ isError: true })
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
			const original = fixture.conn.prompt({ sessionId, prompt: oauthPrompt() })
			const opened = await fixture.mcp.waitForEvent("oauth_browser_opened")
			await delay(OAUTH_SETTLE_QUIET_MS)

			if (kind === "cancel") await fixture.conn.cancel({ sessionId })
			else await fixture.conn.closeSession({ sessionId })
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
		try {
			const promptA = "Start OAuth for session A"
			const promptB = "Start OAuth for session B"
			const echoA = gatewayMcpCall("echo", { message: "session-a" })
			const echoB = gatewayMcpCall("echo", { message: "session-b" }, { serverName: "secondary" })
			fixture = await startAcpMcpFixture({
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
			const pendingA = fixture.conn.prompt({ sessionId: sessionA, prompt: [{ type: "text", text: promptA }] }).then(
				(result) => {
					responseA = result
				},
				(error: unknown) => {
					failureA = error
				},
			)
			const openedA = await fixture.mcp.waitForEvent("oauth_browser_opened")
			const sessionB = await newSession(fixture, fixture.workDir)
			const pendingB = fixture.conn.prompt({ sessionId: sessionB, prompt: [{ type: "text", text: promptB }] }).then(
				(result) => {
					responseB = result
				},
				(error: unknown) => {
					failureB = error
				},
			)
			const openedB = await fixture.mcp.waitForEvent("oauth_browser_opened", {
				predicate: (event) => new URL(event.target).origin === new URL(secondary.url!).origin,
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
			const pending = fixture.conn.prompt({ sessionId, prompt: oauthPrompt() }).then(
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
	"does not apply a cancelled watcher's outcome to a same-server retry",
	async () => {
		const firstPrompt = "Start the cancellable OAuth flow"
		const retryPrompt = "Retry OAuth after explicit cancel"
		const fixture = await startAcpMcpFixture({
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
			const original = fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: firstPrompt }] })
			const opened = await fixture.mcp.waitForEvent("oauth_browser_opened")
			await fixture.conn.cancel({ sessionId })
			expect((await withTimeout(original, "cancelled original OAuth prompt")).stopReason).toBe("cancelled")

			const retry = fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: retryPrompt }] })
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
