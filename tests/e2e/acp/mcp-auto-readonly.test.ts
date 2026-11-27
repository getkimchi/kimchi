import { afterEach, describe, expect, it } from "vitest"
import { mcpToolResult } from "../tui/support/mcp-fixture.js"
import { gatewayMcpCall, modelReply, toolResultText } from "../tui/support/mcp-model-script.js"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitFor } from "./support/scenarios.js"

const MAIN_MODEL = {
	slug: "basic",
	displayName: "Fake Basic",
	provider: "ai-enabler",
	contextWindow: 200_000,
	maxTokens: 8192,
}
const CLASSIFIER_MODEL = {
	slug: "deepseek-v4-flash-0731",
	displayName: "DeepSeek V4 Flash",
	provider: "ai-enabler",
	contextWindow: 200_000,
	maxTokens: 8192,
}

function classifierRequests(fixture: AcpFixture) {
	return fixture.fake.requests.filter(
		(request) =>
			request.url.startsWith("/openai/v1/chat/completions") &&
			request.body !== null &&
			typeof request.body === "object" &&
			"model" in request.body &&
			request.body.model === CLASSIFIER_MODEL.slug,
	)
}

function expectStandardAcpWorkflow(fixture: AcpFixture, sessionId: string): void {
	const variants = fixture.client.sessionUpdates
		.filter((update) => update.sessionId === sessionId)
		.map(({ update }) => update.sessionUpdate)
	expect(variants).toEqual(expect.arrayContaining(["tool_call", "tool_call_update", "agent_message_chunk"]))
	expect(variants.filter((variant) => variant.startsWith("_"))).toEqual([])
	expect(
		fixture.client.sessionUpdates.some(
			({ sessionId: id, update }) =>
				id === sessionId && update.sessionUpdate === "tool_call_update" && update.status === "completed",
		),
	).toBe(true)

	expect(fixture.client.extMethods).toEqual([])
	const existingNotifications = new Set(["_kimchi.dev/pi_notify", "_kimchi.dev/project_trust_update"])
	expect(fixture.client.extNotifications.every(({ method }) => existingNotifications.has(method))).toBe(true)
}

describe("ACP auto MCP approval", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
		fixture = undefined
	})

	it(
		"ACP auto mode completes an annotated gateway read without classifier or requestPermission",
		async () => {
			const read = gatewayMcpCall("getJiraIssue", { issueIdOrKey: "LLM-4358" })
			fixture = await startAcpFixture({
				artifactName: "acp-mcp-auto-gateway-read",
				providerId: "kimchi-dev",
				extraArgs: ["--auto"],
				models: [MAIN_MODEL, CLASSIFIER_MODEL],
				mcp: {
					behavior: {
						catalogTools: [
							{
								name: "getJiraIssue",
								description: "Read a Jira issue",
								inputSchema: {
									type: "object",
									properties: { issueIdOrKey: { type: "string" } },
									additionalProperties: false,
								},
								annotations: { readOnlyHint: true },
							},
						],
						tools: [
							mcpToolResult("getJiraIssue", {
								content: [{ type: "text", text: "LLM-4358: Auto-approved MCP read" }],
							}),
						],
					},
				},
				responses: [read.response, modelReply("The annotated gateway read completed without approval.")],
			})
			const mcp = fixture.mcp
			if (!mcp) throw new Error("Seeded MCP fixture was not created")

			const sessionId = await newSession(fixture, fixture.workDir)
			const result = await prompt(fixture, sessionId, "Read LLM-4358 through the MCP gateway")
			expect(result.stopReason).toBe("end_turn")
			expect(result.chunks).toContain("The annotated gateway read completed without approval.")

			const called = await mcp.waitForEvent("tool_called", {
				where: { name: "getJiraIssue", arguments: { issueIdOrKey: "LLM-4358" } },
				description: "auto-approved ACP Jira read",
			})
			expect(called.arguments).toEqual({ issueIdOrKey: "LLM-4358" })
			expect(toolResultText(fixture.fake.requests, read)).toContain("LLM-4358: Auto-approved MCP read")
			expectStandardAcpWorkflow(fixture, sessionId)
			expect(fixture.client.permissionRequests).toEqual([])
			expect(classifierRequests(fixture)).toEqual([])
		},
		STARTUP_TIMEOUT_MS,
	)

	it(
		"ACP auto mode retains classifier and requestPermission for a gateway write",
		async () => {
			const write = gatewayMcpCall("updateJiraIssue", {
				issueIdOrKey: "LLM-4358",
				fields: { summary: "Updated through the MCP gateway" },
			})
			fixture = await startAcpFixture({
				artifactName: "acp-mcp-auto-gateway-write",
				providerId: "kimchi-dev",
				extraArgs: ["--auto"],
				models: [MAIN_MODEL, CLASSIFIER_MODEL],
				mcp: {
					behavior: {
						catalogTools: [
							{
								name: "updateJiraIssue",
								description: "Update a Jira issue",
								inputSchema: {
									type: "object",
									properties: {
										issueIdOrKey: { type: "string" },
										fields: { type: "object" },
									},
									additionalProperties: false,
								},
								annotations: { readOnlyHint: false },
							},
						],
						tools: [
							mcpToolResult("updateJiraIssue", {
								content: [{ type: "text", text: "LLM-4358 updated by the MCP fixture" }],
							}),
						],
					},
				},
				// The fake endpoint consumes main, classifier, then main responses.
				responses: [
					write.response,
					modelReply('{"verdict":"requires-confirmation","reason":"This updates a Jira issue","riskScore":"high"}'),
					modelReply("The annotated gateway write completed after approval."),
				],
			})
			const mcp = fixture.mcp
			if (!mcp) throw new Error("Seeded MCP fixture was not created")
			const client = fixture.client
			client.answerNextPermissionWith({ kind: "allow_once" })
			let releaseApproval!: () => void
			const approvalReleased = new Promise<void>((resolve) => {
				releaseApproval = resolve
			})
			const selectedOptionIds: string[] = []
			const requestPermission = client.requestPermission.bind(client)
			client.requestPermission = async (params) => {
				const response = await requestPermission(params)
				await approvalReleased
				if (response.outcome.outcome === "selected") selectedOptionIds.push(response.outcome.optionId)
				return response
			}

			const sessionId = await newSession(fixture, fixture.workDir)
			const pendingResult = prompt(fixture, sessionId, "Update LLM-4358 through the MCP gateway")
			const permissionRequests = await waitFor(
				() => client.permissionRequests,
				(requests) => requests.length === 1,
			)
			expect(classifierRequests(fixture)).toHaveLength(1)
			const modelsBeforeApproval = fixture.fake.requests.flatMap((request) => {
				if (
					!request.url.startsWith("/openai/v1/chat/completions") ||
					request.body === null ||
					typeof request.body !== "object" ||
					!("model" in request.body)
				) {
					return []
				}
				return [request.body.model]
			})
			expect(modelsBeforeApproval).toEqual([MAIN_MODEL.slug, CLASSIFIER_MODEL.slug])
			expect(mcp.hasEvent("tool_called", { name: "updateJiraIssue" })).toBe(false)
			const allowOnce = permissionRequests[0]?.options.find((option) => option.kind === "allow_once")
			if (!allowOnce) throw new Error("Permission request did not contain allow_once")

			const calledPromise = mcp.waitForEvent("tool_called", {
				where: {
					name: "updateJiraIssue",
					arguments: {
						issueIdOrKey: "LLM-4358",
						fields: { summary: "Updated through the MCP gateway" },
					},
				},
				description: "approved ACP Jira write",
			})
			releaseApproval()
			const [result, called] = await Promise.all([pendingResult, calledPromise])
			expect(selectedOptionIds).toEqual([allowOnce.optionId])
			expect(result.stopReason).toBe("end_turn")
			expect(result.chunks).toContain("The annotated gateway write completed after approval.")
			expect(called.arguments).toEqual({
				issueIdOrKey: "LLM-4358",
				fields: { summary: "Updated through the MCP gateway" },
			})
			expect(toolResultText(fixture.fake.requests, write)).toContain("LLM-4358 updated by the MCP fixture")
			expectStandardAcpWorkflow(fixture, sessionId)
			expect(fixture.client.permissionRequests).toHaveLength(1)
			expect(fixture.client.permissionRequests[0]?.sessionId).toBe(sessionId)
			expect(classifierRequests(fixture)).toHaveLength(1)
		},
		STARTUP_TIMEOUT_MS,
	)
})
